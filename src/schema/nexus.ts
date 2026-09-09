/**
 * The Nexus document format.
 *
 * One structure for everything Nexus can hand to another copy of itself: a
 * character, a persona, a lorebook, a story, a chat, a memory, or the whole
 * library. Before this there were five different envelope payloads — a
 * character export was `{character, avatar, lorebooks:[{lorebook, entries}]}`,
 * a story export nested chats inside `{chat, branches, messages, …}`, a backup
 * was flat — so every reader needed a branch per kind and every new export
 * shape needed another one.
 *
 * A Nexus document is a set of flat, typed collections plus an envelope. Every
 * collection is optional. `kind` says what the document is *about*, not what
 * shape it takes: a character export and a full backup differ only in which
 * collections are populated. That is what makes one reader enough.
 *
 * Nothing here is SillyTavern-shaped. Cards, Chub packs, Agnai dumps and the
 * rest are converted into this on the way in (see `importers/pipeline.ts`), so
 * foreign formats stay at the edge instead of leaking into storage.
 *
 * Backward compatibility is not optional: every file Nexus has ever written
 * still imports. `fromLegacyEnvelope` lifts the old `nexus-tavern-pro`
 * envelopes into this shape, and it is the only place that knows about them.
 */

import type {
  Branch,
  Character,
  Chat,
  Checkpoint,
  ID,
  ImageProvider,
  LoreEntry,
  Lorebook,
  MediaMeta,
  Memory,
  Message,
  MessageAlternative,
  Persona,
  Provider,
  Settings,
  Story,
  KnowledgeEdge,
  RelationshipDelta,
  SceneDelta,
  StorySummary,
} from '../types';

/** The `format` marker on every document Nexus writes. */
export const NEXUS_FORMAT = 'nexus';

/**
 * The document format's own version, independent of the storage schema. Bump
 * it only when the document shape changes in a way a reader must know about.
 */
export const NEXUS_SCHEMA_VERSION = 1;

/** The marker Nexus wrote before this format existed. Still read, never written. */
export const LEGACY_FORMAT = 'nexus-tavern-pro';

export type NexusDocumentKind =
  | 'character'
  | 'persona'
  | 'lorebook'
  | 'lore-entry'
  | 'story'
  | 'chat'
  | 'memory'
  | 'backup'
  /** Several unrelated things in one file. */
  | 'mixed';

/**
 * The collections a document may carry. Names and element types are exactly
 * the app's own, so a document is readable without a translation table.
 */
export interface NexusCollections {
  characters?: Character[];
  personas?: Persona[];
  lorebooks?: Lorebook[];
  loreEntries?: LoreEntry[];
  stories?: Story[];
  chats?: Chat[];
  branches?: Branch[];
  messages?: Message[];
  alternatives?: MessageAlternative[];
  checkpoints?: Checkpoint[];
  memories?: Memory[];
  storySummaries?: StorySummary[];
  sceneDeltas?: SceneDelta[];
  relationshipDeltas?: RelationshipDelta[];
  knowledgeEdges?: KnowledgeEdge[];
  providers?: Provider[];
  imageProviders?: ImageProvider[];
  mediaMeta?: MediaMeta[];
  /** Whole-library documents only. */
  settings?: Settings;
  /** mediaId → data URL. Restored into blob storage on import. */
  media?: Record<ID, string>;
  /** False when a backup deliberately left images out. */
  mediaIncluded?: boolean;
}

export interface NexusDocument extends NexusCollections {
  format: typeof NEXUS_FORMAT;
  /** Version of this document format. */
  schema: number;
  kind: NexusDocumentKind;
  exportedAt: string;
  generator?: { app: string; schemaVersion: number };
  /**
   * The id of the thing the document is about, when it is about one thing —
   * the exported character, the exported story. Lets a reader pick the subject
   * out of a document that also carries its dependencies.
   */
  primaryId?: ID | null;
}

/** Every collection key, in a stable order. Used for counting and merging. */
export const COLLECTION_KEYS = [
  'characters',
  'personas',
  'lorebooks',
  'loreEntries',
  'stories',
  'chats',
  'branches',
  'messages',
  'alternatives',
  'checkpoints',
  'memories',
  'storySummaries',
  'sceneDeltas',
  'relationshipDeltas',
  'knowledgeEdges',
  'providers',
  'imageProviders',
  'mediaMeta',
] as const satisfies ReadonlyArray<keyof NexusCollections>;

