import type {
  AspectRatio,
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
  ImageProvider,
  Settings,
  Story,
  StorySummary,
} from './index';
import { defaultCapabilities, emptyScene } from './index';
import { uid } from '../utils/uid';

export const SCHEMA_VERSION = 4;

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
    origin: 'manual',
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
    rules: '',
    timeline: '',
    authorNote: '',
    openingMessage: '',
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
    direction: '',
    lorebookIds: [],
    orderCounter: 0,
    scene: emptyScene(),
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
    modelInfo: {},
    capabilityOverrides: {},
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
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://192.168.1.10:11434',
    hint: 'Models are discovered from Ollama itself — no need to type a model name.',
  },
  local: {
    label: 'Local / LAN (other)',
    baseUrl: 'http://192.168.1.10:1234/v1',
    hint: 'LM Studio, KoboldCpp, text-generation-webui…',
  },
};

/**
 * The stock system prompt as it shipped until the narrator work.
 *
 * Kept so an install that never touched the field can be moved forward without
 * overwriting a prompt someone actually wrote. See `settingsRepo.load`.
 */
export const LEGACY_SYSTEM_PROMPT =
  'You are a masterful roleplay partner. Stay in character, write vivid, immersive prose, ' +
  'and never break the fourth wall or speak as the user unless explicitly asked.';

/**
 * "Stay in character" is the wrong instruction for this app: it casts the model
 * as one person answering, when the job is to write the whole scene. The
 * narrator's brief in `context/narration.ts` carries the frame; this leaves the
 * user-facing field saying something compatible rather than contradictory.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are narrating an unfolding story. Write it as prose — the scene, the world and ' +
  'everyone in it except the user — and keep it moving.';

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    activeProviderId: null,
    defaultPersonaId: null,
    globalSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    globalInstructions: '',
    contextBudget: 8192,
    maxPromptTokens: 12288,
    maxResponseTokens: 2048,
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
    lastBackupAt: null,

    activeImageProviderId: null,

    useStorySummary: true,
    summaryWindow: 30,
    autoSummaryEvery: 20,

    autoMemory: false,
    autoMemoryTriggers: ['plot', 'relationship', 'revelation', 'promise', 'romance'],
    autoMemoryPin: false,
    autoMemoryEvery: 6,
  };
}

/* ---------------------------------------------------------- image provider */

export function newImageProvider(partial: Partial<ImageProvider> = {}): ImageProvider {
  const t = now();
  return {
    id: uid(),
    name: 'New Image Provider',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    models: [],
    extraHeaders: {},
    extraBody: {},
    defaultAspect: 'portrait' as AspectRatio,
    promptSuffix: '',
    negativePrompt: '',
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export const IMAGE_PROVIDER_PRESETS: Record<
  ImageProvider['kind'],
  { label: string; baseUrl: string; model: string; hint: string }
> = {
  openai: {
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    hint: 'Any service exposing POST /images/generations — OpenAI, Azure OpenAI, many self-hosted gateways.',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-image',
    hint: 'Uses the generateContent endpoint and reads inline image data from the response.',
  },
  custom: {
    label: 'Custom endpoint',
    baseUrl: '',
    model: '',
    hint: 'Any endpoint that accepts a JSON prompt and returns a base64 image, a data URL or an image URL.',
  },
};

/* ---------------------------------------------------------- story summary */

export function newStorySummary(storyId: string, partial: Partial<StorySummary> = {}): StorySummary {
  const t = now();
  return {
    // One summary per story, so the story id is the primary key.
    id: storyId,
    storyId,
    currentSummary: '',
    rollingSummary: '',
    importantEvents: [],
    relationshipState: '',
    characterState: {},
    locked: false,
    coveredThroughOrder: -1,
    lastGeneratedAt: 0,
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

/** Capability guesses used when a provider reports nothing about a model. */
export function inferCapabilities(modelId: string) {
  const id = modelId.toLowerCase();
  const vision =
    /gpt-4o|gpt-4\.1|gpt-5|o[13]\b|claude-3|claude-[45]|gemini|llava|pixtral|qwen.*vl|intern.*vl|vision|-vl\b/.test(
      id,
    );
  const imageGeneration = /dall-e|gpt-image|flux|stable-diffusion|sdxl|imagen|-image\b/.test(id);
  return defaultCapabilities({
    vision,
    imageGeneration,
    // Image-only endpoints do not do chat completions.
    text: !imageGeneration || /gemini/.test(id),
  });
}
