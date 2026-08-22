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
  // Counted in place rather than with trim().split(): compiling a long story
  // calls this once per message, per lore entry and per memory, and the two
  // intermediate arrays each call were a measurable part of opening a chat.
  let words = 0;
  let inWord = false;
  for (let i = 0; i < chars; i += 1) {
    const code = text.charCodeAt(i);
    const whitespace = code === 32 || (code >= 9 && code <= 13);
    if (whitespace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
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
