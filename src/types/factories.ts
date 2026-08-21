import type {
  Branch,
  Chat,
  Character,
  Checkpoint,
  GenerationSettings,
  Greeting,
  LoreEntry,
  Lorebook,
  Memory,
  Message,
  Persona,
  Provider,
  Settings,
  Story,
} from './index';
import { uid } from '../utils/uid';

export const SCHEMA_VERSION = 3;

export const DEFAULT_GENERATION: GenerationSettings = {
  temperature: 0.9,
  maxTokens: 900,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  streaming: true,
  contextSize: 8192,
};

export function now(): number {
  return Date.now();
}

export function newCharacter(partial: Partial<Character> = {}): Character {
  const t = now();
  return {
    id: uid(),
    name: '',
    displayName: '',
    nickname: '',
    age: '',
    gender: '',
    pronouns: '',
    species: '',
    race: '',
    occupation: '',
    role: '',
    tags: [],
    shortDescription: '',
    description: '',
    appearance: '',
    physicalTraits: '',
    personality: '',
    temperament: '',
    traits: [],
    backstory: '',
    history: '',
    goals: '',
    motivations: '',
    fears: '',
    secrets: '',
    likes: '',
    dislikes: '',
    hobbies: '',
    values: '',
    beliefs: '',
    scenario: '',
    greetings: [],
    defaultGreetingId: null,
    speakingStyle: '',
    speechPatterns: '',
    exampleDialogue: '',
    systemPrompt: '',
    authorNote: '',
    relationships: '',
    friends: '',
    enemies: '',
    family: '',
    romantic: '',
    home: '',
    location: '',
    faction: '',
    world: '',
    lorebookIds: [],
    creator: '',
    creatorNotes: '',
    version: '1.0',
    customFields: [],
    metadata: {},
    avatarMediaId: null,
    avatarUrl: '',
    favorite: false,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newGreeting(content = '', label = 'Greeting'): Greeting {
  return { id: uid(), label, content };
}

export function newPersona(partial: Partial<Persona> = {}): Persona {
  const t = now();
  return {
    id: uid(),
    name: '',
    displayName: '',
    nickname: '',
    age: '',
    gender: '',
    pronouns: '',
    species: '',
    appearance: '',
    personality: '',
    traits: [],
    backstory: '',
    occupation: '',
    goals: '',
    likes: '',
    dislikes: '',
    speechStyle: '',
    customInstructions: '',
    tags: [],
    customFields: [],
    avatarMediaId: null,
    avatarUrl: '',
    isDefault: false,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newLorebook(partial: Partial<Lorebook> = {}): Lorebook {
  const t = now();
  return {
    id: uid(),
    name: '',
    description: '',
    enabled: true,
    tags: [],
    global: false,
    scanDepth: 0,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newLoreEntry(lorebookId: string, partial: Partial<LoreEntry> = {}): LoreEntry {
  const t = now();
  return {
    id: uid(),
    lorebookId,
    name: '',
    content: '',
    primaryKeys: [],
    secondaryKeys: [],
    aliases: [],
    enabled: true,
    priority: 100,
    position: 'after-character',
    depth: 4,
    scanDepth: 0,
    matchMode: 'word-boundary',
    caseSensitive: false,
    activation: 'keyword',
    category: '',
    scope: 'any',
    comment: '',
    customFields: [],
    order: t,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newMemory(partial: Partial<Memory> = {}): Memory {
  const t = now();
  return {
    id: uid(),
    title: '',
    content: '',
    category: 'Other',
    importance: 'normal',
    pinned: false,
    sourceMessageIds: [],
    sourceChatId: null,
    sourceStoryId: null,
    characterIds: [],
    tags: [],
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newStory(partial: Partial<Story> = {}): Story {
  const t = now();
  return {
    id: uid(),
    title: '',
    description: '',
    scenario: '',
    authorNote: '',
    tags: [],
    characters: [],
    personaId: null,
    lorebookIds: [],
    memoryIds: [],
    coverMediaId: null,
    backgroundMediaId: null,
    defaultChatId: null,
    settings: {},
    favorite: false,
    archived: false,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newChat(partial: Partial<Chat> = {}): Chat {
  const t = now();
  return {
    id: uid(),
    storyId: null,
    title: 'New Chat',
    activeBranchId: '',
    personaId: null,
    favorite: false,
    archived: false,
    settings: {},
    lorebookIds: [],
    orderCounter: 0,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newBranch(chatId: string, partial: Partial<Branch> = {}): Branch {
  const t = now();
  return {
    id: uid(),
    chatId,
    parentBranchId: null,
    createdFromMessageId: null,
    forkOrder: Number.MAX_SAFE_INTEGER,
    name: 'Main',
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newMessage(
  chatId: string,
  branchId: string,
  partial: Partial<Message> = {},
): Message {
  const t = now();
  return {
    id: uid(),
    chatId,
    branchId,
    role: 'user',
    characterId: null,
    personaId: null,
    content: '',
    attachments: [],
    order: 0,
    important: false,
    activeAlternativeId: null,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newCheckpoint(partial: Partial<Checkpoint> = {}): Checkpoint {
  const t = now();
  return {
    id: uid(),
    name: 'Checkpoint',
    description: '',
    storyId: null,
    chatId: '',
    branchId: '',
    messageId: '',
    messageOrder: 0,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function newProvider(partial: Partial<Provider> = {}): Provider {
  const t = now();
  return {
    id: uid(),
    name: 'New Provider',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    models: [],
    temperature: DEFAULT_GENERATION.temperature,
    maxTokens: DEFAULT_GENERATION.maxTokens,
    topP: DEFAULT_GENERATION.topP,
    frequencyPenalty: 0,
    presencePenalty: 0,
    streaming: true,
    visionSupport: false,
    extraHeaders: {},
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export const PROVIDER_PRESETS: Record<
  Exclude<Provider['kind'], never>,
  { label: string; baseUrl: string; hint: string }
> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'Hundreds of models behind one key.',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    hint: 'Official OpenAI endpoint.',
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    hint: 'Any service exposing /chat/completions.',
  },
  local: {
    label: 'Local / LAN',
    baseUrl: 'http://192.168.1.10:1234/v1',
    hint: 'LM Studio, Ollama, KoboldCpp, text-generation-webui…',
  },
};

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    activeProviderId: null,
    defaultPersonaId: null,
    globalSystemPrompt:
      'You are a masterful roleplay partner. Stay in character, write vivid, immersive prose, ' +
      'and never break the fourth wall or speak as the user unless explicitly asked.',
    globalInstructions: '',
    contextBudget: 8192,
    reserveForResponse: 1024,
    loreScanDepth: 8,
    maxLoreEntries: 20,
    maxMemories: 25,
    historyLimit: 200,
    theme: 'dark',
    fontScale: 1,
    sendOnEnter: false,
    showTokenCounts: true,
    migratedV2: false,
    schemaVersion: SCHEMA_VERSION,
  };
}
