/**
 * Builds image prompts from live story state.
 *
 * The user always sees and can edit the result before anything is generated —
 * this is a strong starting point, not a black box.
 */

import type { Character, Chat, Message, Persona, Story, StorySummary } from '../types';
import { truncate } from '../utils/text';

export type ImagePromptKind = 'scene' | 'character' | 'persona' | 'custom';

export interface ScenePromptInput {
  story: Story | null;
  chat: Chat | null;
  characters: Character[];
  persona: Persona | null;
  summary: StorySummary | null;
  /** Oldest-first; the tail is what the scene is actually about. */
  recentMessages: Message[];
  /** Restrict the portrait to one character. */
  focusCharacterId?: string | null;
}

/** Words that suggest a line is describing what is visible right now. */
const VISUAL_HINTS =
  /\b(wear|wearing|dress|dressed|robe|cloak|armou?r|coat|hair|eyes?|smil|frown|scowl|blush|stand|sit|kneel|lean|reach|hold|grip|walk|run|step|door|window|table|fire|rain|snow|storm|street|room|hall|forest|light|shadow|dark|candle|lantern)\w*/i;

/** Strips roleplay formatting that would confuse an image model. */
function cleanForImage(text: string): string {
  return text
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Picks the most visually descriptive sentences from recent conversation. */
function extractSceneBeats(messages: Message[], limit = 3): string[] {
  const beats: Array<{ text: string; score: number }> = [];

  // Recency matters most, so only look at the tail of the conversation.
  for (const message of messages.slice(-6)) {
    const sentences = cleanForImage(message.content)
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15 && s.length < 240);

    for (const sentence of sentences) {
      const hits = sentence.match(new RegExp(VISUAL_HINTS, 'gi'))?.length ?? 0;
      if (!hits) continue;
      // Prefer narration over dialogue: quoted speech rarely describes a scene.
      const isDialogue = /^["“']/.test(sentence);
      beats.push({ text: sentence, score: hits + (isDialogue ? -1 : 1) });
    }
  }

  return beats
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((beat) => beat.text);
}

function describeAppearance(character: Character): string {
  const parts = [
    character.appearance,
    character.physicalTraits,
    character.species && `species: ${character.species}`,
    character.age && `age ${character.age}`,
    character.gender,
  ]
    .map((value) => cleanForImage(String(value ?? '')))
    .filter(Boolean);

  if (!parts.length) {
    // Fall back to whatever prose exists rather than emitting a bare name.
    const fallback = cleanForImage(character.shortDescription || character.description);
    return truncate(fallback, 200);
  }
  return truncate(parts.join(', '), 320);
}

function characterLine(character: Character): string {
  const name = character.displayName || character.name;
  const appearance = describeAppearance(character);
  return appearance ? `${name} (${appearance})` : name;
}

function personaLine(persona: Persona): string {
  const name = persona.displayName || persona.name;
  const appearance = truncate(cleanForImage(persona.appearance), 260);
  return appearance ? `${name} (${appearance})` : name;
}

/** Location, pulled from the summary or the characters' own world fields. */
function inferLocation(input: ScenePromptInput): string {
  const fromSummary = input.summary?.currentSummary ?? '';
  const locationMatch = /\b(?:at|in|inside|outside|near) (?:the |a |an )?([A-Z][\w' -]{2,40})/.exec(
    fromSummary,
  );
  if (locationMatch) return locationMatch[1].trim();

  const character = input.characters.find((c) => c.location || c.home);
  return cleanForImage(character?.location || character?.home || '');
}

export function buildScenePrompt(input: ScenePromptInput): string {
  const lines: string[] = [];

  const cast = input.characters.filter((c) => c.name.trim());
  if (cast.length) {
    lines.push(`Characters: ${cast.map(characterLine).join('; ')}.`);
  }
  if (input.persona) {
    lines.push(`Also present: ${personaLine(input.persona)}.`);
  }

  const scenario = cleanForImage(input.story?.scenario ?? '');
  if (scenario) lines.push(`Setting: ${truncate(scenario, 280)}.`);

  const location = inferLocation(input);
  if (location) lines.push(`Location: ${location}.`);

  const beats = extractSceneBeats(input.recentMessages);
  if (beats.length) {
    lines.push(`Happening now: ${beats.map((b) => truncate(b, 200)).join(' ')}`);
  } else if (input.summary?.currentSummary) {
    lines.push(`Happening now: ${truncate(cleanForImage(input.summary.currentSummary), 240)}`);
  }

  if (!lines.length) {
    return 'An atmospheric illustration of a quiet scene. Cinematic lighting, detailed.';
  }

  lines.push('Cinematic illustration, detailed, atmospheric lighting, no text or watermarks.');
  return lines.join('\n');
}

export function buildCharacterPortraitPrompt(character: Character): string {
  const name = character.displayName || character.name;
  const lines = [
    `Character portrait of ${name}.`,
    describeAppearance(character) && `Appearance: ${describeAppearance(character)}.`,
  ].filter(Boolean) as string[];

  const mood = cleanForImage(character.personality || character.temperament);
  if (mood) lines.push(`Demeanour: ${truncate(mood, 180)}.`);

  const world = cleanForImage(character.world || character.faction || character.occupation);
  if (world) lines.push(`Context: ${truncate(world, 160)}.`);

  lines.push(
    'Head and shoulders framing, neutral background, detailed features, ' +
      'soft directional lighting, no text or watermarks.',
  );
  return lines.join('\n');
}

export function buildPersonaPortraitPrompt(persona: Persona): string {
  const name = persona.displayName || persona.name;
  const lines = [`Character portrait of ${name}.`];

  const appearance = cleanForImage(persona.appearance);
  if (appearance) lines.push(`Appearance: ${truncate(appearance, 320)}.`);

  const personality = cleanForImage(persona.personality);
  if (personality) lines.push(`Demeanour: ${truncate(personality, 180)}.`);

  lines.push(
    'Head and shoulders framing, neutral background, detailed features, ' +
      'soft directional lighting, no text or watermarks.',
  );
  return lines.join('\n');
}

export function buildPrompt(kind: ImagePromptKind, input: ScenePromptInput): string {
  switch (kind) {
    case 'character': {
      const character =
        input.characters.find((c) => c.id === input.focusCharacterId) ?? input.characters[0];
      return character ? buildCharacterPortraitPrompt(character) : '';
    }
    case 'persona':
      return input.persona ? buildPersonaPortraitPrompt(input.persona) : '';
    case 'custom':
      return '';
    case 'scene':
    default:
      return buildScenePrompt(input);
  }
}
