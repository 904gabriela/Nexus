import { useMemo, useState } from 'react';
import type { Character } from '../types';
import { useActions, useAppState } from '../state/store';
import { Avatar } from '../components/media/MediaImage';
import { Icon } from '../components/ui/Icon';
import { EmptyState, SearchInput } from '../components/ui/common';
import { ActionSheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { downloadFile, exportCharacter, exportFilename } from '../exporters';
import { relativeTime, truncate } from '../utils/text';
import type { RouteName } from '../state/router';

export function CharactersPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<Character | null>(null);
  const [sort, setSort] = useState<'updated' | 'name' | 'created'>('updated');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = state.characters.filter((character) => {
      if (!needle) return true;
      return [
        character.name,
        character.displayName,
        character.shortDescription,
        character.description,
        character.personality,
        character.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
    return list.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
  }, [state.characters, query, sort]);

  const remove = async (character: Character) => {
    const ok = await confirm(deleteConfirm('character', character.name));
    if (!ok) return;
    await actions.deleteCharacter(character.id);
    actions.toast({ kind: 'success', title: 'Character deleted' });
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Characters
          <span className="subtitle">{state.characters.length} in your library</span>
        </h1>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => navigate('character', 'new')}
        >
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        <SearchInput value={query} onChange={setQuery} placeholder="Search characters…" />

        <div className="row row-between" style={{ marginBottom: 12 }}>
          <div className="chip-row">
            {(['updated', 'name', 'created'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`chip ${sort === option ? 'chip-accent' : ''}`}
                onClick={() => setSort(option)}
                aria-pressed={sort === option}
                style={{ cursor: 'pointer' }}
              >
                {option === 'updated' ? 'Recently updated' : option === 'name' ? 'A–Z' : 'Newest'}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('transfer')}>
            <Icon name="upload" />
            Import
          </button>
        </div>

        {!filtered.length ? (
          <EmptyState
            icon="users"
            title={query ? 'No characters match' : 'No characters yet'}
            message={
              query
                ? 'Try a different search term.'
                : 'Create a character from scratch, or import a JSON card or PNG character card.'
            }
            action={
              !query && (
                <div className="btn-row" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => navigate('character', 'new')}
                  >
                    <Icon name="plus" />
                    Create character
                  </button>
                  <button type="button" className="btn" onClick={() => navigate('transfer')}>
                    <Icon name="upload" />
                    Import
                  </button>
                </div>
              )
            }
          />
        ) : (
          <div className="list">
            {filtered.map((character) => {
              const storyCount = state.stories.filter((s) =>
                s.characters.some((c) => c.characterId === character.id),
              ).length;
              return (
                <div className="card card-button" key={character.id}>
                  <button
                    type="button"
                    onClick={() => navigate('character', character.id)}
                    style={{
                      display: 'flex',
                      gap: 12,
                      alignItems: 'center',
                      flex: 1,
                      minWidth: 0,
                      background: 'none',
                      border: 0,
                      color: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <Avatar
                      mediaId={character.avatarMediaId}
                      fallbackUrl={character.avatarUrl}
                      name={character.name}
                      size={52}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <strong className="truncate">{character.name || 'Unnamed'}</strong>
                        {character.favorite && (
                          <Icon name="star" width={14} height={14} style={{ color: 'var(--warn)' }} />
                        )}
                      </div>
                      <div className="small muted clamp-2">
                        {truncate(
                          character.shortDescription || character.description || character.personality,
                          110,
                        ) || 'No description yet.'}
                      </div>
                      <div className="small muted" style={{ marginTop: 3 }}>
                        {character.greetings.length} greeting
                        {character.greetings.length === 1 ? '' : 's'}
                        {storyCount ? ` · in ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'}` : ''}
                        {` · ${relativeTime(character.updatedAt)}`}
                      </div>
                    </div>
                  </button>
                  {/*
                    Talking to a character is the point of the app, so it is one
                    tap from the library. The story a chat needs is built behind
                    it — filling in a story form first was the wrong order.
                  */}
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    aria-label={`Chat with ${character.name}`}
                    onClick={async () => {
                      const chat = await actions.startChatWithCharacter(character.id);
                      if (chat) navigate('chat', chat.id);
                    }}
                  >
                    <Icon name="chat" />
                    Chat
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Actions for ${character.name}`}
                    onClick={() => setMenuFor(character)}
                  >
                    <Icon name="more" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.name ?? ''}
        actions={
          menuFor
            ? [
                { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => navigate('character', menuFor.id) },
                {
                  key: 'chat',
                  label: 'Chat',
                  description: 'Opens straight into a scene. The story is set up for you.',
                  icon: 'chat',
                  onSelect: async () => {
                    const chat = await actions.startChatWithCharacter(menuFor.id);
                    if (chat) navigate('chat', chat.id);
                  },
                },
                {
                  key: 'story',
                  label: 'Start a story with this character',
                  description: 'Build the campaign yourself — world, cast, lorebooks.',
                  icon: 'book',
                  onSelect: () => navigate('story', 'new', { character: menuFor.id }),
                },
                {
                  key: 'favorite',
                  label: menuFor.favorite ? 'Remove from favourites' : 'Add to favourites',
                  icon: 'star',
                  onSelect: () => actions.saveCharacter({ ...menuFor, favorite: !menuFor.favorite }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicateCharacter(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export',
                  icon: 'download',
                  onSelect: async () => {
                    const json = await exportCharacter(menuFor, {
                      includeAvatar: true,
                      includeLorebooks: true,
                    });
                    downloadFile(exportFilename('character', menuFor.name), json);
                    actions.toast({ kind: 'success', title: 'Character exported' });
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
