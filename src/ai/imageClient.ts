/**
 * Image generation.
 *
 * Deliberately separate from the text client: people routinely run text on one
 * service and images on another, so the two provider lists, keys and models are
 * configured independently.
 *
 * Three request shapes are supported behind one interface:
 *   openai  — POST /images/generations, response {data:[{b64_json|url}]}
 *   gemini  — POST /models/{model}:generateContent, inlineData in the parts
 *   custom  — POST to whatever URL is configured; the response is scanned for
 *             a base64 payload, a data URL or an image URL anywhere in the JSON
 */

import type { AspectRatio, ImageProvider } from '../types';
import { ASPECT_RATIOS } from '../types';
import { deadline } from './client';

/** Diffusion is slow; this is a ceiling, not an expectation. */
const IMAGE_TIMEOUT_MS = 240_000;
const IMAGE_MODELS_TIMEOUT_MS = 20_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

export class ImageError extends Error {
  readonly status?: number;
  readonly detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
    this.detail = detail;
  }
}

export interface GenerateImageOptions {
  provider: ImageProvider;
  prompt: string;
  aspect?: AspectRatio;
  negativePrompt?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  blob: Blob;
  mimeType: string;
  /** The prompt actually sent, including any provider suffix. */
  prompt: string;
  model: string;
}

function sizeFor(aspect: AspectRatio): string {
  return ASPECT_RATIOS.find((entry) => entry.value === aspect)?.size ?? '1024x1024';
}

function dimensionsFor(aspect: AspectRatio): { width: number; height: number } {
  const [width, height] = sizeFor(aspect).split('x').map(Number);
  return { width, height };
}

