/**
 * Who knows of what, on the timeline being played.
 *
 * A KnowledgeEdge answers a different question from everything under it. The
 * memory layer says what the story established; the relationship layer says
 * where two people stand. Neither says whether a particular character has heard
 * any of it, and a roleplay engine that cannot tell those apart has every
 * character react to a secret the moment it is written down.
 *
 * Three rules hold this together, and each of them is a refusal:
 *
 * Knowing of is not believing, and neither is truth. An edge records access to
 * a claim — Sera told Ryu the warehouse burned — and says nothing about whether
 * it burned, whether Sera thinks it did, or whether she was lying. The memory
 * extractor already refuses this conflation for `stated` memories; this is the
 * same refusal one storey up.
 *
 * Nothing propagates. `toldById` is communication provenance and is never
 * walked: Sera telling Ryu something creates one edge, for Ryu. If Sera knows
 * it too, that is a separate edge with its own evidence. There is deliberately
 * no function here that could traverse a chain, because the moment one exists
 * someone will call it and the store will fill with knowledge nobody recorded.
 *
 * Absence is not denial. No edge means nothing is tracked — never that the
 * character does not know. There is no negative-knowledge system, and reading
 * silence as denial would make every story written before this feature
 * suddenly amnesiac.
 *
 * This layer reads the resolved state above it and annotates: it writes nothing
 * to the canonical story, and in this version it reaches no prompt at all.
 */

import type {
  ID,
  KnowledgeAnnotation,
  KnowledgeEdge,
  KnowledgeSubject,
  Memory,
  Relationship,
  ResolvedKnowledge,
} from '../types';
import type { VisibleMessages } from '../scene/delta';
import { memoryBasis, memoryConfidence } from './matrix';
import { samePair } from './relationships';

/**
 * A subject's identity, for grouping.
 *
 * A relationship is keyed by its pair and never by the id of the row that
 * currently describes it: `effectiveRelationships` gives a pair one id when the
 * author has written it down and a synthesised one when only the story has, so
 * removing a hand-written standing changes it. The pair does not change.
 */
function subjectKey(subject: KnowledgeSubject): string {
  return subject.kind === 'memory'
    ? `memory:${subject.id}`
    : `relationship:${JSON.stringify([...subject.betweenIds].sort())}`;
}

/** Where an edge sits in the replay: its newest visible source message. */
function positionOf(edge: { sourceMessageIds: ID[] }, visible: VisibleMessages): number {
  let latest = -1;
  for (const id of edge.sourceMessageIds) {
    const order = visible.orderOf.get(id);
    if (order !== undefined && order > latest) latest = order;
  }
  return latest;
}

/**
 * `toldById` means something only for `told`.
 *
 * Normalised on the way out rather than by rewriting the row: a record that
 * carries a stray value is not corrupt, it is just over-specified, and
 * destroying stored data to enforce a display rule is a bad trade.
 */
function toldBy(edge: { basis: KnowledgeEdge['basis']; toldById: ID | null }): ID | null {
  return edge.basis === 'told' ? (edge.toldById ?? null) : null;
}

/**
 * Edges that actually apply here, oldest first.
 *
 * Every source message must be visible. An edge read from an exchange the
 * branch only half has is an attribution resting on evidence this timeline
 * never completed, and the safe direction is to drop it. Note this is stricter
 * than the rule for memories themselves, which need only one visible source —
 * so a branch cut mid-exchange can carry a memory whose knowledge is untracked.
 * That asymmetry is deliberate: a memory in context is a fact the story may use,
 * and an attribution is a claim about a person.
 */
