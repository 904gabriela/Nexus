/**
 * The scene as the story left it.
 *
 * `chat.scene` is the canonical base — what a person wrote down. It is never
 * written by anything in this file. A scene also moves on its own: they leave
 * the kitchen and step onto the rooftop, and the top of the prompt went on
 * saying "Kitchen" until someone noticed and retyped it.
 *
 * A SceneDelta records that movement beside the base. The effective scene is
 * the base with the visible, applied deltas replayed over it. Because
 * visibility is decided by whether the delta's source messages are on the
 * branch being played — the same rule already used for memories — a sibling
 * branch never inherits a change it did not live through, and switching
 * branches writes nothing at all.
 */

import type { ID, Message, SceneDelta, SceneState } from '../types';

/** The branch's messages, indexed once for both visibility and ordering. */
export interface VisibleMessages {
  ids: Set<ID>;
  orderOf: Map<ID, number>;
}

export function visibleMessagesOf(timeline: Message[]): VisibleMessages {
  const ids = new Set<ID>();
  const orderOf = new Map<ID, number>();
  for (const message of timeline) {
    ids.add(message.id);
    orderOf.set(message.id, message.order);
  }
  return { ids, orderOf };
}

/**
 * Where a delta sits in the replay.
 *
 * An exchange is several messages, so a delta is placed at its newest visible
 * one — the turn that finished establishing the change.
 */
