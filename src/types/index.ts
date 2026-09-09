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
  /**
   * Timing, all measured in messages on the timeline being played and all
   * disabled at 0. Resolved from the visible history rather than from stored
   * activation state, so a branch that never said the keyword has never
   * triggered the entry — the same rule the rest of the app follows, and no
   * fifth store to keep in step.
   *
   * `delay` holds an entry back until the story is long enough for it: a
   * late-game revelation should not be able to fire in the opening exchange.
   *
   * `sticky` keeps a triggered entry alive for a few more messages once the
   * keyword stops being said, so a location or a thread does not flicker in
   * and out of the prompt between mentions.
   *
   * `cooldown` stops a common keyword re-triggering every turn and crowding
   * out everything else — the failure mode of a large worldbook.
   */
  delay: number;
  sticky: number;
  cooldown: number;
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

/**
 * How the memory came to be believed.
 *
 * The story showing something, a character claiming it, and the extractor
 * concluding it are three different kinds of knowledge, and a character who
 * lies makes them come apart. Collapsing them into one flat "fact" is how a
 * story ends up treating a cover story as settled truth.
 */
export type MemoryBasis =
  /** It happened in the text. */
  | 'observed'
  /** Someone said it. It may be wrong, or a lie. */
  | 'stated'
  /** Concluded rather than shown. */
  | 'inferred';

export const MEMORY_BASES: MemoryBasis[] = ['observed', 'stated', 'inferred'];

export type MemoryStatus =
  /** Waiting for a person to accept it. Never sent to the model. */
  | 'proposed'
  /** In use. */
  | 'active'
  /** Replaced by a later memory, kept for the record. */
  | 'superseded';

/** A beat that moved two people relative to each other. */
export interface RelationshipImpact {
  /** Character ids, or the persona's id. */
  betweenIds: [ID, ID];
  /** What changed, in a few words: "trust broken", "grew closer". */
  change: string;
}

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

  /* ------------------------------------------------------- memory matrix */
  /*
   * Everything below is optional in practice: memories saved before these
   * fields existed do not carry them, so read them through the helpers in
   * src/memory/matrix.ts rather than directly.
   */

  /**
   * Who or what this is about, by name. Unlike characterIds these need no
   * character record, so a memory can be about someone the story has only
   * mentioned. Retrieval matches on these.
   */
  subjects?: string[];
  basis?: MemoryBasis;
  /** 0–1. Only confident observations commit without review. */
  confidence?: number;
  status?: MemoryStatus;
  /** Who claimed it, when the basis is 'stated'. */
  statedById?: ID | null;
  /** Memories this one replaces, once it is accepted. */
  supersedes?: ID[];
  relationshipImpact?: RelationshipImpact | null;
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

/**
 * Where the story stands, as opposed to where this scene stands.
 *
 * Deliberately does NOT restate SceneState. The scene knows the room, who is
 * in it and what is happening this minute; this knows the wider situation the
 * scene sits inside — which arc, when, what is unresolved. Nor does it hold
 * recent events: those are the chat and the memories, and copying them here
 * would give the same fact two homes that can disagree.
 */
export interface StoryState {
  /** Which stretch of the story this is — a chapter, an arc, a phase. */
  arc: string;
  /** When it is: "Friday evening", "three days after the fight". */
  time: string;
  /** The tension currently driving things. */
  conflict: string;
  /** What is being pursued at story level, above this scene's objective. */
  objective: string;
  /** Open threads, one per line. Things the story owes an answer to. */
  threads: string[];
  updatedAt: number;
}

/**
 * How two people in a story stand with each other.
 *
 * Between any two participants — two characters, or a character and the
 * persona — which is why the ends are plain ids rather than `characterId`
 * fields. `summary` is where they are now; the history of how they got there
 * is the chat and the memories, not a second copy here.
 */
