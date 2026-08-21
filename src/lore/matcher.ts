/**
 * Lorebook retrieval.
 *
 * Every entry is evaluated independently against the scan window. This is the
 * single implementation used by both the context compiler and the Lorebook
 * Tester, so what the tester shows is exactly what the AI receives.
 */

import type { ID, LoreEntry, LoreHit, LoreMiss, Lorebook } from '../types';
import { escapeRegExp } from '../utils/text';

export interface LoreScanScope {
  /** Where the lookup is happening — gates `story-only`/`chat-only` entries. */
  source: 'story' | 'chat' | 'character' | 'test';
  /** Lorebook ids attached at each level, used for attribution + gating. */
  storyLorebookIds: ID[];
  chatLorebookIds: ID[];
  characterLorebookIds: ID[];
}

export interface LoreScanInput {
  /** Newest-last list of recent message texts. */
  recentTexts: string[];
  /** Extra always-scanned text: scenario, persona, character summaries. */
  ambientText?: string;
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

function scopeAllows(entry: LoreEntry, scope: LoreScanScope, attachedVia: string[]): boolean {
  switch (entry.activation) {
    case 'story-only':
      return scope.source === 'story' || scope.source === 'test' || attachedVia.includes('story');
    case 'chat-only':
      return scope.source === 'chat' || scope.source === 'test' || attachedVia.includes('chat');
    case 'character-only':
      return attachedVia.includes('character') || scope.source === 'test';
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

export function scanLore(input: LoreScanInput): LoreScanResult {
  const { entries, lorebooks, scope } = input;
  const bookById = new Map(lorebooks.map((b) => [b.id, b]));
  const hits: LoreHit[] = [];
  const misses: LoreMiss[] = [];

  const ambient = input.ambientText ?? '';

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
    if (!scopeAllows(entry, scope, via)) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `Activation is "${entry.activation}" but this lookup came from "${scope.source}".`,
      });
      continue;
    }

    if (entry.activation === 'always') {
      hits.push({
        entry,
        lorebookName: bookName,
        matched: [],
        reason: `Always active (attached via ${via.join(', ')}).`,
      });
      continue;
    }

    const depth = entry.scanDepth || book.scanDepth || input.defaultScanDepth;
    const window = depth > 0 ? input.recentTexts.slice(-depth) : input.recentTexts;
    const haystack = [...window, ambient].filter(Boolean).join('\n');

    if (!haystack.trim()) {
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

    const matchedPrimary = matchTerms(primaryTerms, entry, haystack);
    if (!matchedPrimary.length) {
      misses.push({
        entry,
        lorebookName: bookName,
        reason: `No keyword matched in the last ${window.length} message(s).`,
      });
      continue;
    }

    if (entry.secondaryKeys.length) {
      const matchedSecondary = matchTerms(entry.secondaryKeys, entry, haystack);
      if (!matchedSecondary.length) {
        misses.push({
          entry,
          lorebookName: bookName,
          reason: `Primary keyword "${matchedPrimary[0]}" matched, but no secondary keyword did.`,
        });
        continue;
      }
      hits.push({
        entry,
        lorebookName: bookName,
        matched: [...matchedPrimary, ...matchedSecondary],
        reason: `Keywords matched: ${[...matchedPrimary, ...matchedSecondary].join(', ')}`,
      });
      continue;
    }

    hits.push({
      entry,
      lorebookName: bookName,
      matched: matchedPrimary,
      reason: `Keyword matched: ${matchedPrimary.join(', ')}`,
    });
  }

  hits.sort((a, b) => b.entry.priority - a.entry.priority || a.entry.order - b.entry.order);

  if (input.maxEntries > 0 && hits.length > input.maxEntries) {
    for (const dropped of hits.slice(input.maxEntries)) {
      misses.push({
        entry: dropped.entry,
        lorebookName: dropped.lorebookName,
        reason: `Matched, but exceeded the ${input.maxEntries}-entry lore limit (priority ${dropped.entry.priority}).`,
      });
    }
    return { hits: hits.slice(0, input.maxEntries), misses };
  }

  return { hits, misses };
}
