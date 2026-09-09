/**
 * Did the scene actually move?
 *
 * Deliberately not the memory extractor. That one is told to record only what
 * "someone would still need many scenes from now and could not work out from
 * the scene itself" — which is the exact opposite of a scene change, and is why
 * a location that moved in the transcript never reached the scene block.
 *
 * This asks one narrow question about one exchange: has the current scene
 * already changed? Everything hangs on the difference between a thing that
 * happened and a thing that was floated. "They walk onto the rooftop" moved the
 * scene. "They decide to go to the rooftop", "maybe they should", "they head
 * toward it", "from here she can see it", "they were there yesterday" did not,
 * and treating any of them as a move puts the model somewhere the story is not.
 */

import type {
  Character,
  ID,
  MemoryBasis,
  Persona,
  Provider,
  SceneDeltaStatus,
  SceneState,
} from '../types';
import { AUTO_APPLY_SCENE_FIELDS } from '../types';
import { complete } from '../ai/client';
import { AUTO_COMMIT_CONFIDENCE, resolveName } from '../memory/matrix';

export type SceneField = keyof Omit<SceneState, 'updatedAt'>;

export interface SceneChangeCandidate {
  field: SceneField;
  /** For characterStates, the character this line is about. */
  characterId: ID | null;
  value: string;
  basis: MemoryBasis;
  confidence: number;
  /** The sentence it was read from. Used to check the claim, never stored. */
  evidence: string;
}

const SCENE_SYSTEM = `You watch one exchange of a roleplay and decide whether the CURRENT SCENE has already changed.

You are given the scene as it currently stands and the latest exchange. Return ONLY a JSON object:
{"changes": [...]}

Each item of "changes":
{"field": one of ["location","situation","objective","characterStates"],
 "character": the character's name when field is "characterStates", else null,
 "value": the new value, short and in the story's own words,
 "basis": "observed" | "stated" | "inferred",
 "confidence": number between 0 and 1,
 "evidence": the exact sentence from the exchange that establishes it}

Report a change ONLY when the exchange shows it has ALREADY HAPPENED.

These are NOT changes:
- an intention or a decision ("they decide to go to the rooftop")
- a suggestion or a possibility ("maybe they should", "they could")
- anything hedged or hypothetical ("perhaps they are on the rooftop")
- movement that has not arrived ("they head toward the rooftop")
- a place that is merely visible or mentioned ("from the kitchen she can see the rooftop")
- something that happened earlier ("they were on the rooftop yesterday")
- something still to come ("they will meet on the rooftop at dawn")

basis means:
  "observed"  the narration shows it happening
  "stated"    a character says it is so; they may be wrong or lying
  "inferred"  you worked it out; the text did not say it

"location" is where the scene is taking place right now.
"situation" is what is going on right now.
"objective" is what the scene is driving at — report it only if the exchange states a new one outright.
"characterStates" is how one character is right now: hurt, seated, holding something, unconscious. Not their personality, not their history.

If the scene did not change, return {"changes": []}. An empty list is the usual and correct answer. Never invent a change to have something to report.`;

