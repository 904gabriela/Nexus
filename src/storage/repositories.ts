import { emptyScene } from '../types';
import {
  STORES,
  dbDelete,
  dbDeleteMany,
  dbGet,
  dbGetAll,
  dbGetAllByIndex,
  dbPut,
  dbPutMany,
} from './db';
import type {
  Branch,
  Chat,
  Character,
  Checkpoint,
  ID,
  LoreEntry,
  Lorebook,
  MediaMeta,
  Memory,
  Message,
  MessageAlternative,
  Persona,
  Provider,
  ImageProvider,
  Settings,
  Story,
  SceneDelta,
  StorySummary,
} from '../types';
import {
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_SYSTEM_PROMPT,
  SCHEMA_VERSION,
  defaultSettings,
  now,
} from '../types/factories';

/* --------------------------------------------------------------- generic */

function touch<T extends { updatedAt: number }>(value: T): T {
  return { ...value, updatedAt: now() };
}

/**
 * Records written before a field existed come back without it, and the type
 * says otherwise. Fields added after the first release are filled in on read
 * so the rest of the app can trust the type.
 */
function hydrateStory(story: Story): Story {
  return { ...story, openingMessage: story.openingMessage ?? '' };
}

function hydrateChat(chat: Chat): Chat {
  return {
    ...chat,
    direction: chat.direction ?? '',
    // Chats written before scene state existed get an empty one, which the
    // compiler reads as "presence is undeclared" and falls back to the primary
    // character rather than assuming the whole cast is in the room.
    scene: { ...emptyScene(), ...(chat.scene ?? {}) },
  };
}

export const characters = {
  all: () => dbGetAll<Character>(STORES.characters),
  get: (id: ID) => dbGet<Character>(STORES.characters, id),
  save: (value: Character) => dbPut(STORES.characters, touch(value)),
  saveMany: (values: Character[]) => dbPutMany(STORES.characters, values),
  remove: (id: ID) => dbDelete(STORES.characters, id),
};

export const personas = {
  all: () => dbGetAll<Persona>(STORES.personas),
  get: (id: ID) => dbGet<Persona>(STORES.personas, id),
  save: (value: Persona) => dbPut(STORES.personas, touch(value)),
  saveMany: (values: Persona[]) => dbPutMany(STORES.personas, values),
  remove: (id: ID) => dbDelete(STORES.personas, id),
};

export const stories = {
  all: () => dbGetAll<Story>(STORES.stories).then((all) => all.map(hydrateStory)),
  get: (id: ID) => dbGet<Story>(STORES.stories, id).then((s) => (s ? hydrateStory(s) : s)),
  save: (value: Story) => dbPut(STORES.stories, touch(value)),
  saveMany: (values: Story[]) => dbPutMany(STORES.stories, values),
  remove: (id: ID) => dbDelete(STORES.stories, id),
};

export const chats = {
  all: () => dbGetAll<Chat>(STORES.chats).then((all) => all.map(hydrateChat)),
  get: (id: ID) => dbGet<Chat>(STORES.chats, id).then((c) => (c ? hydrateChat(c) : c)),
  byStory: (storyId: ID) =>
    dbGetAllByIndex<Chat>(STORES.chats, 'storyId', storyId).then((all) => all.map(hydrateChat)),
  save: (value: Chat) => dbPut(STORES.chats, touch(value)),
  saveMany: (values: Chat[]) => dbPutMany(STORES.chats, values),
  remove: (id: ID) => dbDelete(STORES.chats, id),
};

export const messages = {
  all: () => dbGetAll<Message>(STORES.messages),
  get: (id: ID) => dbGet<Message>(STORES.messages, id),
  byChat: (chatId: ID) => dbGetAllByIndex<Message>(STORES.messages, 'chatId', chatId),
  save: (value: Message) => dbPut(STORES.messages, touch(value)),
  saveMany: (values: Message[]) => dbPutMany(STORES.messages, values),
  remove: (id: ID) => dbDelete(STORES.messages, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.messages, ids),
};

export const alternatives = {
  all: () => dbGetAll<MessageAlternative>(STORES.messageAlternatives),
  byMessage: (messageId: ID) =>
    dbGetAllByIndex<MessageAlternative>(STORES.messageAlternatives, 'messageId', messageId),
  byChat: (chatId: ID) =>
    dbGetAllByIndex<MessageAlternative>(STORES.messageAlternatives, 'chatId', chatId),
  save: (value: MessageAlternative) => dbPut(STORES.messageAlternatives, touch(value)),
  saveMany: (values: MessageAlternative[]) => dbPutMany(STORES.messageAlternatives, values),
  remove: (id: ID) => dbDelete(STORES.messageAlternatives, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.messageAlternatives, ids),
};

export const branches = {
  all: () => dbGetAll<Branch>(STORES.branches),
  get: (id: ID) => dbGet<Branch>(STORES.branches, id),
  byChat: (chatId: ID) => dbGetAllByIndex<Branch>(STORES.branches, 'chatId', chatId),
  save: (value: Branch) => dbPut(STORES.branches, touch(value)),
  saveMany: (values: Branch[]) => dbPutMany(STORES.branches, values),
  remove: (id: ID) => dbDelete(STORES.branches, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.branches, ids),
};

