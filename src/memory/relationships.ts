/**
 * Where two people stand, as the story left it.
 *
 * `story.relationships` is the canonical, author-owned record and nothing here
 * writes it. It used to be written: a committed memory carrying a relationship
 * impact folded its change straight into that array, which made derived
 * knowledge indistinguishable from what the author wrote, carried a sibling
 * branch's falling-out onto a timeline that never had it, and left no way to
 * take any of it back — the old value survived only as a "(previously: …)"
 * clause inside a sentence.
 *
 * A RelationshipDelta records the change beside the base instead. The effective
 * standing is the base with the visible, applied deltas folded over it, decided
 * by whether the messages that established the change are on the branch being
 * played — the same rule memories and scene deltas already use. Switching
 * branches writes nothing at all.
 *
 * A relationship someone wrote by hand is never folded into. `manual` means
 * they settled it, and it is read here rather than stamped onto the deltas, so
 * deleting the manual row brings the story's own version back rather than
 * leaving it superseded by a row that no longer exists.
 *
 * For anything built on top of this: read `effectiveRelationships`, never
 * `story.relationships` and never the delta rows. Where two people stand is
 * already an answer about one timeline, and a layer that asks a narrower
 * question — what a particular character knows about where they stand — has to
 * start from the branch-resolved value or it inherits the same bug one storey
 * up.
 */

import type { ID, Memory, Relationship, RelationshipDelta } from '../types';
import type { VisibleMessages } from '../scene/delta';
import { newRelationshipDelta } from '../types/factories';
import { memoryBasis, memoryConfidence, memoryStatus } from './matrix';

