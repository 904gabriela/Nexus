/**
 * Nexus Tavern V2 → V3 migration.
 *
 * V2 kept everything in localStorage under `nexus_v2_*` keys, including base64
 * avatars. We read those keys, normalise every record into the new schema,
 * lift base64 images into blob-backed media, and write the result into
 * IndexedDB. The original localStorage keys are left untouched so a failed or
 * declined migration loses nothing and can be retried.
 */

import type {
  Branch,
  Chat,
  Character,
  ID,
  LoreEntry,
  Lorebook,
  Memory,
  Message,
  Persona,
  Provider,
  Settings,
  Story,
} from '../types';
import {
  DEFAULT_GENERATION,
  newBranch,
  newChat,
  newMemory,
  newMessage,
  newProvider,
  newStory,
} from '../types/factories';
import {
  normalizeCharacter,
  normalizeLorebook,
  normalizePersona,
  isPlainObject,
} from '../importers/normalize';
import { importDataUrl } from '../media/mediaStore';
import { firstOf, toBool, toNumber, toStringList } from '../utils/text';
import * as repo from './repositories';

export const V2_KEYS = {
  stories: 'nexus_v2_stories',
  characters: 'nexus_v2_chars',
  personas: 'nexus_v2_personas',
  lore: 'nexus_v2_lore',
  settings: 'nexus_v2_settings',
  chats: 'nexus_v2_chats',
  memories: 'nexus_v2_memories',
} as const;

export interface V2Scan {
  found: boolean;
  counts: {
    characters: number;
    personas: number;
    stories: number;
    lorebooks: number;
    chats: number;
    memories: number;
    settings: number;
  };
  totalBytes: number;
  keysPresent: string[];
}

function readKey(key: string): unknown {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rawSize(key: string): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    return localStorage.getItem(key)?.length ?? 0;
  } catch {
    return 0;
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    // V2 also stored keyed maps in a couple of places.
    const values = Object.values(value);
    if (values.every((v) => isPlainObject(v))) return values;
  }
  return [];
}

export function scanV2(): V2Scan {
  const keysPresent: string[] = [];
  let totalBytes = 0;
  for (const key of Object.values(V2_KEYS)) {
    const size = rawSize(key);
    if (size > 0) {
      keysPresent.push(key);
      totalBytes += size;
    }
  }
  const counts = {
    characters: asArray(readKey(V2_KEYS.characters)).length,
    personas: asArray(readKey(V2_KEYS.personas)).length,
    stories: asArray(readKey(V2_KEYS.stories)).length,
    lorebooks: asArray(readKey(V2_KEYS.lore)).length,
    chats: asArray(readKey(V2_KEYS.chats)).length,
    memories: asArray(readKey(V2_KEYS.memories)).length,
    settings: readKey(V2_KEYS.settings) ? 1 : 0,
  };
  const found =
    keysPresent.length > 0 &&
    Object.values(counts).some((n) => n > 0);
  return { found, counts, totalBytes, keysPresent };
}

export interface MigrationReport {
  characters: number;
  personas: number;
  stories: number;
  lorebooks: number;
  loreEntries: number;
  chats: number;
  messages: number;
  memories: number;
  media: number;
  providers: number;
  warnings: string[];
}

