/**
 * Lorebook retrieval.
 *
 * Every entry is evaluated independently against the scan window. This is the
 * single implementation used by both the context compiler and the Lorebook
 * Tester, so what the tester shows is exactly what the AI receives.
 */

import type { ID, LoreEntry, LoreHit, LoreMiss, LoreTier, Lorebook } from '../types';
import { LORE_TIER_RANK } from '../types';
import { escapeRegExp } from '../utils/text';

export interface LoreScanScope {
  /** Where the lookup is happening — gates `story-only`/`chat-only` entries. */
  source: 'story' | 'chat' | 'character' | 'test';
  /** Lorebook ids attached at each level, used for attribution + gating. */
  storyLorebookIds: ID[];
  chatLorebookIds: ID[];
  characterLorebookIds: ID[];
  /**
   * Books belonging to the character actually being asked to reply.
   *
   * `character-only` is the one activation that means "this character's own
   * knowledge". Gating it on the whole cast made it mean "anyone in the story",
   * so a book attached to a character standing elsewhere in the world was in
   * every turn. Reachability is unchanged — a cast member's book still reaches
   * the scan through `characterLorebookIds`; only `character-only` narrows.
   *
   * Omitted means no responder was resolved, in which case the cast is the
   * best available answer and behaviour is exactly what it was.
   */
  responderLorebookIds?: ID[];
}

export interface LoreScanInput {
  /** Newest-last list of recent message texts. */
  recentTexts: string[];
  /** Extra always-scanned text: scenario, persona, character summaries. */
  ambientText?: string;
  /**
   * What the user is sending right now. Matching here is the strongest signal
   * an entry has: it is the only text we know the roleplay is about.
   */
  currentText?: string;
  /**
   * Names of the characters in the scene. An entry keyed to someone standing
   * in the room outranks the same entry keyed to a name in old history.
   */
  sceneNames?: string[];
  /** How many trailing messages count as recent rather than history. */
  recentWindow?: number;
  /**
   * Identifies this turn, so probability rolls are reproducible. Regenerating
   * the same turn must see the same lore, or the scene drifts for reasons the
   * user cannot see.
   */
  turnSeed?: string;
  /**
   * How many messages the timeline being played holds, for `delay`. Absent
   * falls back to the scan window, which is all a caller without the whole
   * timeline can honestly say.
   */
  messageCount?: number;
  lorebooks: Lorebook[];
  entries: LoreEntry[];
  scope: LoreScanScope;
  defaultScanDepth: number;
  maxEntries: number;
}

export interface LoreScanResult {
  hits: LoreHit[];
  misses: LoreMiss[];
}

/**
 * Timing, read defensively.
 *
 * These three arrived after the first release, so an entry stored before then
 * — or imported from a book that never had them — has none of them. Reading
 * them as zero is the honest default: no delay, no stickiness, no cooldown is
 * exactly how those entries have always behaved.
 */
function timingOf(entry: LoreEntry): { delay: number; sticky: number; cooldown: number } {
  return {
    delay: Math.max(0, Math.round(entry.delay ?? 0)),
    sticky: Math.max(0, Math.round(entry.sticky ?? 0)),
    cooldown: Math.max(0, Math.round(entry.cooldown ?? 0)),
  };
}

/**
 * How many messages back this entry's keywords were last said, counting the
 * newest message as 1. Zero means "not within the span looked at".
 *
 * Deliberately measured from the text of the visible timeline rather than from
 * a record of what fired before. It costs no store and no writes, it cannot
 * drift out of step with the conversation, and it inherits branch correctness
 * for nothing: a branch where the keyword was never said has, correctly, never
 * triggered the entry. The trade is that this counts when the keyword was last
 * *said* rather than when the entry was last *sent* — an entry that matched but
 * lost its place to the token budget still counts as having fired. For deciding
 * whether a thread is still live, what the story said is the better signal
 * anyway.
 */
function messagesSinceMatch(entry: LoreEntry, texts: string[], span: number): number {
  const terms = [...entry.primaryKeys, ...entry.aliases];
  if (!terms.length || span <= 0) return 0;
  const from = Math.max(0, texts.length - span);
  for (let i = texts.length - 1; i >= from; i -= 1) {
    if (matchTerms(terms, entry, texts[i]).length) return texts.length - i;
  }
  return 0;
}

interface Matcher {
  term: string;
  test: (haystack: string) => boolean;
}

