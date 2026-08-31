import { useMemo, useState } from 'react';
import type { Character, Story, StoryCharacterLink } from '../types';
import { newStory } from '../types/factories';
import { generateOpeningScene } from '../ai/openingScene';
import { useActions, useAppState } from '../state/store';
import { Avatar, MediaImage } from '../components/media/MediaImage';
import { ImagePicker } from '../components/media/ImagePicker';
import { Icon } from '../components/ui/Icon';
import { Banner, EmptyState, SearchInput, Tabs } from '../components/ui/common';
import { SelectField, TagField, TextArea, TextField, Toggle } from '../components/ui/Field';
import { GenerationOverrides } from '../components/ui/GenerationOverrides';
import { ActionSheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { downloadFile, exportFilename, exportStory } from '../exporters';
import { relativeTime, truncate } from '../utils/text';
import type { RouteName } from '../state/router';

export function StoriesPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<Story | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.stories
      .filter((story) => (showArchived ? true : !story.archived))
      .filter((story) =>
        needle
          ? [story.title, story.description, story.scenario, story.tags.join(' ')]
              .join(' ')
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  }, [state.stories, query, showArchived]);

  const remove = async (story: Story) => {
    const chats = state.chats.filter((c) => c.storyId === story.id);
    const ok = await confirm(
      deleteConfirm(
        'story',
        story.title,
        chats.length ? (
          <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
            {chats.length} chat{chats.length === 1 ? '' : 's'} and all their messages, branches and
            checkpoints will be deleted too.
          </p>
        ) : undefined,
      ),
    );
    if (!ok) return;
    await actions.deleteStory(story.id);
    actions.toast({ kind: 'success', title: 'Story deleted' });
  };

  const startChat = async (story: Story) => {
    const existing = state.chats
      .filter((c) => c.storyId === story.id && !c.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) {
      navigate('chat', existing.id);
      return;
    }
    const chat = await actions.createChat({ storyId: story.id });
    navigate('chat', chat.id);
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Stories
          <span className="subtitle">{state.stories.length} worlds</span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('story', 'new')}>
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        <SearchInput value={query} onChange={setQuery} placeholder="Search stories…" />

        {state.stories.some((s) => s.archived) && (
          <Toggle
            label="Show archived stories"
            checked={showArchived}
            onChange={setShowArchived}
          />
        )}

        {!filtered.length ? (
          <EmptyState
            icon="book"
            title={query ? 'No stories match' : 'No stories yet'}
            message="A story ties characters, a persona, lorebooks and memories together into one ongoing world."
            action={
              !query && (
                <button type="button" className="btn btn-primary" onClick={() => navigate('story', 'new')}>
                  <Icon name="plus" />
                  Create story
                </button>
              )
            }
          />
        ) : (
          <div className="list">
            {filtered.map((story) => {
              const cast = story.characters
                .map((link) => state.characters.find((c) => c.id === link.characterId))
                .filter(Boolean);
              const chatCount = state.chats.filter((c) => c.storyId === story.id).length;
              return (
                <div className="card" key={story.id} style={{ padding: 0, overflow: 'hidden' }}>
                  {story.coverMediaId && (
                    <MediaImage
                      mediaId={story.coverMediaId}
                      alt={`${story.title} cover`}
                      style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
                    />
                  )}
                  <div style={{ padding: 14 }}>
                    <div className="row row-between row-wrap" style={{ gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row row-wrap" style={{ gap: 6 }}>
                          <strong className="truncate">{story.title || 'Untitled story'}</strong>
                          {story.favorite && (
                            <Icon name="star" width={14} height={14} style={{ color: 'var(--warn)' }} />
                          )}
                          {story.archived && <span className="chip">Archived</span>}
                        </div>
                        <div className="small muted clamp-2">
                          {truncate(story.description || story.scenario, 130) || 'No description.'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={`Actions for ${story.title}`}
                        onClick={() => setMenuFor(story)}
                      >
                        <Icon name="more" />
                      </button>
                    </div>

                    {!!cast.length && (
                      <div className="row" style={{ gap: 4, marginTop: 10 }}>
                        {cast.slice(0, 6).map((character) => (
                          <Avatar
                            key={character!.id}
                            mediaId={character!.avatarMediaId}
                            fallbackUrl={character!.avatarUrl}
                            name={character!.name}
                            size={30}
                          />
                        ))}
                        {cast.length > 6 && <span className="chip">+{cast.length - 6}</span>}
                      </div>
                    )}

                    <div className="small muted" style={{ marginTop: 8 }}>
                      {cast.length} character{cast.length === 1 ? '' : 's'} · {chatCount} chat
                      {chatCount === 1 ? '' : 's'} ·{' '}
                      {story.lorebookIds.length} lorebook{story.lorebookIds.length === 1 ? '' : 's'} ·{' '}
                      {relativeTime(story.updatedAt)}
                    </div>

                    <div className="btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => startChat(story)}>
                        <Icon name="chat" />
                        {chatCount ? 'Continue' : 'Start chat'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => navigate('story', story.id)}
                      >
                        <Icon name="edit" />
                        Edit
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? ''}
        actions={
          menuFor
            ? [
                { key: 'edit', label: 'Edit story', icon: 'edit', onSelect: () => navigate('story', menuFor.id) },
                {
                  key: 'newchat',
                  label: 'Start a new chat',
                  icon: 'chat',
                  onSelect: async () => {
                    const chat = await actions.createChat({ storyId: menuFor.id });
                    navigate('chat', chat.id);
                  },
                },
                {
                  key: 'favorite',
                  label: menuFor.favorite ? 'Remove from favourites' : 'Add to favourites',
                  icon: 'star',
                  onSelect: () => actions.saveStory({ ...menuFor, favorite: !menuFor.favorite }),
                },
                {
                  key: 'archive',
                  label: menuFor.archived ? 'Unarchive' : 'Archive',
                  icon: 'archive',
                  onSelect: () => actions.saveStory({ ...menuFor, archived: !menuFor.archived }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicateStory(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export story',
                  description: 'Includes characters, persona, lorebooks and memories.',
                  icon: 'download',
                  onSelect: async () => {
                    const json = await exportStory(menuFor.id, { includeChats: true, includeMedia: true });
                    downloadFile(exportFilename('story', menuFor.title), json);
                    actions.toast({ kind: 'success', title: 'Story exported' });
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

/* -------------------------------------------------------- story editor */

type TabId = 'overview' | 'cast' | 'lore' | 'memories' | 'media' | 'settings';

export function StoryEditor({
  storyId,
  presetCharacterId,
  onClose,
  onOpenChat,
}: {
  storyId: string | null;
  presetCharacterId?: string | null;
  onClose: () => void;
  onOpenChat: (chatId: string) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const existing = state.stories.find((s) => s.id === storyId) ?? null;

  const [draft, setDraft] = useState<Story>(() => {
    if (existing) return existing;
    const fresh = newStory({ personaId: state.settings.defaultPersonaId });
    if (presetCharacterId) {
      fresh.characters = [{ characterId: presetCharacterId, primary: true, note: '', enabled: true }];
      const character = state.characters.find((c) => c.id === presetCharacterId);
      if (character) {
        fresh.title = `${character.name}`;
        fresh.scenario = character.scenario;
      }
    }
    return fresh;
  });
  const [tab, setTab] = useState<TabId>('overview');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writingOpening, setWritingOpening] = useState(false);

  // What happens when the opening message is left empty depends on the cast,
  // so say which greeting would actually be used rather than describing rules.
  const openingHint = (() => {
    const link =
      draft.characters.find((c) => c.primary && c.enabled) ??
      draft.characters.find((c) => c.enabled);
    const character = link ? state.characters.find((c) => c.id === link.characterId) : undefined;
    const greeting =
      character?.greetings.find((g) => g.id === character.defaultGreetingId) ??
      character?.greetings[0];
    if (greeting?.content.trim()) {
      return `The first message of every new chat in this story. Leave it empty to open with ${
        character?.name || 'the main character'
      }'s greeting instead.`;
    }
    if (character) {
      return `The first message of every new chat in this story. ${
        character.name || 'The main character'
      } has no greeting, so leaving this empty starts the chat with nothing.`;
    }
    return 'The first message of every new chat in this story. Leave it empty and the chat starts with nothing.';
  })();

  const patch = (changes: Partial<Story>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setDirty(true);
  };

  const save = async (): Promise<Story | null> => {
    if (!draft.title.trim()) {
      setError('A story needs a title.');
      setTab('overview');
      return null;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await actions.saveStory(draft);
      setDraft(saved);
      setDirty(false);
      actions.toast({ kind: 'success', title: `Saved "${saved.title}"` });
      return saved;
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const setCharacters = (characters: StoryCharacterLink[]) => {
    // Exactly one primary at all times.
    if (characters.length && !characters.some((c) => c.primary)) characters[0].primary = true;
    patch({ characters });
  };

  const storyChats = state.chats.filter((c) => c.storyId === draft.id);

  /**
   * Writes the story's first page. A character's greeting introduces that
   * character wherever they turn up; an opening scene belongs to this campaign
   * and starts it somewhere. The result is a draft in the field, not a commit.
   */
  const writeOpening = async () => {
    setWritingOpening(true);
    try {
      const scene = await generateOpeningScene({
        story: draft,
        characters: draft.characters
          .filter((link) => link.enabled)
          .map((link) => state.characters.find((c) => c.id === link.characterId))
          .filter(Boolean) as Character[],
        persona: state.personas.find((p) => p.id === draft.personaId) ?? null,
        provider:
          state.providers.find((p) => p.id === state.settings.activeProviderId) ?? null,
      });
      patch({ openingMessage: scene });
      actions.toast({
        kind: 'success',
        title: 'Opening scene written',
        detail: 'Edit it freely — nothing is saved until you press Save.',
      });
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Could not write the opening scene',
        detail: (err as Error).message,
      });
    } finally {
      setWritingOpening(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <button type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Back">
          <Icon name="chevronLeft" />
        </button>
        <h1>
          {existing ? 'Edit Story' : 'New Story'}
          <span className="subtitle">{draft.title || 'Untitled'}{dirty ? ' · unsaved' : ''}</span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="save" />}
          Save
        </button>
      </div>

      <div className="page">
        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'cast', label: 'Cast', badge: draft.characters.length },
            { id: 'lore', label: 'Lorebooks', badge: draft.lorebookIds.length },
            { id: 'memories', label: 'Memories' },
            { id: 'media', label: 'Media' },
            { id: 'settings', label: 'Settings' },
          ]}
          active={tab}
          onChange={setTab}
          label="Story sections"
        />

        {tab === 'overview' && (
          <>
            <TextField
              label="Title"
              required
              value={draft.title}
              onChange={(title) => patch({ title })}
              error={error ?? undefined}
            />
            <TextArea
              label="Description"
              value={draft.description}
              onChange={(description) => patch({ description })}
              hint="A short summary of the world. Included in the AI context."
            />
            <TextArea
              label="Scenario"
              value={draft.scenario}
              onChange={(scenario) => patch({ scenario })}
              large
              hint="The situation the roleplay takes place in. Overrides each character's own scenario."
            />
            <TextArea
              label="Opening scene"
              value={draft.openingMessage}
              onChange={(openingMessage) => patch({ openingMessage })}
              large
              hint={openingHint}
            />
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={writeOpening}
                disabled={writingOpening}
              >
                {writingOpening ? <span className="spinner" /> : <Icon name="sparkle" />}
                {draft.openingMessage.trim() ? 'Rewrite opening scene' : 'Write an opening scene'}
              </button>
            </div>
            <TextArea
              label="Author's note"
              value={draft.authorNote}
              onChange={(authorNote) => patch({ authorNote })}
              hint="Injected near the end of the context for maximum steering weight — tone, pacing, style directions."
            />
            <TagField label="Tags" values={draft.tags} onChange={(tags) => patch({ tags })} />
            <div className="row">
              <Toggle label="Favourite" checked={draft.favorite} onChange={(favorite) => patch({ favorite })} />
            </div>
            <Toggle label="Archived" checked={draft.archived} onChange={(archived) => patch({ archived })} />

            {existing && (
              <>
                <hr className="divider" />
                <h3 className="section-title">
                  Chats
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      const saved = await save();
                      if (!saved) return;
                      const chat = await actions.createChat({ storyId: saved.id });
                      onOpenChat(chat.id);
                    }}
                  >
                    <Icon name="plus" />
                    New chat
                  </button>
                </h3>
                {!storyChats.length ? (
                  <p className="small muted">No chats yet.</p>
                ) : (
                  <div className="list">
                    {storyChats
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          className="card card-button"
                          onClick={() => onOpenChat(chat.id)}
                        >
                          <Icon name="chat" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="truncate">{chat.title}</div>
                            <div className="small muted">{relativeTime(chat.updatedAt)}</div>
                          </div>
                          <Icon name="chevronRight" />
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'cast' && (
          <CastEditor
            links={draft.characters}
            onChange={setCharacters}
            personaId={draft.personaId}
            onPersonaChange={(personaId) => patch({ personaId })}
          />
        )}

        {tab === 'lore' && (
          <>
            <Banner kind="info" title="Attached lorebooks">
              Entries from these books are evaluated on every message in this story. Characters can
              also carry their own lorebooks, and global books always apply.
            </Banner>
            {!state.lorebooks.length ? (
              <EmptyState icon="scroll" title="No lorebooks yet" message="Create one from the Lorebooks tab." />
            ) : (
              <div className="stack">
                {state.lorebooks.map((book) => {
                  const count = state.loreEntries.filter((e) => e.lorebookId === book.id).length;
                  return (
                    <Toggle
                      key={book.id}
                      label={book.name || 'Untitled lorebook'}
                      description={`${count} entr${count === 1 ? 'y' : 'ies'}${book.global ? ' · global (always on)' : ''}${book.enabled ? '' : ' · disabled'}`}
                      checked={draft.lorebookIds.includes(book.id)}
                      onChange={(on) =>
                        patch({
                          lorebookIds: on
                            ? [...draft.lorebookIds, book.id]
                            : draft.lorebookIds.filter((id) => id !== book.id),
                        })
                      }
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'memories' && (
          <>
            <Banner kind="info" title="Story memories">
              Memories are global by default. Selecting them here records them as belonging to this
              story and guarantees they are considered for its context.
            </Banner>
            {!state.memories.length ? (
              <EmptyState icon="brain" title="No memories yet" message="Create memories from the Memories tab or from a chat." />
            ) : (
              <div className="stack">
                {state.memories.map((memory) => (
                  <Toggle
                    key={memory.id}
                    label={memory.title || 'Untitled memory'}
                    description={`${memory.category} · ${memory.importance}${memory.pinned ? ' · pinned' : ''}`}
                    checked={draft.memoryIds.includes(memory.id)}
                    onChange={(on) =>
                      patch({
                        memoryIds: on
                          ? [...draft.memoryIds, memory.id]
                          : draft.memoryIds.filter((id) => id !== memory.id),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'media' && (
          <>
            <ImagePicker
              label="Story cover"
              mediaId={draft.coverMediaId}
              onChange={(coverMediaId) => patch({ coverMediaId })}
              ownerType="story-cover"
              ownerId={draft.id}
              shape="wide"
              hint="Shown on the story card in your library."
            />
            <ImagePicker
              label="Chat background"
              mediaId={draft.backgroundMediaId}
              onChange={(backgroundMediaId) => patch({ backgroundMediaId })}
              ownerType="story-background"
              ownerId={draft.id}
              shape="wide"
              hint="Displayed faintly behind the conversation in every chat of this story."
            />
          </>
        )}

        {tab === 'settings' && (
          <>
            <Banner kind="info" title="Story generation overrides">
              These override the provider defaults for every chat in this story. Individual chats can
              override them again.
            </Banner>
            <GenerationOverrides
              value={draft.settings}
              onChange={(settings) => patch({ settings })}
            />
            {existing && (
              <>
                <hr className="divider" />
                <button
                  type="button"
                  className="btn btn-danger btn-block"
                  onClick={async () => {
                    const chats = state.chats.filter((c) => c.storyId === existing.id);
                    const ok = await confirm(
                      deleteConfirm(
                        'story',
                        existing.title,
                        chats.length ? (
                          <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
                            {chats.length} chat{chats.length === 1 ? '' : 's'} will be deleted too.
                          </p>
                        ) : undefined,
                      ),
                    );
                    if (!ok) return;
                    await actions.deleteStory(existing.id);
                    onClose();
                  }}
                >
                  <Icon name="trash" />
                  Delete story
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CastEditor({
  links,
  onChange,
  personaId,
  onPersonaChange,
}: {
  links: StoryCharacterLink[];
  onChange: (links: StoryCharacterLink[]) => void;
  personaId: string | null;
  onPersonaChange: (id: string | null) => void;
}) {
  const state = useAppState();
  const [adding, setAdding] = useState(false);

  const available = state.characters.filter((c) => !links.some((l) => l.characterId === c.id));

  const move = (index: number, delta: number) => {
    const next = links.slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <>
      <Banner kind="info" title="Multiple characters">
        Every enabled character is described to the AI, and the primary one speaks by default. In the
        chat you can ask any other cast member to reply.
      </Banner>

      <div className="field">
        <span className="field-label">Your persona</span>
        <SelectField
          label=""
          value={personaId ?? ''}
          onChange={(value) => onPersonaChange(value || null)}
          options={[
            { value: '', label: 'No persona' },
            ...state.personas.map((p) => ({ value: p.id, label: p.name || 'Unnamed persona' })),
          ]}
          hint="The character you play. Used for the {{user}} macro."
        />
      </div>

      <h3 className="section-title">
        Cast ({links.length})
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setAdding(true)}
          disabled={!available.length}
        >
          <Icon name="plus" />
          Add character
        </button>
      </h3>

      {!links.length ? (
        <EmptyState
          icon="users"
          title="No characters in this story"
          message="Add at least one character so the AI has someone to play."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAdding(true)}
              disabled={!available.length}
            >
              <Icon name="plus" />
              Add character
            </button>
          }
        />
      ) : (
        <div className="list">
          {links.map((link, index) => {
            const character = state.characters.find((c) => c.id === link.characterId);
            return (
              <div className="card" key={link.characterId}>
                <div className="row" style={{ gap: 10 }}>
                  <Avatar
                    mediaId={character?.avatarMediaId ?? null}
                    fallbackUrl={character?.avatarUrl}
                    name={character?.name ?? '?'}
                    size={44}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      <strong className="truncate">{character?.name ?? 'Missing character'}</strong>
                      {link.primary && <span className="chip chip-accent">Primary</span>}
                      {!link.enabled && <span className="chip chip-danger">Disabled</span>}
                    </div>
                    {!character && (
                      <div className="small" style={{ color: 'var(--danger)' }}>
                        This character was deleted. Remove it from the cast.
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ gap: 2 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <Icon name="chevronUp" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label="Move down"
                      disabled={index === links.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <Icon name="chevronDown" />
                    </button>
                  </div>
                </div>

                <div className="btn-row" style={{ marginTop: 10 }}>
                  {!link.primary && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        onChange(
                          links.map((l) => ({ ...l, primary: l.characterId === link.characterId })),
                        )
                      }
                    >
                      <Icon name="star" />
                      Set primary
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      onChange(
                        links.map((l) =>
                          l.characterId === link.characterId ? { ...l, enabled: !l.enabled } : l,
                        ),
                      )
                    }
                  >
                    <Icon name={link.enabled ? 'eyeOff' : 'eye'} />
                    {link.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onChange(links.filter((l) => l.characterId !== link.characterId))}
                  >
                    <Icon name="x" />
                    Remove
                  </button>
                </div>

                <TextArea
                  label="Story-specific note"
                  value={link.note}
                  onChange={(note) =>
                    onChange(
                      links.map((l) => (l.characterId === link.characterId ? { ...l, note } : l)),
                    )
                  }
                  hint="Extra context for this character in this story only — e.g. “currently wounded and hiding her identity.”"
                />
              </div>
            );
          })}
        </div>
      )}

      <ActionSheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a character"
        actions={available.map((character) => ({
          key: character.id,
          label: character.name || 'Unnamed',
          description: truncate(character.shortDescription || character.description, 70),
          icon: 'user',
          onSelect: () =>
            onChange([
              ...links,
              { characterId: character.id, primary: !links.length, note: '', enabled: true },
            ]),
        }))}
      />
    </>
  );
}
