/**
 * OpenAI-compatible chat client.
 *
 * Works against OpenRouter, OpenAI, any compatible gateway and LAN endpoints
 * (LM Studio / Ollama / KoboldCpp). Streaming is SSE with a graceful fallback to
 * a single non-streamed response when the endpoint does not support it.
 */

import type { ChatCompletionMessage, GenerationSettings, Provider } from '../types';

export class ProviderError extends Error {
  readonly status?: number;
  readonly detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.detail = detail;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) throw new ProviderError('This provider has no base URL configured.');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // Accept both ".../v1" and a bare host; append /v1 only when clearly absent.
  if (!/\/v\d+$/i.test(url) && !/\/(api|openai)$/i.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}

function buildHeaders(provider: Provider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey.trim()) headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  if (provider.kind === 'openrouter') {
    // OpenRouter attributes traffic with these; harmless elsewhere.
    if (typeof location !== 'undefined') headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Nexus Tavern Pro';
  }
  for (const [key, value] of Object.entries(provider.extraHeaders ?? {})) {
    if (key.trim()) headers[key] = value;
  }
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return (
        parsed?.error?.message ??
        parsed?.error ??
        parsed?.message ??
        text.slice(0, 400)
      );
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return '';
  }
}

function describeNetworkFailure(provider: Provider, err: unknown): ProviderError {
  const base = provider.baseUrl;
  const isLocal = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
    base,
  );
  const secureOrigin = typeof location !== 'undefined' && location.protocol === 'https:';
  let hint = 'Check the base URL, your network connection and any CORS restrictions.';
  if (isLocal && secureOrigin) {
    hint =
      'This page is served over HTTPS but the endpoint is plain HTTP on your LAN — ' +
      'browsers block that as mixed content. Serve Nexus over HTTP, or put the endpoint behind HTTPS.';
  } else if (isLocal) {
    hint =
      'Make sure the local server is running, reachable from this device, and started with CORS enabled.';
  }
  return new ProviderError(
    `Could not reach ${base}. ${hint}`,
    undefined,
    err instanceof Error ? err.message : String(err),
  );
}

export interface FetchModelsResult {
  models: string[];
}

export async function fetchModels(provider: Provider, signal?: AbortSignal): Promise<FetchModelsResult> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(provider), signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw describeNetworkFailure(provider, err);
  }
  if (!response.ok) {
    const detail = await readError(response);
    throw new ProviderError(
      response.status === 401
        ? 'The API key was rejected (401). Check the key for this provider.'
        : `Fetching models failed with HTTP ${response.status}.`,
      response.status,
      detail,
    );
  }
  const payload = await response.json().catch(() => null);
  const list: unknown[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models = list
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        return String(obj.id ?? obj.name ?? obj.model ?? '');
      }
      return '';
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!models.length) {
    throw new ProviderError(
      'The endpoint responded, but returned no models. It may not implement /models.',
    );
  }
  return { models: Array.from(new Set(models)) };
}

export interface TestResult {
  ok: boolean;
  message: string;
  detail?: string;
  models?: number;
}

export async function testConnection(provider: Provider): Promise<TestResult> {
  try {
    const { models } = await fetchModels(provider);
    return {
      ok: true,
      message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      models: models.length,
    };
  } catch (err) {
    if (err instanceof ProviderError && err.status && err.status !== 401 && err.status !== 404) {
      return { ok: false, message: err.message, detail: err.detail };
    }
    // /models is optional; a minimal completion is the definitive check.
    try {
      const reply = await complete({
        provider,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        settings: { maxTokens: 5, temperature: 0, streaming: false },
      });
      return {
        ok: true,
        message: `Connected. The endpoint answered a test completion${
          reply.trim() ? ` ("${reply.trim().slice(0, 40)}")` : ''
        }.`,
      };
    } catch (completionErr) {
      const e = completionErr instanceof ProviderError ? completionErr : null;
      return {
        ok: false,
        message: e?.message ?? (err instanceof Error ? err.message : 'Connection failed.'),
        detail: e?.detail ?? (err instanceof ProviderError ? err.detail : undefined),
      };
    }
  }
}

export interface CompleteOptions {
  provider: Provider;
  messages: ChatCompletionMessage[];
  settings?: Partial<GenerationSettings>;
  model?: string;
  signal?: AbortSignal;
  onToken?: (chunk: string, full: string) => void;
}

