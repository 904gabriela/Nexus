/**
 * Minimal promise wrapper around IndexedDB.
 *
 * Deliberately dependency-free: the whole app persists here, so the layer stays
 * small, auditable and easy to migrate.
 */

export const DB_NAME = 'nexus-tavern-pro';
export const DB_VERSION = 2;

export const STORES = {
  characters: 'characters',
  personas: 'personas',
  stories: 'stories',
  chats: 'chats',
  messages: 'messages',
  messageAlternatives: 'messageAlternatives',
  branches: 'branches',
  checkpoints: 'checkpoints',
  memories: 'memories',
  lorebooks: 'lorebooks',
  loreEntries: 'loreEntries',
  media: 'media',
  mediaBlobs: 'mediaBlobs',
  providers: 'providers',
  imageProviders: 'imageProviders',
  storySummaries: 'storySummaries',
  settings: 'settings',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

interface IndexSpec {
  name: string;
  keyPath: string;
  unique?: boolean;
}

const SCHEMA: Record<StoreName, IndexSpec[]> = {
  characters: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  personas: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  stories: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  chats: [
    { name: 'storyId', keyPath: 'storyId' },
    { name: 'updatedAt', keyPath: 'updatedAt' },
  ],
  messages: [
    { name: 'chatId', keyPath: 'chatId' },
    { name: 'branchId', keyPath: 'branchId' },
  ],
  messageAlternatives: [
    { name: 'messageId', keyPath: 'messageId' },
    { name: 'chatId', keyPath: 'chatId' },
  ],
  branches: [{ name: 'chatId', keyPath: 'chatId' }],
  checkpoints: [
    { name: 'chatId', keyPath: 'chatId' },
    { name: 'storyId', keyPath: 'storyId' },
  ],
  memories: [
    { name: 'sourceStoryId', keyPath: 'sourceStoryId' },
    { name: 'updatedAt', keyPath: 'updatedAt' },
  ],
  lorebooks: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  loreEntries: [{ name: 'lorebookId', keyPath: 'lorebookId' }],
  media: [
    { name: 'ownerId', keyPath: 'ownerId' },
    { name: 'createdAt', keyPath: 'createdAt' },
    { name: 'source', keyPath: 'source' },
  ],
  mediaBlobs: [],
  providers: [],
  imageProviders: [],
  storySummaries: [{ name: 'storyId', keyPath: 'storyId' }],
  settings: [],
};

let dbPromise: Promise<IDBDatabase> | null = null;

export class StorageError extends Error {
  readonly reason?: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.reason = reason;
  }
}

function requireIndexedDB(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new StorageError(
      'IndexedDB is unavailable in this browser. Private browsing modes sometimes block it.',
    );
  }
  return indexedDB;
}

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = requireIndexedDB().open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new StorageError('Could not open the local database.', err));
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      for (const [name, indexes] of Object.entries(SCHEMA) as [StoreName, IndexSpec[]][]) {
        const store = db.objectStoreNames.contains(name)
          ? tx.objectStore(name)
          : db.createObjectStore(name, { keyPath: 'id' });
        for (const idx of indexes) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
          }
        }
      }

      // v1 media rows have no `source`, so they would be invisible to the new
      // index. Backfill them as uploads during the upgrade transaction.
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        const media = tx.objectStore(STORES.media);
        const cursorRequest = media.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const row = cursor.value as { source?: string };
          if (!row.source) cursor.update({ ...row, source: 'upload' });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(new StorageError('Could not open the local database.', request.error));
    request.onblocked = () =>
      reject(
        new StorageError(
          'The database is blocked by another open tab. Close other Nexus Tavern tabs and retry.',
        ),
      );
  });
  return dbPromise;
}

/** Test seam — forces the next openDB() to reconnect. */
export function resetDBHandle(): void {
  dbPromise = null;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageError('Database request failed.', request.error));
  });
}

async function withStore<T>(
  names: StoreName | StoreName[],
  mode: IDBTransactionMode,
  fn: (stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  const list = Array.isArray(names) ? names : [names];
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(list, mode);
    } catch (err) {
      reject(new StorageError(`Could not start a "${mode}" transaction.`, err));
      return;
    }
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of list) stores[name] = tx.objectStore(name);

    let result: T;
    let settled = false;
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new StorageError('The database transaction failed.', tx.error));
      }
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(new StorageError('The database transaction was aborted.', tx.error));
      }
    };

    Promise.resolve(fn(stores, tx)).then(
      (value) => {
        result = value;
      },
      (err) => {
        settled = true;
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(err instanceof StorageError ? err : new StorageError(String(err), err));
      },
    );
  });
}

export async function dbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  return withStore(store, 'readonly', (s) => wrap<T | undefined>(s[store].get(id)));
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return withStore(store, 'readonly', (s) => wrap<T[]>(s[store].getAll()));
}

export async function dbGetAllByIndex<T>(
  store: StoreName,
  index: string,
  value: IDBValidKey,
): Promise<T[]> {
  return withStore(store, 'readonly', (s) => wrap<T[]>(s[store].index(index).getAll(value)));
}

export async function dbPut<T>(store: StoreName, value: T): Promise<T> {
  await withStore(store, 'readwrite', (s) => wrap(s[store].put(value)));
  return value;
}

export async function dbPutMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  await withStore(store, 'readwrite', async (s) => {
    for (const value of values) await wrap(s[store].put(value));
  });
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  await withStore(store, 'readwrite', (s) => wrap(s[store].delete(id)));
}

export async function dbDeleteMany(store: StoreName, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await withStore(store, 'readwrite', async (s) => {
    for (const id of ids) await wrap(s[store].delete(id));
  });
}

export async function dbClear(store: StoreName): Promise<void> {
  await withStore(store, 'readwrite', (s) => wrap(s[store].clear()));
}

export async function dbCount(store: StoreName): Promise<number> {
  return withStore(store, 'readonly', (s) => wrap<number>(s[store].count()));
}

/** Multi-store atomic write used by import/restore so partial data never lands. */
export async function dbTransactionWrite(
  writes: Array<{ store: StoreName; op: 'put' | 'delete' | 'clear'; value?: unknown; id?: string }>,
): Promise<void> {
  const names = Array.from(new Set(writes.map((w) => w.store)));
  if (!names.length) return;
  await withStore(names, 'readwrite', async (stores) => {
    for (const write of writes) {
      const store = stores[write.store];
      if (write.op === 'put') await wrap(store.put(write.value));
      else if (write.op === 'delete') await wrap(store.delete(write.id!));
      else await wrap(store.clear());
    }
  });
}

export const ALL_DATA_STORES: StoreName[] = [
  STORES.characters,
  STORES.personas,
  STORES.stories,
  STORES.chats,
  STORES.messages,
  STORES.messageAlternatives,
  STORES.branches,
  STORES.checkpoints,
  STORES.memories,
  STORES.lorebooks,
  STORES.loreEntries,
  STORES.media,
  STORES.mediaBlobs,
  STORES.providers,
  STORES.imageProviders,
  STORES.storySummaries,
  STORES.settings,
];
