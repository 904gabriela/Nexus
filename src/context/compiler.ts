/**
 * Context compiler.
 *
 * Builds the exact payload sent to the model and reports, part by part, what
 * went in, what was dropped, and why. The Context Inspector renders this
 * structure verbatim — there is no second, hidden code path.
 */

import type {
  Attachment,
  ChatContentPart,
  ChatCompletionMessage,
  Character,
  Chat,
  CompiledContext,
  ContextPart,
  LoreEntry,
  LoreMiss,
  Lorebook,
  MemoryHit,
  Memory,
  Message,
  Persona,
  Settings,
  Story,
} from '../types';
import { scanLore } from '../lore/matcher';
import { IMAGE_TOKEN_COST, estimateTokens } from './tokens';

export interface CompileInput {
  settings: Settings;
  story: Story | null;
  chat: Chat | null;
  characters: Character[];
  persona: Persona | null;
  memories: Memory[];
  lorebooks: Lorebook[];
  loreEntries: LoreEntry[];
  /** Timeline for the active branch, oldest first. */
  history: Message[];
  /** Draft the user is about to send (not yet persisted). */
  pendingUserText?: string;
  pendingAttachments?: Attachment[];
  /** One-off instruction for "regenerate with instruction". */
  instruction?: string;
  /** Which character is being asked to reply, in a multi-character story. */
  respondingCharacterId?: string | null;
  /** Resolves an attachment to a data URL for vision-capable providers. */
  imageResolver?: (attachment: Attachment) => string | undefined;
  visionEnabled?: boolean;
}

export interface CompileResult extends CompiledContext {
  loreMisses: LoreMiss[];
}

/** Substitutes {{char}} / {{user}} / {{persona}} style macros. */
export function applyMacros(
  text: string,
  vars: { char: string; user: string; scenario?: string },
): string {
  if (!text) return '';
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, vars.char)
    .replace(/\{\{user\}\}|<USER>/gi, vars.user)
    .replace(/\{\{persona\}\}/gi, vars.user)
    .replace(/\{\{scenario\}\}/gi, vars.scenario ?? '');
}

function line(label: string, value: string): string {
  return value && value.trim() ? `${label}: ${value.trim()}` : '';
}