export interface SceneExtractionInput {
  /** The scene as it stands, so the model can tell a change from a restatement. */
  scene: SceneState;
  /** The exchange to read, oldest first. */
  exchange: Array<{ role: string; content: string }>;
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  signal?: AbortSignal;
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const FIELDS: SceneField[] = [
  'location',
  'situation',
  'objective',
  'characterStates',
  'presentCharacterIds',
  'primaryCharacterId',
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether the exchange really says what the model claims it says.
 *
 * A quoted sentence that appears nowhere in the text is the cheapest possible
 * sign of a hallucinated change, and rejecting it costs nothing.
 */
function grounded(candidate: SceneChangeCandidate, exchangeText: string): boolean {
  const haystack = normalise(exchangeText);
  const evidence = normalise(candidate.evidence);
  if (evidence && haystack.includes(evidence)) return true;
  // Some models paraphrase the evidence. Fall back to the value itself, which
  // has to come from somewhere in the text to be a change the story made.
  const value = normalise(candidate.value);
  return value.length > 2 && haystack.includes(value);
}

/**
 * Whether a candidate may change the scene by itself.
 *
 * Only location, situation and character state ever apply on their own.
 * `objective` is the user's steering rather than a fact about the world, and
 * presence and primary decide who replies — which in turn decides whose secrets
 * and whose private lore enter the prompt — so a model may ask for those but
 * never take them.
 */
export function decideSceneStatus(
  field: SceneField,
  basis: MemoryBasis,
  confidence: number,
): SceneDeltaStatus {
  if (!(AUTO_APPLY_SCENE_FIELDS as readonly string[]).includes(field)) return 'proposed';
  if (basis === 'inferred') return 'proposed';
  return confidence >= AUTO_COMMIT_CONFIDENCE ? 'applied' : 'proposed';
}

/** Parses one model reply into candidates. Exported so it can be tested alone. */
export function parseSceneChanges(
  reply: string,
  input: Pick<SceneExtractionInput, 'characters' | 'persona' | 'exchange'>,
): SceneChangeCandidate[] {
  const parsed = extractJson(reply);
  const raw = Array.isArray(parsed?.changes) ? (parsed!.changes as unknown[]) : [];
  const exchangeText = input.exchange.map((m) => m.content).join('\n');

  const out: SceneChangeCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    const field = String(record.field ?? '') as SceneField;
    if (!FIELDS.includes(field)) continue;

    const value = String(record.value ?? '').trim();
    if (!value) continue;

    const rawBasis = String(record.basis ?? '');
    // An unrecognised basis is not an observation. Guessing 'observed' is how
    // a model's speculation would end up rewriting the scene.
    const basis: MemoryBasis =
      rawBasis === 'observed' || rawBasis === 'stated' || rawBasis === 'inferred'
        ? rawBasis
        : 'inferred';

    const rawConfidence = Number(record.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0;

    const characterId =
      field === 'characterStates'
        ? resolveName(String(record.character ?? ''), input.characters, input.persona)
        : null;
    // A character state about nobody the app knows cannot be stored under a key.
    if (field === 'characterStates' && !characterId) continue;

    const candidate: SceneChangeCandidate = {
      field,
      characterId,
      value,
      basis,
      confidence,
      evidence: String(record.evidence ?? '').trim(),
    };
    if (!grounded(candidate, exchangeText)) continue;
    out.push(candidate);
  }
  return out;
}

/** Asks the model whether this exchange moved the scene. */
export async function extractSceneChanges(
  input: SceneExtractionInput,
): Promise<SceneChangeCandidate[]> {
  if (!input.provider?.model || !input.exchange.length) return [];

  const sceneBlock = [
    `Location: ${input.scene.location || '(not stated)'}`,
    `Situation: ${input.scene.situation || '(not stated)'}`,
    `Right now: ${input.scene.objective || '(not stated)'}`,
  ].join('\n');
  const exchangeBlock = input.exchange
    .map((m) => `${m.role === 'user' ? 'User' : 'Story'}: ${m.content.trim()}`)
    .join('\n\n');

  try {
    const reply = await complete({
      // Background work: it must never displace the roleplay request in the
      // inspector or in the mock the tests read.
      purpose: 'utility',
      provider: input.provider,
      signal: input.signal,
      settings: { temperature: 0.1, maxTokens: 500, streaming: false },
      messages: [
        { role: 'system', content: SCENE_SYSTEM },
        {
          role: 'user',
          content: `The scene as it stands:\n${sceneBlock}\n\nThe latest exchange:\n\n${exchangeBlock}`,
        },
      ],
    });
    return parseSceneChanges(reply, input);
  } catch {
    // A scene that failed to update is the situation we were already in; it
    // must never break the reply that just arrived.
    return [];
  }
}
