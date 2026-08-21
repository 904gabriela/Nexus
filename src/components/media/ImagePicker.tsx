import { useRef, useState } from 'react';
import type { ID, MediaOwnerType } from '../../types';
import { IMAGE_ACCEPT_ATTR, MediaError, replaceMedia, saveMedia } from '../../media/mediaStore';
import { useActions, useAppState } from '../../state/store';
import { useConfirm } from '../ui/Confirm';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { MediaImage, useMediaUrl } from './MediaImage';
import { formatBytes, formatDate } from '../../utils/text';

interface ImagePickerProps {
  label: string;
  mediaId: ID | null;
  onChange: (mediaId: ID | null) => void;
  ownerType: MediaOwnerType;
  ownerId?: ID | null;
  /** Circular preview for avatars, wide for covers/backgrounds. */
  shape?: 'round' | 'square' | 'wide';
  /** Optional advanced URL field (characters/personas keep this secondary). */
  urlValue?: string;
  onUrlChange?: (url: string) => void;
  hint?: string;
}

/**
 * The single image-input component used everywhere.
 *
 * Works on desktop, Android, iPhone and iPad. The primary control is a plain
 * `<input type="file" accept="image/*">` with no `capture` attribute, which is
 * what makes iOS and Android offer the photo library rather than forcing the
 * camera. A separate, clearly-labelled control sets `capture` for taking a new
 * photo, and is only offered on devices that report a camera.
 */
export function ImagePicker({
  label,
  mediaId,
  onChange,
  ownerType,
  ownerId = null,
  shape = 'square',
  urlValue,
  onUrlChange,
  hint,
}: ImagePickerProps) {
  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const { actions } = { actions: useActions() };
  const state = useAppState();
  const confirm = useConfirm();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [preview, setPreview] = useState(false);
  const { url: currentUrl } = useMediaUrl(mediaId);

  // Camera capture only makes sense on a device that has one.
  const hasCamera =
    typeof navigator !== 'undefined' &&
    (('mediaDevices' in navigator && !!navigator.mediaDevices) ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? ''));

  const handleFile = async (file: File | undefined, mode: 'new' | 'replace') => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'replace' && mediaId) {
        await replaceMedia(mediaId, file);
        // Same id, new bytes: nudge consumers so cached URLs refresh.
        onChange(null);
        setTimeout(() => onChange(mediaId), 0);
      } else {
        const meta = await saveMedia(file, { ownerType, ownerId });
        onChange(meta.id);
      }
      await actions.refreshMedia();
    } catch (err) {
      const message =
        err instanceof MediaError
          ? err.message
          : `The image could not be saved: ${(err as Error).message}`;
      setError(message);
      actions.toast({ kind: 'error', title: 'Image upload failed', detail: message });
    } finally {
      setBusy(false);
      if (galleryInput.current) galleryInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Remove this image?',
      message: (
        <p style={{ margin: 0 }}>
          The picture stays in your Media Library — this only detaches it from {label.toLowerCase()}.
        </p>
      ),
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (ok) onChange(null);
  };

  const shapeClass = shape === 'round' ? 'round' : shape === 'wide' ? 'wide' : '';

  return (
    <div className="field">
      <span className="field-label">{label}</span>

      <div className="image-picker">
        <button
          type="button"
          className={`image-picker-preview ${shapeClass}`}
          onClick={() => (mediaId ? setPreview(true) : galleryInput.current?.click())}
          aria-label={mediaId ? `Preview ${label}` : `Add an image for ${label}`}
          disabled={busy}
        >
          {busy ? (
            <span className="spinner" />
          ) : mediaId ? (
            <MediaImage mediaId={mediaId} alt={label} />
          ) : urlValue ? (
            <img src={urlValue} alt={label} onError={(e) => (e.currentTarget.style.display = 'none')} />
          ) : (
            <Icon name="image" width={26} height={26} />
          )}
        </button>

        <div className="image-picker-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => galleryInput.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" />
            {mediaId ? 'Choose another' : 'Upload from device'}
          </button>

          {hasCamera && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => cameraInput.current?.click()}
              disabled={busy}
            >
              <Icon name="camera" />
              Take photo
            </button>
          )}

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowLibrary(true)}
            disabled={busy || !state.media.length}
          >
            <Icon name="grid" />
            Media Library
            {state.media.length ? ` (${state.media.length})` : ''}
          </button>

          {mediaId && (
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPreview(true)}
                disabled={busy}
              >
                <Icon name="eye" />
                Preview
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={remove} disabled={busy}>
                <Icon name="x" />
                Remove
              </button>
            </div>
          )}
        </div>
      </div>

      {/*
        No `capture` attribute: this is what lets iOS/Android show the photo
        library ("Photo Library" / "Files") instead of jumping to the camera.
      */}
      <input
        ref={galleryInput}
        type="file"
        accept={IMAGE_ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void handleFile(e.target.files?.[0], mediaId ? 'replace' : 'new')}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void handleFile(e.target.files?.[0], mediaId ? 'replace' : 'new')}
      />

      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      {hint && !error && <div className="field-hint">{hint}</div>}

      {onUrlChange && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowUrl((v) => !v)}
            aria-expanded={showUrl}
          >
            <Icon name={showUrl ? 'chevronUp' : 'chevronDown'} />
            Advanced: use an image URL instead
          </button>
          {showUrl && (
            <div style={{ marginTop: 6 }}>
              <input
                className="input"
                type="url"
                inputMode="url"
                placeholder="https://example.com/portrait.png"
                value={urlValue ?? ''}
                onChange={(e) => onUrlChange(e.target.value)}
                aria-label={`${label} image URL`}
              />
              <div className="field-hint">
                A remote URL is only shown when no uploaded image is set, and it needs the internet to
                load. Uploading is recommended.
              </div>
            </div>
          )}
        </div>
      )}

      <MediaLibraryPicker
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        onPick={(id) => {
          onChange(id);
          setShowLibrary(false);
        }}
      />

      {preview && (currentUrl || urlValue) && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${label} preview`}
          onClick={() => setPreview(false)}
        >
          <img src={currentUrl ?? urlValue!} alt={label} />
          <button type="button" aria-label="Close preview" onClick={() => setPreview(false)}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Grid picker over everything already in the media store. */
export function MediaLibraryPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (mediaId: ID) => void;
}) {
  const state = useAppState();
  const [query, setQuery] = useState('');
  const filtered = state.media.filter((m) =>
    query.trim() ? m.filename.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  return (
    <Sheet open={open} onClose={onClose} title="Choose from Media Library" large>
      <input
        className="input"
        placeholder="Search by filename…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search media"
        style={{ marginBottom: 12 }}
      />
      {!filtered.length ? (
        <div className="empty-state">
          <Icon name="image" />
          <h3>No images {query ? 'match that search' : 'yet'}</h3>
          <p>
            {query
              ? 'Try a different filename.'
              : 'Upload an image anywhere in the app and it will appear here.'}
          </p>
        </div>
      ) : (
        <div className="media-grid">
          {filtered.map((meta) => (
            <button
              key={meta.id}
              type="button"
              className="media-tile"
              onClick={() => onPick(meta.id)}
              title={`${meta.filename} · ${formatBytes(meta.size)} · ${formatDate(meta.createdAt)}`}
            >
              <MediaImage mediaId={meta.id} alt={meta.filename} />
              <figcaption>{meta.filename}</figcaption>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
