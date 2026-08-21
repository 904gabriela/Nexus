/**
 * "Export for AI summary" — a briefing pack, not a transcript dump.
 *
 * The goal is that someone can paste this into a different AI and it will
 * understand the whole story immediately: who everyone is, what has happened,
 * where things stand, and only the recent dialogue verbatim.
 */

import type {
  Character,
  Chat,
  LoreEntry,
  Lorebook,
  Memory,
  Message,
  Persona,
  Story,
  StorySummary,
} from '../types';
import { describeCharacter, describePersona } from '../context/compiler';
import { truncate } from '../utils/text';

export type AiSummaryFormat = 'markdown' | 'txt' | 'json';

export interface AiSummaryInput {
  story: Story | null;
  chat: Chat | null;
  characters: Character[];
  persona: Persona | null;
  summary: StorySummary | null;
  memories: Memory[];
  lorebooks: Lorebook[];
  loreEntries: LoreEntry[];
  /** Active-branch timeline, oldest first. */
  timeline: Message[];
  branchName: string;
  /** How many trailing messages to include verbatim. */
  recentCount: number;
}

function speakerName(
  message: Message,
  characters: Character[],
  persona: Persona | null,
): string {
  if (message.role === 'user') return persona?.displayName || persona?.name || 'User';
  if (message.role === 'system') return 'System';
  const character = characters.find((c) => c.id === message.characterId);
  return character?.displayName || character?.name || 'Character';
}

interface Collected {
  pinned: Memory[];
  important: Memory[];
  importantMessages: Message[];
  relevantLore: Array<{ entry: LoreEntry; book: string }>;
  recent: Message[];
}

function collect(input: AiSummaryInput): Collected {
  const pinned = input.memories.filter((m) => m.pinned);
  const important = input.memories.filter(
    (m) => !m.pinned && (m.importance === 'critical' || m.importance === 'high'),
  );

  const importantMessages = input.timeline.filter((m) => m.important);

  // Include lore that is always-on, or whose keywords appear anywhere in the
  // story — this pack is read once, so breadth beats precision here.
  const haystack = [
    input.story?.scenario ?? '',
    input.summary?.rollingSummary ?? '',
    input.timeline.map((m) => m.content).join('\n'),
  ]
    .join('\n')
    .toLowerCase();

  const bookById = new Map(input.lorebooks.map((b) => [b.id, b]));
  const relevantLore = input.loreEntries
    .filter((entry) => {
      const book = bookById.get(entry.lorebookId);
      if (!book?.enabled || !entry.enabled || !entry.content.trim()) return false;
      if (entry.activation === 'always') return true;
      const terms = [...entry.primaryKeys, ...entry.aliases];
      return terms.some((term) => term.trim() && haystack.includes(term.toLowerCase()));
    })
    .map((entry) => ({
      entry,
      book: bookById.get(entry.lorebookId)?.name || 'Lorebook',
    }));

  const recent = input.timeline.slice(-Math.max(1, input.recentCount));

  return { pinned, important, importantMessages, relevantLore, recent };
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n\n${body.trim()}\n` : '';
}

export function buildMarkdown(input: AiSummaryInput): string {
  const c = collect(input);
  const parts: string[] = [];

  parts.push(`# ${input.story?.title || input.chat?.title || 'Roleplay'} — story briefing\n`);
  parts.push(
    'This is a condensed briefing for an ongoing roleplay. Read it in full before continuing the story.\n',
  );

  parts.push(section('Premise', input.story?.description ?? ''));
  parts.push(section('Scenario', input.story?.scenario ?? ''));

  if (input.characters.length) {
    parts.push(
      section(
        'Characters',
        input.characters.map((character) => describeCharacter(character, true)).join('\n\n---\n\n'),
      ),
    );
  }
  if (input.persona) {
    parts.push(section('The user plays', describePersona(input.persona)));
  }

  if (input.summary) {
    parts.push(section('Where the story stands', input.summary.currentSummary));
    parts.push(section('History so far', input.summary.rollingSummary));
    if (input.summary.importantEvents.length) {
      parts.push(
        section('Key events', input.summary.importantEvents.map((e) => `- ${e}`).join('\n')),
      );
    }
    parts.push(section('Relationship state', input.summary.relationshipState));

    const states = Object.entries(input.summary.characterState).filter(([, v]) => v.trim());
    if (states.length) {
      parts.push(
        section(
          'Character state',
          states
            .map(([id, state]) => {
              const character = input.characters.find((ch) => ch.id === id);
              return `- **${character?.displayName || character?.name || id}**: ${state}`;
            })
            .join('\n'),
        ),
      );
    }
  }

  if (c.pinned.length) {
    parts.push(
      section(
        'Pinned memories (always true)',
        c.pinned.map((m) => `- **${m.title}** — ${m.content}`).join('\n'),
      ),
    );
  }
  if (c.important.length) {
    parts.push(
      section(
        'Important memories',
        c.important.map((m) => `- **${m.title}** (${m.category}) — ${m.content}`).join('\n'),
      ),
    );
  }
  if (c.importantMessages.length) {
    parts.push(
      section(
        'Messages the user flagged as important',
        c.importantMessages
          .map((m) => `> **${speakerName(m, input.characters, input.persona)}:** ${truncate(m.content, 600)}`)
          .join('\n\n'),
      ),
    );
  }
  if (c.relevantLore.length) {
    parts.push(
      section(
        'World reference',
        c.relevantLore
          .map(({ entry, book }) => `### ${entry.name || 'Entry'} _(${book})_\n${entry.content}`)
          .join('\n\n'),
      ),
    );
  }

  parts.push(section('Current timeline', `Branch: ${input.branchName}`));

  parts.push(
    section(
      `Recent conversation (last ${c.recent.length} messages, verbatim)`,
      c.recent
        .map((m) => `**${speakerName(m, input.characters, input.persona)}:** ${m.content.trim()}`)
        .join('\n\n'),
    ),
  );

  return parts.filter(Boolean).join('\n');
}

