/**
 * Storage durability.
 *
 * IndexedDB is *evictable* by default: under storage pressure a browser may
 * clear it without asking, and Safari discards unused site data after about
 * seven days of inactivity. Everything this app exists for — months of story —
 * lives there, so we ask the browser to mark the origin persistent.
 *
 * The request can be refused, and refusal is normal (Chrome grants it based on
 * engagement heuristics; Firefox may prompt). Nothing here ever claims a
 * guarantee the browser did not give.
 */

export type PersistenceState = 'persistent' | 'best-effort' | 'unsupported';

export interface StorageStatus {
  state: PersistenceState;
  /** Bytes currently used by this origin, when the browser reports it. */
  usage?: number;
  /** Approximate bytes available, when the browser reports it. */
  quota?: number;
}

/** Have we already asked this browser? Asking repeatedly gains nothing. */
const ASKED_KEY = 'nexus_storage_persist_asked';

export function supportsPersistence(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.persist;
}

/** Reads the current state without asking for anything. */
export async function readStorageStatus(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { state: 'unsupported' };
  }
  let state: PersistenceState = 'best-effort';
  try {
    if (navigator.storage.persisted) {
      state = (await navigator.storage.persisted()) ? 'persistent' : 'best-effort';
    } else {
      state = 'unsupported';
    }
  } catch {
    state = 'unsupported';
  }

  let usage: number | undefined;
  let quota: number | undefined;
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      usage = est.usage ?? undefined;
      quota = est.quota ?? undefined;
    }
  } catch {
    /* estimates are a nicety, not a requirement */
  }
  return { state, usage, quota };
}

/**
 * Asks the browser to keep this origin's data. Safe to call on every start:
 * if permission is already granted, or we have asked before and were refused,
 * this does nothing but report the current state.
 */
export async function requestPersistence(force = false): Promise<StorageStatus> {
  const current = await readStorageStatus();
  if (current.state !== 'best-effort') return current;

  let asked = false;
  try {
    asked = localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    /* private mode can throw on access; treat as not asked */
  }
  if (asked && !force) return current;

  try {
    await navigator.storage.persist();
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* refusal is a normal outcome, not an error to surface */
  }
  return readStorageStatus();
}

/**
 * Roughly how much a library is worth protecting. Used to decide when to
 * suggest a backup — a handful of characters is not worth nagging about, a
 * long-running story is.
 */
export interface BackupAdvice {
  /** True when there is enough here that losing it would genuinely hurt. */
  recommend: boolean;
  reason: string;
}

export function backupAdvice(input: {
  messages: number;
  stories: number;
  lastBackupAt: number | null;
  persistence: PersistenceState;
}): BackupAdvice {
  const { messages, stories, lastBackupAt, persistence } = input;
  const substantial = messages >= 200 || stories >= 3;
  if (!substantial) {
    return { recommend: false, reason: 'There is not much here to lose yet.' };
  }

  const days = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86_400_000) : null;
  if (days === null) {
    return {
      recommend: true,
      reason:
        persistence === 'persistent'
          ? `${messages} messages and no backup yet. The browser has agreed to keep this data, ` +
            'but that does not survive clearing site data or losing the device.'
          : `${messages} messages and no backup yet, and the browser has not promised to keep ` +
            'this data — it can be cleared automatically when storage runs low.',
    };
  }
  if (days >= 14) {
    return {
      recommend: true,
      reason: `Your last backup was ${days} days ago; there are ${messages} messages stored now.`,
    };
  }
  return { recommend: false, reason: `Backed up ${days === 0 ? 'today' : `${days} day(s) ago`}.` };
}
