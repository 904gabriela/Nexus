/**
 * Timeline resolution for branched chats.
 *
 * Branching never copies messages. A branch records where it forked from, and
 * the timeline for a branch is assembled by walking its ancestry: from each
 * ancestor we take only the messages that existed at the moment the next branch
 * in the chain forked. The original timeline is therefore never mutated.
 *
 *   Main:   m1 m2 m3 m4 m5
 *                 ^ fork
 *   Alt:    (m1 m2 m3 inherited) a1 a2
 */

import type { Branch, ID, Message } from '../types';

export interface BranchNode extends Branch {
  children: BranchNode[];
  depth: number;
  messageCount: number;
}

/** Root-first chain of branches from the root to `branchId`, inclusive. */
export function branchChain(branches: Branch[], branchId: ID): Branch[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const chain: Branch[] = [];
  const seen = new Set<ID>();
  let current = byId.get(branchId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentBranchId ? byId.get(current.parentBranchId) : undefined;
  }
  return chain;
}

/**
 * Resolves the visible, ordered message list for a branch.
 * `messages` may be the whole chat; filtering happens here.
 */
export function resolveTimeline(
  messages: Message[],
  branches: Branch[],
  branchId: ID,
): Message[] {
  const chain = branchChain(branches, branchId);
  if (!chain.length) return [];

  const byBranch = new Map<ID, Message[]>();
  for (const message of messages) {
    const list = byBranch.get(message.branchId);
    if (list) list.push(message);
    else byBranch.set(message.branchId, [message]);
  }

  const timeline: Message[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const branch = chain[i];
    const next = chain[i + 1];
    // Messages from this branch are visible up to the point the child forked.
    const cutoff = next ? next.forkOrder : Number.MAX_SAFE_INTEGER;
    const own = byBranch.get(branch.id) ?? [];
    for (const message of own) {
      if (message.order <= cutoff) timeline.push(message);
    }
  }

  timeline.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return timeline;
}

/** Builds the branch forest for display. */
export function buildBranchTree(branches: Branch[], messages: Message[]): BranchNode[] {
  const counts = new Map<ID, number>();
  for (const message of messages) {
    counts.set(message.branchId, (counts.get(message.branchId) ?? 0) + 1);
  }
  const nodes = new Map<ID, BranchNode>(
    branches.map((b) => [b.id, { ...b, children: [], depth: 0, messageCount: counts.get(b.id) ?? 0 }]),
  );
  const roots: BranchNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentBranchId ? nodes.get(node.parentBranchId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const assignDepth = (node: BranchNode, depth: number) => {
    node.depth = depth;
    node.children.sort((a, b) => a.createdAt - b.createdAt);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort((a, b) => a.createdAt - b.createdAt);
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

export function flattenBranchTree(roots: BranchNode[]): BranchNode[] {
  const out: BranchNode[] = [];
  const walk = (node: BranchNode) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** Ids of a branch and everything descended from it. */
export function descendantBranchIds(branches: Branch[], branchId: ID): ID[] {
  const childrenOf = new Map<ID, ID[]>();
  for (const branch of branches) {
    if (!branch.parentBranchId) continue;
    const list = childrenOf.get(branch.parentBranchId);
    if (list) list.push(branch.id);
    else childrenOf.set(branch.parentBranchId, [branch.id]);
  }
  const out: ID[] = [];
  const stack = [branchId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

/**
 * Messages that a branch owns outright (safe to delete with the branch).
 * Messages inherited from an ancestor are never touched.
 */
export function ownedMessageIds(messages: Message[], branchIds: ID[]): ID[] {
  const set = new Set(branchIds);
  return messages.filter((m) => set.has(m.branchId)).map((m) => m.id);
}
