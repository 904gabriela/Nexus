/**
 * Automatic memory.
 *
 * Scans a recent exchange for the trigger classes the user has enabled and, on
 * a hit, proposes a memory. Detection is deterministic and local so it costs
 * nothing per turn; the AI is only invoked to phrase the memory once a trigger
 * has actually fired.
 *
 * Everything it creates is an ordinary memory: editable, deletable, and never
 * pinned unless the user turned that on.
 */

import type {
  AutoMemoryTrigger,
  Character,
  Memory,
  MemoryCategory,
  Message,
  Persona,
  Provider,
  Settings,
} from '../types';
import { generateMemoryDraft } from './summarizer';
import { newMemory } from '../types/factories';

interface TriggerRule {
  trigger: AutoMemoryTrigger;
  category: MemoryCategory;
  /** Matching any of these marks the exchange as a candidate. */
  pattern: RegExp;
  /** Minimum matches before the trigger fires — filters incidental use. */
  threshold: number;
}

const RULES: TriggerRule[] = [
  {
    trigger: 'plot',
    category: 'Plot',
    pattern:
      /\b(discovered|revealed|realis?ed|decided|escaped|destroyed|defeated|arrived at last|the plan|turning point|everything changed)\b/gi,
    threshold: 2,
  },
  {
    trigger: 'relationship',
    category: 'Relationship',
    pattern:
      /\b(trust(ed|s)?|betray(ed|al)?|forgave|forgive|apologi[sz]ed?|allies|enem(y|ies)|friendship|closer|distant|estranged)\b/gi,
    threshold: 2,
  },
  {
    trigger: 'new-character',
    category: 'Character',
    pattern:
      /\b(introduc(ed|es)|my name is|call me|a stranger|newcomer|joined (us|them|the)|this is [A-Z][a-z]+)\b/gi,
    threshold: 1,
  },
  {
    trigger: 'revelation',
    category: 'Event',
    pattern:
      /\b(the truth|secret|confess(ed|ion)?|admitted|turns out|all along|hidden|concealed|never told)\b/gi,
    threshold: 2,
  },
  {
    trigger: 'promise',
    category: 'Event',
    pattern: /\b(promise[ds]?|swear|swore|vow(ed|s)?|give you my word|i will never|oath)\b/gi,
    threshold: 1,
  },
  {
    trigger: 'conflict',
    category: 'Event',
    pattern:
      /\b(argu(ed|ment)|fought|fight|attack(ed)?|threaten(ed)?|shouted|drew (a|his|her|their) (blade|sword|knife|weapon)|refus(ed|al))\b/gi,
    threshold: 2,
  },
  {
    trigger: 'romance',
    category: 'Relationship',
    pattern:
      /\b(kiss(ed|es)?|embrac(ed|e)|held (her|his|their) hand|i love you|in love|blush(ed|ing)?|intimate|heart raced)\b/gi,
    threshold: 2,
  },
  {
    trigger: 'location',
    category: 'Location',
    pattern:
      /\b(arriv(ed|es)|depart(ed|s)?|travell?ed|entered|left for|set out|reached|crossed into|made camp)\b/gi,
    threshold: 2,
  },
];

export interface TriggerHit {
  trigger: AutoMemoryTrigger;
  category: MemoryCategory;
  matches: string[];
}

/** Runs the enabled rules over one exchange. Pure and cheap. */
export function detectTriggers(
  messages: Message[],
  enabled: AutoMemoryTrigger[],
): TriggerHit[] {
  const text = messages.map((m) => m.content).join('\n');
  if (text.trim().length < 80) return [];

  const hits: TriggerHit[] = [];
  for (const rule of RULES) {
    if (!enabled.includes(rule.trigger)) continue;
    const matches = text.match(rule.pattern) ?? [];
    // Count distinct matches so one word repeated does not trip the threshold.
    const distinct = Array.from(new Set(matches.map((m) => m.toLowerCase())));
    if (distinct.length >= rule.threshold) {
      hits.push({ trigger: rule.trigger, category: rule.category, matches: distinct.slice(0, 6) });
    }
  }
  return hits.sort((a, b) => b.matches.length - a.matches.length);
}

export interface AutoMemoryInput {
  messages: Message[];
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  settings: Settings;
  chatId: string | null;
  storyId: string | null;
  /** Existing memories, used to avoid proposing near-duplicates. */
  existing: Memory[];
}

/** Cheap similarity check so the same beat is not remembered twice. */
function isDuplicate(content: string, existing: Memory[]): boolean {
  const words = new Set(
    content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4),
  );
  if (words.size < 3) return false;

  for (const memory of existing) {
    const other = new Set(
      memory.content
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4),
    );
    if (!other.size) continue;
    let shared = 0;
    for (const word of words) if (other.has(word)) shared += 1;
    if (shared / Math.min(words.size, other.size) > 0.6) return true;
  }
  return false;
}

export interface AutoMemoryResult {
  memory: Memory;
  hit: TriggerHit;
}

/**
 * Evaluates an exchange and, if a trigger fires, produces a saved-ready memory.
 * Returns null when nothing fired or the beat is already remembered.
 */
export async function maybeCreateAutoMemory(
  input: AutoMemoryInput,
): Promise<AutoMemoryResult | null> {
  const { settings } = input;
  if (!settings.autoMemory) return null;

  const hits = detectTriggers(input.messages, settings.autoMemoryTriggers);
  if (!hits.length) return null;
  const hit = hits[0];

  const draft = await generateMemoryDraft({
    messages: input.messages,
    characters: input.characters,
    persona: input.persona,
    provider: input.provider,
  });

  if (!draft.content.trim()) return null;
  if (isDuplicate(draft.content, input.existing)) return null;

  const memory = newMemory({
    origin: 'auto',
    title: draft.title || `Auto: ${hit.trigger}`,
    content: draft.content,
    // The trigger classification is more reliable than the model's guess here.
    category: hit.category,
    importance: 'normal',
    pinned: settings.autoMemoryPin,
    sourceMessageIds: input.messages.map((m) => m.id),
    sourceChatId: input.chatId,
    sourceStoryId: input.storyId,
    characterIds: Array.from(
      new Set(input.messages.map((m) => m.characterId).filter(Boolean) as string[]),
    ),
    tags: ['auto', hit.trigger],
  });

  return { memory, hit };
}

export function triggerLabel(trigger: AutoMemoryTrigger): string {
  const labels: Record<AutoMemoryTrigger, string> = {
    plot: 'Major plot event',
    relationship: 'Relationship change',
    'new-character': 'New character',
    revelation: 'Important revelation',
    promise: 'Promise',
    conflict: 'Conflict',
    romance: 'Romance milestone',
    location: 'Location change',
  };
  return labels[trigger];
}
