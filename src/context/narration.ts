/**
 * The narrator's brief.
 *
 * Nexus is not a chatbot wearing a character's name. The model's job is to
 * write the scene — the prose, the room, the weather, the passage of time and
 * everyone in it except the user's persona. Nothing in the prompt used to say
 * so. The top-priority block was the global system prompt, whose stock wording
 * ("stay in character") frames the model as one person answering questions,
 * and a model framed that way answers: a line of dialogue, no scene around it.
 *
 * This block states the frame once, in a tier that cannot be trimmed, and then
 * says what a turn should look like — without a word count, a required
 * structure, or a list of components every reply must contain. Shape follows
 * the moment; the brief only rules out the two failure modes that actually
 * happen, which are bare dialogue and stopping at acknowledgement.
 *
 * `describeTurnDirective` is the same brief's last word, and it is placed
 * after the history rather than before it. A dump of the real prompt showed
 * the frame sitting ninety lines above the thing it governs, with the scene,
 * the cast, the story, five lore blocks and the whole transcript in between —
 * so the last thing the model read before writing was a short user line that
 * happened to be a question. A chat-tuned model answers a question.
 */

import type { ResolvedScene } from './scene';

const nameOf = (c: { displayName?: string; name: string }) => c.displayName || c.name;

export interface NarrationInput {
  scene: ResolvedScene;
  personaName: string;
  /**
   * True when the conversation carries transcript brought in from earlier play.
   * Such a transcript is written as a script — `Bakugo: "..."` — so the model
   * needs telling that the names are labels whether or not the scene itself
   * holds more than one character.
   */
  hasCarriedTranscript?: boolean;
}

export function describeNarration(input: NarrationInput): string {
  const { scene, personaName } = input;
  const lines: string[] = ['## You are the narrator'];

  lines.push(
    `You are not a character in this scene. You are the author writing it: the prose, ` +
      `the setting, the passage of time, and everyone present except ${personaName}.`,
  );

  if (scene.primary) {
    const primary = nameOf(scene.primary);
    lines.push(
      `${primary} is someone you write about, not someone you are. When ${primary} speaks ` +
        `you are quoting them, and the writing around the quote is yours to do.`,
    );
  }

  lines.push(
    '',
    'Write a turn the way the next page of a novel would read: give the moment somewhere ' +
      'to happen, let characters react before they answer, and let the scene keep moving ' +
      'after the last line of dialogue. A reply that is nothing but a quoted line is a ' +
      'transcript, not a scene — write bare dialogue only when the beat is genuinely that sharp.',
  );

  // Name prefixes reach the model two ways: the compiler adds them to past
  // assistant turns when the scene holds more than one character, and a carried
  // transcript arrives already written as a script. This used to fire only on
  // the first, which switched the counterweight off in exactly the case where
  // script-teaching is worst — one character plus a pasted transcript.
  if (scene.present.length > 1 || input.hasCarriedTranscript) {
    lines.push(
      '',
      'Some earlier turns are prefixed with a name. That is a label saying who was ' +
        'speaking, not the format to write in — you are writing prose, not a script.',
    );
  }

  lines.push(
    '',
    `Continue the scene from where it stands. A short turn from ${personaName} is an ` +
      'invitation to play out what happens next, not a cue to acknowledge it and stop: ' +
      'answer what was actually said or done — those words, that gesture — let it land, ' +
      'and carry the moment forward far enough to leave something to answer.',
    'Narration, physical action, inner reaction, dialogue and the world going on around ' +
      'them are all available. Use whichever the moment calls for; length and shape follow ' +
      'the scene, not a quota.',
  );

  return lines.join('\n');
}

/**
 * The last thing the model reads before it writes.
 *
 * Everything above this is context: who exists, where they are, what has
 * happened. This says what to do with the turn that just arrived — and it is
 * deliberately short, because its whole value is proximity. It restates only
 * what the failure needs: the user's message is an event in the scene rather
 * than a question addressed to the model, reactions are played out rather than
 * acknowledged, depth follows the moment, and the persona is never written.
 */
export function describeTurnDirective(input: NarrationInput): string {
  const { scene, personaName } = input;
  const audience = scene.present.length
    ? scene.present.map(nameOf).join(', ')
    : 'the characters present';

  return [
    '## This turn',
    `${personaName}'s message above is something happening inside the scene — an action, ` +
      `an expression, a line spoken to ${audience}. It is not a question addressed to you, ` +
      'and it does not want a short conversational answer.',
    '',
    `Play it forward. Let ${audience} react to what ${personaName} actually did — that ` +
      'gesture, those words — and carry the scene to its next real beat instead of ' +
      'stopping once the message has been acknowledged.',
    '',
    'How much room the moment gets follows the moment: a light exchange can be brief, a ' +
      'charged one earns space. Narration, action, inner reaction, dialogue and the world ' +
      'around them are tools — use the ones this beat needs, not all of them every time.',
    `Never write ${personaName}.`,
  ].join('\n');
}
