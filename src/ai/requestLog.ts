/**
 * The last request actually sent to a provider.
 *
 * The Context Inspector used to show what the compiler assembled, which is not
 * the same claim as what the server received — and the gap between those two
 * was exactly where this app's roleplay failures lived. Recording the real
 * body, after every clamp and default has been applied, is what makes the two
 * comparable instead of merely plausible.
 *
 * It holds one entry: the point is to answer "what did we just send", not to
 * accumulate a history that would keep whole prompts alive in memory.
 */

import type { MessagePipelineRow } from '../types';

export interface RecordedRequest {
  /** Wall-clock time the request was built. */
  at: number;
  /** Endpoint the body was posted to. */
  url: string;
  /** Which dialect built it — the two speak different option shapes. */
  dialect: 'ollama' | 'openai';
  /** The exact JSON body, already serialisable. */
  body: unknown;
  /** Prompt-window facts, when the dialect exposes them. */
  numCtx?: number;
  modelLimit?: number;
  /** True when the requested context size exceeded what the model can hold. */
  clamped?: boolean;
  /** Estimated tokens per section of the prompt, largest first. */
  breakdown?: Array<{ label: string; tokens: number }>;
  /** Totals, so the window can be read against what actually went into it. */
  promptTokens?: number;
  outputBudget?: number;
  /** Provenance for each message sent, in the order sent. */
  pipeline?: MessagePipelineRow[];
  /**
   * What the request was for. Summarisation and auto-memory go through the same
   * client, so without this the last thing recorded after a roleplay turn could
   * be a background utility call — and the inspector would faithfully show the
   * wrong payload.
   */
  purpose?: 'chat' | 'utility';
}

let last: RecordedRequest | null = null;
let lastChat: RecordedRequest | null = null;

export function recordRequest(request: RecordedRequest): void {
  last = request;
  if ((request.purpose ?? 'chat') === 'chat') lastChat = request;
}

/** The last roleplay generation, falling back to whatever was last sent. */
export function getLastRequest(): RecordedRequest | null {
  return lastChat ?? last;
}

export function clearLastRequest(): void {
  last = null;
  lastChat = null;
}

/** Pretty-prints the recorded body for the inspector and for copying. */
export function formatRequest(request: RecordedRequest | null): string {
  if (!request) return 'No request has been sent yet in this session.';
  return JSON.stringify(request.body, null, 2);
}
