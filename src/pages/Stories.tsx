import { Fragment, useMemo, useState } from 'react';
import type {
  Character,
  DiscoveredPerson,
  Memory,
  Relationship,
  Story,
  StoryCharacterLink,
} from '../types';
import { emptyStoryState } from '../types';
import { newCharacter, newStory } from '../types/factories';
import { uid } from '../utils/uid';
import { generateOpeningScene } from '../ai/openingScene';
import { availablePresets } from '../narration/presets';
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
import { memoryStatus } from '../memory/matrix';
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

type TabId = 'overview' | 'world' | 'cast' | 'lore' | 'memories' | 'media' | 'settings';

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

  // A story saved before these fields existed carries neither, so every read
  // goes through a default rather than through the row.
  const storyState = draft.state ?? emptyStoryState();
  const patchState = (changes: Partial<typeof storyState>) =>
    patch({ state: { ...storyState, ...changes, updatedAt: Date.now() } });

  /** Everyone a relationship can be between: the cast, plus the persona. */
  const castCharacters = draft.characters
    .map((link) => state.characters.find((c) => c.id === link.characterId))
    .filter((c): c is Character => Boolean(c));

  const participants = [
    ...draft.characters
      .filter((link) => link.enabled)
      .map((link) => state.characters.find((c) => c.id === link.characterId))
      .filter(Boolean)
      .map((c) => ({ id: c!.id, name: c!.displayName || c!.name || 'Unnamed' })),
    ...(draft.personaId
      ? state.personas
          .filter((p) => p.id === draft.personaId)
          .map((p) => ({ id: p.id, name: p.displayName || p.name || 'You' }))
      : []),
  ];

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
        {/*
          The story leads. "Edit Story" over the title framed the whole page as
          a form for a record, when the first question anyone opens it with is
          where their story currently stands — the fields below answer the
          second question, not the first.
        */}
        <h1>
          {existing ? draft.title || 'Untitled story' : 'New Story'}
          <span className="subtitle">
            {existing ? 'Story' : 'Set up the world, cast and opening'}
            {dirty ? ' · unsaved' : ''}
          </span>
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
            { id: 'world', label: 'World' },
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
            <StoryStanding
              story={draft}
              cast={castCharacters}
              memories={state.memories.filter((m) => m.sourceStoryId === draft.id)}
              chatCount={state.chats.filter((c) => c.storyId === draft.id).length}
              saved={Boolean(existing)}
              onOpenChat={onOpenChat}
            />
            <TextField
              label="Title"
              required
              value={draft.title}
              onChange={(title) => patch({ title })}
              error={error ?? undefined}
            />
            <ImagePicker
              label="Cover"
              mediaId={draft.coverMediaId}
              onChange={(coverMediaId) => patch({ coverMediaId })}
              ownerType="story-cover"
              ownerId={draft.id}
              shape="wide"
              hint="Shown on the story card in your library."
            />
            <TextArea
              label="Summary"
              value={draft.description}
              onChange={(description) => patch({ description })}
              hint="What this story is, in a line or two. Included in the AI context."
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

        {/*
          The world: what is true here and what has already happened. Scenario
          is a situation and moves with the story; rules and timeline hold for
          the whole campaign, which is why they are separate fields rather than
          more paragraphs inside the scenario.
        */}
        {tab === 'world' && (
          <>
            <TextArea
              label="Scenario"
              value={draft.scenario}
              onChange={(scenario) => patch({ scenario })}
              large
              hint="The situation the roleplay takes place in. Overrides each character's own scenario."
            />
            <TextArea
              label="World rules"
              value={draft.rules}
              onChange={(rules) => patch({ rules })}
              large
              hint="How this world works — what is possible, what is forbidden, what the narrator must respect."
            />
            <TextArea
              label="Timeline"
              value={draft.timeline}
              onChange={(timeline) => patch({ timeline })}
              large
              hint="What has already happened, in order. The campaign's history up to now."
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

            {/*
              Where the story stands, as opposed to what it is. Rules and the
              timeline above are fixed; these move as you play, and they are
              what lets the model know it is chapter three rather than chapter
              one. Deliberately no "present characters" or "recent events"
              field: the scene owns the first and the chat owns the second.
            */}
            <div className="field">
              <span className="field-label">Where the story stands</span>
              <div className="field-hint" style={{ marginBottom: 8 }}>
                The current situation, above whatever this scene happens to be. Leave any of it
                empty and it is simply not sent.
              </div>
              <div className="field-row field-row-2">
                <TextField
                  label="Arc"
                  value={storyState.arc}
                  onChange={(arc) => patchState({ arc })}
                  hint="Which stretch of the story this is."
                />
                <TextField
                  label="Time"
                  value={storyState.time}
                  onChange={(time) => patchState({ time })}
                  hint="Friday evening; three days after the fight."
                />
              </div>
              <TextArea
                label="Active tension"
                value={storyState.conflict}
                onChange={(conflict) => patchState({ conflict })}
                hint="What is currently unresolved between them."
              />
              <TextArea
                label="Working towards"
                value={storyState.objective}
                onChange={(objective) => patchState({ objective })}
                hint="The story-level goal, above this scene's own."
              />
              <TagField
                label="Open threads"
                values={storyState.threads}
                onChange={(threads) => patchState({ threads })}
              />
            </div>

            {/*
              Presets combine rather than exclude — "Detailed + Slow Burn +
              Cinematic" is a normal selection — so these are switches, not a
              mode picker.
            */}
            <div className="field">
              <span className="field-label">Narration style</span>
              <div className="field-hint" style={{ marginBottom: 8 }}>
                How the narrator writes. Combine as many as suit the story; none of them asks
                for a particular length.
              </div>
              <div className="stack">
                {availablePresets(state.settings.narrationPresets ?? [])
                  .filter((preset) => preset.instruction.trim())
                  .map((preset) => {
                    // A story saved before presets existed has no field at
                    // all, and reading through it would take the editor down.
                    const selected = draft.narrationPresetIds ?? [];
                    const on = selected.includes(preset.id);
                    return (
                      <Toggle
                        key={preset.id}
                        label={preset.name}
                        description={preset.description}
                        checked={on}
                        onChange={(next) =>
                          patch({
                            narrationPresetIds: next
                              ? [...selected, preset.id]
                              : selected.filter((id) => id !== preset.id),
                          })
                        }
                      />
                    );
                  })}
              </div>
            </div>
          </>
        )}

        {tab === 'cast' && (
          <>
            <CastEditor
              links={draft.characters}
              onChange={setCharacters}
              personaId={draft.personaId}
              onPersonaChange={(personaId) => patch({ personaId })}
            />
            <DiscoveredPeople
              discovered={draft.discovered ?? []}
              onChange={(discovered) => patch({ discovered })}
              onAddToCast={(person) => {
                const character = newCharacter({
                  name: person.name,
                  shortDescription: person.note,
                });
                void actions.saveCharacter(character).then(() => {
                  setCharacters([
                    ...draft.characters,
                    { characterId: character.id, primary: false, note: '', enabled: true },
                  ]);
                });
                patch({
                  discovered: (draft.discovered ?? []).filter((p) => p.id !== person.id),
                });
              }}
            />
            <RelationshipEditor
              relationships={draft.relationships ?? []}
              onChange={(relationships) => patch({ relationships })}
              participants={participants}
            />
          </>
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

/**
 * Where this story stands, before any of the fields that edit it.
 *
 * A story used to open on a Title field, which is a form for a thing rather
 * than the thing. Everything below already exists somewhere in the app — the
 * cast, the state, the threads, the memories — and the only reason it was hard
 * to see was that each piece lived on its own page. Nothing here is editable
 * and nothing here is new state; it reads what the story already holds and
 * says it in one place.
 */
function StoryStanding({
  story,
  cast,
  memories,
  chatCount,
  saved,
  onOpenChat,
}: {
  story: Story;
  /** False while the story is new and unsaved — nothing to continue yet. */
  saved: boolean;
  cast: Character[];
  memories: Memory[];
  chatCount: number;
  onOpenChat: (chatId: string) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const stateBlock = story.state ?? emptyStoryState();
  const threads = (stateBlock.threads ?? []).filter(Boolean);
  const recent = memories
    .filter((m) => memoryStatus(m) === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
  const waiting = memories.filter((m) => memoryStatus(m) === 'proposed').length;
  const latestChat = state.chats
    .filter((c) => c.storyId === story.id && !c.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const facts: Array<[string, string]> = [
    ['Arc', stateBlock.arc],
    ['When', stateBlock.time],
    ['Tension', stateBlock.conflict],
    ['Working towards', stateBlock.objective],
  ].filter(([, value]) => Boolean(value?.trim())) as Array<[string, string]>;

  // A story that has never been saved cannot be opened as a chat and has
  // nothing to stand on yet, so the form below is the whole of what it needs.
  if (!saved) return null;

  return (
    <section className="story-standing">
      {/*
        No title here — the page header above carries it, and repeating it
        directly over a Title field was the clearest sign that this page was
        still a form wearing a summary.
      */}
      <div className="row row-between row-wrap" style={{ gap: 8, marginBottom: 10 }}>
        <p className="small muted" style={{ margin: 0, minWidth: 0 }}>
          {chatCount ? `${chatCount} chat${chatCount === 1 ? '' : 's'}` : 'No chats yet'}
          {cast.length ? ` · ${cast.length} in the cast` : ''}
          {waiting ? ` · ${waiting} memor${waiting === 1 ? 'y' : 'ies'} to review` : ''}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            if (latestChat) {
              onOpenChat(latestChat.id);
              return;
            }
            const chat = await actions.createChat({ storyId: story.id });
            onOpenChat(chat.id);
          }}
        >
          <Icon name="chat" />
          {latestChat ? 'Continue story' : 'Start the story'}
        </button>
      </div>

      {!!cast.length && (
        <div className="row row-wrap" style={{ gap: 6, marginBottom: 10 }}>
          {cast.map((character) => (
            <span className="chip" key={character.id}>
              <Avatar
                mediaId={character.avatarMediaId}
                fallbackUrl={character.avatarUrl}
                name={character.name}
                size={18}
              />
              {character.displayName || character.name}
            </span>
          ))}
        </div>
      )}

      {!!facts.length && (
        <dl className="qs-facts" style={{ marginBottom: threads.length ? 8 : 0 }}>
          {facts.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {!!threads.length && (
        <div style={{ marginBottom: recent.length ? 10 : 0 }}>
          <div className="qs-heading" style={{ margin: '0 0 4px' }}>
            Unresolved
          </div>
          <ul className="story-standing-list">
            {threads.map((thread) => (
              <li key={thread}>{thread}</li>
            ))}
          </ul>
        </div>
      )}

      {!!recent.length && (
        <div>
          <div className="qs-heading" style={{ margin: '0 0 4px' }}>
            Lately remembered
          </div>
          <ul className="story-standing-list">
            {recent.map((memory) => (
              <li key={memory.id}>{memory.title || truncate(memory.content, 70)}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * People the story named who are not in the cast.
 *
 * The extractor notices them; this is where a person decides. Most names a
 * story invents should stay names — a courier, a sister who never appears — so
 * the default is that nothing happens, and adding one to the cast is a
 * deliberate act rather than something that happened while you were reading.
 */
function DiscoveredPeople({
  discovered,
  onChange,
  onAddToCast,
}: {
  discovered: DiscoveredPerson[];
  onChange: (discovered: DiscoveredPerson[]) => void;
  onAddToCast: (person: DiscoveredPerson) => void;
}) {
  const pending = discovered.filter((p) => !p.dismissed);
  if (!pending.length) return null;

  return (
    <section className="section">
      <h3 className="section-title">
        Named in the story
        <span className="chip">{pending.length}</span>
      </h3>
      <p className="small muted" style={{ marginBottom: 8 }}>
        The story mentioned these people and they are not in the cast. Add the ones who matter;
        the rest can be dismissed and will not be offered again.
      </p>
      <div className="stack">
        {pending.map((person) => (
          <div className="card" key={person.id}>
            <div className="row row-between" style={{ gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <strong className="truncate">{person.name}</strong>
                {person.note && (
                  <div className="small muted" style={{ marginTop: 2 }}>
                    {person.note}
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onAddToCast(person)}
                >
                  Add to cast
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Dismiss ${person.name}`}
                  onClick={() =>
                    onChange(
                      discovered.map((p) =>
                        p.id === person.id ? { ...p, dismissed: true, updatedAt: Date.now() } : p,
                      ),
                    )
                  }
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Relationships between the people in a story.
 *
 * Deliberately not a grid of every pair: a cast of eight has twenty-eight
 * pairs and almost none of them carry anything. A relationship exists because
 * someone said it does, and the ones that matter are added by hand.
 */
function RelationshipEditor({
  relationships,
  onChange,
  participants,
}: {
  relationships: Relationship[];
  onChange: (next: Relationship[]) => void;
  participants: Array<{ id: string; name: string }>;
}) {
  const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? 'Someone';

  const patchOne = (id: string, changes: Partial<Relationship>) =>
    onChange(
      relationships.map((r) =>
        r.id === id ? { ...r, ...changes, manual: true, updatedAt: Date.now() } : r,
      ),
    );

  const add = () => {
    if (participants.length < 2) return;
    onChange([
      ...relationships,
      {
        id: uid('rel_'),
        betweenIds: [participants[0].id, participants[1].id],
        label: '',
        summary: '',
        manual: true,
        updatedAt: Date.now(),
      },
    ]);
  };

  return (
    <section className="section">
      <h3 className="section-title">
        Relationships
        <button
          type="button"
          className="btn btn-sm"
          onClick={add}
          disabled={participants.length < 2}
        >
          <Icon name="plus" />
          Add
        </button>
      </h3>

      {participants.length < 2 ? (
        <p className="small muted">
          Add at least two people to the cast — or a character and a persona — and their
          relationships can be described here.
        </p>
      ) : !relationships.length ? (
        <p className="small muted">
          None yet. Only relationships between people actually in a scene are sent, so a long cast
          costs nothing until it matters.
        </p>
      ) : (
        <div className="stack">
          {relationships.map((r) => (
            <div className="card" key={r.id}>
              {/*
                Nothing writes an automatic row here any more — the story's own
                conclusions are RelationshipDeltas now, resolved per branch and
                undoable from the chat. So a row that is not `manual` was
                written by the old extractor, before any of that was recorded,
                and there is no way to work out afterwards which turns it came
                from or which timeline it belonged to. It is left exactly as it
                is rather than quietly deleted — it may well be true — but it is
                said plainly, because it behaves differently from everything
                written since.
              */}
              {!r.manual && (
                <p className="small muted" style={{ margin: '0 0 10px' }}>
                  The story wrote this before Nexus recorded which turns a change came from, so it
                  shows on every branch and cannot be undone from a chat. Editing it makes it
                  yours, or{' '}
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => patchOne(r.id, {})}
                    aria-label={`Keep the relationship between ${nameOf(r.betweenIds[0])} and ${nameOf(
                      r.betweenIds[1],
                    )} as written`}
                  >
                    keep it as written
                  </button>
                  . Remove it and the story can say so again as it goes.
                </p>
              )}
              <div className="field-row field-row-2">
                <SelectField
                  label="Between"
                  value={r.betweenIds[0]}
                  onChange={(id) => patchOne(r.id, { betweenIds: [id, r.betweenIds[1]] })}
                  options={participants.map((p) => ({ value: p.id, label: p.name }))}
                />
                <SelectField
                  label="And"
                  value={r.betweenIds[1]}
                  onChange={(id) => patchOne(r.id, { betweenIds: [r.betweenIds[0], id] })}
                  options={participants.map((p) => ({ value: p.id, label: p.name }))}
                />
              </div>
              <TextField
                label="What this is"
                value={r.label}
                onChange={(label) => patchOne(r.id, { label })}
                hint="Rivals; estranged siblings; something neither will name."
              />
              <TextArea
                label="Where they stand now"
                value={r.summary}
                onChange={(summary) => patchOne(r.id, { summary })}
                hint="The current state, not the history — the chat and the memories hold that."
              />
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => onChange(relationships.filter((x) => x.id !== r.id))}
                aria-label={`Remove the relationship between ${nameOf(r.betweenIds[0])} and ${nameOf(
                  r.betweenIds[1],
                )}`}
              >
                <Icon name="trash" />
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
