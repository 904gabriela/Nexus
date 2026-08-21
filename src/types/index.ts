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
  | 'unassigned';

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
  lorebookIds: ID[];
  /** Next value for Message.order. */
  orderCounter: number;
}

/* --------------------------------------------------------------- provider */

export type ProviderKind = 'openrouter' | 'openai' | 'custom' | 'local';

export interface Provider extends Timestamped {
  id: ID;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  streaming: boolean;
  visionSupport: boolean;
  extraHeaders: Record<string, string>;
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
}

/* ------------------------------------------------------------ compilation */

export interface ContextPart {
  id: string;
  label: string;
  kind:
    | 'system'
    | 'global'
    | 'character'
    | 'persona'
    | 'story'
    | 'scenario'
    | 'lore'
    | 'memory'
    | 'author-note'
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

export interface LoreHit {
  entry: LoreEntry;
  lorebookName: string;
  matched: string[];
  reason: string;
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
