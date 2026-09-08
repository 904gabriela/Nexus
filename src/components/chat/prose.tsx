/**
 * Roleplay prose, read as prose.
 *
 * A reply is usually two registers braided together — what happened, and what
 * someone said — and as one undifferentiated block the eye has to do that
 * separation itself on every paragraph. Marking the spoken parts is the whole
 * of it: narration recedes, dialogue steps forward, and the page reads like a
 * scene instead of a transcript.
 *
 * This is display only. Nothing here is written back to a message, and the
 * segments always concatenate to exactly the original string — the renderer
 * cannot drop or alter a character, only decide how to draw it. That property
 * is what makes it safe to run over chats that already exist.
 */

import { Fragment, type ReactNode } from 'react';

type Segment = { kind: 'plain' | 'speech' | 'emphasis'; text: string };

/**
 * Splits on paired straight or curly quotes and on *asterisk emphasis*.
 *
 * Deliberately literal: an unpaired quote stays plain text rather than
 * swallowing the rest of the message, which is the failure mode that makes
 * this kind of formatting worse than none at all.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  // One alternation, so a match is always a complete pair. Speech may not span
  // a blank line — an unclosed quote then ends at the paragraph rather than
  // running to the end of the reply.
  // The quotes and asterisks stay in the output: they are part of what the
  // model wrote, and stripping them would make the rendered text differ from
  // the text that gets copied, edited or exported.
  const pattern = /"[^"\n]*(?:\n(?!\n)[^"\n]*)*"|“[^”]*”|\*[^*\n]+\*/g;

  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) out.push({ kind: 'plain', text: text.slice(last, match.index) });
    const whole = match[0];
    out.push({ kind: whole.startsWith('*') ? 'emphasis' : 'speech', text: whole });
    last = match.index + whole.length;
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) });
  return out;
}

/** Renders the segments. The markup carries no text the source did not have. */
export function Prose({ text }: { text: string }): ReactNode {
  if (!text) return null;
  const parts = segments(text);
  // Nothing to mark: hand back the string so the common case allocates nothing.
  if (parts.length === 1 && parts[0].kind === 'plain') return text;

  return (
    <>
      {parts.map((segment, index) => (
        <Fragment key={index}>
          {segment.kind === 'plain' ? (
            segment.text
          ) : (
            <span className={segment.kind === 'speech' ? 'speech' : 'emphasis'}>
              {segment.text}
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}
