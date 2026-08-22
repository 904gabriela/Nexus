/**
 * Runs work when the main thread is free, with a timeout so it still happens on
 * a busy page. Safari only gained requestIdleCallback recently, so the fallback
 * is a real code path rather than a formality.
 */
export function onIdle(callback: () => void, timeout = 500): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(callback, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, Math.min(timeout, 200));
  return () => window.clearTimeout(id);
}
