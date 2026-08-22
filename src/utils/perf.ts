/**
 * Counters for the work that decides whether the app feels instant.
 *
 * These exist because "typing must not rerender the history or rebuild the
 * context" is only enforceable if it can be measured. They are plain integers
 * incremented on paths that already run, so they cost nothing worth counting,
 * and they are exposed on `window.__nexusPerf` so a real browser session can
 * assert against them instead of relying on a stopwatch.
 */
export const renderStats = {
  /** Renders of an individual message bubble. */
  message: 0,
  /** Renders of the message list container. */
  list: 0,
  /** Renders of the composer. */
  composer: 0,
  /** Renders of the chat screen shell. */
  screen: 0,
};

export function resetRenderStats(): void {
  renderStats.message = 0;
  renderStats.list = 0;
  renderStats.composer = 0;
  renderStats.screen = 0;
}
