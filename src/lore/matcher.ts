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
  /**
   * Every message on the timeline being played, oldest first, when the caller
   * has them. Read only by entries with `sticky` or `cooldown`, which have to
   * know when the entry last fired — and that is decided by the whole history,
   * not by the scan window. Absent falls back to the scan window.
   */
  timelineTexts?: string[];
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

/** What sticky and cooldown say about this entry on the newest message. */
interface TimingVerdict {
  /**
   * `fires`: matched now and allowed to speak. `sticky`: not matched now but
   * still held open by an earlier firing. `resting`: matched now, but it fired
   * too recently. `silent`: nothing to say either way — the ordinary verdict
   * stands.
   */
  kind: 'fires' | 'sticky' | 'resting' | 'silent';
  /** Messages since the firing that decides this. */
  ago: number;
  /** For `resting`: how many more messages it has to sit out. */
  left: number;
}

/**
 * Replays the entry's firings over the timeline to find out whether it may
 * speak now.
 *
 * Sticky and cooldown are both measured from when the entry last *fired*, and
 * an entry fires when its keywords are in the scan window and it is not
 * already resting. So the answer depends on the whole history: a keyword said
 * on every message fires once, holds for `sticky`, rests for `cooldown`, and
 * fires again — the rhythm cooldown exists to impose. Reading only the last
 * few messages cannot see that rhythm; it sees the same shape every turn and
 * gives the same answer every turn, which for a common keyword is "resting",
 * forever.
 *
 * Deliberately derived from the text rather than from a record of what fired
 * before. It costs no store and no writes, cannot drift out of step with the
 * conversation, and inherits branch correctness for nothing: a branch where
 * the keyword was never said has, correctly, never triggered the entry. The
 * approximation is that a mention counts as firing on the message that
 * carries it, whether or not that turn's prompt actually had room for it.
 *
 * A firing has to pass the entry's own secondary keys as well. Without that,
 * stickiness would revive an entry on the strength of a mention that never
 * qualified it in the first place.
 */
function timingVerdict(
  entry: LoreEntry,
  timeline: string[],
  ambient: string,
  depth: number,
  matchedNow: boolean,
  timing: { sticky: number; cooldown: number },
): TimingVerdict {
  const now = timeline.length - 1;
  if (now < 0) return { kind: matchedNow ? 'fires' : 'silent', ago: 0, left: 0 };

  // Matchers are built once for the whole replay rather than once per message.
  const primary = [...entry.primaryKeys, ...entry.aliases]
    .map((term) => buildMatcher(term, entry))
    .filter((m): m is Matcher => m !== null);
  const secondary = entry.secondaryKeys
    .map((term) => buildMatcher(term, entry))
    .filter((m): m is Matcher => m !== null);
  const any = (matchers: Matcher[], text: string) => matchers.some((m) => m.test(text));

  const ambientPrimary = !!ambient && any(primary, ambient);
  const ambientSecondary = !!ambient && !!secondary.length && any(secondary, ambient);
  const span = depth > 0 ? depth : Number.POSITIVE_INFINITY;

  let lastPrimary = Number.NEGATIVE_INFINITY;
  let lastSecondary = Number.NEGATIVE_INFINITY;
  let lastFire = -1;
  let stickyUntil = -1;
  let coolUntil = -1;

  for (let i = 0; i <= now; i += 1) {
    if (any(primary, timeline[i])) lastPrimary = i;
    if (secondary.length && any(secondary, timeline[i])) lastSecondary = i;

    let matched: boolean;
    if (i === now) {
      // The newest message is judged by the live scan, which also sees the
      // text being typed and the names in the scene.
      matched = matchedNow;
    } else {
      const primaryOk = ambientPrimary || i - lastPrimary < span;
      const secondaryOk = !secondary.length || ambientSecondary || i - lastSecondary < span;
      matched = primaryOk && secondaryOk;
    }

    if (matched && i > coolUntil) {
      lastFire = i;
      stickyUntil = i + timing.sticky;
      coolUntil = stickyUntil + timing.cooldown;
    }
  }

  const ago = lastFire < 0 ? 0 : now - lastFire;
  if (lastFire === now) return { kind: 'fires', ago: 0, left: 0 };
  if (now <= stickyUntil) return { kind: matchedNow ? 'fires' : 'sticky', ago, left: 0 };
  if (matchedNow && now <= coolUntil) return { kind: 'resting', ago, left: coolUntil - now };
  return { kind: 'silent', ago, left: 0 };
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
    //
    // The tester pastes one piece of text and has no story behind it, so it
    // has no length to measure; it judges the entry as though the story were
    // already long enough, and says so on its panel.
    const storyLength = input.messageCount ?? input.recentTexts.length;
    if (timing.delay > 0 && scope.source !== 'test' && storyLength < timing.delay) {
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

    // Secondary keys gate on the whole window: they qualify the match rather
    // than locating it. The window is only joined for an entry that has them
    // and has something to qualify — a large book is mostly entries with
    // neither, and they must not pay for it.
    const matchedSecondary =
      winner && entry.secondaryKeys.length
        ? matchTerms(
            entry.secondaryKeys,
            entry,
            [...window, ambient, input.currentText ?? ''].filter(Boolean).join('\n'),
          )
        : [];
    const qualified = !!winner && (!entry.secondaryKeys.length || matchedSecondary.length > 0);

    // Only replayed when the entry asks for it, so a worldbook of thousands
    // of ordinary entries pays nothing for a feature it does not use.
    if (timing.sticky > 0 || timing.cooldown > 0) {
      const verdict = timingVerdict(
        entry,
        input.timelineTexts ?? input.recentTexts,
        ambient,
        depth,
        qualified,
        timing,
      );
      // Nothing matched now, but it fired recently and was asked to stay. This
      // is what stops a location dropping out of the prompt between mentions
      // and the scene quietly losing its footing.
      if (verdict.kind === 'sticky') {
        hits.push({
          entry,
          lorebookName: bookName,
          matched: [],
          reason: `Still active: it fired ${verdict.ago} message(s) ago and stays for ${timing.sticky}.`,
          tier: 'recent',
        });
        continue;
      }
      // It matched, but it has only just been sent. A common keyword that
      // re-triggers every single turn is how one entry crowds a large worldbook
      // out of its own context.
      if (verdict.kind === 'resting') {
        misses.push({
          entry,
          lorebookName: bookName,
          reason: `Matched, but resting: it fired ${verdict.ago} message(s) ago and sits out ${verdict.left} more.`,
        });
        continue;
      }
      // `fires` and `silent` are the ordinary verdict, reached below.
    }

    if (!winner) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `No keyword matched in the last ${window.length} message(s).`,
      });
      continue;
    }

    if (!qualified) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `Primary keyword "${winner.matched[0]}" matched, but no secondary keyword did.`,
      });
      continue;
    }

    const matched = [...winner.matched, ...matchedSecondary];
    hits.push({
      entry,
      lorebookName: bookName,
      matched,
      reason: winner.band.describe(matched),
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
