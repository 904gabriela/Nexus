/**
 * Export layer.
 *
 * Everything is written as human-readable JSON (2-space indent) with a small
 * envelope so imports can identify what they are looking at. API keys are
 * stripped from every export path — see stripSecrets().
 */

import type { Character, ID, LoreEntry, Lorebook, Memory, Message, Persona } from '../types';
import { SCHEMA_VERSION } from '../types/factories';
import {
  mergeCollections,
  nexusDocument,
  type NexusCollections,
  type NexusDocument,
  type NexusDocumentKind,
} from '../schema/nexus';
import * as repo from '../storage/repositories';
import { getMediaBlob, blobToDataUrl, listMedia } from '../media/mediaStore';
import { slugify } from '../utils/text';

/** Re-exported for callers that only import from here. */
export { NEXUS_FORMAT, LEGACY_FORMAT } from '../schema/nexus';

export type ExportKind = Exclude<NexusDocumentKind, 'mixed'>;

/**
 * Every export is a Nexus document (see `schema/nexus.ts`): flat collections
 * under one envelope, whatever the kind. The old per-kind `data` payloads are
 * still read on import, but nothing writes them any more.
 */
function nexusDoc(
  kind: ExportKind,
  collections: NexusCollections,
  primaryId?: ID | null,
): NexusDocument {
  return nexusDocument(kind, collections, {
    primaryId: primaryId ?? null,
    appSchemaVersion: SCHEMA_VERSION,
  });
}

/** Bundles a character's or persona's avatar under its own media id. */
async function avatarCollections(mediaId: ID | null): Promise<NexusCollections> {
  if (!mediaId) return {};
  const blob = await getMediaBlob(mediaId);
  if (!blob) return {};
  return { media: { [mediaId]: await blobToDataUrl(blob) } };
}

/** Flattens `{lorebook, entries}` pairs into the document's two collections. */
async function bookCollections(ids: ID[]): Promise<NexusCollections> {
  const lorebooks: Lorebook[] = [];
  const loreEntries: LoreEntry[] = [];
  for (const id of ids) {
    const lorebook = await repo.lorebooks.get(id);
    if (!lorebook) continue;
    lorebooks.push(lorebook);
    loreEntries.push(...(await repo.loreEntries.byLorebook(id)));
  }
  return { lorebooks, loreEntries };
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

export async function exportCharacter(
  character: Character,
  options: { includeAvatar?: boolean; includeLorebooks?: boolean } = {},
): Promise<string> {
  const collections = mergeCollections(
    { characters: [character] },
    options.includeAvatar === false ? {} : await avatarCollections(character.avatarMediaId),
    options.includeLorebooks ? await bookCollections(character.lorebookIds) : {},
  );
  return toJson(nexusDoc('character', collections, character.id));
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
  const collections = mergeCollections(
    { personas: [persona] },
    includeAvatar ? await avatarCollections(persona.avatarMediaId) : {},
  );
  return toJson(nexusDoc('persona', collections, persona.id));
}

export async function exportLorebook(lorebookId: ID): Promise<string> {
  const lorebook = await repo.lorebooks.get(lorebookId);
  if (!lorebook) throw new Error('That lorebook no longer exists.');
  const entries = await repo.loreEntries.byLorebook(lorebookId);
  return toJson(nexusDoc('lorebook', { lorebooks: [lorebook], loreEntries: entries }, lorebookId));
}

export function exportLoreEntries(lorebook: Lorebook, entries: LoreEntry[]): string {
  return toJson(nexusDoc('lorebook', { lorebooks: [lorebook], loreEntries: entries }, lorebook.id));
}

export function exportLoreEntry(entry: LoreEntry): string {
  return toJson(nexusDoc('lore-entry', { loreEntries: [entry] }, entry.id));
}

export function exportMemory(memory: Memory): string {
  return toJson(nexusDoc('memory', { memories: [memory] }, memory.id));
}

export function exportMemories(memories: Memory[]): string {
  return toJson(nexusDoc('memory', { memories }, memories.length === 1 ? memories[0].id : null));
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

  const allMemories = await repo.memories.all();
  const memories = allMemories.filter(
    (m) => m.sourceStoryId === storyId || story.memoryIds.includes(m.id),
  );

  const chatParts: NexusCollections[] = [];
  if (options.includeChats) {
    for (const chat of await repo.chats.byStory(storyId)) {
      chatParts.push(await collectChat(chat.id));
    }
  }

  let media: NexusCollections = {};
  if (options.includeMedia) {
    media = {
      media: await collectMedia(
        [
          story.coverMediaId,
          story.backgroundMediaId,
          ...characters.map((c) => c.avatarMediaId),
          persona?.avatarMediaId ?? null,
        ].filter(Boolean) as ID[],
      ),
    };
  }

  const collections = mergeCollections(
    {
      stories: [story],
      characters,
      personas: persona ? [persona] : [],
      memories,
    },
    await bookCollections(story.lorebookIds),
    ...chatParts,
    media,
  );
  return toJson(nexusDoc('story', collections, story.id));
}

/** A chat and everything hanging off it, as flat collections. */
async function collectChat(chatId: ID): Promise<NexusCollections> {
  const chat = await repo.chats.get(chatId);
  if (!chat) throw new Error('That chat no longer exists.');
  const [branches, messages, alternatives, checkpoints] = await Promise.all([
    repo.branches.byChat(chatId),
    repo.messages.byChat(chatId),
    repo.alternatives.byChat(chatId),
    repo.checkpoints.byChat(chatId),
  ]);
  return { chats: [chat], branches, messages, alternatives, checkpoints };
}

export async function exportChat(chatId: ID, includeMedia = false): Promise<string> {
  const collections = await collectChat(chatId);
  if (includeMedia) {
    const ids = (collections.messages ?? [])
      .flatMap((m) => m.attachments.map((a) => a.mediaId))
      .filter(Boolean) as ID[];
    collections.media = await collectMedia(ids);
  }
  return toJson(nexusDoc('chat', collections, chatId));
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

/**
 * Providers keep their config but never their key (spec §49). Both provider
 * kinds go through here — an image provider's key is exactly as sensitive.
 */
export function stripSecrets<T extends { apiKey: string }>(providers: T[]): T[] {
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
    imageProviders,
    storySummaries,
    deltas,
    relationshipRows,
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
    repo.imageProviders.all(),
    repo.storySummaries.all(),
    repo.sceneDeltas.all(),
    repo.relationshipDeltas.all(),
    repo.settingsRepo.load(),
  ]);

  const collections: NexusCollections = {
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
    imageProviders: stripSecrets(imageProviders),
    storySummaries,
    sceneDeltas: deltas,
    relationshipDeltas: relationshipRows,
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
    collections.media = media;
  }

  progress('Serialising…');
  return toJson(nexusDoc('backup', collections));
}

export function backupFilename(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `nexus-tavern-backup-${stamp}.json`;
}

export function exportFilename(kind: ExportKind, name: string): string {
  return `${kind}-${slugify(name)}.json`;
}