function buildMatcher(term: string, entry: LoreEntry): Matcher | null {
  const trimmed = term.trim();
  if (!trimmed) return null;
  const flags = entry.caseSensitive ? 'u' : 'iu';

  if (entry.matchMode === 'partial') {
    const needle = entry.caseSensitive ? trimmed : trimmed.toLowerCase();
    return {
      term: trimmed,
      test: (haystack) =>
        (entry.caseSensitive ? haystack : haystack.toLowerCase()).includes(needle),
    };
  }

  if (entry.matchMode === 'exact-phrase') {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}([^\\p{L}\\p{N}]|$)`, flags);
    return { term: trimmed, test: (haystack) => re.test(haystack) };
  }

  // word-boundary: Unicode-aware so accented and CJK keys still work.
  // CJK has no word boundaries, so fall back to substring for non-latin terms.
  const hasLatin = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(trimmed);
  if (!hasLatin) {
    const needle = entry.caseSensitive ? trimmed : trimmed.toLowerCase();
    return {
      term: trimmed,
      test: (haystack) =>
        (entry.caseSensitive ? haystack : haystack.toLowerCase()).includes(needle),
    };
  }
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`,
    flags,
  );
  return { term: trimmed, test: (haystack) => re.test(haystack) };
}

function matchTerms(terms: string[], entry: LoreEntry, haystack: string): string[] {
  const matched: string[] = [];
  for (const term of terms) {
    const matcher = buildMatcher(term, entry);
    if (matcher && matcher.test(haystack)) matched.push(matcher.term);
  }
  return matched;
}

function scopeAllows(
  entry: LoreEntry,
  scope: LoreScanScope,
  attachedVia: string[],
  /** True when the book belongs to the character being asked to reply. */
  responderAttached: boolean,
): boolean {
  switch (entry.activation) {
    case 'story-only':
      return scope.source === 'story' || scope.source === 'test' || attachedVia.includes('story');
    case 'chat-only':
      return scope.source === 'chat' || scope.source === 'test' || attachedVia.includes('chat');
    case 'character-only':
      return responderAttached || scope.source === 'test';
    default:
      return true;
  }
}

function attachmentPaths(book: Lorebook, scope: LoreScanScope): string[] {
  const via: string[] = [];
  if (book.global) via.push('global');
  if (scope.storyLorebookIds.includes(book.id)) via.push('story');
  if (scope.chatLorebookIds.includes(book.id)) via.push('chat');
  if (scope.characterLorebookIds.includes(book.id)) via.push('character');
  return via;
}

/**
 * Fields a lorebook brought with it that Nexus has no column for.
 *
 * The importer keeps every unrecognised key as a custom field rather than
 * dropping it, so a SillyTavern-authored book still carries its probability and
 * group settings — they were simply never read. Reading them here honours the
 * author's configuration without a schema migration or a re-import.
 */
function customValue(entry: LoreEntry, keys: string[]): string | null {
  for (const field of entry.customFields ?? []) {
    const key = field.key.trim().toLowerCase().replace(/[_\s-]/g, '');
    if (keys.some((k) => k.toLowerCase().replace(/[_\s-]/g, '') === key)) {
      return field.value.trim();
    }
  }
  return null;
}

