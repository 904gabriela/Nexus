/**
 * Blob-backed media storage.
 *
 * Images live in IndexedDB as real Blobs — never base64 in localStorage — and
 * are surfaced to the UI through a ref-counted object-URL cache so the same
 * avatar rendered in ten places allocates one URL.
 */

import { STORES, StorageError, dbDelete, dbGet, dbGetAll, dbPut } from '../storage/db';
import type { ID, MediaBlobRow, MediaMeta, MediaOwnerType, MediaSource } from '../types';
import { uid } from '../utils/uid';
import { now } from '../types/factories';

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
];

export const IMAGE_ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/gif,image/*';

/** Hard ceiling per file. Larger images are downscaled before this bites. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Longest edge kept when a source image is bigger. */
export const MAX_IMAGE_EDGE = 1600;

export interface SaveMediaOptions {
  ownerType?: MediaOwnerType;
  ownerId?: ID | null;
  tags?: string[];
  source?: MediaSource;
  prompt?: string;
  imageProviderId?: ID | null;
  imageModel?: string;
  storyId?: ID | null;
  chatId?: ID | null;
  messageId?: ID | null;
  characterId?: ID | null;
  personaId?: ID | null;
  /** Skip downscaling (used when re-importing a backup byte-for-byte). */
  preserveOriginal?: boolean;
  id?: ID;
}

export class MediaError extends Error {
  readonly reason?: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'MediaError';
    this.reason = reason;
  }
}

function isImage(type: string): boolean {
  return type.startsWith('image/');
}

async function readImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      /* fall through to the <img> path */
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return { width: 0, height: 0 };
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/**
 * Downscales oversized images so a photo straight off a phone camera does not
 * eat 8 MB of quota. GIFs are passed through untouched to keep animation.
 */
async function normalizeImage(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number; mimeType: string }> {
  const mimeType = file.type || 'image/png';
  const size = await readImageSize(file);
  const needsResize =
    mimeType !== 'image/gif' &&
    size.width > 0 &&
    Math.max(size.width, size.height) > MAX_IMAGE_EDGE &&
    typeof document !== 'undefined' &&
    typeof createImageBitmap === 'function';

  if (!needsResize) return { blob: file, width: size.width, height: size.height, mimeType };

  try {
    const bitmap = await createImageBitmap(file);
    const scale = MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const outType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outType, 0.9),
    );
    if (!blob) throw new Error('canvas encoding failed');
    return { blob, width, height, mimeType: outType };
  } catch {
    // Resizing is an optimisation; keep the original when it is unavailable.
    return { blob: file, width: size.width, height: size.height, mimeType };
  }
}

export async function saveMedia(
  file: File | Blob,
  options: SaveMediaOptions = {},
): Promise<MediaMeta> {
  const filename = (file as File).name || `image-${Date.now()}.png`;
  const rawType = file.type || 'image/png';

  if (!isImage(rawType)) {
    throw new MediaError(
      `"${filename}" is a ${rawType || 'unknown'} file. Only PNG, JPEG, WEBP and GIF images can be stored.`,
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new MediaError(
      `"${filename}" is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_IMAGE_BYTES / 1024 / 1024
      } MB limit.`,
    );
  }

  const normalized = options.preserveOriginal
    ? { blob: file, mimeType: rawType, ...(await readImageSize(file)) }
    : await normalizeImage(file);

  const meta: MediaMeta = {
    id: options.id ?? uid('med_'),
    filename,
    mimeType: normalized.mimeType,
    size: normalized.blob.size,
    width: normalized.width,
    height: normalized.height,
    ownerType: options.ownerType ?? 'unassigned',
    ownerId: options.ownerId ?? null,
    tags: options.tags ?? [],
    source: options.source ?? 'upload',
    prompt: options.prompt,
    imageProviderId: options.imageProviderId ?? null,
    imageModel: options.imageModel,
    storyId: options.storyId ?? null,
    chatId: options.chatId ?? null,
    messageId: options.messageId ?? null,
    characterId: options.characterId ?? null,
    personaId: options.personaId ?? null,
    createdAt: now(),
    updatedAt: now(),
  };

  try {
    await dbPut<MediaBlobRow>(STORES.mediaBlobs, { id: meta.id, blob: normalized.blob });
    await dbPut(STORES.media, meta);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new MediaError(
        'Saving the image failed — the browser may be out of storage quota. Try removing unused media.',
        err,
      );
    }
    throw err;
  }
  return meta;
}

