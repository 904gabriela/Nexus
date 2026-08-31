/**
 * The opening scene.
 *
 * A story used to begin with whichever greeting the main character carries
 * everywhere — the same paragraph whatever campaign it was dropped into. A
 * greeting introduces a character; an opening scene starts a story, which is a
 * different piece of writing: a place, a moment, and something already in
 * motion for the player to step into.
 *
 * This is a draft, never a commit. The result lands in the story's Opening
 * message field where it can be rewritten or thrown away, so the model is
 * being asked for a starting point rather than trusted with the first page.
 */

import type { Character, Persona, Provider, Story } from '../types';
import { complete } from './client';
import { truncate } from '../utils/text';

export interface OpeningSceneInput {
  story: Story;
  /** The story's cast, already resolved. */
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  signal?: AbortSignal;
}

const SYSTEM = [
  'You are the narrator opening a novel. Write the first passage of a story — the',
  'moment the reader arrives, already underway.',
  '',
  'Write prose: where this is, what it looks and sounds like, what the characters',
  'are doing before anyone speaks. Dialogue is allowed but is not the point, and a',
  'greeting addressed to the reader is not an opening scene.',
  '',
  'Never write the player character. They are present; what they think, say and do',
  'next is not yours to decide. End somewhere they can act.',
  '',
  'Return the passage alone — no title, no heading, no commentary, no options.',
].join('\n');

function characterBrief(character: Character): string {
  const name = character.displayName || character.name;
  const facts = [
    character.shortDescription || character.description,
    character.appearance,
    character.personality,
  ]
    .map((s) => (s ?? '').trim())
    .filter(Boolean);
  return `${name}: ${truncate(facts.join(' — '), 400) || 'no description given'}`;
}

export function buildOpeningBrief(input: OpeningSceneInput): string {
  const lines: string[] = [];
  if (input.story.title.trim()) lines.push(`Story: ${input.story.title.trim()}`);
  if (input.story.description.trim()) {
    lines.push(`Premise: ${truncate(input.story.description.trim(), 600)}`);
  }
  if (input.story.scenario.trim()) {
    lines.push(`Scenario: ${truncate(input.story.scenario.trim(), 900)}`);
  }

  const cast = input.characters.filter((c) => c.name.trim());
  if (cast.length) {
    lines.push('', 'Characters you write:', ...cast.map((c) => `- ${characterBrief(c)}`));
  }

  if (input.persona) {
    const name = input.persona.displayName || input.persona.name;
    lines.push(
      '',
      `The player plays ${name}${
        input.persona.appearance.trim() ? ` (${truncate(input.persona.appearance.trim(), 200)})` : ''
      }. ${name} is present in the scene, but never write their words, actions or thoughts.`,
    );
  }

  if (input.story.authorNote.trim()) {
    lines.push('', `Tone and direction: ${truncate(input.story.authorNote.trim(), 400)}`);
  }

  if (!lines.length) {
    lines.push('No premise has been written yet. Open somewhere concrete and let it suggest one.');
  }

  return lines.join('\n');
}

export class OpeningSceneError extends Error {}

export async function generateOpeningScene(input: OpeningSceneInput): Promise<string> {
  if (!input.provider) {
    throw new OpeningSceneError(
      'Writing an opening scene needs an AI provider. Set one up in Settings, or write the opening yourself.',
    );
  }

  const text = await complete({
    // Background work: this must never displace the roleplay request in the
    // Context Inspector.
    purpose: 'utility',
    provider: input.provider,
    signal: input.signal,
    // Warmer than the summariser: this is the one utility call whose job is to
    // be interesting. Still below the roleplay default, because a first page
    // that ignores the premise is worse than a plain one.
    settings: { temperature: 0.9, maxTokens: 700, streaming: false },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildOpeningBrief(input) },
    ],
  });

  const cleaned = stripPreamble(text);
  if (!cleaned) {
    throw new OpeningSceneError('The model returned an empty opening. Try again.');
  }
  return cleaned;
}

/**
 * Models like to answer a writing request rather than fulfil it — "Here's an
 * opening scene:" followed by the scene, sometimes fenced. Take the prose.
 */
function stripPreamble(raw: string): string {
  let text = raw.trim();

  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence) text = fence[1].trim();

  // Only a first line that is *entirely* an announcement, so a scene that
  // legitimately opens with a short line survives.
  const lines = text.split('\n');
  if (/^(here('| i)s|sure[,!.]|certainly[,!.]|okay[,!.]).{0,80}:$/i.test(lines[0]?.trim() ?? '')) {
    lines.shift();
    text = lines.join('\n').trim();
  }

  // A leading markdown heading is formatting the model added, not the story.
  return text.replace(/^#{1,6}\s+.*\n+/, '').trim();
}
