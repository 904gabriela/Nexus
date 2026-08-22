/**
 * Nexus Tavern Pro — canonical data models.
 *
 * Every persisted entity lives in its own IndexedDB store and is referenced by
 * id. Nothing here embeds another top-level entity wholesale.
 */

export type ID = string;

export interface Timestamped {
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ media */

export type MediaOwnerType =
  | 'character'
  | 'persona'
  | 'story-cover'
  | 'story-background'
  | 'message'
  | 'generated'
  | 'unassigned';

/** Provenance for a stored image: uploaded by the user, or model-generated. */
export type MediaSource = 'upload' | 'generated';

export interface MediaMeta extends Timestamped {
  id: ID;
  filename: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  ownerType: MediaOwnerType;
  ownerId: ID | null;
  tags: string[];
  source: MediaSource;
  /** Set for generated images so they can be regenerated or audited. */
  prompt?: string;
  imageProviderId?: ID | null;
  imageModel?: string;
  /** Optional back-references so the gallery can group generated art. */
  storyId?: ID | null;
  chatId?: ID | null;
  messageId?: ID | null;
  characterId?: ID | null;
  personaId?: ID | null;
}

/** Blob rows live in a separate store so listing metadata never loads pixels. */
export interface MediaBlobRow {
  id: ID;
  blob: Blob;
}

/* -------------------------------------------------------------- character */

export interface Greeting {
  id: ID;
  label: string;
  content: string;
}

export interface CustomField {
  id: ID;
  key: string;
  value: string;
}

export interface Character extends Timestamped {
  id: ID;

  // identity
  name: string;
  displayName: string;
  nickname: string;
  age: string;
  gender: string;
  pronouns: string;
  species: string;
  race: string;
  occupation: string;
  role: string;
  tags: string[];

  // description
  shortDescription: string;
  description: string;
  appearance: string;
  physicalTraits: string;
  personality: string;
  temperament: string;
  traits: string[];

  // background
  backstory: string;
  history: string;
  goals: string;
  motivations: string;
  fears: string;
  secrets: string;
  likes: string;
  dislikes: string;
  hobbies: string;
  values: string;
  beliefs: string;

  // roleplay
  scenario: string;
  greetings: Greeting[];
  defaultGreetingId: ID | null;
  speakingStyle: string;
  speechPatterns: string;
  exampleDialogue: string;
  systemPrompt: string;
  authorNote: string;

  // relationships
  relationships: string;
  friends: string;
  enemies: string;
  family: string;
  romantic: string;

  // world
  home: string;
  location: string;
  faction: string;
  world: string;
  lorebookIds: ID[];

  // advanced
  creator: string;
  creatorNotes: string;
  version: string;
  customFields: CustomField[];
  metadata: Record<string, unknown>;

  avatarMediaId: ID | null;
  avatarUrl: string;
  favorite: boolean;
}

/* ---------------------------------------------------------------- persona */

export interface Persona extends Timestamped {
  id: ID;
  name: string;
  displayName: string;
  nickname: string;
  age: string;
  gender: string;
  pronouns: string;
  species: string;
  appearance: string;
  personality: string;
  traits: string[];
  backstory: string;
  occupation: string;
  goals: string;
  likes: string;
  dislikes: string;
  speechStyle: string;
  customInstructions: string;
  tags: string[];
  customFields: CustomField[];
  avatarMediaId: ID | null;
  avatarUrl: string;
  isDefault: boolean;
}

/* ------------------------------------------------------------------- lore */

export type LoreActivation =
  | 'always'
  | 'keyword'
  | 'story-only'
  | 'chat-only'
  | 'character-only';

export type LorePosition = 'before-character' | 'after-character' | 'author-note' | 'at-depth';

export type LoreMatchMode = 'word-boundary' | 'partial' | 'exact-phrase';

export interface LoreEntry extends Timestamped {
  id: ID;
  lorebookId: ID;
  name: string;
  content: string;
  primaryKeys: string[];
  secondaryKeys: string[];
  aliases: string[];
  enabled: boolean;
  /** Higher wins when the context budget forces trimming. */
  priority: number;
  position: LorePosition;
  /** Injection depth from the end of history when position === 'at-depth'. */
  depth: number;
  /** How many recent messages are scanned for keywords. 0 = global default. */
  scanDepth: number;
  matchMode: LoreMatchMode;
  caseSensitive: boolean;
  activation: LoreActivation;
  category: string;
  scope: string;
  comment: string;
  customFields: CustomField[];
  order: number;
}

export interface Lorebook extends Timestamped {
  id: ID;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  /** Attached everywhere when true, regardless of story/character links. */
  global: boolean;
  scanDepth: number;
}

/* ----------------------------------------------------------------- memory */

export type MemoryCategory =
  | 'Plot'
  | 'Event'
  | 'Character'
  | 'Relationship'
  | 'World'
  | 'Location'
  | 'Item'
  | 'Preference'
  | 'System'
  | 'Other';

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  'Plot',
  'Event',
  'Character',
  'Relationship',
  'World',
  'Location',
  'Item',
  'Preference',
  'System',
  'Other',
];

