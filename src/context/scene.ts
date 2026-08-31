/**
 * Who is actually in the room.
 *
 * The compiler used to hand the model a cast list under the heading "The
 * following characters are present in this scene", which made availability and
 * presence the same claim. Combined with lore that fires on any name appearing
 * anywhere in history, that is how a character mentioned once in a pasted
 * transcript ended up stepping out of the shadows and speaking.
 *
 * Presence is therefore resolved from stated scene state, never from name
 * occurrences. When a chat has never declared its scene, the answer is the
 * focal character alone — not the whole cast, because "we don't know" must
 * never widen into "everyone".
 */

import type { Character, ID, SceneState } from '../types';

export interface ResolvedScene {
  location: string;
  situation: string;
  objective: string;
  /** Characters physically in the scene, primary first. */
  present: Character[];
  /** Cast members who exist in this story but are not in the scene. */
  available: Character[];
  /** The focal NPC. Always also present. */
  primary: Character | null;
  /** Scene-local state, only for characters actually present. */
  states: Array<{ character: Character; state: string }>;
  /** True when the scene was explicitly declared rather than inferred. */
  declared: boolean;
}

export function resolveScene(input: {
  scene: SceneState | null | undefined;
  /** The story's cast, already resolved to characters. */
  cast: Character[];
  /** Explicit override for who is replying, e.g. a per-message pick. */
  respondingCharacterId?: ID | null;
}): ResolvedScene {
  const cast = input.cast.filter(Boolean);
  const scene = input.scene ?? null;
  const byId = new Map(cast.map((c) => [c.id, c]));

  const declaredIds = (scene?.presentCharacterIds ?? []).filter((id) => byId.has(id));
  const declared = declaredIds.length > 0;

  // A declared primary only counts if that character is in the cast.
  const declaredPrimary =
    (scene?.primaryCharacterId && byId.get(scene.primaryCharacterId)) || null;

  let present: Character[];
  if (declared) {
    present = declaredIds.map((id) => byId.get(id)!);
  } else if (declaredPrimary) {
    present = [declaredPrimary];
  } else {
    // Nothing stated at all: the first cast member is the scene, which is what
    // a one-character chat means and the safest reading of a multi-character
    // story that has not yet said where it is.
    present = cast.slice(0, 1);
  }

  // Whoever is being asked to reply must be in the scene to speak in it.
  const requested = input.respondingCharacterId
    ? byId.get(input.respondingCharacterId) ?? null
    : null;
  if (requested && !present.some((c) => c.id === requested.id)) {
    present = [requested, ...present];
  }

  const primary =
    requested ??
    (declaredPrimary && present.some((c) => c.id === declaredPrimary.id)
      ? declaredPrimary
      : present[0] ?? null);

  // Primary leads the list: it is the default speaker, and ordering makes that
  // legible without another sentence of instruction.
  const ordered = primary
    ? [primary, ...present.filter((c) => c.id !== primary.id)]
    : present;

  const presentIds = new Set(ordered.map((c) => c.id));
  const available = cast.filter((c) => !presentIds.has(c.id));

  const states = Object.entries(scene?.characterStates ?? {})
    .filter(([id, state]) => presentIds.has(id) && String(state).trim())
    .map(([id, state]) => ({ character: byId.get(id)!, state: String(state).trim() }));

  return {
    location: scene?.location?.trim() ?? '',
    situation: scene?.situation?.trim() ?? '',
    objective: scene?.objective?.trim() ?? '',
    present: ordered,
    available,
    primary,
    states,
    declared,
  };
}

const nameOf = (c: Character) => c.displayName || c.name;

/**
 * The scene block, as the model sees it.
 *
 * Deliberately terse. The fix for characters wandering in was never more
 * prose — it was saying exactly once, in a place that cannot be trimmed, which
 * names are in the room and that every other name is not.
 */
export function describeScene(scene: ResolvedScene, personaName: string): string {
  const lines: string[] = ['## Current scene'];

  if (scene.location) lines.push(`Location: ${scene.location}`);
  if (scene.situation) lines.push(`Situation: ${scene.situation}`);
  if (scene.objective) lines.push(`Right now: ${scene.objective}`);

  const present = [personaName, ...scene.present.map(nameOf)];
  lines.push('', `Present: ${present.join(', ')}`);

  if (scene.states.length) {
    lines.push(
      ...scene.states.map(({ character, state }) => `- ${nameOf(character)}: ${state}`),
    );
  }

  if (scene.available.length) {
    lines.push(
      '',
      `Elsewhere in this world, not in the scene: ${scene.available.map(nameOf).join(', ')}`,
    );
  }

  lines.push(
    '',
    `Only the characters listed as present are in this scene. Every other name — ` +
      `in the cast, in the lore, or mentioned anywhere in the history — is absent: ` +
      `do not give them dialogue, actions, or reactions unless the story brings them in first.`,
  );

  return lines.join('\n');
}

/**
 * The one rule that has to hold in every chat, including a chat with a single
 * character. It lived inside a multi-character-only branch before, which is
 * why a one-character story had nothing stopping the model from writing the
 * user's lines.
 */
export function describeControl(scene: ResolvedScene, personaName: string): string {
  const speakable = scene.present.map(nameOf);
  const lines = [
    '## Who controls whom',
    `${personaName} is the user. Never write ${personaName}'s dialogue, actions, thoughts, or decisions.`,
    `You may have characters read ${personaName} — notice an expression, guess at a mood, ` +
      `brace for what might be coming — but that is their reading, not a fact about ` +
      `${personaName}. Never state what ${personaName} actually thinks, intends, or does next.`,
  ];
  if (speakable.length) {
    lines.push(
      `You narrate the world and play everyone present except ${personaName}` +
        (speakable.length > 1 ? `: ${speakable.join(', ')}.` : ` — currently ${speakable[0]}.`),
    );
  } else {
    lines.push('You narrate the world and everyone in it except the user.');
  }
  if (scene.primary) {
    lines.push(`${nameOf(scene.primary)} is the focus of this scene.`);
  }
  // How a turn should read used to be tacked on here. It is craft, not control,
  // and it now lives in the narrator's brief — see context/narration.ts.
  return lines.join('\n');
}