export type CollectionKey = (typeof COLLECTION_KEYS)[number];

export function nexusDocument(
  kind: NexusDocumentKind,
  collections: NexusCollections,
  options: { primaryId?: ID | null; appSchemaVersion?: number } = {},
): NexusDocument {
  const doc: NexusDocument = {
    format: NEXUS_FORMAT,
    schema: NEXUS_SCHEMA_VERSION,
    kind,
    exportedAt: new Date().toISOString(),
    ...collections,
  };
  if (options.primaryId !== undefined) doc.primaryId = options.primaryId;
  if (options.appSchemaVersion !== undefined) {
    doc.generator = { app: 'Nexus', schemaVersion: options.appSchemaVersion };
  }
  return doc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNexusDocument(value: unknown): value is NexusDocument {
  return isRecord(value) && value.format === NEXUS_FORMAT && typeof value.kind === 'string';
}

export function isLegacyEnvelope(
  value: unknown,
): value is { format: string; kind: string; version?: number; data: unknown } {
  return isRecord(value) && value.format === LEGACY_FORMAT && 'data' in value;
}

/** How many rows a document carries, per collection. Empty ones are omitted. */
export function documentCounts(doc: NexusCollections): Array<{ key: CollectionKey; count: number }> {
  return COLLECTION_KEYS.map((key) => ({ key, count: doc[key]?.length ?? 0 })).filter(
    (row) => row.count > 0,
  );
}

/** Concatenates collections. Used to fold several parsed files into one import. */
export function mergeCollections(...parts: NexusCollections[]): NexusCollections {
  const out: NexusCollections = {};
  for (const part of parts) {
    for (const key of COLLECTION_KEYS) {
      const rows = part[key];
      if (!rows?.length) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = [...((out as any)[key] ?? []), ...rows];
    }
    if (part.media) out.media = { ...(out.media ?? {}), ...part.media };
    if (part.settings) out.settings = part.settings;
    if (part.mediaIncluded) out.mediaIncluded = true;
  }
  return out;
}

/* ------------------------------------------------------ legacy envelopes */

/** `{lorebook, entries}` pairs, as story and character exports used to nest them. */
interface LegacyBookPair {
  lorebook?: Lorebook;
  entries?: LoreEntry[];
}

/** A chat and everything hanging off it, as chat and story exports nested it. */
interface LegacyChatBundle {
  chat?: Chat;
  branches?: Branch[];
  messages?: Message[];
  alternatives?: MessageAlternative[];
  checkpoints?: Checkpoint[];
  media?: Record<ID, string>;
}

function flattenBooks(pairs: LegacyBookPair[] | undefined): NexusCollections {
  const lorebooks: Lorebook[] = [];
  const loreEntries: LoreEntry[] = [];
  for (const pair of pairs ?? []) {
    if (pair?.lorebook) lorebooks.push(pair.lorebook);
    if (pair?.entries?.length) loreEntries.push(...pair.entries);
  }
  return { lorebooks, loreEntries };
}

function flattenChats(bundles: LegacyChatBundle[] | undefined): NexusCollections {
  const out: NexusCollections = {
    chats: [],
    branches: [],
    messages: [],
    alternatives: [],
    checkpoints: [],
  };
  for (const bundle of bundles ?? []) {
    if (bundle?.chat) out.chats!.push(bundle.chat);
    out.branches!.push(...(bundle?.branches ?? []));
    out.messages!.push(...(bundle?.messages ?? []));
    out.alternatives!.push(...(bundle?.alternatives ?? []));
    out.checkpoints!.push(...(bundle?.checkpoints ?? []));
    if (bundle?.media) out.media = { ...(out.media ?? {}), ...bundle.media };
  }
  return out;
}

/**
 * Lifts a `nexus-tavern-pro` envelope into a document.
 *
 * Every shape the app has ever exported is handled here, and only here. An
 * unrecognised kind returns null rather than guessing — the caller then falls
 * through to the foreign-format detectors, which is the right outcome for a
 * file that merely happens to carry the marker.
 */
export function fromLegacyEnvelope(envelope: unknown): NexusDocument | null {
  if (!isLegacyEnvelope(envelope)) return null;
  const data = envelope.data;
  if (!isRecord(data) && !Array.isArray(data)) return null;
  const d = (isRecord(data) ? data : {}) as Record<string, any>;

  const stamp = (kind: NexusDocumentKind, collections: NexusCollections, primaryId?: ID | null) => {
    const doc = nexusDocument(kind, collections, { primaryId: primaryId ?? null });
    // Preserve when the original was written; a lifted document is the same
    // export, not a new one.
    const exportedAt = (envelope as Record<string, unknown>).exportedAt;
    if (typeof exportedAt === 'string') doc.exportedAt = exportedAt;
    return doc;
  };

  switch (envelope.kind) {
    case 'character': {
      const character: Character | undefined = d.character;
      if (!character) return null;
      const books = flattenBooks(d.lorebooks);
      return stamp(
        'character',
        { characters: [character], ...books, ...avatarMedia(character.avatarMediaId, d.avatar) },
        character.id,
      );
    }
    case 'persona': {
      const persona: Persona | undefined = d.persona;
      if (!persona) return null;
      return stamp(
        'persona',
        { personas: [persona], ...avatarMedia(persona.avatarMediaId, d.avatar) },
        persona.id,
      );
    }
    case 'lorebook': {
      if (!d.lorebook && !d.entries) return null;
      return stamp(
        'lorebook',
        { lorebooks: d.lorebook ? [d.lorebook] : [], loreEntries: d.entries ?? [] },
        d.lorebook?.id ?? null,
      );
    }
    case 'lore-entry': {
      if (!d.entry) return null;
      return stamp('lore-entry', { loreEntries: [d.entry] }, d.entry.id);
    }
    case 'memory': {
      const memories: Memory[] = d.memories ?? (d.memory ? [d.memory] : []);
      if (!memories.length) return null;
      return stamp('memory', { memories }, memories.length === 1 ? memories[0].id : null);
    }
    case 'story': {
      const story: Story | undefined = d.story;
      if (!story) return null;
      const books = flattenBooks(d.lorebooks);
      const chats = flattenChats(d.chats);
      return stamp(
        'story',
        {
          stories: [story],
          characters: d.characters ?? [],
          personas: d.persona ? [d.persona] : [],
          memories: d.memories ?? [],
          ...books,
          ...chats,
          media: { ...(chats.media ?? {}), ...(d.media ?? {}) },
        },
        story.id,
      );
    }
    case 'chat': {
      const chat: Chat | undefined = d.chat;
      if (!chat) return null;
      return stamp(
        'chat',
        {
          chats: [chat],
          branches: d.branches ?? [],
          messages: d.messages ?? [],
          alternatives: d.alternatives ?? [],
          checkpoints: d.checkpoints ?? [],
          media: d.media,
        },
        chat.id,
      );
    }
    case 'backup': {
      // Backups were already flat, which is where this shape came from.
      return stamp('backup', {
        characters: d.characters ?? [],
        personas: d.personas ?? [],
        stories: d.stories ?? [],
        chats: d.chats ?? [],
        branches: d.branches ?? [],
        messages: d.messages ?? [],
        alternatives: d.alternatives ?? [],
        checkpoints: d.checkpoints ?? [],
        memories: d.memories ?? [],
        lorebooks: d.lorebooks ?? [],
        loreEntries: d.loreEntries ?? [],
        storySummaries: d.storySummaries ?? [],
        sceneDeltas: d.sceneDeltas ?? [],
        relationshipDeltas: d.relationshipDeltas ?? [],
        knowledgeEdges: d.knowledgeEdges ?? [],
        providers: d.providers ?? [],
        imageProviders: d.imageProviders ?? [],
        mediaMeta: d.mediaMeta ?? [],
        settings: d.settings,
        media: d.media,
        mediaIncluded: Boolean(d.mediaIncluded),
      });
    }
    default:
      return null;
  }
}

/** A single subject's avatar, keyed by its media id so it needs no special case. */
function avatarMedia(mediaId: ID | null | undefined, dataUrl: unknown): NexusCollections {
  if (!mediaId || typeof dataUrl !== 'string' || !dataUrl) return {};
  return { media: { [mediaId]: dataUrl } };
}

/**
 * The data URL for a document's single subject, when it has one.
 *
 * Character and persona imports need the avatar bytes even when the incoming
 * media id means nothing locally, so this is pulled back out on the way in.
 */
export function subjectAvatar(doc: NexusDocument): string | undefined {
  const subject =
    (doc.characters?.length === 1 ? doc.characters[0] : null) ??
    (doc.personas?.length === 1 ? doc.personas[0] : null);
  const mediaId = subject?.avatarMediaId;
  if (!mediaId) return undefined;
  return doc.media?.[mediaId];
}