function positionOf(delta: SceneDelta, visible: VisibleMessages): number {
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
 * Every source message must be visible: a delta read from an exchange the
 * branch only half has is a claim about events this timeline did not complete.
 */
export function applicableDeltas(
  deltas: SceneDelta[],
  visible: VisibleMessages,
): SceneDelta[] {
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

/**
 * Folds one delta's fields onto a scene.
 *
 * Scalars replace. `characterStates` merges by key and never by whole record,
 * because a delta that says Reiko sat down says nothing about Kenta's broken
 * arm — replacing the record would quietly forget him. An empty value removes
 * the entry, which is the convention Quick Settings already writes with.
 */
function merge(scene: SceneState, fields: Partial<SceneState>): SceneState {
  const next: SceneState = { ...scene };

  if (fields.location !== undefined) next.location = fields.location;
  if (fields.situation !== undefined) next.situation = fields.situation;
  if (fields.objective !== undefined) next.objective = fields.objective;
  if (fields.primaryCharacterId !== undefined) {
    next.primaryCharacterId = fields.primaryCharacterId;
  }
  if (fields.presentCharacterIds !== undefined) {
    next.presentCharacterIds = [...fields.presentCharacterIds];
  }

  if (fields.characterStates !== undefined) {
    const states = { ...next.characterStates };
    for (const [id, value] of Object.entries(fields.characterStates)) {
      if (String(value ?? '').trim()) states[id] = String(value).trim();
      else delete states[id];
    }
    next.characterStates = states;
  }

  // `updatedAt` is deliberately untouched: it means "when a person last edited
  // the base", and replaying is not a person editing anything.
  return next;
}

/**
 * The scene the model should be told about: the base, plus what the story did.
 *
 * Pure, deterministic, and it never mutates `base`.
 */
export function effectiveScene(
  base: SceneState,
  deltas: SceneDelta[],
  visible: VisibleMessages,
): SceneState {
  const applicable = applicableDeltas(deltas, visible);
  if (!applicable.length) return base;
  let scene = base;
  for (const delta of applicable) scene = merge(scene, delta.fields);
  return scene;
}

/* ------------------------------------------------------- user supersession */

/** Scene keys a delta can carry. */
const SCALAR_FIELDS = [
  'location',
  'situation',
  'objective',
  'primaryCharacterId',
] as const;

function sameArray(a: ID[] | undefined, b: ID[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * What a user's edit actually changed, compared with what they were shown.
 *
 * Quick Settings displays the effective scene and commits to the base, so a
 * field can come back byte-identical simply because the sheet was opened and
 * closed. Treating that as an edit would supersede every derived value the
 * moment anyone looked at it, so "changed" is decided here rather than by the
 * fact that a commit happened at all.
 */
export function changedSceneFields(
  shown: SceneState,
  written: Partial<SceneState>,
): { fields: Array<keyof SceneState>; characterKeys: ID[] } {
  const fields: Array<keyof SceneState> = [];
  const characterKeys: ID[] = [];

  for (const key of SCALAR_FIELDS) {
    if (written[key] !== undefined && written[key] !== shown[key]) fields.push(key);
  }
  if (
    written.presentCharacterIds !== undefined &&
    !sameArray(written.presentCharacterIds, shown.presentCharacterIds)
  ) {
    fields.push('presentCharacterIds');
  }
  if (written.characterStates !== undefined) {
    const before = shown.characterStates ?? {};
    const after = written.characterStates;
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if ((before[id] ?? '') !== (after[id] ?? '')) characterKeys.push(id);
    }
    if (characterKeys.length) fields.push('characterStates');
  }

  return { fields, characterKeys };
}

/**
 * Applied deltas a user's edit takes over from.
 *
 * Field-specific: writing a new location says nothing about who is in the room,
 * so a presence delta keeps applying. Superseding is not reversal — the user
 * did not undo the story, they wrote over one part of it — and the two are kept
 * apart because that is the difference the UI has to explain.
 */
export function supersededByEdit(
  deltas: SceneDelta[],
  changed: { fields: Array<keyof SceneState>; characterKeys: ID[] },
): SceneDelta[] {
  if (!changed.fields.length) return [];
  const touched = new Set(changed.fields);
  const keys = new Set(changed.characterKeys);

  return deltas.filter((delta) => {
    if (delta.status !== 'applied') return false;
    for (const key of Object.keys(delta.fields) as Array<keyof SceneState>) {
      if (!touched.has(key)) continue;
      if (key !== 'characterStates') return true;
      // Only the characters the user actually rewrote.
      const deltaKeys = Object.keys(delta.fields.characterStates ?? {});
      if (deltaKeys.some((id) => keys.has(id))) return true;
    }
    return false;
  });
}

/**
 * The delta each field's effective value currently comes from.
 *
 * A field with no entry is the user's own. This is how authorship is known:
 * from the applied history, rather than from a second set of flags on
 * SceneState that could disagree with it.
 */
export function derivedFields(
  deltas: SceneDelta[],
  visible: VisibleMessages,
): Map<string, SceneDelta> {
  const out = new Map<string, SceneDelta>();
  for (const delta of applicableDeltas(deltas, visible)) {
    for (const key of Object.keys(delta.fields)) {
      if (key !== 'characterStates') {
        out.set(key, delta);
        continue;
      }
      // Per character, so undoing Reiko's line does not claim Kenta's.
      for (const id of Object.keys(delta.fields.characterStates ?? {})) {
        out.set(`characterStates:${id}`, delta);
      }
    }
  }
  return out;
}

/** The values a delta is about to replace, for explaining and undoing it. */
export function previousFor(
  scene: SceneState,
  fields: Partial<SceneState>,
): Partial<SceneState> {
  const previous: Partial<SceneState> = {};
  for (const key of SCALAR_FIELDS) {
    if (fields[key] !== undefined) (previous as Record<string, unknown>)[key] = scene[key];
  }
  if (fields.presentCharacterIds !== undefined) {
    previous.presentCharacterIds = [...scene.presentCharacterIds];
  }
  if (fields.characterStates !== undefined) {
    const states: Record<ID, string> = {};
    for (const id of Object.keys(fields.characterStates)) {
      // An absent entry is recorded as empty, matching the convention `merge`
      // reads: restoring it means removing the key again.
      states[id] = scene.characterStates[id] ?? '';
    }
    previous.characterStates = states;
  }
  return previous;
}