export function buildPlainText(input: AiSummaryInput): string {
  // Strip Markdown emphasis and heading markers, keep the structure readable.
  return buildMarkdown(input)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/^> /gm, '  ')
    .replace(/^---$/gm, '------------------------------');
}

export function buildJson(input: AiSummaryInput): string {
  const c = collect(input);
  return JSON.stringify(
    {
      format: 'nexus-tavern-pro',
      kind: 'ai-summary',
      generatedAt: new Date().toISOString(),
      story: input.story
        ? {
            title: input.story.title,
            description: input.story.description,
            scenario: input.story.scenario,
            authorNote: input.story.authorNote,
            tags: input.story.tags,
          }
        : null,
      characters: input.characters.map((character) => ({
        name: character.displayName || character.name,
        description: character.description,
        appearance: character.appearance,
        personality: character.personality,
        speakingStyle: character.speakingStyle,
        goals: character.goals,
        secrets: character.secrets,
      })),
      persona: input.persona
        ? {
            name: input.persona.displayName || input.persona.name,
            appearance: input.persona.appearance,
            personality: input.persona.personality,
            customInstructions: input.persona.customInstructions,
          }
        : null,
      summary: input.summary
        ? {
            current: input.summary.currentSummary,
            rolling: input.summary.rollingSummary,
            importantEvents: input.summary.importantEvents,
            relationshipState: input.summary.relationshipState,
            characterState: Object.fromEntries(
              Object.entries(input.summary.characterState).map(([id, state]) => {
                const character = input.characters.find((ch) => ch.id === id);
                return [character?.displayName || character?.name || id, state];
              }),
            ),
          }
        : null,
      pinnedMemories: c.pinned.map((m) => ({ title: m.title, content: m.content, category: m.category })),
      importantMemories: c.important.map((m) => ({
        title: m.title,
        content: m.content,
        category: m.category,
        importance: m.importance,
      })),
      importantMessages: c.importantMessages.map((m) => ({
        speaker: speakerName(m, input.characters, input.persona),
        content: m.content,
      })),
      lore: c.relevantLore.map(({ entry, book }) => ({
        lorebook: book,
        name: entry.name,
        keys: entry.primaryKeys,
        content: entry.content,
      })),
      branch: input.branchName,
      recentConversation: c.recent.map((m) => ({
        role: m.role,
        speaker: speakerName(m, input.characters, input.persona),
        content: m.content,
      })),
    },
    null,
    2,
  );
}

export function buildAiSummary(input: AiSummaryInput, format: AiSummaryFormat): string {
  if (format === 'json') return buildJson(input);
  if (format === 'txt') return buildPlainText(input);
  return buildMarkdown(input);
}

export function aiSummaryFilename(input: AiSummaryInput, format: AiSummaryFormat): string {
  const base = (input.story?.title || input.chat?.title || 'story')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50) || 'story';
  const ext = format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'md';
  return `${base}-briefing.${ext}`;
}

export function aiSummaryMime(format: AiSummaryFormat): string {
  if (format === 'json') return 'application/json';
  if (format === 'markdown') return 'text/markdown';
  return 'text/plain';
}