export const checkpoints = {
  all: () => dbGetAll<Checkpoint>(STORES.checkpoints),
  get: (id: ID) => dbGet<Checkpoint>(STORES.checkpoints, id),
  byChat: (chatId: ID) => dbGetAllByIndex<Checkpoint>(STORES.checkpoints, 'chatId', chatId),
  save: (value: Checkpoint) => dbPut(STORES.checkpoints, touch(value)),
  saveMany: (values: Checkpoint[]) => dbPutMany(STORES.checkpoints, values),
  remove: (id: ID) => dbDelete(STORES.checkpoints, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.checkpoints, ids),
};

export const memories = {
  all: () => dbGetAll<Memory>(STORES.memories),
  get: (id: ID) => dbGet<Memory>(STORES.memories, id),
  save: (value: Memory) => dbPut(STORES.memories, touch(value)),
  saveMany: (values: Memory[]) => dbPutMany(STORES.memories, values),
  remove: (id: ID) => dbDelete(STORES.memories, id),
};

export const lorebooks = {
  all: () => dbGetAll<Lorebook>(STORES.lorebooks),
  get: (id: ID) => dbGet<Lorebook>(STORES.lorebooks, id),
  save: (value: Lorebook) => dbPut(STORES.lorebooks, touch(value)),
  saveMany: (values: Lorebook[]) => dbPutMany(STORES.lorebooks, values),
  remove: (id: ID) => dbDelete(STORES.lorebooks, id),
};

export const loreEntries = {
  all: () => dbGetAll<LoreEntry>(STORES.loreEntries),
  get: (id: ID) => dbGet<LoreEntry>(STORES.loreEntries, id),
  byLorebook: (lorebookId: ID) =>
    dbGetAllByIndex<LoreEntry>(STORES.loreEntries, 'lorebookId', lorebookId),
  save: (value: LoreEntry) => dbPut(STORES.loreEntries, touch(value)),
  saveMany: (values: LoreEntry[]) => dbPutMany(STORES.loreEntries, values),
  remove: (id: ID) => dbDelete(STORES.loreEntries, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.loreEntries, ids),
};

export const mediaMeta = {
  all: () => dbGetAll<MediaMeta>(STORES.media),
  get: (id: ID) => dbGet<MediaMeta>(STORES.media, id),
  save: (value: MediaMeta) => dbPut(STORES.media, touch(value)),
  saveMany: (values: MediaMeta[]) => dbPutMany(STORES.media, values),
  remove: (id: ID) => dbDelete(STORES.media, id),
};

export const providers = {
  all: () => dbGetAll<Provider>(STORES.providers),
  get: (id: ID) => dbGet<Provider>(STORES.providers, id),
  save: (value: Provider) => dbPut(STORES.providers, touch(value)),
  saveMany: (values: Provider[]) => dbPutMany(STORES.providers, values),
  remove: (id: ID) => dbDelete(STORES.providers, id),
};

export const imageProviders = {
  all: () => dbGetAll<ImageProvider>(STORES.imageProviders),
  get: (id: ID) => dbGet<ImageProvider>(STORES.imageProviders, id),
  save: (value: ImageProvider) => dbPut(STORES.imageProviders, touch(value)),
  saveMany: (values: ImageProvider[]) => dbPutMany(STORES.imageProviders, values),
  remove: (id: ID) => dbDelete(STORES.imageProviders, id),
};

export const storySummaries = {
  all: () => dbGetAll<StorySummary>(STORES.storySummaries),
  get: (id: ID) => dbGet<StorySummary>(STORES.storySummaries, id),
  byStory: (storyId: ID) =>
    dbGetAllByIndex<StorySummary>(STORES.storySummaries, 'storyId', storyId),
  /**
   * Summaries owned by one chat. There is no chatId index — a story holds a
   * handful of these at most, so scanning beats a schema version bump — and
   * legacy rows have no chatId at all, which is what makes them everyone's.
   */
  byChat: async (chatId: ID) =>
    (await dbGetAll<StorySummary>(STORES.storySummaries)).filter((s) => s.chatId === chatId),
  save: (value: StorySummary) => dbPut(STORES.storySummaries, touch(value)),
  saveMany: (values: StorySummary[]) => dbPutMany(STORES.storySummaries, values),
  remove: (id: ID) => dbDelete(STORES.storySummaries, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.storySummaries, ids),
};

export const sceneDeltas = {
  all: () => dbGetAll<SceneDelta>(STORES.sceneDeltas),
  byChat: (chatId: ID) => dbGetAllByIndex<SceneDelta>(STORES.sceneDeltas, 'chatId', chatId),
  byBranch: (branchId: ID) =>
    dbGetAllByIndex<SceneDelta>(STORES.sceneDeltas, 'branchId', branchId),
  save: (value: SceneDelta) => dbPut(STORES.sceneDeltas, touch(value)),
  saveMany: (values: SceneDelta[]) => dbPutMany(STORES.sceneDeltas, values),
  remove: (id: ID) => dbDelete(STORES.sceneDeltas, id),
  removeMany: (ids: ID[]) => dbDeleteMany(STORES.sceneDeltas, ids),
};

