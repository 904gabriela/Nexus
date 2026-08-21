import { useMemo, useRef, useState } from 'react';
import type { MediaMeta } from '../types';
import { useActions, useAppState } from '../state/store';
import { MediaImage, useMediaUrl } from '../components/media/MediaImage';
import { Icon } from '../components/ui/Icon';
import { EmptyState, SearchInput } from '../components/ui/common';
import { SelectField } from '../components/ui/Field';
import { ActionSheet, Sheet } from '../components/ui/Sheet';
import { useConfirm } from '../components/ui/Confirm';
import { IMAGE_ACCEPT_ATTR, MediaError, replaceMedia, saveMedia } from '../media/mediaStore';
import { downloadFile } from '../exporters';
import { getMediaBlob } from '../media/mediaStore';
import { formatBytes, formatDate } from '../utils/text';

type Usage = { label: string; where: string };

export function MediaPage() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const uploadInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'generated' | MediaMeta['ownerType']>('all');
  const [preview, setPreview] = useState<MediaMeta | null>(null);
  const [menuFor, setMenuFor] = useState<MediaMeta | null>(null);
  const [reuseFor, setReuseFor] = useState<MediaMeta | null>(null);
  const [uploading, setUploading] = useState(false);

  const usageOf = useMemo(() => {
    const map = new Map<string, Usage[]>();
    const push = (id: string | null, usage: Usage) => {
      if (!id) return;
      const list = map.get(id);
      if (list) list.push(usage);
      else map.set(id, [usage]);
    };
    for (const character of state.characters) {
      push(character.avatarMediaId, { label: character.name || 'Unnamed', where: 'Character avatar' });
    }
    for (const persona of state.personas) {
      push(persona.avatarMediaId, { label: persona.name || 'Unnamed', where: 'Persona avatar' });
    }
    for (const story of state.stories) {
      push(story.coverMediaId, { label: story.title || 'Untitled', where: 'Story cover' });
      push(story.backgroundMediaId, { label: story.title || 'Untitled', where: 'Story background' });
    }
    for (const message of state.messages) {
      for (const attachment of message.attachments ?? []) {
        push(attachment.mediaId, { label: 'Chat message', where: 'Attachment' });
      }
    }
    return map;
  }, [state.characters, state.personas, state.stories, state.messages]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.media.filter((meta) => {
      // 'generated' cuts across owner types: a generated image may since have
      // been made someone's avatar.
      if (filter === 'generated') {
        if (meta.source !== 'generated') return false;
      } else if (filter !== 'all' && meta.ownerType !== filter) {
        return false;
      }
      if (!needle) return true;
      return (
        meta.filename.toLowerCase().includes(needle) ||
        (usageOf.get(meta.id) ?? []).some((u) => u.label.toLowerCase().includes(needle))
      );
    });
  }, [state.media, query, filter, usageOf]);

  const totalBytes = state.media.reduce((sum, m) => sum + m.size, 0);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    let added = 0;
    for (const file of Array.from(files)) {
      try {
        await saveMedia(file, { ownerType: 'unassigned' });
        added += 1;
      } catch (err) {
        actions.toast({
          kind: 'error',
          title: `Could not add "${file.name}"`,
          detail: err instanceof MediaError ? err.message : (err as Error).message,
        });
      }
    }
    await actions.refreshMedia();
    setUploading(false);
    if (uploadInput.current) uploadInput.current.value = '';
    if (added) actions.toast({ kind: 'success', title: `Added ${added} image(s)` });
  };

  const doReplace = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !menuFor) return;
    try {
      await replaceMedia(menuFor.id, file);
      await actions.refreshMedia();
      actions.toast({
        kind: 'success',
        title: 'Image replaced',
        detail: 'Everywhere it was used now shows the new picture.',
      });
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Replace failed',
        detail: err instanceof MediaError ? err.message : (err as Error).message,
      });
    } finally {
      if (replaceInput.current) replaceInput.current.value = '';
    }
  };

  const remove = async (meta: MediaMeta) => {
    const uses = usageOf.get(meta.id) ?? [];
    const ok = await confirm({
      title: 'Delete this image?',
      message: (
        <>
          <p style={{ margin: 0 }}>
            <strong>{meta.filename}</strong> will be permanently removed from this device.
          </p>
          {!!uses.length && (
            <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
              It is used by {uses.map((u) => `${u.label} (${u.where})`).join(', ')} — those will lose
              their picture.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await actions.removeMedia(meta.id);
    actions.toast({ kind: 'success', title: 'Image deleted' });
  };

  const orphans = state.media.filter((m) => !(usageOf.get(m.id) ?? []).length);

  return (
    <>
      <div className="page-header">
        <h1>
          Media
          <span className="subtitle">
            {state.media.length} image{state.media.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </span>
        </h1>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => uploadInput.current?.click()}
          disabled={uploading}
        >
          {uploading ? <span className="spinner" /> : <Icon name="upload" />}
          Upload
        </button>
      </div>

      <div className="page">
        <input
          ref={uploadInput}
          type="file"
          accept={IMAGE_ACCEPT_ATTR}
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => void upload(e.target.files)}
        />
        <input
          ref={replaceInput}
          type="file"
          accept={IMAGE_ACCEPT_ATTR}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => void doReplace(e.target.files)}
        />

        <SearchInput value={query} onChange={setQuery} placeholder="Search images…" />

        <div className="chip-row" style={{ marginBottom: 12 }}>
          {(
            [
              ['all', 'All'],
              ['generated', 'Generated'],
              ['character', 'Character avatars'],
              ['persona', 'Persona avatars'],
              ['story-cover', 'Story covers'],
              ['story-background', 'Backgrounds'],
              ['message', 'Chat attachments'],
              ['unassigned', 'Unassigned'],
            ] as const
          ).map(([value, label]) => {
            const count =
              value === 'all'
                ? state.media.length
                : value === 'generated'
                  ? state.media.filter((m) => m.source === 'generated').length
                  : state.media.filter((m) => m.ownerType === value).length;
            if (!count && value !== 'all') return null;
            return (
              <button
                key={value}
                type="button"
                className={`chip ${filter === value ? 'chip-accent' : ''}`}
                style={{ cursor: 'pointer' }}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        {orphans.length > 3 && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row row-between row-wrap">
              <span className="small">
                {orphans.length} image{orphans.length === 1 ? ' is' : 's are'} not used anywhere.
              </span>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete ${orphans.length} unused images?`,
                    message: (
                      <p style={{ margin: 0 }}>
                        These images are not attached to any character, persona, story or message.
                      </p>
                    ),
                    confirmLabel: 'Delete unused',
                    destructive: true,
                  });
                  if (!ok) return;
                  for (const meta of orphans) await actions.removeMedia(meta.id);
                  actions.toast({ kind: 'success', title: `Deleted ${orphans.length} images` });
                }}
              >
                <Icon name="trash" />
                Clean up
              </button>
            </div>
          </div>
        )}

        {!filtered.length ? (
          <EmptyState
            icon="image"
            title={state.media.length ? 'No images match' : 'No images yet'}
            message="Every picture you upload for a character, persona, story or chat lands here."
            action={
              <button type="button" className="btn btn-primary" onClick={() => uploadInput.current?.click()}>
                <Icon name="upload" />
                Upload images
              </button>
            }
          />
        ) : (
          <div className="media-grid">
            {filtered.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className="media-tile"
                onClick={() => setPreview(meta)}
                aria-label={`Preview ${meta.filename}`}
              >
                <MediaImage mediaId={meta.id} alt={meta.filename} />
                <figcaption>{meta.filename}</figcaption>
              </button>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <MediaDetail
          meta={preview}
          usage={usageOf.get(preview.id) ?? []}
          onClose={() => setPreview(null)}
          onMenu={() => {
            setMenuFor(preview);
            setPreview(null);
          }}
        />
      )}

      {reuseFor && <ReuseSheet meta={reuseFor} onClose={() => setReuseFor(null)} />}

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.filename ?? ''}
        actions={
          menuFor
            ? [
                {
                  key: 'replace',
                  label: 'Replace image',
                  description: 'Keeps every existing reference and swaps the picture.',
                  icon: 'refresh',
                  onSelect: () => replaceInput.current?.click(),
                },
                {
                  key: 'reuse',
                  label: 'Use this image',
                  description: 'Set it as an avatar, story cover or background.',
                  icon: 'target',
                  onSelect: () => setReuseFor(menuFor),
                },
                {
                  key: 'download',
                  label: 'Download',
                  icon: 'download',
                  onSelect: async () => {
                    const blob = await getMediaBlob(menuFor.id);
                    if (blob) downloadFile(menuFor.filename, blob, menuFor.mimeType);
                    else actions.toast({ kind: 'error', title: 'The image data is missing.' });
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: 'trash',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => remove(menuFor),
                },
              ]
            : []
        }
      />
    </>
  );
}

function MediaDetail({
  meta,
  usage,
  onClose,
  onMenu,
}: {
  meta: MediaMeta;
  usage: Usage[];
  onClose: () => void;
  onMenu: () => void;
}) {
  const { url } = useMediaUrl(meta.id);
  return (
    <Sheet
      open
      onClose={onClose}
      title={meta.filename}
      large
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={onMenu}>
            <Icon name="more" />
            Actions
          </button>
        </>
      }
    >
      {url && (
        <img
          src={url}
          alt={meta.filename}
          style={{
            width: '100%',
            maxHeight: '46dvh',
            objectFit: 'contain',
            borderRadius: 12,
            background: 'var(--bg-input)',
            marginBottom: 14,
          }}
        />
      )}
      <div className="stack">
        <Row label="Source" value={meta.source === 'generated' ? 'AI generated' : 'Uploaded'} />
        {meta.source === 'generated' && meta.imageModel && (
          <Row label="Model" value={meta.imageModel} />
        )}
        <Row label="Type" value={meta.mimeType} />
        <Row label="Size" value={formatBytes(meta.size)} />
        <Row
          label="Dimensions"
          value={meta.width && meta.height ? `${meta.width} × ${meta.height}` : 'Unknown'}
        />
        <Row label="Added" value={formatDate(meta.createdAt)} />
        <Row label="Identifier" value={meta.id} mono />
        {meta.prompt && (
          <div>
            <div className="small muted">Prompt</div>
            <pre className="ctx-part-body mono" style={{ borderRadius: 8, maxHeight: 160 }}>
              {meta.prompt}
            </pre>
          </div>
        )}
        <div>
          <div className="small muted">Used by</div>
          {!usage.length ? (
            <span className="chip chip-warn">Not used anywhere</span>
          ) : (
            <div className="chip-row">
              {usage.map((u, i) => (
                <span className="chip" key={i}>
                  {u.label} — {u.where}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row row-between">
      <span className="small muted">{label}</span>
      <span className={mono ? 'mono' : 'small'} style={{ textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

/**
 * Attach an existing image to something. This is what makes the gallery a
 * library rather than a dead-end list.
 */
function ReuseSheet({ meta, onClose }: { meta: MediaMeta; onClose: () => void }) {
  const state = useAppState();
  const actions = useActions();
  const [target, setTarget] = useState<'character' | 'persona' | 'cover' | 'background'>(
    'character',
  );
  const [id, setId] = useState('');

  const options =
    target === 'character'
      ? state.characters.map((c) => ({ value: c.id, label: c.name || 'Unnamed' }))
      : target === 'persona'
        ? state.personas.map((p) => ({ value: p.id, label: p.name || 'Unnamed' }))
        : state.stories.map((s) => ({ value: s.id, label: s.title || 'Untitled' }));

  const apply = async () => {
    if (!id) return;
    if (target === 'character') {
      const character = state.characters.find((c) => c.id === id);
      if (character) await actions.saveCharacter({ ...character, avatarMediaId: meta.id });
    } else if (target === 'persona') {
      const persona = state.personas.find((p) => p.id === id);
      if (persona) await actions.savePersona({ ...persona, avatarMediaId: meta.id });
    } else {
      const story = state.stories.find((s) => s.id === id);
      if (story) {
        await actions.saveStory({
          ...story,
          ...(target === 'cover' ? { coverMediaId: meta.id } : { backgroundMediaId: meta.id }),
        });
      }
    }
    actions.toast({ kind: 'success', title: 'Image applied' });
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Use this image"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={!id}>
            <Icon name="check" />
            Apply
          </button>
        </>
      }
    >
      <div className="chip-row" style={{ marginBottom: 14 }}>
        {(
          [
            ['character', 'Character avatar'],
            ['persona', 'Persona avatar'],
            ['cover', 'Story cover'],
            ['background', 'Story background'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`chip ${target === value ? 'chip-accent' : ''}`}
            style={{ cursor: 'pointer', minHeight: 40, padding: '0 14px' }}
            aria-pressed={target === value}
            onClick={() => {
              setTarget(value);
              setId('');
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {!options.length ? (
        <p className="small muted">Nothing to apply this to yet.</p>
      ) : (
        <SelectField
          label={target === 'character' ? 'Character' : target === 'persona' ? 'Persona' : 'Story'}
          value={id}
          onChange={setId}
          options={[{ value: '', label: 'Choose…' }, ...options]}
        />
      )}
    </Sheet>
  );
}
