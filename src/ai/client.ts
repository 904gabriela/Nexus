/**
 * OpenAI-compatible chat client.
 *
 * Works against OpenRouter, OpenAI, any compatible gateway and LAN endpoints
 * (LM Studio / Ollama / KoboldCpp). Streaming is SSE with a graceful fallback to
 * a single non-streamed response when the endpoint does not support it.
 */

import type {
  ChatCompletionMessage,
  GenerationSettings,
  ModelInfo,
  Provider,
} from '../types';
import { defaultCapabilities } from '../types';
import { inferCapabilities } from '../types/factories';

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
  // A pasted endpoint often already includes the path. Strip it back to the
  // base so "http://host:1234/v1/chat/completions" and "http://host:1234" both
  // end up as "http://host:1234/v1".
  url = url.replace(/\/(chat\/completions|completions|models)$/i, '').replace(/\/+$/, '');
  // Accept both ".../v1" and a bare host; append /v1 only when clearly absent.
  if (!/\/v\d+$/i.test(url) && !/\/(api|openai)$/i.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}

/* --------------------------------------------------------------- timeouts */

/**
 * Nothing here waits forever. A phone talking to a PC across a LAN is the case
 * that matters: a firewall that DROPs (rather than REJECTs) leaves `fetch`
 * hanging with no error and no end, so every request carries its own deadline.
 */
const CONNECT_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 180_000;
const MODELS_TIMEOUT_MS = 20_000;
/** A stream that goes quiet this long is treated as dead. */
const STALL_TIMEOUT_MS = 120_000;

export interface Deadline {
  signal: AbortSignal;
  /** True when *we* aborted on time, as opposed to the user pressing Stop. */
  timedOut: () => boolean;
  /** Restart the clock — used per chunk to detect a stalled stream. */
  bump: (ms?: number) => void;
  done: () => void;
}

export function deadline(userSignal: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  const onUserAbort = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    bump: (next = ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, next);
    },
    done: () => {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    },
  };
}

function timeoutError(provider: Provider, seconds: number, what: string): ProviderError {
  return new ProviderError(
    `${what} timed out after ${seconds}s. ${lanHint(provider.baseUrl)}`,
    undefined,
    'No response before the deadline.',
  );
}

/* ------------------------------------------------------- reachability help */

