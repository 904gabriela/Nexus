import { useEffect, useMemo, useState } from 'react';
import { useActions, useAppState } from '../state/store';
import { Avatar } from '../components/media/MediaImage';
import { Icon } from '../components/ui/Icon';
import { Banner, EmptyState } from '../components/ui/common';
import { migrateV2, dismissV2Migration } from '../storage/migration';
import { newLorebook, newMemory } from '../types/factories';
import { relativeTime, formatBytes, truncate } from '../utils/text';
import {
  backupAdvice,
  readStorageStatus,
  type PersistenceState,
} from '../storage/persistence';
import type { RouteName } from '../state/router';

export function DashboardPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const [migrating, setMigrating] = useState(false);

  // Storage durability feeds the wording: an un-persisted origin is a stronger
  // reason to back up than a persisted one.
  const [persistence, setPersistence] = useState<PersistenceState>('unsupported');
  useEffect(() => {
    void readStorageStatus().then((s) => setPersistence(s.state));
  }, []);

  const totalMessages = state.chats.reduce((n, c) => n + Math.max(0, c.orderCounter), 0);
  const advice = backupAdvice({
    messages: totalMessages,
    stories: state.stories.length,
    lastBackupAt: state.settings.lastBackupAt,
    persistence,
  });

  const recentStories = useMemo(
    () =>
      state.stories
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [state.stories],
  );

  const recentChats = useMemo(
    () =>
      state.chats
        .filter((c) => !c.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [state.chats],
  );

  const provider = state.providers.find((p) => p.id === state.settings.activeProviderId) ?? null;

  const runMigration = async () => {
    setMigrating(true);
    try {
      const report = await migrateV2();
      await actions.reload();
      const summary = [
        report.characters && `${report.characters} characters`,
        report.personas && `${report.personas} personas`,
        report.stories && `${report.stories} stories`,
        report.lorebooks && `${report.lorebooks} lorebooks (${report.loreEntries} entries)`,
        report.chats && `${report.chats} chats (${report.messages} messages)`,
        report.memories && `${report.memories} memories`,
        report.media && `${report.media} images`,
      ]
        .filter(Boolean)
        .join(', ');
      actions.toast({
        kind: 'success',
        title: 'V2 data migrated',
        detail: summary || 'Nothing needed migrating.',
      });
      for (const warning of report.warnings.slice(0, 4)) {
        actions.toast({ kind: 'warn', title: 'Migration note', detail: warning });
      }
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Migration failed',
        detail: `${(err as Error).message} — your old V2 data is untouched and you can try again.`,
      });
    } finally {
      setMigrating(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Storyline
          <span className="subtitle">Your roleplay library</span>
        </h1>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => navigate('search')}
          aria-label="Search everything"
        >
          <Icon name="search" />
        </button>
      </div>

      <div className="page">
        {advice.recommend && (
          <Banner
            kind="warn"
            title="Worth backing up"
            action={
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => navigate('transfer')}
              >
                <Icon name="download" />
                Back up now
              </button>
            }
          >
            {advice.reason}
          </Banner>
        )}

        {state.v2Scan?.found && (
          <Banner
            kind="info"
            title="Existing Nexus Tavern V2 data found on this device"
            action={
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={runMigration}
                  disabled={migrating}
                >
                  {migrating ? <span className="spinner" /> : <Icon name="download" />}
                  Migrate existing V2 data
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={migrating}
                  onClick={async () => {
                    await dismissV2Migration();
                    await actions.reload();
                  }}
                >
                  Not now
                </button>
              </div>
            }
          >
            {[
              state.v2Scan.counts.characters && `${state.v2Scan.counts.characters} characters`,
              state.v2Scan.counts.personas && `${state.v2Scan.counts.personas} personas`,
              state.v2Scan.counts.stories && `${state.v2Scan.counts.stories} stories`,
              state.v2Scan.counts.lorebooks && `${state.v2Scan.counts.lorebooks} lorebooks`,
              state.v2Scan.counts.chats && `${state.v2Scan.counts.chats} chats`,
              state.v2Scan.counts.memories && `${state.v2Scan.counts.memories} memories`,
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            ({formatBytes(state.v2Scan.totalBytes)}) are still in the old localStorage format.
            Migrating copies them into the new database — your V2 data is left in place, so nothing
            is lost either way.
          </Banner>
        )}

        {!provider && (
          <Banner
            kind="warn"
            title="No AI provider configured"
            action={
              <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate('settings')}>
                <Icon name="settings" />
                Set up a provider
              </button>
            }
          >
            You can create characters, stories and lorebooks right now, but generating replies needs
            an AI provider.
          </Banner>
        )}

        <section className="section">
          <h2 className="section-title">Quick actions</h2>
          <div className="grid">
            {[
              { label: 'New Character', icon: 'users', run: () => navigate('character', 'new') },
              { label: 'New Persona', icon: 'user', run: () => navigate('persona', 'new') },
              { label: 'New Story', icon: 'book', run: () => navigate('story', 'new') },
              {
                label: 'New Chat',
                icon: 'chat',
                run: async () => {
                  const story = state.stories.filter((s) => !s.archived)[0];
                  if (!story) {
                    actions.toast({
                      kind: 'warn',
                      title: 'Create a story first',
                      detail: 'A chat needs a story to hold its characters.',
                    });
                    navigate('stories');
                    return;
                  }
                  const chat = await actions.createChat({ storyId: story.id });
                  navigate('chat', chat.id);
                },
              },
              {
                label: 'New Lorebook',
                icon: 'scroll',
                run: async () => {
                  const book = await actions.saveLorebook(newLorebook({ name: 'New Lorebook' }));
                  navigate('lorebook', book.id);
                },
              },
              {
                label: 'New Memory',
                icon: 'brain',
                run: async () => {
                  await actions.saveMemory(
                    newMemory({ title: 'New memory', content: '' }),
                  );
                  navigate('memories');
                },
              },
              { label: 'Import', icon: 'upload', run: () => navigate('transfer') },
              { label: 'Backup', icon: 'download', run: () => navigate('transfer') },
            ].map((action) => (
              <button key={action.label} type="button" className="card card-button" onClick={action.run}>
                <Icon name={action.icon} />
                <span style={{ fontWeight: 550 }}>{action.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Library</h2>
          <div className="stat-grid">
            {[
              ['Characters', state.characters.length, 'characters' as RouteName],
              ['Personas', state.personas.length, 'personas' as RouteName],
              ['Stories', state.stories.length, 'stories' as RouteName],
              ['Chats', state.chats.length, 'chat' as RouteName],
              ['Lorebooks', state.lorebooks.length, 'lorebooks' as RouteName],
              ['Memories', state.memories.length, 'memories' as RouteName],
              ['Images', state.media.length, 'media' as RouteName],
            ].map(([label, value, route]) => (
              <button
                key={label as string}
                type="button"
                className="stat"
                onClick={() => navigate(route as RouteName)}
              >
                <b>{value as number}</b>
                <span>{label as string}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">
            Recent stories
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('stories')}>
              See all
            </button>
          </h2>
          {!recentStories.length ? (
            <EmptyState
              icon="book"
              title="No stories yet"
              message="A story is where characters, lorebooks and chats come together."
              action={
                <button type="button" className="btn btn-primary" onClick={() => navigate('story', 'new')}>
                  <Icon name="plus" />
                  Create your first story
                </button>
              }
            />
          ) : (
            <div className="list">
              {recentStories.map((story) => {
                const cast = story.characters
                  .map((link) => state.characters.find((c) => c.id === link.characterId))
                  .filter(Boolean);
                return (
                  <button
                    key={story.id}
                    type="button"
                    className="card card-button"
                    onClick={() => navigate('story', story.id)}
                  >
                    {cast[0] ? (
                      <Avatar
                        mediaId={cast[0]!.avatarMediaId}
                        fallbackUrl={cast[0]!.avatarUrl}
                        name={cast[0]!.name}
                        size={44}
                        square
                      />
                    ) : (
                      <Icon name="book" />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 600 }}>
                        {story.title || 'Untitled story'}
                      </div>
                      <div className="small muted truncate">
                        {cast.length
                          ? cast.map((c) => c!.name).join(', ')
                          : truncate(story.description, 60) || 'No characters yet'}
                      </div>
                      <div className="small muted">{relativeTime(story.updatedAt)}</div>
                    </div>
                    <Icon name="chevronRight" />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {!!recentChats.length && (
          <section className="section">
            <h2 className="section-title">
              Recent chats
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('chat')}>
                See all
              </button>
            </h2>
            <div className="list">
              {recentChats.map((chat) => {
                const story = state.stories.find((s) => s.id === chat.storyId);
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className="card card-button"
                    onClick={() => navigate('chat', chat.id)}
                  >
                    <Icon name="chat" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 600 }}>
                        {chat.title}
                      </div>
                      <div className="small muted truncate">
                        {story?.title ?? 'No story'} · {relativeTime(chat.updatedAt)}
                      </div>
                    </div>
                    <Icon name="chevronRight" />
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
