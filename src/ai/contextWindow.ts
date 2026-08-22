/**
 * How much context the model can actually hold.
 *
 * Nexus used to build a prompt against whatever number the Context size field
 * said — 513,856 in one real configuration — and hand it to Ollama without
 * saying how big the window should be. Ollama then applied its own default
 * (commonly 4096), truncated the prompt to fit, and answered anyway. The
 * truncation keeps the tail and drops the head, and the head is where the
 * system prompt lives, so the persona, the cast and the roleplay rules were
 * the first things thrown away. That is why a character who was only mentioned
 * in old history could walk into the scene, and why the user's own persona
 * could be mistaken for someone else.
 *
 * So the budget has to be negotiated rather than declared: ask the model what
 * it can hold, take the smaller of that and what the user asked for, and send
 * that number back as num_ctx so the server allocates the window we budgeted
 * against.
 */

import type { Provider } from '../types';

/** Below this a roleplay prompt cannot hold its own rules, let alone a scene. */
export const MIN_CONTEXT = 2048;

/** Used when the model will not say and nothing else is known. */
export const ASSUMED_CONTEXT = 8192;

export interface ContextWindow {
  /** Tokens the model can actually hold, as reported or assumed. */
  limit: number;
  /** True when the model reported this rather than us guessing. */
  reported: boolean;
  /** Which model the figure belongs to. */
  model: string;
}

export interface UsableBudget {
  /** What to send as num_ctx: the whole window, prompt plus reply. */
  numCtx: number;
  /** What the compiler may spend on the prompt. */
  promptBudget: number;
  /** Held back for the reply. */
  reserved: number;
  /** The model's own ceiling. */
  modelLimit: number;
  /** What the user asked for, before clamping. */
  requested: number;
  /** True when the request was larger than the model can hold. */
  clamped: boolean;
  reported: boolean;
}

const cache = new Map<string, ContextWindow>();

function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}::${model}`;
}

/** Discards cached figures — used when a provider is edited. */
export function clearContextWindowCache(): void {
  cache.clear();
}

/**
 * Pulls the context length out of an /api/show payload.
 *
 * Ollama keys it by architecture (`llama.context_length`, `qwen2.context_length`,
 * …), so the key cannot be hardcoded; anything ending in `.context_length` is
 * the same fact under a different model family.
 */
export function readContextLength(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, any>;

  const info = obj.model_info;
  if (info && typeof info === 'object') {
    for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
      if (!key.endsWith('.context_length') && key !== 'context_length') continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }

  // Some builds surface it at the top level, or inside details.
  for (const candidate of [obj.context_length, obj.details?.context_length]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }

  // A num_ctx baked into the Modelfile is a deliberate override, so it wins
  // over the architecture default when both are present.
  const params = typeof obj.parameters === 'string' ? obj.parameters : '';
  const match = /^\s*num_ctx\s+(\d+)/m.exec(params);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }

  return null;
}

function ollamaRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/, '');
}

/**
 * Asks Ollama what the model's window is. Never throws: a provider that cannot
 * answer leaves us on the assumed figure rather than blocking generation.
 */
export async function fetchOllamaContextWindow(
  provider: Provider,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContextWindow> {
  const key = cacheKey(provider.baseUrl, model);
  const cached = cache.get(key);
  if (cached) return cached;

  let window: ContextWindow = { limit: ASSUMED_CONTEXT, reported: false, model };
  try {
    const response = await fetchImpl(`${ollamaRoot(provider.baseUrl)}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const limit = readContextLength(payload);
      if (limit) window = { limit, reported: true, model };
    }
  } catch {
    // Offline or blocked: the assumed figure stands.
  }

  cache.set(key, window);
  return window;
}

/**
 * Works out what may actually be spent.
 *
 * `requested` is the user's Context size setting. It is a ceiling on ambition,
 * not a promise: the model's own window always wins, because exceeding it does
 * not produce an error, it produces silent truncation.
 */
export function resolveUsableBudget(input: {
  requested: number;
  modelLimit: number;
  /** Tokens to hold back for the reply (num_predict / max tokens). */
  reserveForResponse: number;
  reported?: boolean;
}): UsableBudget {
  const modelLimit = Math.max(MIN_CONTEXT, Math.floor(input.modelLimit) || ASSUMED_CONTEXT);
  const requested = Math.max(MIN_CONTEXT, Math.floor(input.requested) || ASSUMED_CONTEXT);
  const numCtx = Math.min(requested, modelLimit);

  // The reply shares the window with the prompt. Reserve enough for a full
  // response but never so much that the prompt cannot hold a scene.
  const reserved = Math.min(
    Math.max(0, Math.floor(input.reserveForResponse) || 0),
    Math.floor(numCtx / 2),
  );

  return {
    numCtx,
    promptBudget: Math.max(MIN_CONTEXT - reserved, numCtx - reserved),
    reserved,
    modelLimit,
    requested,
    clamped: requested > modelLimit,
    reported: input.reported ?? false,
  };
}
