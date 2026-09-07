/**
 * Which memories the scene actually needs.
 *
 * Memories used to be ranked by pinned → importance → recency and nothing
 * else, which is blind to what is happening: a memory about someone who is not
 * in the room outranked one about exactly the moment being played, purely for
 * being newer. With a handful of memories that is survivable; with a thousand
 * it means the prompt is full of the wrong ones.
 *
 * Lore already solved this with relevance tiers, so memories use the same
 * vocabulary rather than a second one. A memory is scene-relevant if it is
 * about someone in the room or something just said; recent if it surfaced in
 * the last few turns; story-relevant if it belongs to this story at all; and
 * background otherwise.
 *
 * Matching is deliberately narrow. A memory's *content* is prose, and matching
 * on prose matches everything — so the terms come from its title, its tags, its
 * subjects and the characters it names. Those are the parts someone chose; the
 * body is where they wrote freely.
 */

import type { ID, Memory } from '../types';
import { isUsable, memorySubjects } from './matrix';

export type MemoryTier =
  /** About someone in the room, or something in the current message. */
  | 'scene'
  /** Surfaced in the last few turns. */
  | 'recent'
  /** Belongs to this story, but nothing in the scene touched it. */
  | 'story'
  /** From elsewhere, or unattached. */
  | 'background';

export const MEMORY_TIER_RANK: Record<MemoryTier, number> = {
  scene: 4,
  recent: 3,
  story: 2,
  background: 1,
};

const IMPORTANCE_RANK: Record<Memory['importance'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export interface RankedMemory {
  memory: Memory;
  tier: MemoryTier;
  /** Ordering key. Higher wins. */
  score: number;
  /** Why this one, in the Inspector's words. */
  reason: string;
  /** The terms that put it in its tier, if any. */
  matched: string[];
}

export interface RankMemoriesInput {
  memories: Memory[];
  /** The story being played, if any. */
  storyId: ID | null;
  /** Characters physically in the scene. */
  presentCharacterIds: ID[];
  /** Location, situation and the names of who is present. */
  sceneText: string;
  /** The turn being answered. */
  currentText: string;
  /** The last few turns, already joined. */
  recentText: string;
  /** How many to admit. */
  limit: number;
}

/** Terms worth matching on: the title, tags and subjects, nothing from the body. */
function termsOf(memory: Memory): string[] {
  const fromTitle = memory.title
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 3);
  const fromTags = (memory.tags ?? []).map((t) => t.trim()).filter(Boolean);
  // Subjects are the matrix's most useful output for retrieval: they name who
  // the memory is about even when no character record exists for them.
  const fromSubjects = memorySubjects(memory);
  return [
    ...new Set([...fromTitle, ...fromTags, ...fromSubjects].map((t) => t.toLowerCase())),
  ];
}

function mentions(haystack: string, terms: string[]): string[] {
  if (!haystack.trim() || !terms.length) return [];
  const lower = haystack.toLowerCase();
  // Word-boundary matching, so "ash" does not fire on "Ashfell". The terms are
  // user-authored, so they are escaped rather than trusted as patterns.
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(lower);
  });
}

/**
 * Ranks and cuts to `limit`.
 *
 * Pinning is a strong retrieval boost, not an exemption: a pinned memory is
 * treated as scene-relevant so it competes at the top, but it still competes.
 * Guaranteeing inclusion regardless of budget is how one pinned memory ends up
 * displacing the scene it was pinned to serve.
 */
export function rankMemories(input: RankMemoriesInput): RankedMemory[] {
  const present = new Set(input.presentCharacterIds);

  const ranked = input.memories
    .filter((memory) => memory.content.trim())
    // A memory waiting for review, or one a later memory replaced, is not
    // something the story knows yet. Ranking is where that line is enforced,
    // so no caller can forget it.
    .filter(isUsable)
    .map((memory): RankedMemory => {
      const terms = termsOf(memory);
      const aboutSomeoneHere = (memory.characterIds ?? []).some((id) => present.has(id));
      const inCurrent = mentions(input.currentText, terms);
      const inScene = mentions(input.sceneText, terms);
      const inRecent = mentions(input.recentText, terms);
      const thisStory = Boolean(input.storyId) && memory.sourceStoryId === input.storyId;

      let tier: MemoryTier;
      let matched: string[] = [];
      let reason: string;

      if (memory.pinned) {
        tier = 'scene';
        reason = 'Pinned — always ranked with the scene.';
      } else if (aboutSomeoneHere) {
        tier = 'scene';
        reason = 'About someone in the scene.';
      } else if (inCurrent.length || inScene.length) {
        tier = 'scene';
        matched = [...new Set([...inCurrent, ...inScene])];
        reason = `Matched: ${matched.join(', ')} (in the current scene or message).`;
      } else if (inRecent.length) {
        tier = 'recent';
        matched = inRecent;
        reason = `Matched: ${matched.join(', ')} (in the last few turns).`;
      } else if (thisStory) {
        tier = 'story';
        reason = 'Belongs to this story.';
      } else {
        tier = 'background';
        reason = 'Background — nothing in the scene touched it.';
      }

      // Tier decides first, then how much the memory matters, then recency.
      // The bands are wide enough that importance can never lift a background
      // memory over a scene-relevant one.
      const score =
        MEMORY_TIER_RANK[tier] * 1000 +
        IMPORTANCE_RANK[memory.importance] * 100 +
        (memory.pinned ? 50 : 0);

      return { memory, tier, score, reason, matched };
    });

  ranked.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
  return ranked.slice(0, Math.max(0, input.limit));
}
