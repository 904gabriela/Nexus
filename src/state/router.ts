import { useCallback, useEffect, useState } from 'react';

export type RouteName =
  | 'dashboard'
  | 'chat'
  | 'stories'
  | 'story'
  | 'characters'
  | 'character'
  | 'personas'
  | 'persona'
  | 'lorebooks'
  | 'lorebook'
  | 'memories'
  | 'transfer'
  | 'media'
  | 'settings'
  | 'search';

export interface Route {
  name: RouteName;
  param: string | null;
  query: URLSearchParams;
}

const VALID: RouteName[] = [
  'dashboard',
  'chat',
  'stories',
  'story',
  'characters',
  'character',
  'personas',
  'persona',
  'lorebooks',
  'lorebook',
  'memories',
  'transfer',
  'media',
  'settings',
  'search',
];

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, search = ''] = raw.split('?');
  const [name, param] = path.split('/');
  const routeName = (VALID as string[]).includes(name) ? (name as RouteName) : 'dashboard';
  return {
    name: routeName,
    param: param ? decodeURIComponent(param) : null,
    query: new URLSearchParams(search),
  };
}

export function buildHash(name: RouteName, param?: string | null, query?: Record<string, string>) {
  let hash = `#/${name}`;
  if (param) hash += `/${encodeURIComponent(param)}`;
  if (query && Object.keys(query).length) {
    hash += `?${new URLSearchParams(query).toString()}`;
  }
  return hash;
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof location === 'undefined' ? '' : location.hash),
  );

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    if (!location.hash) location.replace('#/dashboard');
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback(
    (name: RouteName, param?: string | null, query?: Record<string, string>) => {
      const next = buildHash(name, param, query);
      if (location.hash === next) {
        setRoute(parseHash(next));
        return;
      }
      location.hash = next;
    },
    [],
  );

  const back = useCallback(() => {
    if (history.length > 1) history.back();
    else location.hash = buildHash('dashboard');
  }, []);

  return { route, navigate, back };
}