export function applicableEdges(
  edges: KnowledgeEdge[],
  visible: VisibleMessages,
): KnowledgeEdge[] {
  return edges
    .filter(
      (edge) =>
        edge.status === 'applied' &&
        edge.sourceMessageIds.length > 0 &&
        edge.sourceMessageIds.every((id) => visible.ids.has(id)),
    )
    .sort(
      (a, b) =>
        positionOf(a, visible) - positionOf(b, visible) ||
        a.appliedAt - b.appliedAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The edges a memory's own `statedById` already implies.
 *
 * A character who said something has access to what they said. That is already
 * recorded — the memory extractor resolves the claimant by name and stores it —
 * so materialising a row per memory would be a migration whose only purpose is
 * to copy information the database already holds, and which would drift the
 * moment someone edited or deleted the memory. Derived at read time it stays
 * correct for nothing.
 *
 * It carries no branch: a Memory records `sourceChatId` and no branch id, so
 * there is no branch of origin to report and `null` says so rather than
 * inventing one. Visibility still comes from the messages, which is what
 * decides the answer anyway.
 *
 * `stated` is emphatically not belief. Ryu asserting that Kenta betrayed Sera
 * is Ryu holding that claim; it is not Nexus agreeing.
 */
export function derivedStatementEdges(
  memories: Memory[],
  visible: VisibleMessages,
): ResolvedKnowledge[] {
  const out: ResolvedKnowledge[] = [];
  for (const memory of memories) {
    if (memoryBasis(memory) !== 'stated') continue;
    const knowerId = memory.statedById;
    if (!knowerId) continue;
    const sources = memory.sourceMessageIds ?? [];
    if (!sources.length || !sources.every((id) => visible.ids.has(id))) continue;

    out.push({
      id: `derived:${memory.id}:${knowerId}`,
      knowerId,
      subject: { kind: 'memory', id: memory.id },
      basis: 'stated',
      toldById: null,
      sourceMessageIds: [...sources],
      confidence: memoryConfidence(memory),
      branchId: null,
      derived: true,
    });
  }
  return out;
}

/**
 * Everything this branch has recorded about who knows of what.
 *
 * Stored edges and read-time derivations come back as one list. Pure: it reads
 * canonical and resolved state and writes nothing.
 */
export function resolveKnowledge(
  edges: KnowledgeEdge[],
  memories: Memory[],
  visible: VisibleMessages,
): ResolvedKnowledge[] {
  const stored: ResolvedKnowledge[] = applicableEdges(edges, visible).map((edge) => ({
    id: edge.id,
    knowerId: edge.knowerId,
    subject: edge.subject,
    basis: edge.basis,
    toldById: toldBy(edge),
    sourceMessageIds: [...edge.sourceMessageIds],
    confidence: edge.confidence,
    branchId: edge.branchId,
    derived: false,
  }));
  return [...stored, ...derivedStatementEdges(memories, visible)];
}

/**
 * One entry per subject anyone is recorded as knowing of, for the inspector.
 *
 * Built from the edges rather than from the story, so a subject survives what
 * it is about going quiet. A relationship standing that has been taken back
 * still leaves people who heard about it — their knowledge was not undone by
 * the standing being undone — and that shows as `unresolved` rather than
 * disappearing, which would be indistinguishable from no edge existing. It
 * comes back on its own if the pair stands again.
 */
export function knowledgeAnnotations(
  resolved: ResolvedKnowledge[],
  context: {
    memories: Memory[];
    relationships: Relationship[];
    nameOf: (id: ID) => string;
  },
): KnowledgeAnnotation[] {
  const grouped = new Map<string, ResolvedKnowledge[]>();
  for (const entry of resolved) {
    const key = subjectKey(entry.subject);
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }

  const out: KnowledgeAnnotation[] = [];

  for (const knowers of grouped.values()) {
    const subject = knowers[0].subject;
    const named = knowers.map((knower) => ({
      knower,
      knowerName: context.nameOf(knower.knowerId),
      toldByName: knower.toldById ? context.nameOf(knower.toldById) : null,
    }));

    if (subject.kind === 'memory') {
      const memory = context.memories.find((m) => m.id === subject.id);
      out.push({
        subject,
        label: memory?.title || 'A memory that is no longer here',
        unresolved: !memory,
        knowers: named,
      });
      continue;
    }

    const standing = context.relationships.find(
      (r) =>
        Array.isArray(r.betweenIds) &&
        r.betweenIds.length === 2 &&
        samePair(r.betweenIds, subject.betweenIds),
    );
    // Named in the order the standing itself uses, so the same pair reads the
    // same here as everywhere else. A subject keeps whatever order the sentence
    // it was read from happened to use, and that is not a display decision.
    const ends = standing?.betweenIds ?? subject.betweenIds;
    out.push({
      subject,
      label: `${context.nameOf(ends[0])} and ${context.nameOf(ends[1])}`,
      unresolved: !standing,
      knowers: named,
    });
  }

  return out;
}