export type MemoryImportance = 'low' | 'normal' | 'high' | 'critical';

export const MEMORY_IMPORTANCE: MemoryImportance[] = ['low', 'normal', 'high', 'critical'];

export interface Memory extends Timestamped {
  id: ID;
  /** 'auto' memories were proposed by the trigger scan, not written by hand. */
  origin: 'manual' | 'auto' | 'imported';
  title: string;
  content: string;
  category: MemoryCategory;
  importance: MemoryImportance;
  pinned: boolean;
  sourceMessageIds: ID[];
  sourceChatId: ID | null;
  sourceStoryId: ID | null;
  characterIds: ID[];
  tags: string[];
}

/* ------------------------------------------------------------------ story */

export interface StoryCharacterLink {
  characterId: ID;
  primary: boolean;
  /** Per-story override of the character's system prompt fragment. */
  note: string;
  enabled: boolean;
}

export interface GenerationSettings {
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  streaming: boolean;
  contextSize: number;
}

export interface Story extends Timestamped {
  id: ID;
  title: string;
  description: string;
  scenario: string;
  authorNote: string;
  /**
   * The message a new chat opens with. Takes precedence over the primary
   * character's default greeting, so a story can set its own opening scene
   * without editing the character.
   */
  openingMessage: string;
  tags: string[];
  characters: StoryCharacterLink[];
  personaId: ID | null;
  lorebookIds: ID[];
  memoryIds: ID[];
  coverMediaId: ID | null;
  backgroundMediaId: ID | null;
  defaultChatId: ID | null;
  settings: Partial<GenerationSettings>;
  favorite: boolean;
  archived: boolean;
}

/* ------------------------------------------------------- chat / messaging */

export interface Branch extends Timestamped {
  id: ID;
  chatId: ID;
  parentBranchId: ID | null;
  /** The message this branch forked from (belongs to an ancestor branch). */
  createdFromMessageId: ID | null;
  /** Global order value of the fork message; used to slice ancestor history. */
  forkOrder: number;
  name: string;
}

export interface Attachment {
  id: ID;
  kind: 'image' | 'file';
  mediaId: ID | null;
  /** Populated for non-image files stored as text (e.g. imported transcripts). */
  text?: string;
  filename: string;
  mimeType: string;
  size: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message extends Timestamped {
  id: ID;
  chatId: ID;
  branchId: ID;
  role: MessageRole;
  /** Which AI character spoke (assistant messages in multi-character stories). */
  characterId: ID | null;
  personaId: ID | null;
  content: string;
  attachments: Attachment[];
  /** Monotonic per-chat ordering key; stable across branches. */
  order: number;
  important: boolean;
  /** null => the message's own `content` is showing. */
  activeAlternativeId: ID | null;
  error?: string;
  model?: string;
  /**
   * A record of earlier play rather than a turn taken in this chat — a seeded
   * opening, or a transcript pasted in to continue from. It still reads as
   * conversation, but the names inside it describe the story's past, so the
   * compiler frames it as history instead of letting it imply a cast.
   */
  historical?: boolean;
}

export interface MessageAlternative extends Timestamped {
  id: ID;
  messageId: ID;
  chatId: ID;
  content: string;
  instruction: string;
  model: string;
}

export interface Checkpoint extends Timestamped {
  id: ID;
  name: string;
  description: string;
  storyId: ID | null;
  chatId: ID;
  branchId: ID;
  messageId: ID;
  messageOrder: number;
}

export interface Chat extends Timestamped {
  id: ID;
  storyId: ID | null;
  title: string;
  activeBranchId: ID;
  personaId: ID | null;
  favorite: boolean;
  archived: boolean;
  settings: Partial<GenerationSettings>;
  /**
   * Live steering for this chat alone: "shorter replies", "more dialogue".
   * Injected near the end of the context, where it carries the most weight,
   * and editable from inside the conversation.
   */
  direction: string;
  lorebookIds: ID[];
  /** Next value for Message.order. */
  orderCounter: number;
  /**
   * Who and what is actually in the scene right now.
   *
   * Distinct from the story's cast, which is only the list of characters this
   * world may draw on. Conflating the two is what let a character who was
   * merely mentioned in old history walk into the room and start speaking.
   */
  scene: SceneState;
}

/**
 * The current moment of a roleplay, as opposed to everything the world knows.
 *
 * Presence is stated, never inferred. A name occurring in a fifteen-thousand
 * word transcript is evidence that a character exists, not that they are
 * standing in the room, and the compiler is required to keep that distinction
 * visible to the model.
 */
export interface SceneState {
  /** Where the scene is taking place, in prose. */
  location: string;
  /** What is happening right now. */
  situation: string;
  /** Characters physically in the scene. Empty means "fall back to primary". */
  presentCharacterIds: ID[];
  /** The focal NPC. A default for who replies, not a limit on who may. */
  primaryCharacterId: ID | null;
  /** Optional immediate goal or open question driving the scene. */
  objective: string;
  /** Temporary, scene-local state per character id — injuries, mood, secrets. */
  characterStates: Record<ID, string>;
  updatedAt: number;
}

export function emptyScene(): SceneState {
  return {
    location: '',
    situation: '',
    presentCharacterIds: [],
    primaryCharacterId: null,
    objective: '',
    characterStates: {},
    updatedAt: 0,
  };
}

/* --------------------------------------------------------------- provider */

export type ProviderKind = 'openrouter' | 'openai' | 'custom' | 'local' | 'ollama';

/**
 * What a given model can actually do. Populated from the provider's model
 * listing where it exposes one, and overridable by hand — the UI gates
 * controls on these rather than assuming.
 */
export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  streaming: boolean;
  imageGeneration: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  capabilities: ModelCapabilities;
  /** True when capabilities came from the provider rather than a guess. */
  reported: boolean;
}

