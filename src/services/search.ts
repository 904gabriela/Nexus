import type { Chat } from '../types';
import { messages as messageRepo } from '../storage/repositories';

export interface MessageHit {
  chatId: string;
  chatTitle: string;
  messageId: string;
  snippet: string;
}

/**
 * Message search runs on demand rather than keeping every message in memory —
 * a long-running library can hold tens of thousands of them.
 */
export async function messagesMatching(
  needle: string,
  chats: Chat[],
  limit = 60,
): Promise<MessageHit[]> {
  const term = needle.trim().toLowerCase();
  if (!term) return [];
  const hits: MessageHit[] = [];

  for (const chat of chats) {
    if (hits.length >= limit) break;
    const rows = await messageRepo.byChat(chat.id);
    for (const message of rows) {
      if (hits.length >= limit) break;
      const lower = message.content.toLowerCase();
      const index = lower.indexOf(term);
      if (index === -1) continue;
      const start = Math.max(0, index - 60);
      const end = Math.min(message.content.length, index + term.length + 60);
      hits.push({
        chatId: chat.id,
        chatTitle: chat.title,
        messageId: message.id,
        snippet: `${start > 0 ? '…' : ''}${message.content.slice(start, end)}${
          end < message.content.length ? '…' : ''
        }`,
      });
    }
  }

  return hits;
}
