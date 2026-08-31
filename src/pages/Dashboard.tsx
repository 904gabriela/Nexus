import { useEffect, useMemo, useState } from 'react';
import { useActions, useAppState } from '../state/store';
import { Avatar, MediaImage } from '../components/media/MediaImage';
import { Icon } from '../components/ui/Icon';
import { ActionSheet } from '../components/ui/Sheet';
import { Banner, EmptyState } from '../components/ui/common';
import { migrateV2, dismissV2Migration } from '../storage/migration';
import { newLorebook, newMemory } from '../types/factories';
import { relativeTime, formatBytes } from '../utils/text';
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
  const [createOpen, setCreateOpen] = useState(false);

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
        .slice(0, 12),
    [state.stories],
  );

  const recentChats = useMemo(
    () =>
      state.chats
        .filter((c) => !c.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [state.chats],
  );

  /** The cover for a story: its own, else the primary character's portrait. */
  const coverFor = (story: (typeof state.stories)[number]) => {
    if (story.coverMediaId) return { mediaId: story.coverMediaId, name: story.title };
    const link =
      story.characters.find((c) => c.primary && c.enabled) ?? story.characters.find((c) => c.enabled);
    const character = link ? state.characters.find((c) => c.id === link.characterId) : null;
    return character
      ? { mediaId: character.avatarMediaId, url: character.avatarUrl, name: character.name }
      : null;
  };

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

        {/*
          What you were last reading comes first: nine times in ten the reason
          for opening the app is already open somewhere.
        */}
        {!!recentChats.length && (
          <section className="section">
            <h2 className="section-title">
              Continue
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('chat')}>
                All chats
              </button>
            </h2>
            <div className="list">
              {recentChats.map((chat) => {
                const story = state.stories.find((s) => s.id === chat.storyId) ?? null;
                const cover = story ? coverFor(story) : null;
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className="card card-button"
                    onClick={() => navigate('chat', chat.id)}
                  >
                    {cover ? (
                      <Avatar
                        mediaId={cover.mediaId}
                        fallbackUrl={cover.url}
                        name={cover.name}
                        size={40}
                        square
                      />
                    ) : (
                      <Icon name="chat" />
                    )}
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

        {/*
          A shelf, not a settings panel: covers at a readable size, the title
          under each, and nothing else competing for the tap.
        */}
        <section className="section">
          <h2 className="section-title">
            Your stories
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('stories')}>
              See all
            </button>
          </h2>
          {!recentStories.length ? (
            <EmptyState
              icon="book"
              title="Nothing here yet"
              message="A story is where characters, lorebooks and chats come together."
              action={
                <button type="button" className="btn btn-primary" onClick={() => navigate('story', 'new')}>
                  <Icon name="plus" />
                  Create your first story
                </button>
              }
            />
          ) : (
            <div className="shelf">
              {recentStories.map((story) => {
                const cover = coverFor(story);
                return (
                  <button
                    key={story.id}
                    type="button"
                    className="shelf-item"
                    onClick={() => navigate('story', story.id)}
                  >
                    <span className="shelf-cover">
                      {cover?.mediaId ? (
                        <MediaImage mediaId={cover.mediaId} alt={story.title || 'Untitled story'} />
                      ) : cover?.url ? (
                        <img src={cover.url} alt={story.title || 'Untitled story'} loading="lazy" />
                      ) : (
                        <Icon name="book" />
                      )}
                    </span>
                    <span className="shelf-title truncate">{story.title || 'Untitled story'}</span>
                    <span className="shelf-meta truncate">{relativeTime(story.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/*
        One button for everything that creates something. The eight-tile grid
        this replaces put every action on screen at once and made none of them
        look like the point.
      */}
      <button
        type="button"
        className="fab"
        aria-label="Create something new"
        onClick={() => setCreateOpen(true)}
      >
        <Icon name="plus" />
      </button>

      <ActionSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create"
        actions={[
          {
            key: 'story',
            label: 'New story',
            description: 'A campaign: cast, world, lorebooks, chats.',
            icon: 'book',
            onSelect: () => navigate('story', 'new'),
          },
          {
            key: 'character',
            label: 'New character',
            description: 'Reusable across every story.',
            icon: 'users',
            onSelect: () => navigate('character', 'new'),
          },
          {
            key: 'persona',
            label: 'New persona',
            description: 'Who you play.',
            icon: 'user',
            onSelect: () => navigate('persona', 'new'),
          },
          {
            key: 'lorebook',
            label: 'New lorebook',
            icon: 'scroll',
            onSelect: async () => {
              const book = await actions.saveLorebook(newLorebook({ name: 'New Lorebook' }));
              navigate('lorebook', book.id);
            },
          },
          {
            key: 'memory',
            label: 'New memory',
            icon: 'brain',
            onSelect: async () => {
              await actions.saveMemory(newMemory({ title: 'New memory', content: '' }));
              navigate('memories');
            },
          },
          {
            key: 'import',
            label: 'Import a file',
            description: 'Character cards, lorebooks, chat logs, backups.',
            icon: 'upload',
            separatorBefore: true,
            onSelect: () => navigate('transfer'),
          },
        ]}
      />
    </>
  );
}