export function describeCharacter(character: Character, detailed = true): string {
  const name = character.displayName || character.name;
  const parts: string[] = [`# ${name}`];

  const identity = [
    line('Nickname', character.nickname),
    line('Age', character.age),
    line('Gender', character.gender),
    line('Pronouns', character.pronouns),
    line('Species', character.species),
    line('Race', character.race),
    line('Occupation', character.occupation),
    line('Role', character.role),
  ].filter(Boolean);
  if (identity.length) parts.push(identity.join('\n'));

  const body = [
    line('Summary', character.shortDescription),
    line('Description', character.description),
    line('Appearance', character.appearance),
    line('Physical traits', character.physicalTraits),
    line('Personality', character.personality),
    line('Temperament', character.temperament),
    line('Traits', character.traits.join(', ')),
  ].filter(Boolean);
  if (body.length) parts.push(body.join('\n'));

  if (detailed) {
    const background = [
      line('Backstory', character.backstory),
      line('History', character.history),
      line('Goals', character.goals),
      line('Motivations', character.motivations),
      line('Fears', character.fears),
      line('Secrets', character.secrets),
      line('Likes', character.likes),
      line('Dislikes', character.dislikes),
      line('Hobbies', character.hobbies),
      line('Values', character.values),
      line('Beliefs', character.beliefs),
    ].filter(Boolean);
    if (background.length) parts.push(background.join('\n'));

    const relations = [
      line('Relationships', character.relationships),
      line('Friends', character.friends),
      line('Enemies', character.enemies),
      line('Family', character.family),
      line('Romantic', character.romantic),
    ].filter(Boolean);
    if (relations.length) parts.push(relations.join('\n'));

    const world = [
      line('Home', character.home),
      line('Location', character.location),
      line('Faction', character.faction),
      line('World', character.world),
    ].filter(Boolean);
    if (world.length) parts.push(world.join('\n'));

    const voice = [
      line('Speaking style', character.speakingStyle),
      line('Speech patterns', character.speechPatterns),
    ].filter(Boolean);
    if (voice.length) parts.push(voice.join('\n'));

    const custom = character.customFields
      .filter((f) => f.key.trim() && f.value.trim())
      .map((f) => line(f.key, f.value));
    if (custom.length) parts.push(custom.join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}

export function describePersona(persona: Persona): string {
  const name = persona.displayName || persona.name;
  return [
    `# ${name} (the user's persona)`,
    [
      line('Nickname', persona.nickname),
      line('Age', persona.age),
      line('Gender', persona.gender),
      line('Pronouns', persona.pronouns),
      line('Species', persona.species),
      line('Occupation', persona.occupation),
    ]
      .filter(Boolean)
      .join('\n'),
    [
      line('Appearance', persona.appearance),
      line('Personality', persona.personality),
      line('Traits', persona.traits.join(', ')),
      line('Backstory', persona.backstory),
      line('Goals', persona.goals),
      line('Likes', persona.likes),
      line('Dislikes', persona.dislikes),
      line('Speech style', persona.speechStyle),
    ]
      .filter(Boolean)
      .join('\n'),
    persona.customFields
      .filter((f) => f.key.trim() && f.value.trim())
      .map((f) => line(f.key, f.value))
      .join('\n'),
    persona.customInstructions.trim(),
  ]
    .filter((s) => s && s.trim())
    .join('\n\n');
}

function memoryReason(memory: Memory): string {
  if (memory.pinned) return 'Pinned';
  if (memory.importance === 'critical') return 'Critical importance';
  if (memory.importance === 'high') return 'High importance';
  if (memory.importance === 'normal') return 'Normal importance';
  return 'Low importance';
}

const IMPORTANCE_RANK: Record<Memory['importance'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Priority tiers, higher survives trimming (spec §44). */
const PRIORITY = {
  system: 1000,
  global: 950,
  character: 900,
  persona: 850,
  story: 800,
  scenario: 790,
  pinnedMemory: 780,
  criticalMemory: 770,
  lore: 700,
  memory: 600,
  authorNote: 880,
  instruction: 990,
  recentHistory: 500,
  olderHistory: 100,
} as const;

function part(
  id: string,
  label: string,
  kind: ContextPart['kind'],
  content: string,
  reason: string,
  priority: number,
): ContextPart {
  return {
    id,
    label,
    kind,
    content,
    tokens: estimateTokens(content),
    reason,
    included: true,
    priority,
  };
}

export function compileContext(input: CompileInput): CompileResult {
  const { settings, story, chat, characters, persona } = input;

  const activeCharacters = characters.filter(Boolean);
  const responding =
    activeCharacters.find((c) => c.id === input.respondingCharacterId) ?? activeCharacters[0] ?? null;

  const charName = responding ? responding.displayName || responding.name : 'the character';
  const userName = persona ? persona.displayName || persona.name : 'User';
  const macroVars = { char: charName, user: userName, scenario: story?.scenario ?? '' };
  const macro = (text: string) => applyMacros(text, macroVars);

  const budget = Math.max(
    512,
    (chat?.settings.contextSize ??
      story?.settings.contextSize ??
      settings.contextBudget ??
      8192) - (settings.reserveForResponse ?? 0),
  );

  /* ------------------------------------------------------- gather parts */

  const parts: ContextPart[] = [];

  if (settings.globalSystemPrompt.trim()) {
    parts.push(
      part(
        'system',
        'System instructions',
        'system',
        macro(settings.globalSystemPrompt),
        'Always included — global system prompt from Settings.',
        PRIORITY.system,
      ),
    );
  }

  if (settings.globalInstructions.trim()) {
    parts.push(
      part(
        'global',
        'Global instructions',
        'global',
        macro(settings.globalInstructions),
        'Always included — global instructions from Settings.',
        PRIORITY.global,
      ),
    );
  }

  // Multi-character stories get a roster plus a directive about who speaks.
  if (activeCharacters.length > 1) {
    const roster = activeCharacters.map((c) => `- ${c.displayName || c.name}`).join('\n');
    parts.push(
      part(
        'cast',
        'Cast',
        'character',
        `The following characters are present in this scene:\n${roster}\n\n` +
          `You are currently writing as ${charName}. You may reference the others, ` +
          `but never write dialogue or actions for ${userName}.`,
        `${activeCharacters.length} active characters in this story.`,
        PRIORITY.character,
      ),
    );
  }

  activeCharacters.forEach((character, index) => {
    const isResponder = character.id === responding?.id;
    parts.push(
      part(
        `character:${character.id}`,
        `Character — ${character.displayName || character.name}${isResponder ? ' (speaking)' : ''}`,
        'character',
        macro(describeCharacter(character, true)),
        isResponder
          ? 'The character generating this reply.'
          : `Active co-star #${index + 1} in this story.`,
        isResponder ? PRIORITY.character : PRIORITY.character - 10 - index,
      ),
    );

    if (character.systemPrompt.trim()) {
      parts.push(
        part(
          `character-system:${character.id}`,
          `${character.displayName || character.name} — system prompt`,
          'system',
          macro(character.systemPrompt),
          'Character-specific system prompt.',
          PRIORITY.system - 5,
        ),
      );
    }
    if (character.exampleDialogue.trim()) {
      parts.push(
        part(
          `character-examples:${character.id}`,
          `${character.displayName || character.name} — example dialogue`,
          'character',
          macro(character.exampleDialogue),
          'Example dialogue teaches the model the character voice.',
          PRIORITY.character - 100,
        ),
      );
    }
  });

  // Per-story character notes.
  for (const link of story?.characters ?? []) {
    if (!link.enabled || !link.note.trim()) continue;
    const character = activeCharacters.find((c) => c.id === link.characterId);
    if (!character) continue;
    parts.push(
      part(
        `character-note:${link.characterId}`,
        `${character.displayName || character.name} — story note`,
        'story',
        macro(link.note),
        'Per-story note attached to this character.',
        PRIORITY.character - 20,
      ),
    );
  }

  if (persona) {
    parts.push(
      part(
        `persona:${persona.id}`,
        `Persona — ${persona.displayName || persona.name}`,
        'persona',
        macro(describePersona(persona)),
        'The persona the user is playing.',
        PRIORITY.persona,
      ),
    );
  }

  if (story) {
    const storyBlock = [
      story.title ? `# Story: ${story.title}` : '',
      story.description.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (storyBlock.trim()) {
      parts.push(
        part(
          `story:${story.id}`,
          'Story',
          'story',
          macro(storyBlock),
          'Story title and description.',
          PRIORITY.story,
        ),
      );
    }
    const scenario = story.scenario.trim() || responding?.scenario?.trim() || '';
    if (scenario) {
      parts.push(
        part(
          'scenario',
          'Scenario',
          'scenario',
          macro(`## Scenario\n${scenario}`),
          story.scenario.trim() ? 'Story scenario.' : 'Falls back to the character scenario.',
          PRIORITY.scenario,
        ),
      );
    }
  } else if (responding?.scenario?.trim()) {
    parts.push(
      part(
        'scenario',
        'Scenario',
        'scenario',
        macro(`## Scenario\n${responding.scenario}`),
        'Character scenario (no story attached).',
        PRIORITY.scenario,
      ),
    );
  }

  /* --------------------------------------------------------------- lore */

  const recentTexts = input.history
    .slice(-Math.max(settings.loreScanDepth, 1) * 3)
    .map((m) => resolveContent(m));
  if (input.pendingUserText) recentTexts.push(input.pendingUserText);

  const loreScan = scanLore({
    recentTexts,
    ambientText: [story?.scenario ?? '', persona?.personality ?? ''].filter(Boolean).join('\n'),
    lorebooks: input.lorebooks,
    entries: input.loreEntries,
    scope: {
      source: story ? 'story' : 'chat',
      storyLorebookIds: story?.lorebookIds ?? [],
      chatLorebookIds: chat?.lorebookIds ?? [],
      characterLorebookIds: activeCharacters.flatMap((c) => c.lorebookIds),
    },
    defaultScanDepth: settings.loreScanDepth,
    maxEntries: settings.maxLoreEntries,
  });

  for (const hit of loreScan.hits) {
    const heading = hit.entry.name ? `## ${hit.entry.name}` : '';
    parts.push(
      part(
        `lore:${hit.entry.id}`,
        `Lore — ${hit.entry.name || 'Untitled entry'} (${hit.lorebookName})`,
        'lore',
        macro([heading, hit.entry.content].filter(Boolean).join('\n')),
        hit.reason,
        PRIORITY.lore + Math.min(hit.entry.priority, 99),
      ),
    );
  }

  /* ------------------------------------------------------------ memories */

  const rankedMemories = [...input.memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const rank = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
    if (rank) return rank;
    return b.updatedAt - a.updatedAt;
  });

  const memoryHits: MemoryHit[] = [];
  const usableMemories = rankedMemories.slice(0, Math.max(0, settings.maxMemories));
  for (const memory of usableMemories) {
    if (!memory.content.trim()) continue;
    const reason = memoryReason(memory);
    memoryHits.push({ memory, reason });
    const priority = memory.pinned
      ? PRIORITY.pinnedMemory
      : memory.importance === 'critical'
        ? PRIORITY.criticalMemory
        : PRIORITY.memory + IMPORTANCE_RANK[memory.importance];
    parts.push(
      part(
        `memory:${memory.id}`,
        `Memory — ${memory.title || 'Untitled'}`,
        'memory',
        macro(
          `## ${memory.title || 'Memory'} [${memory.category}]\n${memory.content}`,
        ),
        `Included because: ${reason}.`,
        priority,
      ),
    );
  }

  /* -------------------------------------------------------- author note */

  const authorNote = [story?.authorNote ?? '', responding?.authorNote ?? '']
    .filter((s) => s.trim())
    .join('\n\n');
  if (authorNote.trim()) {
    parts.push(
      part(
        'author-note',
        "Author's note",
        'author-note',
        macro(authorNote),
        "Author's note is injected near the end for maximum steering weight.",
        PRIORITY.authorNote,
      ),
    );
  }

  if (input.instruction?.trim()) {
    parts.push(
      part(
        'instruction',
        'Regeneration instruction',
        'instruction',
        macro(input.instruction),
        'One-off instruction supplied for this generation.',
        PRIORITY.instruction,
      ),
    );
  }

  /* ---------------------------------------------------------- budgeting */

  const fixedTokens = parts.reduce((sum, p) => sum + p.tokens, 0);

  // History is budgeted separately: newest messages are kept first.
  const historyParts: ContextPart[] = [];
  const historyLimit = Math.max(1, settings.historyLimit || 200);
  const consideredHistory = input.history.slice(-historyLimit);

  for (let i = consideredHistory.length - 1; i >= 0; i -= 1) {
    const message = consideredHistory[i];
    const content = resolveContent(message);
    if (!content.trim() && !message.attachments.length) continue;
    const distanceFromEnd = consideredHistory.length - 1 - i;
    const speaker =
      message.role === 'user'
        ? userName
        : activeCharacters.find((c) => c.id === message.characterId)?.name ?? charName;
    historyParts.unshift({
      id: `history:${message.id}`,
      label: `${speaker} (${message.role})`,
      kind: 'history',
      content,
      tokens:
        estimateTokens(content) +
        message.attachments.filter((a) => a.kind === 'image').length * IMAGE_TOKEN_COST,
      reason: distanceFromEnd < 10 ? 'Recent message.' : `Message #${i + 1} in this branch.`,
      included: true,
      priority: distanceFromEnd < 10 ? PRIORITY.recentHistory : PRIORITY.olderHistory,
    });
  }

  const pendingTokens = input.pendingUserText
    ? estimateTokens(input.pendingUserText) +
      (input.pendingAttachments?.length ?? 0) * IMAGE_TOKEN_COST
    : 0;

  const excluded: ContextPart[] = [];
  let historyBudget = budget - fixedTokens - pendingTokens;

  const keptHistory: ContextPart[] = [];
  for (let i = historyParts.length - 1; i >= 0; i -= 1) {
    const hp = historyParts[i];
    if (historyBudget - hp.tokens < 0 && keptHistory.length > 0) {
      excluded.push({ ...hp, included: false, reason: 'Trimmed — older than the context budget.' });
      continue;
    }
    historyBudget -= hp.tokens;
    keptHistory.unshift(hp);
  }

  // If fixed parts alone blow the budget, drop the lowest-priority ones.
  let finalParts = parts;
  let overBudget = false;
  let totalFixed = fixedTokens;
  if (totalFixed + pendingTokens > budget) {
    overBudget = true;
    const sorted = [...parts].sort((a, b) => a.priority - b.priority);
    const dropped = new Set<string>();
    for (const candidate of sorted) {
      if (totalFixed + pendingTokens <= budget) break;
      // Never drop the top tier — without it the model has no instructions.
      if (candidate.priority >= PRIORITY.persona) continue;
      dropped.add(candidate.id);
      totalFixed -= candidate.tokens;
      excluded.push({
        ...candidate,
        included: false,
        reason: `${candidate.reason} — dropped: context budget exceeded.`,
      });
    }
    finalParts = parts.filter((p) => !dropped.has(p.id));
  }

  const allParts = [...finalParts, ...keptHistory];
  const totalTokens = allParts.reduce((sum, p) => sum + p.tokens, 0) + pendingTokens;

  /* ------------------------------------------------------ build payload */

  const systemPrompt = finalParts
    .filter((p) => p.kind !== 'history')
    .sort((a, b) => b.priority - a.priority)
    .map((p) => p.content)
    .filter(Boolean)
    .join('\n\n---\n\n');

  const payload: ChatCompletionMessage[] = [];
  if (systemPrompt.trim()) payload.push({ role: 'system', content: systemPrompt });

  const messageById = new Map(consideredHistory.map((m) => [`history:${m.id}`, m]));
  for (const hp of keptHistory) {
    const message = messageById.get(hp.id);
    if (!message) continue;
    payload.push(toApiMessage(message, hp.content, input));
  }

  if (input.pendingUserText || input.pendingAttachments?.length) {
    payload.push(
      toApiMessage(
        {
          role: 'user',
          attachments: input.pendingAttachments ?? [],
        } as Message,
        input.pendingUserText ?? '',
        input,
      ),
    );
  }

  return {
    systemPrompt,
    messages: payload,
    parts: allParts,
    excluded,
    totalTokens,
    budget,
    overBudget: overBudget || totalTokens > budget,
    loreHits: loreScan.hits,
    loreMisses: loreScan.misses,
    memoryHits,
  };
}

/** The active alternative, when one is selected, is what the model sees. */
export function resolveContent(message: Message, alternativeContent?: string): string {
  if (message.activeAlternativeId && alternativeContent !== undefined) return alternativeContent;
  return message.content;
}

function toApiMessage(
  message: Message,
  content: string,
  input: CompileInput,
): ChatCompletionMessage {
  const images = (message.attachments ?? []).filter((a) => a.kind === 'image');
  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'file' && a.text);

  let text = content;
  for (const file of textFiles) {
    text += `\n\n[Attached file: ${file.filename}]\n${file.text}`;
  }

  if (!images.length || !input.visionEnabled || !input.imageResolver) {
    const noted = images.length
      ? `${text}\n\n[${images.length} image attachment${images.length > 1 ? 's' : ''}: ${images
          .map((i) => i.filename)
          .join(', ')}]`
      : text;
    return { role: message.role, content: noted };
  }

  const contentParts: ChatContentPart[] = [];
  if (text.trim()) contentParts.push({ type: 'text', text });
  for (const image of images) {
    const url = input.imageResolver(image);
    if (url) contentParts.push({ type: 'image_url', image_url: { url } });
  }
  if (!contentParts.length) contentParts.push({ type: 'text', text });
  return { role: message.role, content: contentParts };
}

/** Flattens a compiled context to plain text for copy-to-clipboard. */
export function contextToText(compiled: CompiledContext): string {
  const lines: string[] = ['===== SYSTEM =====', compiled.systemPrompt, ''];
  for (const message of compiled.messages) {
    if (message.role === 'system') continue;
    const body =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((p) => (p.type === 'text' ? p.text : `[image: ${p.image_url.url.slice(0, 48)}…]`))
            .join('\n');
    lines.push(`===== ${message.role.toUpperCase()} =====`, body, '');
  }
  lines.push(`===== ESTIMATE: ${compiled.totalTokens} / ${compiled.budget} tokens =====`);
  return lines.join('\n');
}