/** Ends are stored in the order the extractor named them; a pair is unordered. */
export function samePair(a: [ID, ID], b: [ID, ID]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

function pairKey(ids: [ID, ID]): string {
  // Stringified rather than joined: an id is opaque, and a separator it could
  // contain would make two different pairs share a key.
  return JSON.stringify([...ids].sort());
}

/**
 * Where a delta sits in the replay: its newest visible source message, which
 * is the turn that finished establishing the change.
 */
function positionOf(delta: RelationshipDelta, visible: VisibleMessages): number {
  let latest = -1;
  for (const id of delta.sourceMessageIds) {
    const order = visible.orderOf.get(id);
    if (order !== undefined && order > latest) latest = order;
  }
  return latest;
}

/**
 * Deltas that actually apply here, oldest first.
 *
 * Every source message must be visible. A relationship impact is read from a
 * whole exchange and the extractor does not say which half of it carried the
 * change, so a branch that has only part of that exchange has only part of the
 * evidence — and dropping the change is the safe direction.
 */
export function applicableRelationshipDeltas(
  deltas: RelationshipDelta[],
  visible: VisibleMessages,
): RelationshipDelta[] {
  return deltas
    .filter(
      (delta) =>
        delta.status === 'applied' &&
        delta.sourceMessageIds.length > 0 &&
        delta.sourceMessageIds.every((id) => visible.ids.has(id)),
    )
    .sort(
      (a, b) =>
        positionOf(a, visible) - positionOf(b, visible) ||
        a.appliedAt - b.appliedAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

const PREVIOUSLY = ' (previously: ';

/**
 * The newest change leads and what was there is kept behind it.
 *
 * Folding oldest-first with the same operation the old destructive write used
 * means the sentence the model is given is the one it was always given — only
 * now it is computed from rows that can be undone rather than typed over the
 * author's record.
 */
function fold(summary: string, change: string): string {
  const before = summary.trim();
  return before ? `${change}${PREVIOUSLY}${before})` : change;
}

/** The newest change in a folded summary — where they stand now. */
function leadingClause(summary: string): string {
  const at = summary.indexOf(PREVIOUSLY);
  return (at === -1 ? summary : summary.slice(0, at)).trim();
}

/** The id an effective relationship carries when only the story ever said it. */
function derivedId(ids: [ID, ID]): string {
  return `derived:${[...ids].sort().join(':')}`;
}

/**
 * The standing the model should be told about: the base, plus what the story
 * did to it on this branch.
 *
 * Pure and deterministic, and it never mutates `base` or anything in it.
 */
export function effectiveRelationships(
  base: Relationship[] | null | undefined,
  deltas: RelationshipDelta[],
  visible: VisibleMessages,
): Relationship[] {
  const applicable = applicableRelationshipDeltas(deltas, visible);
  const rows = base ?? [];
  if (!applicable.length) return rows;

  const byPair = new Map<string, RelationshipDelta[]>();
  for (const delta of applicable) {
    const key = pairKey(delta.betweenIds);
    const list = byPair.get(key);
    if (list) list.push(delta);
    else byPair.set(key, [delta]);
  }

  const out: Relationship[] = [];
  const used = new Set<string>();

  for (const row of rows) {
    const key = Array.isArray(row.betweenIds) && row.betweenIds.length === 2
      ? pairKey(row.betweenIds)
      : '';
    // Nothing stops an author writing the same pair twice, and folding the
    // same change into both would say it twice in the prompt. The first row
    // wins, as it did when this was a single findIndex.
    const changes = key && !used.has(key) ? byPair.get(key) : undefined;
    used.add(key);
    // Hand-written, so it stands as written. The deltas keep applying to
    // nothing until the row is removed, at which point they are heard again.
    if (!changes || row.manual) {
      out.push(row);
      continue;
    }
    let summary = row.summary;
    let at = row.updatedAt;
    for (const delta of changes) {
      summary = fold(summary, delta.change);
      at = Math.max(at, delta.appliedAt);
    }
    out.push({ ...row, summary, updatedAt: at });
  }

  // Pairs the author never wrote down. The story said it, so it is said.
  for (const [key, changes] of byPair) {
    if (used.has(key)) continue;
    let summary = '';
    let at = 0;
    for (const delta of changes) {
      summary = fold(summary, delta.change);
      at = Math.max(at, delta.appliedAt);
    }
    out.push({
      id: derivedId(changes[0].betweenIds),
      betweenIds: changes[0].betweenIds,
      label: '',
      summary,
      manual: false,
      updatedAt: at,
    });
  }

  return out;
}

/**
 * Relationship changes carried by memories, as rows rather than as edits.
 *
 * A memory's own status decides the delta's: a proposal is not yet something
 * the story believes, so it is recorded and left inert until the person accepts
 * the memory. That is a change from the old write, which dropped uncommitted
 * impacts on the floor — accepting a memory by hand then never moved the
 * standing it was about.
 *
 * `standing` is the effective set as this branch currently sees it, and is
 * read for two reasons only: a pair the author wrote by hand is left alone
 * entirely, and a change that restates where they already stand is not a
 * change.
 */
export function relationshipDeltasFrom(
  memories: Memory[],
  scope: { chatId: ID; branchId: ID },
  standing: Relationship[],
): RelationshipDelta[] {
  const out: RelationshipDelta[] = [];

  for (const memory of memories) {
    const impact = memory.relationshipImpact;
    if (!impact) continue;
    // Provenance is what makes a delta resolvable at all; without it there is
    // no branch that could ever see this, so there is nothing to record.
    if (!memory.sourceMessageIds.length) continue;

    const existing = standing.find((row) => samePair(row.betweenIds, impact.betweenIds));
    if (existing?.manual) continue;
    // Compared against where they stand *now* rather than the whole folded
    // sentence: after two changes the summary carries its own history, and a
    // plain equality check would stop recognising a restatement and record the
    // same conclusion again every turn.
    if (leadingClause(existing?.summary ?? '') === impact.change.trim()) continue;

    out.push(
      newRelationshipDelta(scope.chatId, scope.branchId, impact.betweenIds, {
        change: impact.change,
        sourceMemoryId: memory.id,
        sourceMessageIds: [...memory.sourceMessageIds],
        basis: memoryBasis(memory),
        confidence: memoryConfidence(memory),
        status: memoryStatus(memory) === 'active' ? 'applied' : 'proposed',
      }),
    );
  }

  return out;
}

/**
 * The delta each effective standing currently ends on, keyed by the id of the
 * row `effectiveRelationships` returns.
 *
 * A pair with no entry is the author's own — either they wrote it by hand, or
 * nothing on this branch has moved it. This is how authorship is known: from
 * the applied history, rather than from a flag on the relationship that could
 * disagree with it.
 */
export function derivedRelationships(
  base: Relationship[] | null | undefined,
  deltas: RelationshipDelta[],
  visible: VisibleMessages,
): Map<ID, RelationshipDelta> {
  // The same rule `effectiveRelationships` folds by: when the author wrote a
  // pair twice, the first row is the one the story's changes land on, and its
  // own `manual` flag is the one that decides whether they land at all. Read
  // any other way, Undo would attach to a row that shows no change, or be
  // missing from the row that does.
  const first = new Map<string, Relationship>();
  for (const row of base ?? []) {
    if (!Array.isArray(row.betweenIds) || row.betweenIds.length !== 2) continue;
    const key = pairKey(row.betweenIds);
    if (!first.has(key)) first.set(key, row);
  }

  const out = new Map<ID, RelationshipDelta>();
  for (const delta of applicableRelationshipDeltas(deltas, visible)) {
    const key = pairKey(delta.betweenIds);
    const row = first.get(key);
    if (row?.manual) continue;
    out.set(row?.id ?? derivedId(delta.betweenIds), delta);
  }
  return out;
}