function buildBody(options: CompleteOptions, stream: boolean) {
  const { provider, settings = {} } = options;
  const body: Record<string, unknown> = {
    model: options.model || provider.model,
    messages: options.messages,
    stream,
    temperature: settings.temperature ?? provider.temperature,
    max_tokens: settings.maxTokens ?? provider.maxTokens,
    top_p: settings.topP ?? provider.topP,
  };
  const freq = settings.frequencyPenalty ?? provider.frequencyPenalty;
  const pres = settings.presencePenalty ?? provider.presencePenalty;
  if (freq) body.frequency_penalty = freq;
  if (pres) body.presence_penalty = pres;
  if (!body.model) {
    throw new ProviderError('No model is selected for this provider. Pick one in Settings.');
  }
  return body;
}

/** Non-streaming completion. */
export async function complete(options: CompleteOptions): Promise<string> {
  const { provider } = options;
  const url = `${normalizeBaseUrl(provider.baseUrl)}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify(buildBody(options, false)),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw describeNetworkFailure(provider, err);
  }
  if (!response.ok) throw await httpError(response);
  const payload = await response.json().catch(() => null);
  const text =
    payload?.choices?.[0]?.message?.content ??
    payload?.choices?.[0]?.text ??
    payload?.content ??
    '';
  if (typeof text !== 'string' || !text) {
    throw new ProviderError(
      'The provider returned an empty response.',
      response.status,
      JSON.stringify(payload)?.slice(0, 300),
    );
  }
  return text;
}

async function httpError(response: Response): Promise<ProviderError> {
  const detail = await readError(response);
  const messages: Record<number, string> = {
    400: 'The provider rejected the request (400). The model name or parameters may be invalid.',
    401: 'Authentication failed (401). Check the API key.',
    402: 'Payment required (402). The account may be out of credit.',
    403: 'Access denied (403). The key may lack permission for this model.',
    404: 'Endpoint or model not found (404). Check the base URL and model name.',
    413: 'The request was too large (413). Reduce the context budget or max tokens.',
    429: 'Rate limited (429). Wait a moment and try again.',
    500: 'The provider had a server error (500).',
    502: 'The provider gateway failed (502).',
    503: 'The provider is unavailable (503).',
  };
  return new ProviderError(
    messages[response.status] ?? `Request failed with HTTP ${response.status}.`,
    response.status,
    detail,
  );
}

/**
 * Streaming completion. Falls back to a single request when the endpoint does
 * not produce a readable stream. Returns the full text.
 */
export async function streamComplete(options: CompleteOptions): Promise<string> {
  const { provider, onToken } = options;
  const wantsStream = options.settings?.streaming ?? provider.streaming;
  if (!wantsStream) {
    const text = await complete(options);
    onToken?.(text, text);
    return text;
  }

  const url = `${normalizeBaseUrl(provider.baseUrl)}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(provider), Accept: 'text/event-stream' },
      body: JSON.stringify(buildBody(options, true)),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw describeNetworkFailure(provider, err);
  }

  if (!response.ok) throw await httpError(response);

  if (!response.body || typeof response.body.getReader !== 'function') {
    // Some environments (and a few proxies) hand back a buffered body.
    const text = await response.text();
    const full = parseBufferedStream(text);
    onToken?.(full, full);
    return full;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const rawLine = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf('\n');
        if (!rawLine || rawLine.startsWith(':')) continue;
        if (!rawLine.startsWith('data:')) continue;
        const data = rawLine.slice(5).trim();
        if (data === '[DONE]') {
          buffer = '';
          break;
        }
        const chunk = extractDelta(data);
        if (chunk) {
          full += chunk;
          onToken?.(chunk, full);
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      // A stopped generation keeps whatever text already arrived.
      return full;
    }
    throw new ProviderError(
      'The response stream was interrupted.',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (!full.trim()) {
    throw new ProviderError('The provider streamed an empty response.');
  }
  return full;
}

function extractDelta(data: string): string {
  try {
    const parsed = JSON.parse(data);
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
    if (typeof delta === 'string') return delta;
    if (Array.isArray(delta)) {
      return delta.map((d) => (typeof d?.text === 'string' ? d.text : '')).join('');
    }
    if (parsed?.error) {
      throw new ProviderError(
        typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? 'Stream error'),
      );
    }
    return '';
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    return '';
  }
}

function parseBufferedStream(text: string): string {
  let full = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') break;
    full += extractDelta(data);
  }
  if (full) return full;
  // Not SSE after all — try a plain JSON completion body.
  try {
    const parsed = JSON.parse(text);
    return parsed?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

/** Redacted key for display (spec §49). */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(16, key.length - 8))}${key.slice(-4)}`;
}