/** Hosts that only exist on the local network. */
function isLanUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function pageIsHttps(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

/** "This device", whichever device is asking. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A loopback address means "the device running the browser". Copying a base URL
 * that works on the PC over to a phone therefore points the phone at itself,
 * and nothing is listening there. This is only knowable when the page itself
 * came from somewhere else — served from a LAN address, the mismatch is certain
 * rather than a guess.
 */
function loopbackFromAnotherDevice(baseUrl: string): boolean {
  if (typeof location === 'undefined') return false;
  return (
    isLoopbackHost(hostOf(baseUrl)) &&
    !!location.hostname &&
    !isLoopbackHost(location.hostname.toLowerCase())
  );
}

/**
 * A browser on an HTTPS page refuses to open a plain-HTTP connection at all —
 * the request never leaves the device, so there is nothing to diagnose after
 * the fact. Detect it up front and say so precisely instead of reporting a
 * generic network failure the user cannot act on.
 */
function assertReachable(provider: Provider, url: string): void {
  if (loopbackFromAnotherDevice(provider.baseUrl)) {
    throw new ProviderError(
      `${provider.baseUrl} means "this device", so on this device it points at itself — ` +
        'not at the computer running the model. A base URL that works on that computer ' +
        'cannot be copied here unchanged.',
      undefined,
      `Use the other computer's address on your network instead, for example ` +
        `http://${location.hostname}:11434/v1 if the model is running on the same machine ` +
        'that is serving this page.',
    );
  }
  if (pageIsHttps() && url.toLowerCase().startsWith('http://')) {
    throw new ProviderError(
      'Your browser will block this request: this page is served over HTTPS and the ' +
        `endpoint is plain HTTP (${provider.baseUrl}). That is the browser's mixed-content ` +
        'rule and no setting in this app can bypass it.',
      undefined,
      'Open this app over http:// on your LAN, or put the AI endpoint behind HTTPS.',
    );
  }
}

function lanHint(baseUrl: string): string {
  if (!isLanUrl(baseUrl)) {
    return 'Check the base URL, your connection, and whether the endpoint allows browser requests (CORS).';
  }
  return (
    'For a local model on your PC: confirm the server is listening on the network ' +
    'rather than only 127.0.0.1, that you used the PC\'s LAN IP, that the port is open ' +
    'in the firewall, and that the server allows cross-origin requests (CORS).'
  );
}

function buildHeaders(provider: Provider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey.trim()) headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  if (provider.kind === 'openrouter') {
    // OpenRouter attributes traffic with these; harmless elsewhere.
    if (typeof location !== 'undefined') headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Storyline';
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

/**
 * `fetch` reports a blocked request and an unreachable host identically — the
 * browser deliberately withholds the difference. So this explains both real
 * possibilities rather than guessing at one.
 */
function describeNetworkFailure(provider: Provider, err: unknown): ProviderError {
  return new ProviderError(
    `Could not reach ${provider.baseUrl}. ${lanHint(provider.baseUrl)}`,
    undefined,
    err instanceof Error ? err.message : String(err),
  );
}

export interface FetchModelsResult {
  models: string[];
  /** Capability record per model, reported where the provider says so. */
  info: Record<string, ModelInfo>;
}

/**
 * Reads capabilities from a model listing. OpenRouter publishes
 * `architecture.input_modalities`; most others publish nothing, in which case
 * we fall back to inference and mark the record as unreported so the UI can
 * say the capabilities are a guess.
 */
function readCapabilities(raw: unknown, id: string): ModelInfo {
  if (!raw || typeof raw !== 'object') {
    return { id, capabilities: inferCapabilities(id), reported: false };
  }
  const obj = raw as Record<string, any>;
  const modalities: unknown =
    obj.architecture?.input_modalities ?? obj.input_modalities ?? obj.modalities;
  const outputModalities: unknown =
    obj.architecture?.output_modalities ?? obj.output_modalities;

  if (Array.isArray(modalities)) {
    const list = modalities.map((m) => String(m).toLowerCase());
    const outputs = Array.isArray(outputModalities)
      ? outputModalities.map((m) => String(m).toLowerCase())
      : [];
    return {
      id,
      label: typeof obj.name === 'string' ? obj.name : undefined,
      capabilities: defaultCapabilities({
        text: list.includes('text'),
        vision: list.includes('image'),
        imageGeneration: outputs.includes('image'),
        streaming: true,
      }),
      reported: true,
    };
  }

  return {
    id,
    label: typeof obj.name === 'string' ? obj.name : undefined,
    capabilities: inferCapabilities(id),
    reported: false,
  };
}

export async function fetchModels(provider: Provider, signal?: AbortSignal): Promise<FetchModelsResult> {
  const base = normalizeBaseUrl(provider.baseUrl);
  assertReachable(provider, base);
  const url = `${base}/models`;
  const clock = deadline(signal, MODELS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(provider), signal: clock.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      if (clock.timedOut()) throw timeoutError(provider, MODELS_TIMEOUT_MS / 1000, 'Loading models');
      throw err;
    }
    throw describeNetworkFailure(provider, err);
  } finally {
    clock.done();
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
  const info: Record<string, ModelInfo> = {};
  const models = list
    .map((item) => {
      const id =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object'
            ? String(
                (item as Record<string, unknown>).id ??
                  (item as Record<string, unknown>).name ??
                  (item as Record<string, unknown>).model ??
                  '',
              )
            : '';
      if (id) info[id] = readCapabilities(item, id);
      return id;
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!models.length) {
    throw new ProviderError(
      'The endpoint responded, but returned no models. It may not implement /models.',
    );
  }
  return { models: Array.from(new Set(models)), info };
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
  const base = normalizeBaseUrl(provider.baseUrl);
  assertReachable(provider, base);
  const url = `${base}/chat/completions`;
  const clock = deadline(options.signal, REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify(buildBody(options, false)),
      signal: clock.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      if (clock.timedOut()) throw timeoutError(provider, REQUEST_TIMEOUT_MS / 1000, 'The request');
      throw err;
    }
    throw describeNetworkFailure(provider, err);
  }

  // The deadline stays armed through the body read: a server can send headers
  // promptly and then stall before the JSON arrives.
  try {
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
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' && clock.timedOut()) {
      throw timeoutError(provider, REQUEST_TIMEOUT_MS / 1000, 'The request');
    }
    throw err;
  } finally {
    clock.done();
  }
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

  const base = normalizeBaseUrl(provider.baseUrl);
  assertReachable(provider, base);
  const url = `${base}/chat/completions`;

  // Two different deadlines: one to get a response at all, then a rolling one
  // that only fires when the stream goes quiet. A long generation is normal;
  // two minutes of silence is not.
  const clock = deadline(options.signal, CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(provider), Accept: 'text/event-stream' },
      body: JSON.stringify(buildBody(options, true)),
      signal: clock.signal,
    });
  } catch (err) {
    clock.done();
    if ((err as Error)?.name === 'AbortError') {
      if (clock.timedOut()) throw timeoutError(provider, CONNECT_TIMEOUT_MS / 1000, 'Connecting');
      throw err;
    }
    throw describeNetworkFailure(provider, err);
  }

  if (!response.ok) {
    clock.done();
    throw await httpError(response);
  }
  clock.bump(STALL_TIMEOUT_MS);

  if (!response.body || typeof response.body.getReader !== 'function') {
    // Some environments (and a few proxies) hand back a buffered body.
    try {
      const text = await response.text();
      const full = parseBufferedStream(text);
      onToken?.(full, full);
      return full;
    } finally {
      clock.done();
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  // Kept so a body that turns out not to be SSE at all can still be salvaged;
  // some gateways ignore `stream: true` and answer with a plain completion.
  let raw = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clock.bump(STALL_TIMEOUT_MS); // bytes arrived — reset the silence clock
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;

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
      if (clock.timedOut()) {
        // Silence, not a user stop. Keep the partial text if there is any,
        // otherwise say plainly that the endpoint went quiet.
        if (full.trim()) return full;
        throw timeoutError(provider, STALL_TIMEOUT_MS / 1000, 'The stream');
      }
      // A stopped generation keeps whatever text already arrived.
      return full;
    }
    throw new ProviderError(
      'The response stream was interrupted.',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clock.done();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (!full.trim()) {
    // Not SSE after all. Read it as a normal completion body before giving up —
    // reporting "empty response" for a perfectly good reply is worse than slow.
    const salvaged = parseBufferedStream(raw).trim();
    if (salvaged) {
      onToken?.(salvaged, salvaged);
      return salvaged;
    }
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