export const settingsRepo = {
  async load(): Promise<Settings> {
    const stored = await dbGet<Settings>(STORES.settings, 'settings');
    if (!stored) {
      const fresh = defaultSettings();
      await dbPut(STORES.settings, fresh);
      return fresh;
    }
    // Merge forward so new settings keys appear for existing installs.
    const merged = { ...defaultSettings(), ...stored, schemaVersion: SCHEMA_VERSION };
    // An install that never edited the system prompt is still carrying the
    // stock "stay in character" wording, which frames the model as one speaker
    // rather than the narrator of a scene. Move only that exact string forward:
    // a prompt someone wrote themselves is theirs, however much it resembles
    // the old default.
    if (stored.globalSystemPrompt?.trim() === LEGACY_SYSTEM_PROMPT) {
      merged.globalSystemPrompt = DEFAULT_SYSTEM_PROMPT;
      await dbPut(STORES.settings, merged);
    }
    return merged;
  },
  save: (value: Settings) => dbPut(STORES.settings, value),
};

/* ------------------------------------------------------- cascade deletes */

/** Removes a chat and every row that only exists because of it. */
export async function deleteChatCascade(chatId: ID): Promise<void> {
  const [
    chatMessages,
    chatBranches,
    chatCheckpoints,
    chatAlternatives,
    chatSummaries,
    chatDeltas,
  ] = await Promise.all([
    messages.byChat(chatId),
    branches.byChat(chatId),
    checkpoints.byChat(chatId),
    alternatives.byChat(chatId),
    // A summary compresses one of this chat's timelines, and its watermark is
    // in this chat's order space, so it cannot outlive the chat.
    storySummaries.byChat(chatId),
    // A scene delta is a claim about one of this chat's timelines.
    sceneDeltas.byChat(chatId),
  ]);
  await Promise.all([
    messages.removeMany(chatMessages.map((m) => m.id)),
    branches.removeMany(chatBranches.map((b) => b.id)),
    checkpoints.removeMany(chatCheckpoints.map((c) => c.id)),
    alternatives.removeMany(chatAlternatives.map((a) => a.id)),
    storySummaries.removeMany(chatSummaries.map((s) => s.id)),
    sceneDeltas.removeMany(chatDeltas.map((d) => d.id)),
    chats.remove(chatId),
  ]);
}

export async function deleteStoryCascade(storyId: ID): Promise<void> {
  const storyChats = await chats.byStory(storyId);
  for (const chat of storyChats) await deleteChatCascade(chat.id);
  // Per-chat rows went with their chats above; this also catches legacy rows,
  // which name no chat and so belong to the story itself.
  const remaining = await storySummaries.byStory(storyId);
  await storySummaries.removeMany(remaining.map((s) => s.id));
  await stories.remove(storyId);
}

export async function deleteLorebookCascade(lorebookId: ID): Promise<void> {
  const entries = await loreEntries.byLorebook(lorebookId);
  await loreEntries.removeMany(entries.map((e) => e.id));
  await lorebooks.remove(lorebookId);

  // Detach from anything that referenced it.
  const [allStories, allChars, allChats] = await Promise.all([
    stories.all(),
    characters.all(),
    chats.all(),
  ]);
  await Promise.all([
    stories.saveMany(
      allStories
        .filter((s) => s.lorebookIds.includes(lorebookId))
        .map((s) => ({ ...s, lorebookIds: s.lorebookIds.filter((id) => id !== lorebookId) })),
    ),
    characters.saveMany(
      allChars
        .filter((c) => c.lorebookIds.includes(lorebookId))
        .map((c) => ({ ...c, lorebookIds: c.lorebookIds.filter((id) => id !== lorebookId) })),
    ),
    chats.saveMany(
      allChats
        .filter((c) => c.lorebookIds.includes(lorebookId))
        .map((c) => ({ ...c, lorebookIds: c.lorebookIds.filter((id) => id !== lorebookId) })),
    ),
  ]);
}

/** Detaches a character from every story before deleting it. */
export async function deleteCharacterCascade(characterId: ID): Promise<void> {
  const allStories = await stories.all();
  const affected = allStories.filter((s) => s.characters.some((c) => c.characterId === characterId));
  await stories.saveMany(
    affected.map((s) => {
      const remaining = s.characters.filter((c) => c.characterId !== characterId);
      if (remaining.length && !remaining.some((c) => c.primary)) remaining[0].primary = true;
      return { ...s, characters: remaining };
    }),
  );
  await characters.remove(characterId);
}

export async function deletePersonaCascade(personaId: ID): Promise<void> {
  const [allStories, allChats] = await Promise.all([stories.all(), chats.all()]);
  await Promise.all([
    stories.saveMany(
      allStories.filter((s) => s.personaId === personaId).map((s) => ({ ...s, personaId: null })),
    ),
    chats.saveMany(
      allChats.filter((c) => c.personaId === personaId).map((c) => ({ ...c, personaId: null })),
    ),
  ]);
  await personas.remove(personaId);
}
