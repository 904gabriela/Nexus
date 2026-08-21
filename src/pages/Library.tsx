import { useAppState } from '../state/store';
import { Icon } from '../components/ui/Icon';
import type { RouteName } from '../state/router';

interface Entry {
  route: RouteName;
  label: string;
  icon: string;
  blurb: string;
  count: number;
  create?: { label: string; route: RouteName; param?: string };
}

/**
 * The second tier of navigation. The bottom bar holds only what you reach
 * constantly — everything you *manage* rather than *use* lives here, one tap
 * from anywhere, with its create action on the same row.
 */
export function LibraryPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
}) {
  const state = useAppState();

  const entries: Entry[] = [
    {
      route: 'characters',
      label: 'Characters',
      icon: 'users',
      blurb: 'The cast you write with.',
      count: state.characters.length,
      create: { label: 'New character', route: 'character', param: 'new' },
    },
    {
      route: 'personas',
      label: 'Personas',
      icon: 'user',
      blurb: 'Who you are in the story.',
      count: state.personas.length,
      create: { label: 'New persona', route: 'persona', param: 'new' },
    },
    {
      route: 'lorebooks',
      label: 'Lorebooks',
      icon: 'scroll',
      blurb: 'World facts the AI recalls on cue.',
      count: state.lorebooks.length,
      create: { label: 'New lorebook', route: 'lorebooks' },
    },
    {
      route: 'memories',
      label: 'Memories',
      icon: 'brain',
      blurb: 'What the story must never forget.',
      count: state.memories.length,
      create: { label: 'New memory', route: 'memories' },
    },
    {
      route: 'media',
      label: 'Images',
      icon: 'image',
      blurb: 'Uploaded and generated pictures.',
      count: state.media.length,
    },
    {
      route: 'transfer',
      label: 'Import & Backup',
      icon: 'transfer',
      blurb: 'Bring data in, take it out, back it up.',
      count: 0,
    },
  ];

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Library</h1>
          <p className="small muted">Everything you manage, in one place.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => navigate('search')}
          aria-label="Search everything"
        >
          <Icon name="search" />
        </button>
      </header>

      <div className="page">
        <div className="list">
          {entries.map((entry) => (
            <div className="card library-row" key={entry.route}>
              <button
                type="button"
                className="library-open"
                onClick={() => navigate(entry.route)}
                aria-label={`Open ${entry.label}`}
              >
                <span className="library-icon" aria-hidden="true">
                  <Icon name={entry.icon} width={20} height={20} />
                </span>
                <span className="library-text">
                  <span className="library-title">
                    {entry.label}
                    {entry.count > 0 && <span className="chip">{entry.count}</span>}
                  </span>
                  <span className="small muted">{entry.blurb}</span>
                </span>
                <Icon name="chevronRight" width={17} height={17} />
              </button>
              {entry.create && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(entry.create!.route, entry.create!.param ?? null)}
                >
                  <Icon name="plus" />
                  New
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