export function defaultCapabilities(partial: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { text: true, vision: false, streaming: true, imageGeneration: false, ...partial };
}

export interface Provider extends Timestamped {
  id: ID;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  /** Capability records keyed by model id; `models` stays the ordered list. */
  modelInfo: Record<string, ModelInfo>;
  /** Manual override when a provider reports nothing useful. */
  capabilityOverrides: Partial<ModelCapabilities>;
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  streaming: boolean;
  visionSupport: boolean;
  extraHeaders: Record<string, string>;
}

/* --------------------------------------------------------- image provider */

export type ImageProviderKind = 'openai' | 'gemini' | 'custom';

export type AspectRatio = 'portrait' | 'square' | 'landscape';

export const ASPECT_RATIOS: Array<{ value: AspectRatio; label: string; size: string }> = [
  { value: 'portrait', label: 'Portrait', size: '1024x1536' },
  { value: 'square', label: 'Square', size: '1024x1024' },
  { value: 'landscape', label: 'Landscape', size: '1536x1024' },
];

/**
 * Image generation is configured completely separately from text generation:
 * people routinely pair a text model on one service with an image model on
 * another.
 */
export interface ImageProvider extends Timestamped {
  id: ID;
  name: string;
  kind: ImageProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  extraHeaders: Record<string, string>;
  /** Extra body fields merged into the request (quality, style, seed…). */
  extraBody: Record<string, unknown>;
  defaultAspect: AspectRatio;
  /** Appended to every prompt — house style, quality tags, safety wording. */
  promptSuffix: string;
  negativePrompt: string;
}

/* --------------------------------------------------------- story summary */

export type SummaryScope = 'story';

/**
 * Long-run memory for a story. Without this, a months-long roleplay either
 * blows the context budget or silently forgets its own history.
 */
export interface StorySummary extends Timestamped {
  /** One row per story; the story id doubles as the primary key. */
  id: ID;
  storyId: ID;
  /** Human-facing synopsis of where the story stands right now. */
  currentSummary: string;
  /** Compacted history of everything before the recent window. */
  rollingSummary: string;
  /** Discrete beats worth never losing. */
  importantEvents: string[];
  /** "Sera ⇄ Corin: wary allies, one unpaid debt." */
  relationshipState: string;
  /** Per-character running state, keyed by character id. */
  characterState: Record<ID, string>;
  /** A locked summary is never overwritten by automatic regeneration. */
  locked: boolean;
  /** Message order the rolling summary already covers. */
  coveredThroughOrder: number;
  lastGeneratedAt: number;
}

/* --------------------------------------------------------------- settings */