export interface Relationship {
  id: ID;
  /** The two participants. Character ids, or the persona's id. */
  betweenIds: [ID, ID];
  /** What this is, in a few words: "rivals", "estranged siblings". */
  label: string;
  /** Where they stand now, in prose. */
  summary: string;
  /**
   * True when a person wrote or corrected this rather than the story
   * inferring it. A manual relationship outranks anything derived.
   */
  manual: boolean;
  updatedAt: number;
}

/**
 * A change to where two people stand, as the story made it.
 *
 * `story.relationships` is what the author wrote and stays that way: an
 * extractor folding its conclusions into that array made derived knowledge
 * indistinguishable from authored knowledge, unbranchable, and impossible to
 * take back. This row is the derived half instead — it names the turns that
 * established it, so a branch that cannot see them does not see the change
 * either, and undoing it is a status change rather than an attempt to unpick a
 * sentence from a paragraph.
 *
 * Shaped like SceneDelta because it answers the same questions, not because
 * they share machinery. There is deliberately no common "delta" abstraction:
 * the two resolve differently, and the resemblance is not worth a layer.
 */
export interface RelationshipDelta extends Timestamped {
  id: ID;
  chatId: ID;
  /** The branch whose timeline established this. */
  branchId: ID;
  /** The pair, in the order the extractor named them. Compared unordered. */
  betweenIds: [ID, ID];
  /** Where they stand now, in a few words: "trust broken", "grew closer". */
  change: string;
  /** The memory this came from, so the two can be read together. */
  sourceMemoryId: ID | null;
  /**
   * The exchange it was read from. Its visibility decides the delta's.
   *
   * Exchange-level rather than the single grounded turn a SceneDelta names:
   * the memory extractor reports one conclusion per exchange and does not say
   * which half of it carried the relationship. Requiring all of them to be
   * visible is the safe direction — a branch cut mid-exchange drops the
   * change rather than keeping it on half its evidence.
   */
  sourceMessageIds: ID[];
  appliedAt: number;
  basis: MemoryBasis;
  /** 0–1, from the memory that carried the impact. */
  confidence: number;
  /**
   * `proposed` never affects the standing and mirrors a memory still waiting
   * to be accepted; it becomes `applied` when that memory is. `reversed` is one
   * the user took back.
   *
   * There is deliberately no `superseded`, which SceneDelta needs and this does
   * not: a scene field is always there to be written over, whereas a
   * relationship someone writes by hand is a row whose existence is itself the
   * override. Resolution reads `manual` directly, so deleting that row lets the
   * story's own version be heard again instead of leaving it stamped
   * superseded by something no longer there.
   */
  status: RelationshipDeltaStatus;
}

export type RelationshipDeltaStatus = 'proposed' | 'applied' | 'reversed';

/* -------------------------------------------------------------- knowledge */

/**
 * How a character came to have access to a claim.
 *
 * Deliberately not `MemoryBasis`, which sits one layer down and answers a
 * different question: that one says how the *extractor* arrived at a claim,
 * this one says how a *character in the story* came to hold it. Two fields
 * called `basis` meaning different things is worth two type names.
 */
export type KnowledgeBasis =
  | 'witnessed'
  | 'participated'
  | 'told'
  | 'discovered'
  | 'inferred'
  | 'authored'
  /**
   * Derivation only. Produced at read time from a memory's own `statedById`
   * and never written to the store; extraction must not emit it.
   */
  | 'stated';

/**
 * What a character knows of.
 *
 * A relationship is named by its pair, never by the id of the row that
 * currently describes it. `effectiveRelationships` gives a pair one id when the
 * author has written it down and another when only the story has, so removing a
 * hand-written standing — which the story editor allows — changes that id. An
 * edge keyed by it would quietly stop matching. The pair is stable through
 * every operation the author can perform, and is the truer subject anyway:
 * knowledge is about how two people stand, not about a database row.
 */
export type KnowledgeSubject =
  | { kind: 'memory'; id: ID }
  | { kind: 'relationship'; betweenIds: [ID, ID] };

