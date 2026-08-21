/**
 * Export layer.
 *
 * Everything is written as human-readable JSON (2-space indent) with a small
 * envelope so imports can identify what they are looking at. API keys are
 * stripped from every export path — see stripSecrets().
 */

import type {
  Character,
  Chat,
  Checkpoint,
  ID,
  LoreEntry,
  Lorebook,
  Memory,
  Message,
  MessageAlternative,
  Persona,
  Provider,
  Settings,
  Story,
} from '../types';
import { SCHEMA_VERSION } from '../types/factories';
import * as repo from '../storage/repositories';
import { getMediaBlob, blobToDataUrl, listMedia } from '../media/mediaStore';
import { slugify } from '../utils/text';

export const NEXUS_FORMAT = 'nexus-tavern-pro';

export type ExportKind =
  | 'character'
  | 'persona'
  | 'lorebook'
  | 'lore-entry'
  | 'story'
  | 'chat'
  | 'memory'
  | 'backup';

export interface ExportEnvelope<T> {
  format: typeof NEXUS_FORMAT;
  kind: ExportKind;
  version: number;
  exportedAt: string;
  data: T;
}

function envelope<T>(kind: ExportKind, data: T): ExportEnvelope<T> {
  return {
    format: NEXUS_FORMAT,
    kind,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Triggers a browser download. */
export function downloadFile(filename: string, content: string | Blob, mimeType = 'application/json') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Give Safari a beat before revoking or the download aborts.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* --------------------------------------------------------- single items */

export interface CharacterExport {
  character: Character;
  avatar?: string;
  lorebooks?: Array<{ lorebook: Lorebook; entries: LoreEntry[] }>;
}

export async function exportCharacter(
  character: Character,
  options: { includeAvatar?: boolean; includeLorebooks?: boolean } = {},
): Promise<string> {
  const payload: CharacterExport = { character };
  if (options.includeAvatar !== false && character.avatarMediaId) {
    const blob = await getMediaBlob(character.avatarMediaId);
    if (blob) payload.avatar = await blobToDataUrl(blob);
  }
  if (options.includeLorebooks && character.lorebookIds.length) {
    payload.lorebooks = [];
    for (const id of character.lorebookIds) {
      const lorebook = await repo.lorebooks.get(id);
      if (!lorebook) continue;
      const entries = await repo.loreEntries.byLorebook(id);
      payload.lorebooks.push({ lorebook, entries });
    }
  }
  return toJson(envelope('character', payload));
}

/** Also emits a SillyTavern-compatible v2 character card. */
export function exportCharacterAsCardV2(character: Character, avatarDataUrl?: string): string {
  const greetings = character.greetings;
  const defaultGreeting =
    greetings.find((g) => g.id === character.defaultGreetingId) ?? greetings[0];
  const alternates = greetings.filter((g) => g.id !== defaultGreeting?.id).map((g) => g.content);
  return toJson({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: [character.description, character.appearance]
        .filter((s) => s.trim())
        .join('\n\n'),
      personality: character.personality,
      scenario: character.scenario,
      first_mes: defaultGreeting?.content ?? '',
      mes_example: character.exampleDialogue,
      creator_notes: character.creatorNotes,
      system_prompt: character.systemPrompt,
      post_history_instructions: character.authorNote,
      alternate_greetings: alternates,
      tags: character.tags,
      creator: character.creator,
      character_version: character.version,
      extensions: { nexus: { customFields: character.customFields } },
      avatar: avatarDataUrl ?? undefined,
    },
  });
}

export async function exportPersona(persona: Persona, includeAvatar = true): Promise<string> {
  const payload: { persona: Persona; avatar?: string } = { persona };
  if (includeAvatar && persona.avatarMediaId) {
    const blob = await getMediaBlob(persona.avatarMediaId);
    if (blob) payload.avatar = await blobToDataUrl(blob);
  }
  return toJson(envelope('persona', payload));
}

export async function exportLorebook(lorebookId: ID): Promise<string> {
  const lorebook = await repo.lorebooks.get(lorebookId);
  if (!lorebook) throw new Error('That lorebook no longer exists.');
  const entries = await repo.loreEntries.byLorebook(lorebookId);
  return toJson(envelope('lorebook', { lorebook, entries }));
}

export function exportLoreEntries(lorebook: Lorebook, entries: LoreEntry[]): string {
  return toJson(envelope('lorebook', { lorebook, entries }));
}

export function exportLoreEntry(entry: LoreEntry): string {
  return toJson(envelope('lore-entry', { entry }));
}

export function exportMemory(memory: Memory): string {
  return toJson(envelope('memory', { memory }));
}

export function exportMemories(memories: Memory[]): string {
  return toJson(envelope('memory', { memories }));
}

export interface StoryExport {
  story: Story;
  characters: Character[];
  persona: Persona | null;
  lorebooks: Array<{ lorebook: Lorebook; entries: LoreEntry[] }>;
  memories: Memory[];
  chats?: ChatExport[];
  media?: Record<ID, string>;
}

export async function exportStory(
  storyId: ID,
  options: { includeChats?: boolean; includeMedia?: boolean } = {},
): Promise<string> {
  const story = await repo.stories.get(storyId);
  if (!story) throw new Error('That story no longer exists.');

  const characters: Character[] = [];
  for (const link of story.characters) {
    const character = await repo.characters.get(link.characterId);
    if (character) characters.push(character);
  }
  const persona = story.personaId ? ((await repo.personas.get(story.personaId)) ?? null) : null;

  const lorebooks: StoryExport['lorebooks'] = [];
  for (const id of story.lorebookIds) {
    const lorebook = await repo.lorebooks.get(id);
    if (!lorebook) continue;
    lorebooks.push({ lorebook, entries: await repo.loreEntries.byLorebook(id) });
  }

  const allMemories = await repo.memories.all();
  const memories = allMemories.filter(
    (m) => m.sourceStoryId === storyId || story.memoryIds.includes(m.id),
  );

  const payload: StoryExport = { story, characters, persona, lorebooks, memories };

  if (options.includeChats) {
    const chats = await repo.chats.byStory(storyId);
    payload.chats = [];
    for (const chat of chats) payload.chats.push(await collectChat(chat.id));
  }

  if (options.includeMedia) {
    payload.media = await collectMedia(
      [
        story.coverMediaId,
        story.backgroundMediaId,
        ...characters.map((c) => c.avatarMediaId),
        persona?.avatarMediaId ?? null,
      ].filter(Boolean) as ID[],
    );
  }

  return toJson(envelope('story', payload));
}

export interface ChatExport {
  chat: Chat;
  branches: Awaited<ReturnType<typeof repo.branches.byChat>>;
  messages: Message[];
  alternatives: MessageAlternative[];
  checkpoints: Checkpoint[];
}

async function collectChat(chatId: ID): Promise<ChatExport> {
  const chat = await repo.chats.get(chatId);
  if (!chat) throw new Error('That chat no longer exists.');
  const [branches, messages, alternatives, checkpoints] = await Promise.all([
    repo.branches.byChat(chatId),
    repo.messages.byChat(chatId),
    repo.alternatives.byChat(chatId),
    repo.checkpoints.byChat(chatId),
  ]);
  return { chat, branches, messages, alternatives, checkpoints };
}

export async function exportChat(chatId: ID, includeMedia = false): Promise<string> {
  const payload = await collectChat(chatId);
  const withMedia: ChatExport & { media?: Record<ID, string> } = payload;
  if (includeMedia) {
    const ids = payload.messages
      .flatMap((m) => m.attachments.map((a) => a.mediaId))
      .filter(Boolean) as ID[];
    withMedia.media = await collectMedia(ids);
  }
  return toJson(envelope('chat', withMedia));
}

/** Plain-text transcript, handy for archiving or feeding elsewhere. */
export function chatToTranscript(
  messages: Message[],
  nameFor: (message: Message) => string,
): string {
  return messages
    .map((message) => `${nameFor(message)}:\n${message.content}\n`)
    .join('\n');
}

async function collectMedia(ids: ID[]): Promise<Record<ID, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const out: Record<ID, string> = {};
  for (const id of unique) {
    const blob = await getMediaBlob(id);
    if (blob) out[id] = await blobToDataUrl(blob);
  }
  return out;
}