export async function getMedia(id: ID): Promise<{ meta: MediaMeta; blob: Blob } | null> {
  const [meta, row] = await Promise.all([
    dbGet<MediaMeta>(STORES.media, id),
    dbGet<MediaBlobRow>(STORES.mediaBlobs, id),
  ]);
  if (!meta || !row) return null;
  return { meta, blob: row.blob };
}

export async function getMediaBlob(id: ID): Promise<Blob | null> {
  const row = await dbGet<MediaBlobRow>(STORES.mediaBlobs, id);
  return row?.blob ?? null;
}

export async function listMedia(): Promise<MediaMeta[]> {
  const all = await dbGetAll<MediaMeta>(STORES.media);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteMedia(id: ID): Promise<void> {
  releaseAllFor(id);
  await Promise.all([dbDelete(STORES.media, id), dbDelete(STORES.mediaBlobs, id)]);
}

/** Swaps the bytes behind an existing media id, keeping every reference valid. */
export async function replaceMedia(id: ID, file: File | Blob): Promise<MediaMeta> {
  const existing = await dbGet<MediaMeta>(STORES.media, id);
  if (!existing) throw new MediaError('That image no longer exists.');
  const saved = await saveMedia(file, {
    ownerType: existing.ownerType,
    ownerId: existing.ownerId,
    tags: existing.tags,
    source: existing.source,
    storyId: existing.storyId,
    chatId: existing.chatId,
    messageId: existing.messageId,
    characterId: existing.characterId,
    personaId: existing.personaId,
    id,
  });
  releaseAllFor(id);
  return { ...saved, createdAt: existing.createdAt };
}

export async function updateMediaMeta(
  id: ID,
  patch: Partial<
    Pick<
      MediaMeta,
      | 'ownerType'
      | 'ownerId'
      | 'tags'
      | 'filename'
      | 'storyId'
      | 'chatId'
      | 'messageId'
      | 'characterId'
      | 'personaId'
    >
  >,
): Promise<MediaMeta | null> {
  const existing = await dbGet<MediaMeta>(STORES.media, id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: now() };
  await dbPut(STORES.media, updated);
  return updated;
}

/* ------------------------------------------------------- object URL cache */

interface UrlEntry {
  url: string;
  refs: number;
}

const urlCache = new Map<ID, UrlEntry>();

/** Acquires a cached object URL. Every acquire must be matched by releaseUrl. */
export async function acquireUrl(id: ID): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) {
    cached.refs += 1;
    return cached.url;
  }
  const blob = await getMediaBlob(id);
  if (!blob) return null;
  const existing = urlCache.get(id);
  if (existing) {
    // A concurrent caller won the race; reuse their URL.
    existing.refs += 1;
    return existing.url;
  }
  const url = URL.createObjectURL(blob);
  urlCache.set(id, { url, refs: 1 });
  return url;
}

export function releaseUrl(id: ID): void {
  const entry = urlCache.get(id);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url);
    urlCache.delete(id);
  }
}

/** Force-drops a cached URL (after replace/delete) so viewers refetch. */
export function releaseAllFor(id: ID): void {
  const entry = urlCache.get(id);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  urlCache.delete(id);
}

export function revokeAllUrls(): void {
  for (const [, entry] of urlCache) URL.revokeObjectURL(entry.url);
  urlCache.clear();
}

/* ------------------------------------------------------------ conversions */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new MediaError('Could not read the image data.', reader.error));
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new MediaError('That value is not a valid data URL.');
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const payload = match[3];
  if (!isBase64) return new Blob([decodeURIComponent(payload)], { type: mime });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Imports a base64/data-url image (from V2 data or a backup) into media. */
export async function importDataUrl(
  dataUrl: string,
  options: SaveMediaOptions & { filename?: string } = {},
): Promise<MediaMeta> {
  const blob = await dataUrlToBlob(dataUrl);
  const file =
    typeof File !== 'undefined'
      ? new File([blob], options.filename ?? 'imported-image', { type: blob.type })
      : blob;
  return saveMedia(file, { ...options, preserveOriginal: true });
}