/**
 * One character's access to one claim.
 *
 * "Knows of", never "knows". Holding a claim is not believing it, agreeing
 * with it, having witnessed it, or the claim being true — the memory layer
 * already refuses that conflation for `stated` memories, and this is the same
 * refusal one storey up. A character can hold a claim that is a lie they were
 * told, and the store has to be able to say so.
 *
 * `confidence` is confidence in the *attribution*: how sure Nexus is that this
 * character was told this, not how likely the thing is to be true.
 *
 * Absence of an edge means nothing is tracked. It never means the character
 * does not know — there is no negative-knowledge system, and reading absence
 * as denial would make every story written before this feature amnesiac.
 */
export interface KnowledgeEdge extends Timestamped {
  id: ID;
  chatId: ID;
  /** The branch whose timeline established this. */
  branchId: ID;
  /** Character or persona id. One edge per knower; never a `knownBy` array. */
  knowerId: ID;
  subject: KnowledgeSubject;
  basis: KnowledgeBasis;
  /**
   * Who did the telling, for `told`. Communication provenance only: it does
   * not mean the teller knows, believes, or is telling the truth, and it is
   * never traversed to give the teller knowledge of anything.
   */
  toldById: ID | null;
  /** The exchange it was read from. Its visibility decides the edge's. */
  sourceMessageIds: ID[];
  confidence: number;
  status: KnowledgeEdgeStatus;
  appliedAt: number;
}

export type KnowledgeEdgeStatus = 'proposed' | 'applied' | 'reversed';

/**
 * An edge as it applies on the branch being played.
 *
 * Stored rows and read-time derivations arrive here as one shape, the way
 * `ResolvedScene` and `ResolvedSummary` already do for their layers. A derived
 * edge reports no branch of origin because the memory it came from records
 * none — `null` says that rather than inventing one.
 */
export interface ResolvedKnowledge {
  id: ID;
  knowerId: ID;
  subject: KnowledgeSubject;
  basis: KnowledgeBasis;
  toldById: ID | null;
  sourceMessageIds: ID[];
  confidence: number;
  branchId: ID | null;
  /** True when nothing is stored: not exported, not reversible. */
  derived: boolean;
}

/**
 * One subject and everyone recorded as knowing of it.
 *
 * Carried on the compile result beside `loreMisses` — inspector-visible and
 * prompt-invisible. Knowledge contributes no context part and no tokens.
 */
export interface KnowledgeAnnotation {
  subject: KnowledgeSubject;
  /** The memory's title, or the two names, for display. */
  label: string;
  /**
   * True for a relationship subject with no standing in this scene right now.
   * The edge survives the standing disappearing — someone's knowledge of how
   * two people stood is not erased by the standing being taken back — so this
   * distinguishes "nothing to show it against" from "no edge exists".
   */
  unresolved: boolean;
  /**
   * Names resolved here rather than in the view, so the Context Inspector
   * stays a verbatim renderer of one compile and never has to look anything up
   * for itself.
   */
  knowers: Array<{
    knower: ResolvedKnowledge;
    knowerName: string;
    toldByName: string | null;
  }>;
}

/** Off, or tracked and shown without touching generation. */
export type KnowledgeMode = 'off' | 'annotate';

export interface NarrationPreset {
  id: ID;
  name: string;
  instruction: string;
  description: string;
  builtIn: boolean;
}

/**
 * Someone the story named who has no character record.
 *
 * The story invents people constantly — a courier, a name dropped in an
 * argument, a sister who never appears. Most of them should stay names. This
 * records the ones the extractor noticed so a person can decide, rather than
 * silently creating characters nobody asked for.
 */
export interface DiscoveredPerson {
  id: ID;
  name: string;
  /** What the story has said about them so far, in a line. */
  note: string;
  /** Where they were first named, so the claim can be checked. */
  sourceMessageIds: ID[];
  /** Turned down. Kept so the same name is not proposed again. */
  dismissed: boolean;
  updatedAt: number;
}

