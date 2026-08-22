/**
 * The text being typed, held outside React's component tree.
 *
 * Keeping the draft in the chat screen's state meant every keystroke rerendered
 * the screen — and with it every message in the history — and recompiled the
 * whole AI context, because the compiler took the pending text as an input.
 * Typing five characters into a 300-message roleplay cost 1,500 message renders
 * and five full context builds.
 *
 * Here the draft is a value with subscribers, so a keystroke rerenders only the
 * two components that actually display it: the composer itself and the token
 * chip in the header. The message list never sees it.
 */
import { useSyncExternalStore } from 'react';

let text = '';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the draft without subscribing — for send, where a snapshot is enough. */
export function getDraft(): string {
  return text;
}

export function setDraft(next: string): void {
  if (next === text) return;
  text = next;
  for (const listener of listeners) listener();
}

export function clearDraft(): void {
  setDraft('');
}

/** Subscribes to the draft. Only call this where the text is actually shown. */
export function useDraft(): string {
  return useSyncExternalStore(subscribe, getDraft, getDraft);
}