async function liftAvatar(
  value: string,
  ownerType: 'character' | 'persona' | 'story-cover' | 'story-background',
  ownerId: ID,
  warnings: string[],
  label: string,
): Promise<ID | null> {
  if (!value || !value.startsWith('data:')) return null;
  try {
    const meta = await importDataUrl(value, {
      ownerType,
      ownerId,
      filename: `${label}-avatar`,
    });
    return meta.id;
  } catch (err) {
    warnings.push(`Could not migrate the image for "${label}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Runs the migration. Existing V3 rows are never overwritten — a V2 record
 * whose id already exists is imported under a fresh id.
 */
export async function migrateV2(): Promise<MigrationReport> {
  const report: MigrationReport = {
    characters: 0,
    personas: 0,
    stories: 0,
    lorebooks: 0,
    loreEntries: 0,
    chats: 0,
    messages: 0,
    memories: 0,
    media: 0,
    providers: 0,
    warnings: [],
  };

  const [existingChars, existingPersonas, existingStories, existingBooks] = await Promise.all([
    repo.characters.all(),
    repo.personas.all(),
    repo.stories.all(),
    repo.lorebooks.all(),
  ]);
  const takenIds = new Set<ID>([
    ...existingChars.map((c) => c.id),
    ...existingPersonas.map((p) => p.id),
    ...existingStories.map((s) => s.id),
    ...existingBooks.map((b) => b.id),
  ]);

  /* ------------------------------------------------------- characters */

  const v2Chars = asArray(readKey(V2_KEYS.characters));
  const charIdMap = new Map<string, ID>();
  const newChars: Character[] = [];
  for (const raw of v2Chars) {
    if (!isPlainObject(raw)) continue;
    try {
      const character = normalizeCharacter(raw);
      const oldId = firstOf(raw.id);
      if (oldId && !takenIds.has(oldId)) character.id = oldId;
      takenIds.add(character.id);
      if (oldId) charIdMap.set(oldId, character.id);

      const avatarRaw = firstOf(raw.avatar, raw.avatarUrl, raw.image, raw.portrait);
      if (avatarRaw.startsWith('data:')) {
        const mediaId = await liftAvatar(
          avatarRaw,
          'character',
          character.id,
          report.warnings,
          character.name,
        );
        if (mediaId) {
          character.avatarMediaId = mediaId;
          character.avatarUrl = '';
          report.media += 1;
        }
      }
      character.createdAt = toNumber(raw.createdAt, character.createdAt);
      newChars.push(character);
    } catch (err) {
      report.warnings.push(`Skipped a character: ${(err as Error).message}`);
    }
  }
  await repo.characters.saveMany(newChars);
  report.characters = newChars.length;

  /* ---------------------------------------------------------- personas */

  const v2Personas = asArray(readKey(V2_KEYS.personas));
  const personaIdMap = new Map<string, ID>();
  const newPersonas: Persona[] = [];
  for (const raw of v2Personas) {
    if (!isPlainObject(raw)) continue;
    try {
      const persona = normalizePersona(raw);
      const oldId = firstOf(raw.id);
      if (oldId && !takenIds.has(oldId)) persona.id = oldId;
      takenIds.add(persona.id);
      if (oldId) personaIdMap.set(oldId, persona.id);

      const avatarRaw = firstOf(raw.avatar, raw.avatarUrl, raw.image);
      if (avatarRaw.startsWith('data:')) {
        const mediaId = await liftAvatar(
          avatarRaw,
          'persona',
          persona.id,
          report.warnings,
          persona.name,
        );
        if (mediaId) {
          persona.avatarMediaId = mediaId;
          persona.avatarUrl = '';
          report.media += 1;
        }
      }
      persona.createdAt = toNumber(raw.createdAt, persona.createdAt);
      newPersonas.push(persona);
    } catch (err) {
      report.warnings.push(`Skipped a persona: ${(err as Error).message}`);
    }
  }
  await repo.personas.saveMany(newPersonas);
  report.personas = newPersonas.length;

  /* --------------------------------------------------------- lorebooks */

  const v2Lore = asArray(readKey(V2_KEYS.lore));
  const loreIdMap = new Map<string, ID>();
  const newBooks: Lorebook[] = [];
  const newEntries: LoreEntry[] = [];
  for (const raw of v2Lore) {
    if (!isPlainObject(raw)) continue;
    try {
      const { lorebook, entries } = normalizeLorebook(raw);
      const oldId = firstOf(raw.id);
      if (oldId && !takenIds.has(oldId)) lorebook.id = oldId;
      takenIds.add(lorebook.id);
      if (oldId) loreIdMap.set(oldId, lorebook.id);
      for (const entry of entries) entry.lorebookId = lorebook.id;
      newBooks.push(lorebook);
      newEntries.push(...entries);
    } catch (err) {
      report.warnings.push(`Skipped a lorebook: ${(err as Error).message}`);
    }
  }
  await repo.lorebooks.saveMany(newBooks);
  await repo.loreEntries.saveMany(newEntries);
  report.lorebooks = newBooks.length;
  report.loreEntries = newEntries.length;

  /* ----------------------------------------------------------- stories */

  const v2Stories = asArray(readKey(V2_KEYS.stories));
  const storyIdMap = new Map<string, ID>();
  const newStories: Story[] = [];
  for (const raw of v2Stories) {
    if (!isPlainObject(raw)) continue;
    try {
      const story = newStory({
        title: firstOf(raw.title, raw.name) || 'Untitled Story',
        description: firstOf(raw.description, raw.summary),
        scenario: firstOf(raw.scenario, raw.premise),
        authorNote: firstOf(raw.authorNote, raw.author_note, raw.authorsNote),
        tags: toStringList(raw.tags),
        favorite: toBool(raw.favorite, false),
        archived: toBool(raw.archived, false),
      });
      const oldId = firstOf(raw.id);
      if (oldId && !takenIds.has(oldId)) story.id = oldId;
      takenIds.add(story.id);
      if (oldId) storyIdMap.set(oldId, story.id);

      // V2 stored active characters as an id array (`activeCharacters`).
      const charRefs = [
        ...toStringList(raw.activeCharacters),
        ...toStringList(raw.characterIds),
        ...toStringList(raw.characters),
      ];
      story.characters = charRefs
        .map((ref) => charIdMap.get(ref) ?? ref)
        .filter((id) => newChars.some((c) => c.id === id) || existingChars.some((c) => c.id === id))
        .map((characterId, index) => ({
          characterId,
          primary: index === 0,
          note: '',
          enabled: true,
        }));

      const personaRef = firstOf(raw.personaId, raw.persona, raw.activePersona);
      if (personaRef) story.personaId = personaIdMap.get(personaRef) ?? personaRef;

      story.lorebookIds = [...toStringList(raw.lorebookIds), ...toStringList(raw.lorebooks)]
        .map((ref) => loreIdMap.get(ref) ?? ref)
        .filter((id) => newBooks.some((b) => b.id === id));

      for (const [field, ownerType] of [
        ['cover', 'story-cover'],
        ['background', 'story-background'],
      ] as const) {
        const value = firstOf(raw[field], raw[`${field}Image`], raw[`${field}Url`]);
        if (value.startsWith('data:')) {
          const mediaId = await liftAvatar(
            value,
            ownerType,
            story.id,
            report.warnings,
            `${story.title} ${field}`,
          );
          if (mediaId) {
            if (field === 'cover') story.coverMediaId = mediaId;
            else story.backgroundMediaId = mediaId;
            report.media += 1;
          }
        }
      }

      story.createdAt = toNumber(raw.createdAt, story.createdAt);
      newStories.push(story);
    } catch (err) {
      report.warnings.push(`Skipped a story: ${(err as Error).message}`);
    }
  }
  await repo.stories.saveMany(newStories);
  report.stories = newStories.length;

  /* ------------------------------------------------------------- chats */

  const v2Chats = asArray(readKey(V2_KEYS.chats));
  const outChats: Chat[] = [];
  const outBranches: Branch[] = [];
  const outMessages: Message[] = [];
  for (const raw of v2Chats) {
    if (!isPlainObject(raw)) continue;
    try {
      const storyRef = firstOf(raw.storyId, raw.story);
      const chat = newChat({
        storyId: storyRef ? (storyIdMap.get(storyRef) ?? storyRef) : null,
        title: firstOf(raw.title, raw.name) || 'Migrated Chat',
        favorite: toBool(raw.favorite, false),
        archived: toBool(raw.archived, false),
      });
      const branch = newBranch(chat.id, { name: 'Main' });
      chat.activeBranchId = branch.id;

      const rawMessages = asArray(raw.messages);
      let order = 0;
      for (const rawMessage of rawMessages) {
        if (!isPlainObject(rawMessage)) continue;
        const role =
          firstOf(rawMessage.role, rawMessage.sender, rawMessage.from) === 'user'
            ? 'user'
            : firstOf(rawMessage.role) === 'system'
              ? 'system'
              : 'assistant';
        const content = firstOf(rawMessage.content, rawMessage.text, rawMessage.message);
        if (!content) continue;
        const charRef = firstOf(rawMessage.characterId, rawMessage.charId);
        outMessages.push(
          newMessage(chat.id, branch.id, {
            role,
            content,
            characterId: role === 'assistant' && charRef ? (charIdMap.get(charRef) ?? charRef) : null,
            order,
            createdAt: toNumber(rawMessage.timestamp ?? rawMessage.createdAt, Date.now()),
            important: toBool(rawMessage.important, false),
          }),
        );
        order += 1;
      }
      chat.orderCounter = order;
      outChats.push(chat);
      outBranches.push(branch);
    } catch (err) {
      report.warnings.push(`Skipped a chat: ${(err as Error).message}`);
    }
  }
  await repo.chats.saveMany(outChats);
  await repo.branches.saveMany(outBranches);
  await repo.messages.saveMany(outMessages);
  report.chats = outChats.length;
  report.messages = outMessages.length;

  // Point each story at its first migrated chat.
  const storyDefaults = newStories
    .map((story) => {
      const chat = outChats.find((c) => c.storyId === story.id);
      return chat ? { ...story, defaultChatId: chat.id } : null;
    })
    .filter(Boolean) as Story[];
  if (storyDefaults.length) await repo.stories.saveMany(storyDefaults);

  /* ---------------------------------------------------------- memories */

  const v2Memories = asArray(readKey(V2_KEYS.memories));
  const outMemories: Memory[] = [];
  for (const raw of v2Memories) {
    if (!isPlainObject(raw)) continue;
    const content = firstOf(raw.content, raw.text, raw.summary);
    if (!content) continue;
    outMemories.push(
      newMemory({
        title: firstOf(raw.title, raw.name) || content.slice(0, 48),
        content,
        pinned: toBool(raw.pinned, false),
        tags: toStringList(raw.tags),
        createdAt: toNumber(raw.createdAt, Date.now()),
      }),
    );
  }
  await repo.memories.saveMany(outMemories);
  report.memories = outMemories.length;

  /* -------------------------------------------------- settings/provider */

  const v2Settings = readKey(V2_KEYS.settings);
  if (isPlainObject(v2Settings)) {
    const settings = await repo.settingsRepo.load();
    const patch: Partial<Settings> = {};
    const sysPrompt = firstOf(v2Settings.systemPrompt, v2Settings.globalSystemPrompt);
    if (sysPrompt) patch.globalSystemPrompt = sysPrompt;
    const budget = toNumber(v2Settings.contextSize ?? v2Settings.contextBudget, 0);
    if (budget > 0) patch.contextBudget = budget;
    if (typeof v2Settings.theme === 'string' && ['dark', 'light'].includes(v2Settings.theme)) {
      patch.theme = v2Settings.theme as Settings['theme'];
    }

    const apiKey = firstOf(v2Settings.apiKey, v2Settings.openrouterKey, v2Settings.key);
    const model = firstOf(v2Settings.model, v2Settings.selectedModel);
    const baseUrl = firstOf(v2Settings.baseUrl, v2Settings.apiUrl);
    if (apiKey || model || baseUrl) {
      const existingProviders = await repo.providers.all();
      const provider: Provider = newProvider({
        name: 'Migrated from V2',
        kind: baseUrl && !baseUrl.includes('openrouter') ? 'custom' : 'openrouter',
        baseUrl: baseUrl || 'https://openrouter.ai/api/v1',
        apiKey,
        model,
        temperature: toNumber(v2Settings.temperature, DEFAULT_GENERATION.temperature),
        maxTokens: toNumber(v2Settings.maxTokens, DEFAULT_GENERATION.maxTokens),
        streaming: toBool(v2Settings.streaming, true),
      });
      await repo.providers.save(provider);
      report.providers = 1;
      if (!existingProviders.length) patch.activeProviderId = provider.id;
    }

    await repo.settingsRepo.save({ ...settings, ...patch, migratedV2: true });
  } else {
    const settings = await repo.settingsRepo.load();
    await repo.settingsRepo.save({ ...settings, migratedV2: true });
  }

  return report;
}

/** Marks migration as handled without importing (user declined). */
export async function dismissV2Migration(): Promise<void> {
  const settings = await repo.settingsRepo.load();
  await repo.settingsRepo.save({ ...settings, migratedV2: true });
}