export interface Story extends Timestamped {
  id: ID;
  title: string;
  description: string;
  scenario: string;
  /**
   * How this world works — what is possible in it, what is forbidden, what the
   * narrator must respect. Distinct from the scenario, which is a situation
   * and changes as the story moves; rules hold for the whole campaign.
   */
  rules: string;
  /** What has already happened, in order. The campaign's history. */
  timeline: string;
  /**
   * Narration style presets applied to every chat in this story. They combine
   * — "Detailed + Slow Burn + Cinematic" is a normal selection — so this is a
   * list rather than a mode. See `narration/presets.ts`.
   */
  narrationPresetIds: ID[];
  /**
   * Where the story currently stands. Nested on the story rather than kept in
   * its own store because it is exactly one per story, the same reasoning that
   * puts SceneState on the chat.
   */
  state: StoryState;
  /** How the cast stand with each other and with the persona. */
  relationships: Relationship[];
  /**
   * People the story has named who are not in the cast yet.
   *
   * Optional: a story saved before this existed simply has none. Kept on the
   * story rather than written straight into the character library, because a
   * name the story mentioned once is not yet a character — turning every
   * passing innkeeper into a library entry is how the library becomes
   * unusable.
   */
  discovered?: DiscoveredPerson[];
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
  /**
   * What a historical message's content actually is.
   *
   * `turn`  — one named character's turn, and `characterId` says whose. An
   *           imported log is a sequence of these: the file names a speaker
   *           per message, so the attribution is the file's, not a guess.
   * `scene` — a whole scene in one message: narration, a story opening, or a
   *           pasted transcript carrying several speakers at once. There is no
   *           single speaker to name, and naming one would be a lie.
   *
   * Absent means unknown, which is read as `scene` — the conservative answer,
   * and the behaviour everything stored before this field existed already had.
   */
  speakerScope?: 'turn' | 'scene';
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
  /**
   * Narration presets for this chat alone. `null` inherits the story's
   * selection; an empty array is a deliberate "none", which is why this is
   * nullable rather than just empty.
   */
  narrationPresetIds: ID[] | null;
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

/**
 * A change to the current scene that the story itself established.
 *
 * `chat.scene` is the canonical base: what a person wrote down. A scene also
 * moves on its own — they leave the kitchen and step onto the rooftop — and
 * until now nothing recorded that, so the top of every prompt went on
 * insisting on a room the transcript had already left.
 *
 * A delta is that movement, kept beside the base rather than written into it.
 * The effective scene is the base with the visible, applied deltas replayed
 * over it, so the base stays the author's, the branch that lived the change is
 * the only one that has it, and any of it can be taken back.
 */
export interface SceneDelta extends Timestamped {
  id: ID;
  chatId: ID;
  /** The branch whose timeline established this. */
  branchId: ID;
  /** The exchange it was read from. Its visibility decides the delta's. */
  sourceMessageIds: ID[];
  appliedAt: number;
  /** Only SceneState keys, and only the ones that changed. */
  fields: Partial<SceneState>;
  /** What those keys held before. For explaining and repairing, never replay. */
  previous: Partial<SceneState>;
  basis: MemoryBasis;
  /** 0–1. Only confident observations apply without being asked. */
  confidence: number;
  /**
   * `proposed` never affects the scene. `applied` does. `reversed` is one the
   * user took back; `superseded` is one whose field the user has since written
   * by hand. Both of the last two are excluded from replay, and they are kept
   * apart because the difference is what the UI has to explain.
   */
  status: SceneDeltaStatus;
}

export type SceneEvolutionMode = 'off' | 'propose' | 'apply';

export type SceneDeltaStatus = 'proposed' | 'applied' | 'reversed' | 'superseded';

/** Scene fields a delta may apply on its own; the rest can only propose. */
export const AUTO_APPLY_SCENE_FIELDS = ['location', 'situation', 'characterStates'] as const;
export type AutoApplySceneField = (typeof AUTO_APPLY_SCENE_FIELDS)[number];

export function emptyStoryState(): StoryState {
  return { arc: '', time: '', conflict: '', objective: '', threads: [], updatedAt: 0 };
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
  /**
   * Row id. Rows written before summaries knew which timeline they described
   * carry the story id here, because there was one row per story; new rows get
   * an id of their own so a story can hold one summary per branch.
   */
  id: ID;
  storyId: ID;
  /**
   * The chat whose order space `coveredThroughOrder` belongs to.
   *
   * Every chat counts its own messages from zero, so a watermark without this
   * cannot be read: applying one chat's number to another silently deletes the
   * whole transcript. Absent on legacy rows.
   */
  chatId?: ID | null;
  /**
   * The branch whose timeline this compresses. A summary is a claim about one
   * sequence of events, so a sibling branch — which never had them — must
   * never see it. Absent on legacy rows.
   */
  branchId?: ID | null;
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
  /**
   * Practical ceiling on prompt size, whatever the model could hold. A model
   * with a 131,072-token window is not asking for a 131,072-token prompt: past
   * a point more prompt buys continuity nobody asked for at a cost in latency
   * everybody feels.
   */
  maxPromptTokens: number;
  /**
   * Practical ceiling on a single reply. num_predict has to fit inside the
   * window alongside the prompt, so a 32,000-token reply reservation makes the
   * server allocate a 32,000-token cache for a turn that will use a fraction of
   * it — paid for in startup latency on every message.
   */
  maxResponseTokens: number;
  /**
   * Presets the user created, plus edits to the built-in ones stored under the
   * same id. Lives in settings rather than its own object store so an existing
   * database needs no version bump to gain the feature.
   */
  narrationPresets: NarrationPreset[];
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
  /**
   * How much the story may move the scene on its own.
   *
   * 'off' extracts nothing. 'propose' reads scene changes but never applies
   * one without being asked. 'apply' lets a confident, observed change move
   * location, situation and character state by itself — announced, and
   * reversible from Quick Settings.
   */
  sceneEvolution: SceneEvolutionMode;
  /**
   * Whether the story tracks what each character knows of.
   *
   * 'annotate' records and shows it and changes nothing about generation:
   * knowledge contributes no prompt text and no tokens. There is deliberately
   * no gating mode yet — a value nothing can act on is a state later readers
   * have to reason about for no benefit, and settings merge forward, so adding
   * one later needs no migration.
   */
  knowledgeMode: KnowledgeMode;
  /** Messages kept verbatim before older turns fold into the rolling summary. */
  summaryWindow: number;
  /** Auto-regenerate the summary once this many new messages accumulate. */
  autoSummaryEvery: number;

  /* automatic memory */
  autoMemory: boolean;
  /**
   * Whether the extractor also reports people the story named who are not in
   * the cast. Optional: an install that predates it reads as on, which is the
   * behaviour it already had.
   */
  autoCharacters?: boolean;
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

/**
 * One message as it reaches the provider, next to where it came from.
 *
 * A prompt can be correct in every section and still fail because of how the
 * conversation itself was assembled — a turn dropped, a speaker unattributed, a
 * transcript excerpted from the wrong end. This row is what makes that
 * inspectable without exporting the payload and reading it by hand.
 */
export interface MessagePipelineRow {
  /** Position in the array actually sent. */
  index: number;
  apiRole: MessageRole;
  /** The role as stored, which for a synthesised turn has no counterpart. */
  storedRole: MessageRole | null;
  /** Who Nexus believes spoke: a character name, the persona, or the system. */
  sender: string;
  characterId: ID | null;
  /** Carried over from earlier play rather than taken in this chat. */
  historical: boolean;
  /** True when only part of the stored message was sent. */
  excerpted: boolean;
  originalTokens: number;
  finalTokens: number;
  head: string;
  tail: string;
}

export interface CompiledContext {
  systemPrompt: string;
  messages: ChatCompletionMessage[];
  /** Provenance for each message sent, in the order sent. */
  pipeline: MessagePipelineRow[];
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