function normalizeBaseUrl(provider: ImageProvider): string {
  let url = provider.baseUrl.trim().replace(/\/+$/, '');
  if (!url) throw new ImageError('This image provider has no base URL configured.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function buildHeaders(provider: ImageProvider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = provider.apiKey.trim();
  if (key) {
    // Gemini authenticates with its own header rather than a bearer token.
    if (provider.kind === 'gemini') headers['x-goog-api-key'] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  for (const [name, value] of Object.entries(provider.extraHeaders ?? {})) {
    if (name.trim()) headers[name] = value;
  }
  return headers;
}

/** Composes the final prompt: user text + provider house style. */
export function composePrompt(provider: ImageProvider, prompt: string): string {
  const suffix = provider.promptSuffix.trim();
  const base = prompt.trim();
  if (!base) throw new ImageError('The image prompt is empty.');
  return suffix ? `${base}\n\n${suffix}` : base;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const clean = base64.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Walks an arbitrary JSON response looking for image data. Custom endpoints
 * vary wildly, so rather than demanding one shape we search for the first
 * plausible payload: inline base64, a data URL, or an http(s) image URL.
 */
function findImagePayload(
  value: unknown,
  depth = 0,
  /** True when we arrived here via a key that names image data explicitly. */
  trusted = false,
): { kind: 'base64' | 'url'; value: string; mimeType?: string } | null {
  if (depth > 6) return null;

  if (typeof value === 'string') {
    if (/^data:image\/[a-z+]+;base64,/i.test(value)) {
      const mimeType = /^data:(image\/[a-z+]+);/i.exec(value)?.[1] ?? 'image/png';
      return { kind: 'base64', value, mimeType };
    }
    if (/^https?:\/\/\S+$/i.test(value) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(value)) {
      return { kind: 'url', value };
    }
    // Bare base64 with no data-URL prefix. Under a key that explicitly names
    // image data we trust any valid-looking payload; elsewhere we require some
    // length so a stray identifier is not mistaken for an image.
    const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(value);
    if (looksBase64 && (trusted ? value.length > 16 : value.length > 256)) {
      return { kind: 'base64', value, mimeType: 'image/png' };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImagePayload(item, depth + 1, trusted);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Check the well-known keys first so we don't return a stray URL field.
    for (const key of ['b64_json', 'inlineData', 'inline_data', 'image', 'data', 'url']) {
      if (key in obj) {
        // 'data' is often just a wrapper array, so only the leaf keys grant trust.
        const grantsTrust = key !== 'data' && key !== 'url';
        const found = findImagePayload(obj[key], depth + 1, trusted || grantsTrust);
        if (found) {
          const mime = typeof obj.mimeType === 'string' ? obj.mimeType : undefined;
          return mime && found.kind === 'base64' ? { ...found, mimeType: mime } : found;
        }
      }
    }
    for (const nested of Object.values(obj)) {
      const found = findImagePayload(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? text.slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return '';
  }
}

function httpError(status: number, detail: string): ImageError {
  const messages: Record<number, string> = {
    400: 'The image provider rejected the request (400). The model name, size or prompt may be unsupported.',
    401: 'Authentication failed (401). Check the image provider API key.',
    402: 'Payment required (402). The image account may be out of credit.',
    403: 'Access denied (403). The key may lack permission for this image model.',
    404: 'Image endpoint or model not found (404). Check the base URL and model name.',
    429: 'Rate limited (429). Wait a moment and try again.',
    500: 'The image provider had a server error (500).',
    503: 'The image provider is unavailable (503).',
  };
  return new ImageError(
    messages[status] ?? `Image generation failed with HTTP ${status}.`,
    status,
    detail,
  );
}

async function post(
  url: string,
  provider: ImageProvider,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  // Diffusion can legitimately run for minutes, but not forever.
  const clock = deadline(signal, IMAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify(body),
      signal: clock.signal,
    });
  } catch (err) {
    clock.done();
    if ((err as Error)?.name === 'AbortError') {
      if (clock.timedOut()) {
        throw new ImageError(
          `The image provider did not respond within ${IMAGE_TIMEOUT_MS / 1000}s.`,
        );
      }
      throw err;
    }
    throw new ImageError(
      `Could not reach ${provider.baseUrl}. Check the URL, your connection, and any CORS restrictions.`,
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    if (!response.ok) throw httpError(response.status, await readError(response));
    return await response.json().catch(() => {
      throw new ImageError('The image provider returned a response that was not valid JSON.');
    });
  } finally {
    clock.done();
  }
}

export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage> {
  const { provider, signal } = options;
  const aspect = options.aspect ?? provider.defaultAspect;
  const prompt = composePrompt(provider, options.prompt);
  const negative = (options.negativePrompt ?? provider.negativePrompt).trim();

  if (!provider.model.trim()) {
    throw new ImageError('No image model is selected for this provider.');
  }

  const base = normalizeBaseUrl(provider);
  let payload: unknown;

  if (provider.kind === 'gemini') {
    // Gemini takes the prompt as generateContent parts and returns inlineData.
    const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent`;
    const text = negative ? `${prompt}\n\nAvoid: ${negative}` : prompt;
    payload = await post(
      url,
      provider,
      {
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['IMAGE'], ...(provider.extraBody ?? {}) },
      },
      signal,
    );
  } else {
    const url =
      provider.kind === 'custom' && /\/(generate|images?|predictions?)\b/i.test(base)
        ? base // a custom endpoint may already be the full path
        : `${base.replace(/\/v\d+$/, (v) => v)}/images/generations`;
    const { width, height } = dimensionsFor(aspect);
    payload = await post(
      url,
      provider,
      {
        model: provider.model,
        prompt,
        n: 1,
        size: sizeFor(aspect),
        width,
        height,
        ...(negative ? { negative_prompt: negative } : {}),
        ...(provider.extraBody ?? {}),
      },
      signal,
    );
  }

  const found = findImagePayload(payload);
  if (!found) {
    throw new ImageError(
      'The image provider responded, but no image data could be found in the reply.',
      undefined,
      JSON.stringify(payload)?.slice(0, 300),
    );
  }

  if (found.kind === 'base64') {
    return {
      blob: base64ToBlob(found.value, found.mimeType ?? 'image/png'),
      mimeType: found.mimeType ?? 'image/png',
      prompt,
      model: provider.model,
    };
  }

  // A URL response still needs fetching, and that request is subject to the
  // provider's CORS policy — surface that clearly rather than failing opaquely.
  const downloadClock = deadline(signal, IMAGE_DOWNLOAD_TIMEOUT_MS);
  let imageResponse: Response;
  try {
    imageResponse = await fetch(found.value, { signal: downloadClock.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' && !downloadClock.timedOut()) throw err;
    throw new ImageError(
      'The provider returned an image URL that this browser could not download. ' +
        'That is usually a CORS restriction on the image host — choose a provider ' +
        'that returns base64 image data instead.',
      undefined,
      found.value,
    );
  }
  try {
    if (!imageResponse.ok) {
      throw new ImageError(
        `Downloading the generated image failed with HTTP ${imageResponse.status}.`,
      );
    }
    const blob = await imageResponse.blob();
    return { blob, mimeType: blob.type || 'image/png', prompt, model: provider.model };
  } finally {
    downloadClock.done();
  }
}

export interface ImageTestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

/**
 * Verifies configuration without burning a full generation where possible:
 * we ask for the model list, and fall back to reporting what we can check.
 */
export async function testImageProvider(provider: ImageProvider): Promise<ImageTestResult> {
  if (!provider.baseUrl.trim()) {
    return { ok: false, message: 'No base URL is configured.' };
  }
  if (!provider.model.trim()) {
    return { ok: false, message: 'No image model is configured.' };
  }
  try {
    const models = await fetchImageModels(provider);
    return {
      ok: true,
      message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} listed.`,
    };
  } catch (err) {
    const error = err instanceof ImageError ? err : null;
    // A 404 on /models is normal for image-only endpoints, and says nothing
    // about whether generation works.
    if (error?.status === 404) {
      return {
        ok: true,
        message:
          'The endpoint is reachable but does not list models. That is normal for image-only ' +
          'services — generate an image to confirm the model name is right.',
      };
    }
    return {
      ok: false,
      message: error?.message ?? (err as Error).message,
      detail: error?.detail,
    };
  }
}

export async function fetchImageModels(provider: ImageProvider): Promise<string[]> {
  const base = normalizeBaseUrl(provider);
  const url = `${base}/models`;
  const clock = deadline(undefined, IMAGE_MODELS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(provider), signal: clock.signal });
  } catch (err) {
    clock.done();
    throw new ImageError(
      clock.timedOut()
        ? `${provider.baseUrl} did not respond within ${IMAGE_MODELS_TIMEOUT_MS / 1000}s.`
        : `Could not reach ${provider.baseUrl}.`,
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  }
  clock.done();
  if (!response.ok) throw httpError(response.status, await readError(response));
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
        // Gemini returns "models/gemini-…"; strip the prefix for display.
        return String(obj.id ?? obj.name ?? obj.model ?? '').replace(/^models\//, '');
      }
      return '';
    })
    .filter(Boolean);

  if (!models.length) {
    throw new ImageError('The endpoint responded but listed no models.', 404);
  }
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(16, key.length - 8))}${key.slice(-4)}`;
}
