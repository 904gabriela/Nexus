/**
 * The wider situation, and how people stand in it.
 *
 * Two blocks that sit between the scene and the story's static setup. The
 * scene says what is happening in this room this minute; the setup says what
 * was true before play began. Neither could say "they have been circling each
 * other for three chapters and neither has said it out loud", which is the
 * kind of fact a long roleplay runs on and the kind the model had no way to be
 * told.
 *
 * Both are deliberately narrow. Story state does not restate the scene and
 * does not list recent events — those are the chat and the memories, and a
 * second copy is a second thing that can be wrong. Relationships hold where
 * two people stand *now*, not the history of how they got there.
 */

import type { DiscoveredPerson, Relationship, StoryState } from '../types';

/** Anyone a relationship can be about: a cast member or the persona. */
export interface Participant {
  id: string;
  name: string;
}

export function describeStoryState(state: StoryState | null | undefined): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.arc.trim()) lines.push(`Arc: ${state.arc.trim()}`);
  if (state.time.trim()) lines.push(`Time: ${state.time.trim()}`);
  if (state.conflict.trim()) lines.push(`Active tension: ${state.conflict.trim()}`);
  if (state.objective.trim()) lines.push(`Working towards: ${state.objective.trim()}`);

  const threads = (state.threads ?? []).map((t) => t.trim()).filter(Boolean);
  if (threads.length) {
    lines.push('', 'Unresolved:', ...threads.map((t) => `- ${t}`));
  }

  if (!lines.length) return '';
  return ['## Where the story stands', ...lines].join('\n');
}

/**
 * Relationships worth sending: the ones between people in the room.
 *
 * A story can accumulate a relationship for every pair in its cast, and most
 * of them are irrelevant to the scene running now. Filtering to participants
 * who are actually present is the same discipline the cast already follows —
 * and it keeps the block from growing quadratically with the cast.
 */
export function relevantRelationships(
  relationships: Relationship[] | null | undefined,
  presentIds: Set<string>,
): Relationship[] {
  return (relationships ?? []).filter(
    (r) =>
      Array.isArray(r.betweenIds) &&
      r.betweenIds.length === 2 &&
      presentIds.has(r.betweenIds[0]) &&
      presentIds.has(r.betweenIds[1]) &&
      (r.label.trim() || r.summary.trim()),
  );
}

export function describeRelationships(
  relationships: Relationship[],
  participants: Participant[],
): string {
  if (!relationships.length) return '';
  const nameOf = new Map(participants.map((p) => [p.id, p.name]));

  const lines = relationships.map((r) => {
    const a = nameOf.get(r.betweenIds[0]) ?? 'Someone';
    const b = nameOf.get(r.betweenIds[1]) ?? 'someone';
    const label = r.label.trim();
    const summary = r.summary.trim();
    const head = label ? `${a} and ${b} — ${label}` : `${a} and ${b}`;
    return summary ? `- ${head}: ${summary}` : `- ${head}`;
  });

  return [
    '## How they stand',
    'Where these people are with each other as the scene opens. Play them from here ' +
      'rather than from nothing, and let the scene change them rather than restating them.',
    '',
    ...lines,
  ].join('\n');
}

/* ------------------------------------------------- people the story named */

/** How many named strangers are worth carrying. */
const MAX_DISCOVERED = 12;

/**
 * People the story has named who this branch has actually heard of.
 *
 * Automatic discovery notices a name, records where it was named, and offers
 * the person in the story's Cast tab. Until now that was the whole of it: the
 * model was never told, so the turn after Aizawa walked in it had no idea who
 * Aizawa was and invented him again — a different teacher every time, which is
 * exactly the discontinuity discovery exists to prevent.
 *
 * Filtered by the same rule the memories use, and for the same reason: a person
 * first named on a sibling branch was never named on this one. A row with no
 * provenance is kept — an imported or pre-provenance story is not evidence of
 * anything being off-branch.
 *
 * Dismissed people are left out. The author said they were not worth keeping,
 * and that answer should not be quietly ignored in the prompt.
 */
export function relevantDiscovered(
  people: DiscoveredPerson[] | null | undefined,
  visibleMessageIds: Set<string>,
): DiscoveredPerson[] {
  return (people ?? [])
    .filter((person) => {
      if (person.dismissed || !person.name.trim()) return false;
      const sources = person.sourceMessageIds ?? [];
      if (!sources.length) return true;
      return sources.some((id) => visibleMessageIds.has(id));
    })
    .slice(-MAX_DISCOVERED);
}

/**
 * A line each, and an instruction not to fill in the rest.
 *
 * The danger of naming someone the model knows nothing about is that it
 * cheerfully invents a biography. So the block says what the story said and
 * explicitly refuses the gap — this is a reminder that a person exists, not a
 * character sheet.
 */
export function describeDiscovered(people: DiscoveredPerson[]): string {
  if (!people.length) return '';
  const lines = people.map((person) => {
    const note = person.note.trim();
    return note ? `- ${person.name.trim()}: ${note}` : `- ${person.name.trim()}`;
  });

  return [
    '## People the story has named',
    'Mentioned already, but not part of the cast and not described anywhere. Keep them ' +
      'consistent with what is said here, and do not invent a history for them.',
    '',
    ...lines,
  ].join('\n');
}