export interface Settings {
  id: 'settings';
  activeProviderId: ID | null;
  defaultPersonaId: ID | null;
  globalSystemPrompt: string;
  globalInstructions: string;
  contextBudget: number;
  reserveForResponse: number;
  loreScanDepth: number;
  maxLoreEntries: number;
  maxMemories: number;
  historyLimit: number;
  theme: 'dark' | 'light';
  fontScale: number;
  sendOnEnter: boolean;
  showTokenCounts: boolean;
  migratedV2: boolean;
  schemaVersion: number;
  /** When a full backup was last downloaded, so we can stop nagging. */
  lastBackupAt: number | null;

  /* image generation */
  activeImageProviderId: ID | null;

  /* long-run memory */
  useStorySummary: boolean;
  /** Messages kept verbatim before older turns fold into the rolling summary. */
  summaryWindow: number;
  /** Auto-regenerate the summary once this many new messages accumulate. */
  autoSummaryEvery: number;

  /* automatic memory */
  autoMemory: boolean;
  autoMemoryTriggers: AutoMemoryTrigger[];
  autoMemoryPin: boolean;
  /** Evaluate automatic memory once every N assistant replies. */
  autoMemoryEvery: number;
}

export type AutoMemoryTrigger =
  | 'plot'
  | 'relationship'
  | 'new-character'
  | 'revelation'
  | 'promise'
  | 'conflict'
  | 'romance'
  | 'location';

export const AUTO_MEMORY_TRIGGERS: Array<{ value: AutoMemoryTrigger; label: string }> = [
  { value: 'plot', label: 'Major plot event' },
  { value: 'relationship', label: 'Relationship change' },
  { value: 'new-character', label: 'New character' },
  { value: 'revelation', label: 'Important revelation' },
  { value: 'promise', label: 'Promise' },
  { value: 'conflict', label: 'Conflict' },
  { value: 'romance', label: 'Romance milestone' },
  { value: 'location', label: 'Location change' },
];

/* ------------------------------------------------------------ compilation */

export interface ContextPart {
  id: string;
  label: string;
  kind:
    | 'system'
    | 'global'
    | 'scene'
    | 'character'
    | 'persona'
    | 'story'
    | 'scenario'
    | 'lore'
    | 'memory'
    | 'author-note'
    | 'direction'
    | 'history'
    | 'instruction';
  content: string;
  tokens: number;
  reason: string;
  included: boolean;
  priority: number;
}

export interface CompiledContext {
  systemPrompt: string;
  messages: ChatCompletionMessage[];
  parts: ContextPart[];
  excluded: ContextPart[];
  totalTokens: number;
  budget: number;
  overBudget: boolean;
  loreHits: LoreHit[];
  memoryHits: MemoryHit[];
}

/**
 * Where a lore entry earned its place, highest relevance first.
 *
 * A keyword hit is not one fact but several: the same name can appear in the
 * user's current message, in a message from twenty turns ago, or in a pasted
 * transcript nobody is talking about any more. Ranking them identically is
 * what let a fifteen-thousand-word history drown the running scene.
 */
export type LoreTier =
  /** Matched a character who is in the scene, or the current user message. */
  | 'scene'
  /** Matched in the last few turns of conversation. */
  | 'recent'
  /** Matched the story's own scenario or a story-specific character note. */
  | 'story'
  /** Matched only in older history. */
  | 'history'
  /** Always-on world rules with no keyword at all. */
  | 'world';

export const LORE_TIER_RANK: Record<LoreTier, number> = {
  scene: 5,
  recent: 4,
  story: 3,
  history: 2,
  world: 1,
};

export interface LoreHit {
  entry: LoreEntry;
  lorebookName: string;
  matched: string[];
  reason: string;
  /** Why this entry matters now, not merely that it matched. */
  tier: LoreTier;
}

export interface LoreMiss {
  entry: LoreEntry;
  lorebookName: string;
  reason: string;
}

export interface MemoryHit {
  memory: Memory;
  reason: string;
}

export interface ChatContentPartText {
  type: 'text';
  text: string;
}
export interface ChatContentPartImage {
  type: 'image_url';
  image_url: { url: string };
}
export type ChatContentPart = ChatContentPartText | ChatContentPartImage;

export interface ChatCompletionMessage {
  role: MessageRole;
  content: string | ChatContentPart[];
  name?: string;
}

/* ------------------------------------------------------------------ misc */

export interface ToastMessage {
  id: ID;
  kind: 'info' | 'success' | 'error' | 'warn';
  title: string;
  detail?: string;
}
