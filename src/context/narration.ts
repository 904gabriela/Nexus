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
 */

import type { ResolvedScene } from './scene';

const nameOf = (c: { displayName?: string; name: string }) => c.displayName || c.name;

export function describeNarration(scene: ResolvedScene, personaName: string): string {
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

  // With two or more in the room the compiler prefixes past assistant turns
  // with `Name:` so it is unambiguous who spoke. Left unexplained that reads as
  // a script format to imitate, and the model answers in screenplay lines.
  if (scene.present.length > 1) {
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