function customNumber(entry: LoreEntry, keys: string[], fallback: number): number {
  const raw = customValue(entry, keys);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function customFlag(entry: LoreEntry, keys: string[]): boolean {
  const raw = customValue(entry, keys);
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * A stable pseudo-random value in [0,100) for an entry in a given turn.
 *
 * Probability has to be honoured without making regeneration a lottery: if the
 * roll were fresh each call, pressing Regenerate could change which lore is in
 * scope, and the scene would drift for reasons the user cannot see. Seeding on
 * the entry and the turn keeps a given turn's context reproducible while still
 * varying across the story.
 */
function stableRoll(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 100;
}

/** The bands an entry can match in, strongest first. */
interface Band {
  tier: LoreTier;
  text: string;
  describe: (terms: string[]) => string;
}

export function scanLore(input: LoreScanInput): LoreScanResult {
  const { entries, lorebooks, scope } = input;
  const bookById = new Map(lorebooks.map((b) => [b.id, b]));
  const hits: LoreHit[] = [];
  const misses: LoreMiss[] = [];

  const ambient = input.ambientText ?? '';
  const recentWindow = Math.max(1, input.recentWindow ?? 6);
  const responderBooks = new Set(scope.responderLorebookIds ?? scope.characterLorebookIds);

  for (const entry of entries) {
    const book = bookById.get(entry.lorebookId);
    if (!book) {
      misses.push({ entry, lorebookName: 'Unknown lorebook', reason: 'Its lorebook is missing.' });
      continue;
    }
    const bookName = book.name || 'Untitled lorebook';

    if (!book.enabled) {
      misses.push({ entry, lorebookName: bookName, reason: 'Lorebook is disabled.' });
      continue;
    }
    if (!entry.enabled) {
      misses.push({ entry, lorebookName: bookName, reason: 'Entry is disabled.' });
      continue;
    }
    if (!entry.content.trim()) {
      misses.push({ entry, lorebookName: bookName, reason: 'Entry has no content.' });
      continue;
    }

    const via = attachmentPaths(book, scope);
    if (!via.length) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: 'Lorebook is not attached to this story, chat or character (and is not global).',
      });
      continue;
    }
    if (!scopeAllows(entry, scope, via, responderBooks.has(book.id))) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason:
          entry.activation === 'character-only'
            ? 'Activation is "character-only" and this book does not belong to the character replying.'
            : `Activation is "${entry.activation}" but this lookup came from "${scope.source}".`,
      });
      continue;
    }

    const timing = timingOf(entry);
    // Before anything else, including 'always': a late revelation set to hold
    // back until the story is long enough must not fire in the opening
    // exchange just because someone marked it constant.
    const storyLength = input.messageCount ?? input.recentTexts.length;
    if (timing.delay > 0 && storyLength < timing.delay) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `Held back until the story is ${timing.delay} message(s) long; it is ${storyLength}.`,
      });
      continue;
    }

    if (entry.activation === 'always') {
      hits.push({
        entry,
        lorebookName: bookName,
        matched: [],
        reason: `Always active (attached via ${via.join(', ')}).`,
        tier: 'world',
      });
      continue;
    }

    const depth = entry.scanDepth || book.scanDepth || input.defaultScanDepth;
    const window = depth > 0 ? input.recentTexts.slice(-depth) : input.recentTexts;

    // The same window, split by how much the roleplay currently cares about it.
    // An entry keyed to "Edgeshot" matching a pasted transcript is a different
    // claim from one matching the sentence the user just typed, and the split
    // is what lets the budget keep the second and drop the first.
    const recent = window.slice(-recentWindow);
    const older = window.slice(0, Math.max(0, window.length - recentWindow));
    const bands: Band[] = [
      {
        tier: 'scene',
        text: [input.currentText ?? '', ...(input.sceneNames ?? [])].filter(Boolean).join('\n'),
        describe: (t) => `Keyword matched: ${t.join(', ')} (in the current scene or message)`,
      },
      {
        tier: 'recent',
        text: recent.join('\n'),
        describe: (t) =>
          `Keyword matched: ${t.join(', ')} (in the last ${recent.length} message(s))`,
      },
      {
        tier: 'story',
        text: ambient,
        describe: (t) => `Keyword matched: ${t.join(', ')} (in the story's own setup)`,
      },
      {
        tier: 'history',
        text: older.join('\n'),
        describe: (t) => `Keyword matched: ${t.join(', ')} (only in older history)`,
      },
    ];

    if (!bands.some((b) => b.text.trim())) {
      misses.push({ entry, lorebookName: bookName, reason: 'Nothing in the scan window yet.' });
      continue;
    }

    const primaryTerms = [...entry.primaryKeys, ...entry.aliases];
    if (!primaryTerms.length) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: 'Keyword-triggered but has no primary keywords or aliases.',
      });
      continue;
    }

    // Strongest band wins; a match anywhere still counts, it just ranks lower.
    let winner: { band: Band; matched: string[] } | null = null;
    for (const band of bands) {
      if (!band.text.trim()) continue;
      const matched = matchTerms(primaryTerms, entry, band.text);
      if (matched.length) {
        winner = { band, matched };
        break;
      }
    }

    // How long since the story last said any of this entry's words. Only
    // computed when something actually asks, so a worldbook of thousands of
    // ordinary entries pays nothing for a feature it does not use.
    const since =
      timing.sticky > 0 || timing.cooldown > 0
        ? messagesSinceMatch(
            entry,
            input.recentTexts,
            Math.max(timing.sticky, timing.cooldown),
          )
        : 0;

    if (!winner) {
      // Nothing matched now, but it did recently and was asked to stay. This is
      // what stops a location dropping out of the prompt between mentions and
      // the scene quietly losing its footing.
      if (timing.sticky > 0 && since > 0 && since <= timing.sticky) {
        hits.push({
          entry,
          lorebookName: bookName,
          matched: [],
          reason: `Still active: keyword last matched ${since} message(s) ago, sticky for ${timing.sticky}.`,
          tier: 'recent',
        });
        continue;
      }
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `No keyword matched in the last ${window.length} message(s).`,
      });
      continue;
    }

    // It matched, but it has only just been sent. A common keyword that
    // re-triggers every single turn is how one entry crowds a large worldbook
    // out of its own context.
    if (timing.cooldown > 0 && since > 0 && since <= timing.cooldown) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `Matched, but resting: it last matched ${since} message(s) ago and its cooldown is ${timing.cooldown}.`,
      });
      continue;
    }

    if (entry.secondaryKeys.length) {
      // Secondary keys gate on the whole window: they qualify the match rather
      // than locating it.
      const whole = [...window, ambient, input.currentText ?? ''].filter(Boolean).join('\n');
      const matchedSecondary = matchTerms(entry.secondaryKeys, entry, whole);
      if (!matchedSecondary.length) {
        misses.push({
          entry,
          lorebookName: bookName,
          reason: `Primary keyword "${winner.matched[0]}" matched, but no secondary keyword did.`,
        });
        continue;
      }
      hits.push({
        entry,
        lorebookName: bookName,
        matched: [...winner.matched, ...matchedSecondary],
        reason: winner.band.describe([...winner.matched, ...matchedSecondary]),
        tier: winner.band.tier,
      });
      continue;
    }

    hits.push({
      entry,
      lorebookName: bookName,
      matched: winner.matched,
      reason: winner.band.describe(winner.matched),
      tier: winner.band.tier,
    });
  }

  // Relevance first, then the author's own priority within a tier. This is the
  // ordering the entry limit and the token budget both cut from the bottom of.
  hits.sort(
    (a, b) =>
      LORE_TIER_RANK[b.tier] - LORE_TIER_RANK[a.tier] ||
      b.entry.priority - a.entry.priority ||
      a.entry.order - b.entry.order,
  );

  const seed = input.turnSeed ?? '';
  const surviving: LoreHit[] = [];

  // Probability, as the lorebook author set it. Rolled from a stable seed so a
  // regeneration of the same turn sees the same lore.
  for (const hit of hits) {
    const probability = customNumber(hit.entry, ['probability'], 100);
    if (probability >= 100 || hit.entry.activation === 'always') {
      surviving.push(hit);
      continue;
    }
    const roll = stableRoll(`${hit.entry.id}:${seed}`);
    if (roll < probability) {
      surviving.push(hit);
    } else {
      misses.push({
        entry: hit.entry,
        lorebookName: hit.lorebookName,
        reason: `Matched, but did not pass its ${probability}% probability this turn.`,
      });
    }
  }

  // Groups are mutually exclusive: among entries sharing a group name, the
  // heaviest wins and the rest stand down. An entry marked as an override is
  // exempt, which is how an author pins one member of a group.
  const groupWinner = new Map<string, LoreHit>();
  const kept: LoreHit[] = [];
  for (const hit of surviving) {
    const group = customValue(hit.entry, ['group']);
    if (!group || customFlag(hit.entry, ['groupOverride'])) {
      kept.push(hit);
      continue;
    }
    const weight = customNumber(hit.entry, ['groupWeight'], 100);
    const current = groupWinner.get(group);
    if (!current || weight > customNumber(current.entry, ['groupWeight'], 100)) {
      if (current) {
        misses.push({
          entry: current.entry,
          lorebookName: current.lorebookName,
          reason: `Outweighed by another entry in group "${group}".`,
        });
      }
      groupWinner.set(group, hit);
    } else {
      misses.push({
        entry: hit.entry,
        lorebookName: hit.lorebookName,
        reason: `Outweighed by another entry in group "${group}".`,
      });
    }
  }
  for (const winner of groupWinner.values()) kept.push(winner);
  kept.sort(
    (a, b) =>
      LORE_TIER_RANK[b.tier] - LORE_TIER_RANK[a.tier] ||
      b.entry.priority - a.entry.priority ||
      a.entry.order - b.entry.order,
  );
  hits.length = 0;
  hits.push(...kept);

  if (input.maxEntries > 0 && hits.length > input.maxEntries) {
    for (const dropped of hits.slice(input.maxEntries)) {
      misses.push({
        entry: dropped.entry,
        lorebookName: dropped.lorebookName,
        reason: `Matched at ${dropped.tier} relevance, but exceeded the ${input.maxEntries}-entry lore limit (priority ${dropped.entry.priority}).`,
      });
    }
    return { hits: hits.slice(0, input.maxEntries), misses };
  }

  return { hits, misses };
}
