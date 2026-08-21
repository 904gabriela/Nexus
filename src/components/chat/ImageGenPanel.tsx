import { useEffect, useMemo, useState } from 'react';
import type { AspectRatio, Character, ID, MediaMeta } from '../../types';
import { ASPECT_RATIOS } from '../../types';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Banner, Tabs } from '../ui/common';
import { SelectField } from '../ui/Field';
import { useConfirm } from '../ui/Confirm';
import { MediaImage } from '../media/MediaImage';
import { useActions, useAppState } from '../../state/store';
import { buildPrompt, type ImagePromptKind, type ScenePromptInput } from '../../ai/promptBuilder';
import type { UseGeneration } from '../../hooks/useGeneration';

const KINDS: Array<{ id: ImagePromptKind; label: string }> = [
  { id: 'scene', label: 'Scene' },
  { id: 'character', label: 'Character' },
  { id: 'persona', label: 'Persona' },
  { id: 'custom', label: 'Custom' },
];

/**
 * Generate an image for the current scene.
 *
 * The prompt is assembled from live story state and then handed to the user to
 * edit — they can always see and change exactly what will be sent.
 */
export function ImageGenPanel({
  open,
  onClose,
  gen,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  gen: UseGeneration;
  onOpenSettings: () => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const { timeline } = { timeline: gen.recentTimeline };

  const [kind, setKind] = useState<ImagePromptKind>('scene');
  const [focusCharacterId, setFocusCharacterId] = useState<ID | ''>('');
  const [prompt, setPrompt] = useState('');
  const [touched, setTouched] = useState(false);
  const [aspect, setAspect] = useState<AspectRatio>(
    gen.imageProvider?.defaultAspect ?? 'portrait',
  );
  const [result, setResult] = useState<MediaMeta | null>(null);

  const promptInput: ScenePromptInput = useMemo(
    () => ({
      story: gen.story,
      chat: null,
      characters: gen.characters,
      persona: gen.persona,
      summary: gen.summary,
      recentMessages: timeline,
      focusCharacterId: focusCharacterId || gen.characters[0]?.id || null,
    }),
    [gen.story, gen.characters, gen.persona, gen.summary, timeline, focusCharacterId],
  );

  // Rebuild the suggested prompt whenever the kind changes, unless the user
  // has already edited it — never silently discard their wording.
  useEffect(() => {
    if (touched) return;
    setPrompt(buildPrompt(kind, promptInput));
  }, [kind, promptInput, touched]);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setTouched(false);
    }
  }, [open]);

  const regenerateSuggestion = () => {
    setPrompt(buildPrompt(kind, promptInput));
    setTouched(false);
  };

  const focusCharacter: Character | null =
    gen.characters.find((c) => c.id === (focusCharacterId || gen.characters[0]?.id)) ?? null;

  const run = async () => {
    const meta = await gen.createImage({
      prompt,
      aspect,
      characterId: kind === 'character' ? (focusCharacter?.id ?? null) : null,
      personaId: kind === 'persona' ? (gen.persona?.id ?? null) : null,
    });
    if (meta) setResult(meta);
  };

  const attachToChat = async () => {
    if (!result) return;
    await actions.appendMessage({
      role: 'user',
      content: '',
      attachments: [
        {
          id: `att_${result.id}`,
          kind: 'image',
          mediaId: result.id,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
        },
      ],
    });
    actions.toast({ kind: 'success', title: 'Image added to the conversation' });
    onClose();
  };

  const applyImageTo = async (target: 'character' | 'persona' | 'cover' | 'background') => {
    if (!result) return;
    if (target === 'character' && focusCharacter) {
      await actions.saveCharacter({ ...focusCharacter, avatarMediaId: result.id });
      actions.toast({ kind: 'success', title: `Set as ${focusCharacter.name}'s avatar` });
    } else if (target === 'persona' && gen.persona) {
      await actions.savePersona({ ...gen.persona, avatarMediaId: result.id });
      actions.toast({ kind: 'success', title: `Set as ${gen.persona.name}'s avatar` });
    } else if (gen.story && (target === 'cover' || target === 'background')) {
      await actions.saveStory({
        ...gen.story,
        ...(target === 'cover'
          ? { coverMediaId: result.id }
          : { backgroundMediaId: result.id }),
      });
      actions.toast({
        kind: 'success',
        title: target === 'cover' ? 'Set as story cover' : 'Set as chat background',
      });
    }
  };

  const discard = async () => {
    if (!result) return;
    const ok = await confirm({
      title: 'Delete this image?',
      message: <p style={{ margin: 0 }}>The generated image will be removed from your library.</p>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await actions.removeMedia(result.id);
    setResult(null);
  };

  const noProvider = !gen.imageProvider;

  return (
    <Sheet
      open={open}
      onClose={gen.generatingImage ? () => {} : onClose}
      title="Generate image"
      large
      hideClose={gen.generatingImage}
      footer={
        result ? (
          <>
            <button type="button" className="btn btn-danger" onClick={discard}>
              <Icon name="trash" />
              Delete
            </button>
            <button type="button" className="btn" onClick={run} disabled={gen.generatingImage}>
              <Icon name="refresh" />
              Regenerate
            </button>
            <button type="button" className="btn btn-primary" onClick={attachToChat}>
              <Icon name="send" />
              Add to chat
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={gen.generatingImage ? gen.stopImage : onClose}
            >
              {gen.generatingImage ? 'Stop' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={run}
              disabled={noProvider || gen.generatingImage || !prompt.trim()}
            >
              {gen.generatingImage ? <span className="spinner" /> : <Icon name="sparkle" />}
              {gen.generatingImage ? 'Generating…' : 'Generate'}
            </button>
          </>
        )
      }
    >
      {noProvider ? (
        <Banner
          kind="warn"
          title="No image provider configured"
          action={
            <button type="button" className="btn btn-sm btn-primary" onClick={onOpenSettings}>
              <Icon name="settings" />
              Set up image generation
            </button>
          }
        >
          Image generation uses its own provider, separate from your text model. Add one in
          Settings → Image Generation.
        </Banner>
      ) : (
        <p className="small muted" style={{ marginTop: 0 }}>
          Using <strong>{gen.imageProvider!.name}</strong> · {gen.imageProvider!.model}
        </p>
      )}

      {result ? (
        <>
          <MediaImage
            mediaId={result.id}
            alt="Generated image"
            style={{
              width: '100%',
              maxHeight: '46dvh',
              objectFit: 'contain',
              borderRadius: 12,
              background: 'var(--bg-input)',
              marginBottom: 12,
            }}
          />
          <details>
            <summary className="small muted" style={{ cursor: 'pointer', minHeight: 34 }}>
              Prompt used
            </summary>
            <pre className="ctx-part-body mono" style={{ marginTop: 8, borderRadius: 8 }}>
              {result.prompt}
            </pre>
          </details>

          <h3 className="section-title" style={{ marginTop: 16 }}>
            Use this image
          </h3>
          <div className="btn-row">
            {focusCharacter && (
              <button type="button" className="btn btn-sm" onClick={() => applyImageTo('character')}>
                <Icon name="users" />
                {focusCharacter.name}'s avatar
              </button>
            )}
            {gen.persona && (
              <button type="button" className="btn btn-sm" onClick={() => applyImageTo('persona')}>
                <Icon name="user" />
                Persona avatar
              </button>
            )}
            {gen.story && (
              <>
                <button type="button" className="btn btn-sm" onClick={() => applyImageTo('cover')}>
                  <Icon name="book" />
                  Story cover
                </button>
                <button type="button" className="btn btn-sm" onClick={() => applyImageTo('background')}>
                  <Icon name="image" />
                  Chat background
                </button>
              </>
            )}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            The image is already saved to your Media library.
          </p>
        </>
      ) : (
        <>
          <Tabs tabs={KINDS} active={kind} onChange={setKind} label="Image type" />

          {kind === 'character' && gen.characters.length > 1 && (
            <SelectField
              label="Character"
              value={focusCharacterId || gen.characters[0].id}
              onChange={(value) => {
                setFocusCharacterId(value);
                setTouched(false);
              }}
              options={gen.characters.map((c) => ({ value: c.id, label: c.name || 'Unnamed' }))}
            />
          )}

          {kind === 'persona' && !gen.persona && (
            <Banner kind="warn" title="No persona assigned">
              This story has no persona, so there is nothing to draw. Assign one in the story editor.
            </Banner>
          )}

          <div className="field">
            <div className="row row-between" style={{ marginBottom: 6 }}>
              <label className="field-label" htmlFor="image-prompt" style={{ marginBottom: 0 }}>
                {kind === 'custom' ? 'Prompt' : 'Generated prompt'}
              </label>
              {kind !== 'custom' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={regenerateSuggestion}
                >
                  <Icon name="refresh" />
                  Rebuild from scene
                </button>
              )}
            </div>
            <textarea
              id="image-prompt"
              className="textarea textarea-lg"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setTouched(true);
              }}
              placeholder={
                kind === 'custom'
                  ? 'Describe the image you want…'
                  : 'The prompt is built from your story — edit it freely.'
              }
              aria-label="Image prompt"
            />
            <div className="field-hint">
              {kind === 'scene'
                ? 'Built from the story, the cast, their appearance and the last few messages.'
                : kind === 'custom'
                  ? 'Nothing is added automatically — this is exactly what gets sent.'
                  : 'Built from the character sheet. Edit anything you like before generating.'}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Aspect ratio</span>
            <div className="chip-row">
              {ASPECT_RATIOS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`chip ${aspect === option.value ? 'chip-accent' : ''}`}
                  style={{ cursor: 'pointer', minHeight: 40, padding: '0 14px' }}
                  aria-pressed={aspect === option.value}
                  onClick={() => setAspect(option.value)}
                >
                  {option.label}
                  <span className="muted" style={{ marginLeft: 6, fontSize: '0.85em' }}>
                    {option.size}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {!!state.media.filter((m) => m.source === 'generated').length && (
            <p className="small muted">
              {state.media.filter((m) => m.source === 'generated').length} generated image(s) already
              in your Media library.
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
