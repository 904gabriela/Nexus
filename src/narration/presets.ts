/**
 * Narration style presets.
 *
 * A preset is a short prompt modifier that shapes *how* the narrator writes,
 * not what it knows. They are modular by design: "Detailed + Slow Burn +
 * Cinematic" is a normal selection, not a mode you switch between, because the
 * qualities they describe are independent of one another.
 *
 * They are deliberately not baked into the global system prompt. A preset is
 * data — it can be enabled, disabled, edited, duplicated and combined, and a
 * story or a single chat can carry its own selection. The compiler renders the
 * chosen ones into one block; nothing else in the prompt changes.
 *
 * The built-ins below ship as code so a fresh install has them without a
 * migration. Editing one stores an override under the same id; the built-in
 * text stays available underneath, so "reset" is just deleting the override.
 */

import type { ID } from '../types';

export interface NarrationPreset {
  id: ID;
  name: string;
  /** One or two sentences, written as guidance to the narrator. */
  instruction: string;
  /** Shown in the picker, never sent to the model. */
  description: string;
  /** True for the presets that ship with Nexus. */
  builtIn: boolean;
}

/**
 * Written as permissions and emphases rather than rules, so combining several
 * cannot produce a contradiction the model has to arbitrate. None of them
 * mentions length in words.
 */
export const BUILT_IN_PRESETS: NarrationPreset[] = [
  {
    id: 'preset-default',
    name: 'Default',
    description: 'No additional shaping. The scene decides.',
    instruction: '',
    builtIn: true,
  },
  {
    id: 'preset-cinematic',
    name: 'Cinematic',
    description: 'Visual composition, atmosphere, movement.',
    instruction:
      'Emphasise visual composition, atmosphere, physical movement and how the scene ' +
      'transitions from one moment to the next. Let the reader see where they are standing.',
    builtIn: true,
  },
  {
    id: 'preset-detailed',
    name: 'Detailed',
    description: 'Richer sensory description; reactions get room.',
    instruction:
      'Use richer sensory and environmental description where it earns its place. Expand ' +
      'the reactions that matter rather than rushing through them.',
    builtIn: true,
  },
  {
    id: 'preset-slow-burn',
    name: 'Slow Burn',
    description: 'Tension develops; nothing resolves early.',
    instruction:
      'Let emotional tension build gradually. Do not rush emotional progression or resolve ' +
      'tension as soon as it appears — leave things unsaid that can be said later.',
    builtIn: true,
  },
  {
    id: 'preset-fast-paced',
    name: 'Fast Paced',
    description: 'Momentum, decisive action, short beats.',
    instruction:
      'Favour momentum: decisive actions, shorter beats and rapid reactions. Keep the scene ' +
      'moving rather than dwelling.',
    builtIn: true,
  },
  {
    id: 'preset-emotional',
    name: 'Emotional',
    description: 'Interior weather and what it costs.',
    instruction:
      'Stay close to what the characters are feeling and what it costs them to feel it. Let ' +
      'interior reaction carry as much weight as anything said aloud.',
    builtIn: true,
  },
  {
    id: 'preset-romantic',
    name: 'Romantic',
    description: 'Proximity, awareness, restraint.',
    instruction:
      'Attend to proximity, awareness and restraint — what is almost said, almost done, and ' +
      'noticed anyway. Intimacy comes from attention, not from declaration.',
    builtIn: true,
  },
  {
    id: 'preset-dramatic',
    name: 'Dramatic',
    description: 'Stakes and consequence in every beat.',
    instruction:
      'Keep the stakes visible. Give choices consequences that land inside the scene rather ' +
      'than being described after the fact.',
    builtIn: true,
  },
  {
    id: 'preset-action',
    name: 'Action',
    description: 'Physical clarity under pressure.',
    instruction:
      'Keep physical action legible: who moves, where, and what it costs. Favour concrete ' +
      'movement over abstract description while the pressure is on.',
    builtIn: true,
  },
  {
    id: 'preset-dark',
    name: 'Dark',
    description: 'Unsoftened tone; consequences bite.',
    instruction:
      'Do not soften the tone. Let threat, cost and consequence stay real rather than ' +
      'resolving them comfortably.',
    builtIn: true,
  },
  {
    id: 'preset-comedic',
    name: 'Comedic',
    description: 'Timing, and letting a moment land.',
    instruction:
      'Play for timing. Let a beat land before moving on, and let characters be undignified ' +
      'in ways that fit who they are.',
    builtIn: true,
  },
];

export const DEFAULT_PRESET_ID = 'preset-default';

/**
 * The presets available right now: built-ins, with any stored edit of the same
 * id replacing its text, plus anything the user created themselves.
 */
export function availablePresets(stored: NarrationPreset[]): NarrationPreset[] {
  const overrides = new Map(stored.map((p) => [p.id, p]));
  const merged = BUILT_IN_PRESETS.map((base) => {
    const override = overrides.get(base.id);
    return override ? { ...base, ...override, builtIn: true } : base;
  });
  const custom = stored.filter((p) => !BUILT_IN_PRESETS.some((b) => b.id === p.id));
  return [...merged, ...custom];
}

/** Resolves a selection to the presets that actually contribute text. */
export function selectedPresets(ids: ID[], stored: NarrationPreset[]): NarrationPreset[] {
  const byId = new Map(availablePresets(stored).map((p) => [p.id, p]));
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is NarrationPreset => Boolean(p) && Boolean(p!.instruction.trim()));
}

/**
 * The block the compiler sends, or an empty string when nothing is selected.
 *
 * Presets are listed rather than run together into a paragraph: each is a
 * separate emphasis, and a list makes it obvious that they combine instead of
 * competing.
 */
export function describeNarrationStyle(presets: NarrationPreset[]): string {
  const active = presets.filter((p) => p.instruction.trim());
  if (!active.length) return '';
  return [
    '## Narration style',
    'These shape how the scene is written. They do not change who is present or what has ' +
      'happened, and none of them asks for a particular length.',
    '',
    ...active.map((p) => `- ${p.name}: ${p.instruction.trim()}`),
  ].join('\n');
}
