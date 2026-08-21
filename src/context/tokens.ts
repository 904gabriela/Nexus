/**
 * Token estimation without shipping a tokenizer.
 *
 * Blends a character-count and a word-count heuristic, which tracks BPE output
 * to roughly ±12% for English prose — good enough for a budget meter that is
 * always labelled as an estimate.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const byChars = chars / 3.8;
  const byWords = words * 1.35;
  return Math.max(1, Math.round((byChars + byWords) / 2));
}

/** Images cost a flat allowance in the budget meter. */
export const IMAGE_TOKEN_COST = 800;

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}
