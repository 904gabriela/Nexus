/**
 * Automatic memory.
 *
 * Scans a recent exchange for the trigger classes the user has enabled and, on
 * a hit, asks the memory matrix what changed. Detection is deterministic and
 * local so it costs nothing per turn; the AI is only invoked once a trigger has
 * actually fired.
 *
 * Everything it creates is an ordinary memory: editable, deletable, and never
 * pinned unless the user turned that on. Anything the matrix was not confident
 * about arrives as a proposal and stays out of the prompt until accepted.
 */

import type {
  AutoMemoryTrigger,
  Character,
  DiscoveredPerson,
  Memory,
  MemoryCategory,
  Message,
  Persona,
  Provider,
  Settings,
} from '../types';
import { extractMemories } from './matrix';

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

export interface AutoMemoryResult {
  memory: Memory;
  /** What made the scan look at this exchange at all. */
  hit: TriggerHit;
  /** Whether it committed, and why or why not. */
  reason: string;
}

/**
 * Evaluates an exchange and, if a trigger fires, extracts what changed.
 *
 * The triggers stay: they are a local, free filter over the exchange, and they
 * are what the user configured in Settings. What changed is that a firing no
 * longer produces one prose summary — it hands the exchange to the memory
 * matrix, which reports typed changes with a basis and a confidence, or reports
 * nothing at all. An empty result is a normal outcome; most exchanges do not
 * change anything worth keeping for later.
 */
export async function maybeCreateAutoMemory(
  input: AutoMemoryInput,
): Promise<{
  results: AutoMemoryResult[];
  discovered: DiscoveredPerson[];
  readable: boolean;
}> {
  const { settings } = input;
  const nothing = { results: [], discovered: [], readable: true };
  if (!settings.autoMemory) return nothing;

  const hits = detectTriggers(input.messages, settings.autoMemoryTriggers);
  if (!hits.length) return nothing;
  const hit = hits[0];

  const extracted = await extractMemories({
    messages: input.messages,
    characters: input.characters,
    persona: input.persona,
    provider: input.provider,
    chatId: input.chatId,
    storyId: input.storyId,
    existing: input.existing,
    pin: settings.autoMemoryPin,
    discoverPeople: settings.autoCharacters ?? true,
  });

  return {
    results: extracted.memories.map(({ memory, reason }) => ({
      // The trigger classification is a better category than the model's guess
      // only when the model did not offer one it was sure of; it did, so its
      // category stands and the trigger becomes a tag.
      memory: { ...memory, tags: [...new Set([...memory.tags, hit.trigger])] },
      hit,
      reason,
    })),
    discovered: extracted.discovered,
    readable: extracted.readable,
  };
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
