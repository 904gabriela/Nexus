import { useEffect } from 'react';
import { AppStoreProvider, useAppState, useStore } from './state/store';
import { compileStats } from './context/compiler';
import { renderStats, resetRenderStats } from './utils/perf';
import { ConfirmProvider } from './components/ui/Confirm';
import { useRoute, type RouteName } from './state/router';
import { Icon } from './components/ui/Icon';
import { Banner, Spinner } from './components/ui/common';
import { DashboardPage } from './pages/Dashboard';
import { ChatPage } from './pages/Chat';
import { StoriesPage, StoryEditor } from './pages/Stories';
import { CharactersPage } from './pages/Characters';
import { CharacterEditor } from './pages/CharacterEditor';
import { PersonasPage, PersonaEditor } from './pages/Personas';
import { LorebooksPage, LorebookEditor } from './pages/Lorebooks';
import { MemoriesPage } from './pages/Memories';
import { WritingStylesPage } from './pages/WritingStyles';
import { LibraryPage } from './pages/Library';
import { TransferPage } from './pages/Transfer';
import { MediaPage } from './pages/Media';
import { SettingsPage } from './pages/Settings';
import { SearchPage } from './pages/Search';
import { revokeAllUrls } from './media/mediaStore';

/**
 * `primary` entries form the bottom bar on a phone: Home, Chats, Stories,
 * Library, Settings. Everything you manage rather than use sits one tap deeper
 * under Library, so the bar stays readable at 390px and each label means what
 * it says — the old "More" button went straight to Settings.
 */
const NAV: Array<{ route: RouteName; label: string; icon: string; primary: boolean }> = [
  { route: 'dashboard', label: 'Home', icon: 'home', primary: true },
  { route: 'chat', label: 'Chats', icon: 'chat', primary: true },
  { route: 'stories', label: 'Stories', icon: 'book', primary: true },
  { route: 'library', label: 'Library', icon: 'grid', primary: true },
  { route: 'settings', label: 'Settings', icon: 'settings', primary: true },
  { route: 'characters', label: 'Characters', icon: 'users', primary: false },
  { route: 'personas', label: 'Personas', icon: 'user', primary: false },
  { route: 'lorebooks', label: 'Lorebooks', icon: 'scroll', primary: false },
  { route: 'memories', label: 'Memories', icon: 'brain', primary: false },
  { route: 'styles', label: 'Writing styles', icon: 'edit', primary: false },
  { route: 'transfer', label: 'Import / Export', icon: 'transfer', primary: false },
  { route: 'media', label: 'Media', icon: 'image', primary: false },
  { route: 'search', label: 'Search', icon: 'search', primary: false },
];

/** Editor routes own the whole screen, so the bottom bar is hidden there. */
const FULLSCREEN: RouteName[] = ['chat', 'character', 'persona', 'story', 'lorebook'];

// A read-only window onto the counters, so a real browser session can measure
// what typing and opening a chat actually cost.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__nexusPerf = {
    compileStats,
    renderStats,
    reset: () => {
      resetRenderStats();
      compileStats.calls = 0;
      compileStats.totalMs = 0;
      compileStats.lastMs = 0;
    },
  };
}

export default function App() {
  return (
    <AppStoreProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </AppStoreProvider>
  );
}

function Shell() {
  const { route, navigate } = useRoute();
  const state = useAppState();
  const { toasts, dismissToast } = useStore();

  useEffect(() => revokeAllUrls, []);

  if (!state.ready) {
    return (
      <div className="app-shell">
        <Spinner label="Opening your library…" />
      </div>
    );
  }

  if (state.loadError) {
    return (
      <div className="app-shell">
        <div className="page">
          <Banner kind="error" title="Storyline could not start">
            {state.loadError} If you are in a private browsing window, try a normal window — some
            browsers block local databases in private mode.
          </Banner>
          <button type="button" className="btn btn-primary btn-block" onClick={() => location.reload()}>
            <Icon name="refresh" />
            Reload
          </button>
        </div>
      </div>
    );
  }

  const fullscreen =
    FULLSCREEN.includes(route.name) &&
    // The chat list (no chat id) still shows navigation.
    !(route.name === 'chat' && !route.param);

  return (
    <div className="app-shell">
      <div className="app-body">
        <nav className="side-nav" aria-label="Main navigation">
          <div className="side-nav-brand">
            Storyline
            <small>Pro</small>
          </div>
          {/*
            The same shape the phone has had all along. Listing all twelve
            destinations flat made the sidebar an index of tables — characters,
            personas, lorebooks, memories, media — which is what the app holds
            rather than what anyone came to do. What you use is at the top;
            what you manage is under Library, one heading down and still one
            click away.
          */}
          {NAV.filter((item) => item.primary).map((item) => (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              aria-current={route.name === item.route ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
          <div className="side-nav-group">Library</div>
          {NAV.filter((item) => !item.primary).map((item) => (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              aria-current={route.name === item.route ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <main className={`app-main${fullscreen ? ' no-nav-pad' : ''}`} id="main">
          <Router route={route} navigate={navigate} />
        </main>
      </div>

      {!fullscreen && (
        <nav className="bottom-nav" aria-label="Main navigation">
          {NAV.filter((item) => item.primary).map((item) => (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              aria-current={route.name === item.route ? 'page' : undefined}
              aria-label={item.label}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast-title">{toast.title}</div>
              {toast.detail && <div className="toast-detail">{toast.detail}</div>}
            </div>
            <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
              <Icon name="x" width={15} height={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Router({
  route,
  navigate,
}: {
  route: ReturnType<typeof useRoute>['route'];
  navigate: ReturnType<typeof useRoute>['navigate'];
}) {
  switch (route.name) {
    case 'chat':
      return (
        <ChatPage
          chatId={route.param}
          navigate={navigate}
          jumpToMessageId={route.query.get('message')}
        />
      );
    case 'stories':
      return <StoriesPage navigate={navigate} />;
    case 'story':
      return (
        <StoryEditor
          key={route.param ?? 'new'}
          storyId={route.param === 'new' ? null : route.param}
          presetCharacterId={route.query.get('character')}
          onClose={() => navigate('stories')}
          onOpenChat={(chatId) => navigate('chat', chatId)}
        />
      );
    case 'characters':
      return <CharactersPage navigate={navigate} />;
    case 'character':
      return (
        <CharacterEditor
          key={route.param ?? 'new'}
          characterId={route.param === 'new' ? null : route.param}
          onClose={() => navigate('characters')}
        />
      );
    case 'personas':
      return <PersonasPage navigate={navigate} />;
    case 'persona':
      return (
        <PersonaEditor
          key={route.param ?? 'new'}
          personaId={route.param === 'new' ? null : route.param}
          onClose={() => navigate('personas')}
        />
      );
    case 'lorebooks':
      return <LorebooksPage navigate={navigate} />;
    case 'lorebook':
      return route.param ? (
        <LorebookEditor key={route.param} lorebookId={route.param} onClose={() => navigate('lorebooks')} />
      ) : (
        <LorebooksPage navigate={navigate} />
      );
    case 'memories':
      return <MemoriesPage navigate={navigate} />;
    case 'styles':
      return <WritingStylesPage />;
    case 'transfer':
      return <TransferPage />;
    case 'media':
      return <MediaPage />;
    case 'library':
      return <LibraryPage navigate={navigate} />;
    case 'settings':
      return <SettingsPage />;
    case 'search':
      return <SearchPage initialQuery={route.query.get('q') ?? ''} navigate={navigate} />;
    case 'dashboard':
    default:
      return <DashboardPage navigate={navigate} />;
  }
}
