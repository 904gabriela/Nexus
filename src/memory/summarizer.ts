/**
 * Memory generation from selected messages.
 *
 * Uses the configured provider when one is available; otherwise falls back to a
 * deterministic extractive summary so "Remember" always produces something
 * editable rather than failing.
 */

import type { Character, Memory, MemoryCategory, Message, Persona, Provider } from '../types';
import { complete } from '../ai/client';
import { truncate } from '../utils/text';

export interface SummarizeInput {
  messages: Message[];
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  signal?: AbortSignal;
}

export interface MemoryDraft {
  title: string;
  content: string;
  category: MemoryCategory;
  generatedBy: 'ai' | 'fallback';
  note?: string;
}

function speakerName(
  message: Message,
  characters: Character[],
  persona: Persona | null,
): string {
  if (message.role === 'user') return persona?.displayName || persona?.name || 'User';
  const character = characters.find((c) => c.id === message.characterId);
  return character?.displayName || character?.name || 'Character';
}

function transcript(input: SummarizeInput): string {
  return input.messages
    .map((m) => `${speakerName(m, input.characters, input.persona)}: ${m.content.trim()}`)
    .join('\n\n');
}

const CATEGORY_PATTERNS: Array<[MemoryCategory, RegExp]> = [
  ['Relationship', /\b(love|kiss|marry|married|betray|trust|friend|hate|apolog|forgave|forgive)\w*/i],
  ['Item', /\b(sword|ring|amulet|key|artifact|weapon|potion|book|letter|gift)\w*/i],
  ['Location', /\b(arrive[d]?|travel|entered|city|village|castle|forest|tavern|room|road)\w*/i],
  ['Event', /\b(fought|battle|died|killed|escaped|attacked|saved|met|discovered|happened)\w*/i],
  ['World', /\b(kingdom|empire|magic|god|prophec|law|history|war|clan|faction)\w*/i],
  ['Character', /\b(revealed|secret|past|childhood|family|father|mother|sister|brother)\w*/i],
  ['Preference', /\b(likes?|dislikes?|prefers?|favou?rite|hates?)\b/i],
];

function guessCategory(text: string): MemoryCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return 'Plot';
}

/** Extractive fallback: keeps the most information-dense sentences. */
export function fallbackSummary(input: SummarizeInput): MemoryDraft {
  const messages = input.messages;
  const raw = transcript(input);

  const sentences: Array<{ text: string; score: number; index: number }> = [];
  let index = 0;
  for (const message of messages) {
    const speaker = speakerName(message, input.characters, input.persona);
    const parts = message.content
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    for (const sentence of parts) {
      // Prefer concrete sentences: named entities, numbers, dialogue.
      let score = Math.min(sentence.length / 60, 2);
      if (/\b[A-Z][a-z]{2,}\b/.test(sentence)) score += 1.2;
      if (/\d/.test(sentence)) score += 0.6;
      if (/"[^"]{6,}"|“[^”]{6,}”/.test(sentence)) score += 0.8;
      if (/\b(never|always|must|will|promise|swear|remember|secret)\b/i.test(sentence)) score += 1;
      if (/^(um|uh|hmm|haha|lol)\b/i.test(sentence)) score -= 1;
      sentences.push({ text: `${speaker}: ${sentence}`, score, index });
      index += 1;
    }
  }

  sentences.sort((a, b) => b.score - a.score);
  const picked = sentences.slice(0, Math.min(6, Math.max(2, Math.ceil(messages.length * 0.8))));
  picked.sort((a, b) => a.index - b.index);

  const content = picked.length
    ? picked.map((s) => `• ${s.text}`).join('\n')
    : truncate(raw, 600);

  const first = messages[0]?.content.replace(/\s+/g, ' ').trim() ?? '';
  const title = truncate(first || 'Remembered moment', 60);

  return {
    title,
    content,
    category: guessCategory(raw),
    generatedBy: 'fallback',
    note:
      'Summarised locally without AI. Edit it freely — this is a draft, nothing is saved until you press Save.',
  };
}

const SUMMARY_SYSTEM = `You compress roleplay transcripts into durable long-term memories.
Return ONLY a JSON object with these keys and nothing else:
{"title": string (max 60 chars), "category": one of ["Plot","Event","Character","Relationship","World","Location","Item","Preference","System","Other"], "content": string}
The content must be 1-4 short factual sentences in third person, present or past tense, capturing only what would matter many scenes later. Never invent details. Never include commentary.`;

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function generateMemoryDraft(input: SummarizeInput): Promise<MemoryDraft> {
  if (!input.messages.length) {
    return {
      title: '',
      content: '',
      category: 'Other',
      generatedBy: 'fallback',
      note: 'No messages were selected.',
    };
  }

  if (!input.provider || !input.provider.model) {
    return {
      ...fallbackSummary(input),
      note:
        'No AI provider is configured, so this was summarised locally. Edit it before saving, or set up a provider in Settings for AI summaries.',
    };
  }

  try {
    const reply = await complete({
      provider: input.provider,
      signal: input.signal,
      settings: { temperature: 0.3, maxTokens: 400, streaming: false },
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Transcript:\n\n${truncate(transcript(input), 8000)}` },
      ],
    });
    const parsed = extractJson(reply);
    if (!parsed) {
      return {
        ...fallbackSummary(input),
        note: 'The AI reply was not valid JSON, so a local summary was used instead.',
      };
    }
    const category = String(parsed.category ?? '') as MemoryCategory;
    const valid: MemoryCategory[] = [
      'Plot',
      'Event',
      'Character',
      'Relationship',
      'World',
      'Location',
      'Item',
      'Preference',
      'System',
      'Other',
    ];
    const content = String(parsed.content ?? '').trim();
    if (!content) {
      return { ...fallbackSummary(input), note: 'The AI returned no content; used a local summary.' };
    }
    return {
      title: truncate(String(parsed.title ?? '').trim() || content, 60),
      content,
      category: valid.includes(category) ? category : guessCategory(content),
      generatedBy: 'ai',
    };
  } catch (err) {
    return {
      ...fallbackSummary(input),
      note: `AI summarisation failed (${(err as Error).message}). A local summary was used instead — edit it as you like.`,
    };
  }
}

export function memoryFromDraft(draft: MemoryDraft, partial: Partial<Memory> = {}): Partial<Memory> {
  return {
    title: draft.title,
    content: draft.content,
    category: draft.category,
    ...partial,
  };
}
