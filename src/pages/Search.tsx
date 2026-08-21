import { useDeferredValue, useMemo, useState } from 'react';
import { useAppState, useActions } from '../state/store';
import { Icon } from '../components/ui/Icon';
import { EmptyState, Highlight, SearchInput } from '../components/ui/common';
import { messagesMatching } from '../services/search';
import { truncate } from '../utils/text';
import type { RouteName } from '../state/router';

/** Application-wide search across every entity type, including messages. */
export function SearchPage({
  initialQuery,
  navigate,
}: {
  initialQuery: string;
  navigate: (name: RouteName, param?: string | null) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const [query, setQuery] = useState(initialQuery);
  const deferred = useDeferredValue(query);
  const needle = deferred.trim().toLowerCase();

  const [messageHits, setMessageHits] = useState<
    Array<{ chatId: string; chatTitle: string; snippet: string; messageId: string }>
  >([]);
  const [searchingMessages, setSearchingMessages] = useState(false);

  const results = useMemo(() => {
    if (!needle) {
      return {
        characters: [],
        personas: [],
        stories: [],
        chats: [],
        lorebooks: [],
        loreEntries: [],
        memories: [],
      };
    }
    const hit = (...fields: Array<string | string[] | undefined>) =>
      fields
        .flatMap((f) => (Array.isArray(f) ? f : [f ?? '']))
        .join(' ')
        .toLowerCase()
        .includes(needle);

    return {
      characters: state.characters.filter((c) =>
        hit(c.name, c.displayName, c.shortDescription, c.description, c.personality, c.tags),
      ),
      personas: state.personas.filter((p) => hit(p.name, p.personality, p.backstory, p.tags)),
      stories: state.stories.filter((s) => hit(s.title, s.description, s.scenario, s.tags)),
      chats: state.chats.filter((c) => hit(c.title)),
      lorebooks: state.lorebooks.filter((b) => hit(b.name, b.description, b.tags)),
      loreEntries: state.loreEntries.filter((e) =>
        hit(e.name, e.content, e.primaryKeys, e.secondaryKeys, e.aliases, e.category),
      ),
      memories: state.memories.filter((m) => hit(m.title, m.content, m.tags, m.category)),
    };
  }, [state, needle]);

  const total =
    results.characters.length +
    results.personas.length +
    results.stories.length +
    results.chats.length +
    results.lorebooks.length +
    results.loreEntries.length +
    results.memories.length;

  const searchMessages = async () => {
    if (!needle) return;
    setSearchingMessages(true);
    try {
      const hits = await messagesMatching(needle, state.chats, 60);
      setMessageHits(hits);
      if (!hits.length) {
        actions.toast({ kind: 'info', title: 'No messages matched that search.' });
      }
    } catch (err) {
      actions.toast({ kind: 'error', title: 'Message search failed', detail: (err as Error).message });
    } finally {
      setSearchingMessages(false);
    }
  };

  const group = <T,>(
    title: string,
    items: T[],
    render: (item: T) => { key: string; title: string; subtitle: string; onOpen: () => void; icon: string },
  ) => {
    if (!items.length) return null;
    return (
      <section key={title}>
        <h3 className="result-group-title">
          {title} ({items.length})
        </h3>
        <div className="list">
          {items.slice(0, 25).map((item) => {
            const view = render(item);
            return (
              <button key={view.key} type="button" className="card card-button" onClick={view.onOpen}>
                <Icon name={view.icon} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 600 }}>
                    <Highlight text={view.title} query={deferred} />
                  </div>
                  <div className="small muted clamp-2">
                    <Highlight text={view.subtitle} query={deferred} />
                  </div>
                </div>
                <Icon name="chevronRight" />
              </button>
            );
          })}
          {items.length > 25 && (
            <p className="small muted">…and {items.length - 25} more. Refine your search.</p>
          )}
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Search
          <span className="subtitle">
            {needle ? `${total} match${total === 1 ? '' : 'es'}` : 'Everything in your library'}
          </span>
        </h1>
      </div>

      <div className="page">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search characters, stories, lore, memories…"
          label="Search everything"
        />

        {!needle ? (
          <EmptyState
            icon="search"
            title="Start typing"
            message="Searches characters, personas, stories, chats, lorebooks, lore entries and memories. Chat messages are searched on demand."
          />
        ) : (
          <>
            {group('Characters', results.characters, (c) => ({
              key: c.id,
              title: c.name || 'Unnamed',
              subtitle: truncate(c.shortDescription || c.description || c.personality, 120),
              icon: 'users',
              onOpen: () => navigate('character', c.id),
            }))}
            {group('Personas', results.personas, (p) => ({
              key: p.id,
              title: p.name || 'Unnamed',
              subtitle: truncate(p.personality, 120),
              icon: 'user',
              onOpen: () => navigate('persona', p.id),
            }))}
            {group('Stories', results.stories, (s) => ({
              key: s.id,
              title: s.title || 'Untitled',
              subtitle: truncate(s.description || s.scenario, 120),
              icon: 'book',
              onOpen: () => navigate('story', s.id),
            }))}
            {group('Chats', results.chats, (c) => ({
              key: c.id,
              title: c.title,
              subtitle: state.stories.find((s) => s.id === c.storyId)?.title ?? 'No story',
              icon: 'chat',
              onOpen: () => navigate('chat', c.id),
            }))}
            {group('Lorebooks', results.lorebooks, (b) => ({
              key: b.id,
              title: b.name || 'Untitled',
              subtitle: truncate(b.description, 120),
              icon: 'scroll',
              onOpen: () => navigate('lorebook', b.id),
            }))}
            {group('Lore entries', results.loreEntries, (e) => ({
              key: e.id,
              title: e.name || 'Untitled entry',
              subtitle: `${e.primaryKeys.join(', ')} — ${truncate(e.content, 100)}`,
              icon: 'scroll',
              onOpen: () => navigate('lorebook', e.lorebookId),
            }))}
            {group('Memories', results.memories, (m) => ({
              key: m.id,
              title: m.title || 'Untitled memory',
              subtitle: truncate(m.content, 120),
              icon: 'brain',
              onOpen: () => navigate('memories'),
            }))}

            <section>
              <h3 className="result-group-title">Chat messages</h3>
              {!messageHits.length ? (
                <button
                  type="button"
                  className="btn btn-block"
                  onClick={searchMessages}
                  disabled={searchingMessages}
                >
                  {searchingMessages ? <span className="spinner" /> : <Icon name="search" />}
                  Search inside chat messages
                </button>
              ) : (
                <div className="list">
                  {messageHits.map((hit) => (
                    <button
                      key={hit.messageId}
                      type="button"
                      className="card card-button"
                      onClick={() => navigate('chat', hit.chatId)}
                    >
                      <Icon name="chat" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="truncate" style={{ fontWeight: 600 }}>
                          {hit.chatTitle}
                        </div>
                        <div className="small muted clamp-2">
                          <Highlight text={hit.snippet} query={deferred} />
                        </div>
                      </div>
                      <Icon name="chevronRight" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            {!total && !messageHits.length && (
              <EmptyState
                icon="search"
                title="Nothing matched"
                message="Try a shorter or different term, and search inside chat messages above."
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