/* ---------------------------------------------------------------- backup */

export interface BackupPayload {
  characters: Character[];
  personas: Persona[];
  stories: Story[];
  chats: Chat[];
  branches: Awaited<ReturnType<typeof repo.branches.all>>;
  messages: Message[];
  alternatives: MessageAlternative[];
  checkpoints: Checkpoint[];
  memories: Memory[];
  lorebooks: Lorebook[];
  loreEntries: LoreEntry[];
  mediaMeta: Awaited<ReturnType<typeof repo.mediaMeta.all>>;
  /** mediaId → data URL. Present only when media is bundled. */
  media?: Record<ID, string>;
  mediaIncluded: boolean;
  providers: Provider[];
  settings: Settings;
}

/** Providers keep their config but never their key (spec §49). */
export function stripSecrets(providers: Provider[]): Provider[] {
  return providers.map((p) => ({ ...p, apiKey: '' }));
}

export interface BackupOptions {
  includeMedia: boolean;
  onProgress?: (message: string) => void;
}

export async function buildBackup(options: BackupOptions): Promise<string> {
  const progress = options.onProgress ?? (() => {});
  progress('Reading library…');

  const [
    characters,
    personas,
    stories,
    chats,
    branches,
    messages,
    alternatives,
    checkpoints,
    memories,
    lorebooks,
    loreEntries,
    mediaMetaList,
    providers,
    settings,
  ] = await Promise.all([
    repo.characters.all(),
    repo.personas.all(),
    repo.stories.all(),
    repo.chats.all(),
    repo.branches.all(),
    repo.messages.all(),
    repo.alternatives.all(),
    repo.checkpoints.all(),
    repo.memories.all(),
    repo.lorebooks.all(),
    repo.loreEntries.all(),
    listMedia(),
    repo.providers.all(),
    repo.settingsRepo.load(),
  ]);

  const payload: BackupPayload = {
    characters,
    personas,
    stories,
    chats,
    branches,
    messages,
    alternatives,
    checkpoints,
    memories,
    lorebooks,
    loreEntries,
    mediaMeta: mediaMetaList,
    mediaIncluded: options.includeMedia,
    providers: stripSecrets(providers),
    settings: { ...settings },
  };

  if (options.includeMedia) {
    progress(`Bundling ${mediaMetaList.length} image(s)…`);
    const media: Record<ID, string> = {};
    for (let i = 0; i < mediaMetaList.length; i += 1) {
      const meta = mediaMetaList[i];
      const blob = await getMediaBlob(meta.id);
      if (blob) media[meta.id] = await blobToDataUrl(blob);
      if (i % 5 === 0) progress(`Bundling images… ${i + 1}/${mediaMetaList.length}`);
    }
    payload.media = media;
  }

  progress('Serialising…');
  return toJson(envelope('backup', payload));
}

export function backupFilename(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `nexus-tavern-backup-${stamp}.json`;
}

export function exportFilename(kind: ExportKind, name: string): string {
  return `${kind}-${slugify(name)}.json`;
}
