/**
 * Import pipeline: READ → DETECT → PARSE → VALIDATE → NORMALISE → PREVIEW →
 * CONFIRM → IMPORT → PERSIST.
 *
 * Parsing is pure and side-effect free; nothing touches storage until
 * commitImport() runs. Imported data is treated as untrusted: only known
 * fields are read, everything else lands in customFields as plain strings, and
 * no imported string is ever evaluated or injected as HTML.
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
  Memory,
  Message,
  MessageAlternative,
  Persona,
  Provider,
  Settings,
  Story,
  SceneDelta,
  StorySummary,
} from '../types';
import {
  newBranch,
  newChat,
  newCharacter,
  newLoreEntry,
  newLorebook,
  newMemory,
  newMessage,
  newPersona,
  newStory,
} from '../types/factories';
import {
  extractEmbeddedLorebook,
  isPlainObject,
  normalizeCharacter,
  normalizeLoreEntry,
  normalizeLorebook,
  normalizePersona,
  normalizeStory,
} from './normalize';
import { emptyScene } from '../types';
import {
  COLLECTION_KEYS,
  documentCounts,
  fromLegacyEnvelope,
  isNexusDocument,
  LEGACY_FORMAT,
  NEXUS_FORMAT,
  subjectAvatar,
  type CollectionKey,
  type NexusDocument,
} from '../schema/nexus';
import { readCharacterCardFromPng } from './pngMetadata';
import * as repo from '../storage/repositories';
import { importDataUrl, saveMedia } from '../media/mediaStore';
import { uid } from '../utils/uid';
import { firstOf, toStringList, truncate } from '../utils/text';

export type ImportKind =
  | 'character'
  | 'persona'
  | 'lorebook'
  | 'lore-entry'
  | 'story'
  | 'chat'
  | 'memory'
  | 'backup'
  | 'unknown';

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  character: 'Character',
  persona: 'Persona',
  lorebook: 'Lorebook',
  'lore-entry': 'Lorebook Entry',
  story: 'Story',
  chat: 'Chat',
  memory: 'Memory',
  backup: 'Full Backup',
  unknown: 'Unrecognised',
};

export const TXT_TARGETS: ImportKind[] = [
  'character',
  'persona',
  'lore-entry',
  'story',
  'chat',
];

export type ConflictStrategy = 'copy' | 'replace' | 'merge' | 'cancel';

export interface ImportIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
}

/** Everything a preview needs, plus the payload commitImport() will write. */
export interface ParsedImport {
  id: string;
  kind: ImportKind;
  sourceName: string;
  sourceFormat: string;
  title: string;
  summary: string[];
  issues: ImportIssue[];
  /** Set when the user must pick what a TXT file becomes. */
  needsKindChoice?: boolean;
  rawText?: string;
  payload: ImportPayload;
  /** Existing rows this import would collide with. */
  conflicts: ConflictInfo[];
}

export interface ConflictInfo {
  kind: ImportKind;
  existingId: ID;
  existingName: string;
  incomingName: string;
  reason: 'same-id' | 'same-name';
}

export interface ImportPayload {
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
  providers?: Provider[];
  imageProviders?: ImageProvider[];
  storySummaries?: StorySummary[];
  sceneDeltas?: SceneDelta[];
  settings?: Settings;
  /** mediaId → data URL, restored into blob storage on commit. */
  media?: Record<ID, string>;
  /** Avatar bytes carried alongside a single character/persona import. */
  avatarDataUrl?: string;
  /** The image file itself, when importing a PNG character card. */
  avatarFile?: File | Blob;
}

export class ImportError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'ImportError';
    this.detail = detail;
  }
}

/* ------------------------------------------------------------- file read */

export interface ReadFile {
  name: string;
  size: number;
  type: string;
  text?: string;
  file: File;
}

const TEXT_EXTENSIONS = /\.(json|txt|md|markdown|jsonl|card|yaml|yml)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;

export async function readFile(file: File): Promise<ReadFile> {
  const base: ReadFile = { name: file.name, size: file.size, type: file.type, file };
  if (file.size > 64 * 1024 * 1024) {
    throw new ImportError(
      `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB, which is too large to import.`,
    );
  }
  if (IMAGE_EXTENSIONS.test(file.name) || file.type.startsWith('image/')) return base;
  if (!TEXT_EXTENSIONS.test(file.name) && file.type && !file.type.startsWith('text/') && file.type !== 'application/json') {
    throw new ImportError(
      `"${file.name}" is a ${file.type || 'unknown'} file. Import accepts JSON, TXT and image files.`,
    );
  }
  try {
    base.text = await file.text();
  } catch (err) {
    throw new ImportError(`Could not read "${file.name}".`, (err as Error).message);
  }
  return base;
}

/* --------------------------------------------------------------- detect */

export function detectKind(value: unknown, filename = ''): { kind: ImportKind; format: string } {
  if (Array.isArray(value)) {
    const first = value[0];
    if (isPlainObject(first)) {
      if ('keys' in first || 'key' in first || 'primaryKeys' in first || 'keywords' in first) {
        return { kind: 'lorebook', format: 'entry array' };
      }
      if ('first_mes' in first || 'personality' in first || 'char_name' in first) {
        return { kind: 'character', format: 'character array' };
      }
    }
    return { kind: 'unknown', format: 'array' };
  }

  if (!isPlainObject(value)) return { kind: 'unknown', format: 'scalar' };

  // Our own documents. parseJson handles these before detection is reached;
  // detectKind still answers for them because callers use it for previews.
  if (value.format === NEXUS_FORMAT && typeof value.kind === 'string') {
    const kind = (value.kind === 'mixed' ? 'backup' : value.kind) as ImportKind;
    if (IMPORT_KIND_LABELS[kind]) return { kind, format: 'Nexus document' };
  }
  if (value.format === LEGACY_FORMAT && typeof value.kind === 'string') {
    const kind = value.kind as ImportKind;
    if (IMPORT_KIND_LABELS[kind]) return { kind, format: 'Nexus export (pre-schema)' };
  }

  // A raw backup body.
  if (
    Array.isArray(value.characters) &&
    Array.isArray(value.stories) &&
    (Array.isArray(value.lorebooks) || Array.isArray(value.chats))
  ) {
    return { kind: 'backup', format: 'backup body' };
  }

  if (typeof value.spec === 'string' && String(value.spec).startsWith('chara_card')) {
    return { kind: 'character', format: `SillyTavern ${value.spec}` };
  }

  if (isPlainObject(value.character) || isPlainObject(value.char)) {
    return { kind: 'character', format: 'wrapped character' };
  }

  if (value.entries !== undefined && (Array.isArray(value.entries) || isPlainObject(value.entries))) {
    return { kind: 'lorebook', format: 'lorebook / world info' };
  }
  if (isPlainObject(value.originalData) || value.lore) {
    return { kind: 'lorebook', format: 'world info' };
  }

  if (
    'first_mes' in value ||
    'firstMes' in value ||
    'char_name' in value ||
    'char_persona' in value ||
    'mes_example' in value ||
    ('personality' in value && 'name' in value)
  ) {
    return { kind: 'character', format: 'character card v1' };
  }

  if (Array.isArray(value.messages) && value.messages.length) {
    return { kind: 'chat', format: 'chat log' };
  }

  if ('scenario' in value && ('title' in value || 'premise' in value)) {
    return { kind: 'story', format: 'story' };
  }

  if (
    ('content' in value || 'entry' in value) &&
    ('keys' in value || 'key' in value || 'keywords' in value)
  ) {
    return { kind: 'lore-entry', format: 'single lore entry' };
  }

  if ('customInstructions' in value || 'speechStyle' in value || 'isDefault' in value) {
    return { kind: 'persona', format: 'persona' };
  }

  if ('title' in value && 'content' in value && ('importance' in value || 'pinned' in value)) {
    return { kind: 'memory', format: 'memory' };
  }

  if ('name' in value && ('description' in value || 'personality' in value)) {
    return { kind: 'character', format: 'loose character-like object' };
  }

  if (/lorebook|world|lore/i.test(filename)) return { kind: 'lorebook', format: 'guessed by filename' };

  return { kind: 'unknown', format: 'unrecognised JSON' };
}

/* ---------------------------------------------------------------- parse */

/**
 * Unwraps a pre-schema envelope for the foreign-format builders.
 *
 * `parseJson` lifts our own envelopes into documents before it gets this far,
 * so this only fires for a file that carries the old marker with a payload
 * shape `fromLegacyEnvelope` did not recognise — a hand-edited export, most
 * likely, which is better handled by the detectors than rejected.
 */
function unwrapEnvelope(value: unknown): unknown {
  if (isPlainObject(value) && value.format === LEGACY_FORMAT && 'data' in value) {
    return value.data;
  }
  return value;
}

export async function parseFile(read: ReadFile): Promise<ParsedImport> {
  const isImage = IMAGE_EXTENSIONS.test(read.name) || read.type.startsWith('image/');
  if (isImage) return parseImage(read);

  const text = read.text ?? '';
  if (!text.trim()) throw new ImportError(`"${read.name}" is empty.`);

  const looksJson = /^\s*[[{]/.test(text);
  if (!looksJson) return parseText(read, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = (err as Error).message;
    const position = /position (\d+)/.exec(message)?.[1];
    const near = position
      ? ` Near: "${truncate(text.slice(Math.max(0, Number(position) - 40), Number(position) + 40), 90)}"`
      : '';
    throw new ImportError(`"${read.name}" is not valid JSON. ${message}.${near}`);
  }

  return parseJson(parsed, read.name);
}

export async function parseJson(input: unknown, sourceName: string): Promise<ParsedImport> {
  // Anything Nexus wrote goes through one reader, whatever it is about. The
  // per-kind builders below exist for foreign formats — cards, world-info
  // dumps, chat logs — which is the only place shape-guessing belongs.
  const own = isNexusDocument(input)
    ? { doc: input, format: 'Nexus document' }
    : (() => {
        const lifted = fromLegacyEnvelope(input);
        return lifted ? { doc: lifted, format: 'Nexus export (pre-schema)' } : null;
      })();
  if (own) return buildNexusImport(own.doc, sourceName, own.format);

  const detected = detectKind(input, sourceName);
  const body = unwrapEnvelope(input);

  switch (detected.kind) {
    case 'character':
      return buildCharacterImport(body, sourceName, detected.format);
    case 'persona':
      return buildPersonaImport(body, sourceName, detected.format);
    case 'lorebook':
      return buildLorebookImport(body, sourceName, detected.format);
    case 'lore-entry':
      return buildLoreEntryImport(body, sourceName, detected.format);
    case 'story':
      return buildStoryImport(body, sourceName, detected.format);
    case 'chat':
      return buildChatImport(body, sourceName, detected.format);
    case 'memory':
      return buildMemoryImport(body, sourceName, detected.format);
    case 'backup':
      return buildBackupImport(body, sourceName, detected.format);
    default:
      throw new ImportError(
        `Could not work out what "${sourceName}" contains.`,
        'Expected a character, persona, lorebook, story, chat, memory or backup file. ' +
          'If this is a plain text file, rename it to .txt and import it again to choose a type manually.',
      );
  }
}

/* -------------------------------------------------- our own documents */

const COLLECTION_LABELS: Partial<Record<CollectionKey, string>> = {
  characters: 'characters',
  personas: 'personas',
  lorebooks: 'lorebooks',
  loreEntries: 'lore entries',
  stories: 'stories',
  chats: 'chats',
  branches: 'branches',
  messages: 'messages',
  alternatives: 'alternatives',
  checkpoints: 'checkpoints',
  memories: 'memories',
  storySummaries: 'story summaries',
  sceneDeltas: 'scene changes',
  providers: 'text providers (keys not included)',
  imageProviders: 'image providers (keys not included)',
};

/**
 * Fills a document's rows out to complete records.
 *
 * A document's collections are the app's own row types, so they are used as
 * they are — running them back through the card normalisers would be actively
 * destructive, since those rebuild a character from `first_mes` and card keys
 * and know nothing about a `greetings` array, an id, or a lorebook link.
 *
 * They still cannot be trusted to be *complete*: a hand-written or truncated
 * document may be missing fields the rest of the app reads without checking.
 * Layering each row over its factory default costs nothing for a real export
 * (every key is already present and wins) and makes a partial one safe.
 */
function hydrate(key: CollectionKey, rows: Array<Record<string, unknown>>): unknown[] {
  switch (key) {
    case 'characters':
      return rows.map((row) => ({ ...newCharacter(), ...row }));
    case 'personas':
      return rows.map((row) => ({ ...newPersona(), ...row }));
    case 'stories':
      return rows.map((row) => ({ ...newStory(), ...row }));
    case 'lorebooks':
      return rows.map((row) => ({ ...newLorebook(), ...row }));
    case 'loreEntries':
      return rows.map((row) => ({
        ...newLoreEntry(String(row.lorebookId ?? '')),
        ...row,
      }));
    case 'memories':
      return rows.map((row) => ({ ...newMemory(), ...row }));
    case 'chats':
      return rows.map((row) => ({ ...newChat(), ...row }));
    case 'branches':
      return rows.map((row) => ({ ...newBranch(String(row.chatId ?? '')), ...row }));
    case 'messages':
      return rows.map((row) => ({
        ...newMessage(String(row.chatId ?? ''), String(row.branchId ?? ''), {
          role: (row.role as Message['role']) ?? 'assistant',
        }),
        ...row,
      }));
    default:
      // Alternatives, checkpoints, summaries and providers are structural rows
      // that only ever appear in a document this app wrote.
      return rows;
  }
}

/** The name to show for a document that is about one thing. */
function subjectTitle(doc: NexusDocument): string {
  const byId = <T extends { id: ID }>(rows: T[] | undefined) =>
    rows?.find((r) => r.id === doc.primaryId) ?? rows?.[0];
  switch (doc.kind) {
    case 'character':
      return byId(doc.characters)?.name || 'Character';
    case 'persona':
      return byId(doc.personas)?.name || 'Persona';
    case 'lorebook':
      return byId(doc.lorebooks)?.name || 'Lorebook';
    case 'lore-entry':
      return byId(doc.loreEntries)?.name || 'Lorebook entry';
    case 'story':
      return byId(doc.stories)?.title || 'Story';
    case 'chat':
      return byId(doc.chats)?.title || 'Chat';
    case 'memory':
      return doc.memories?.length === 1 ? doc.memories[0].title || 'Memory' : `${doc.memories?.length ?? 0} memories`;
    case 'backup':
      return 'Full backup';
    default:
      return 'Nexus document';
  }
}

/**
 * Reads a Nexus document — every export this app has ever written, once the
 * pre-schema envelopes have been lifted (see `schema/nexus.ts`).
 *
 * There is deliberately no shape-guessing here. The collections are already
 * the app's own rows, so the work is limited to summarising them, pulling a
 * single subject's avatar back out of `media`, and re-running the warnings
 * that are worth showing before a commit.
 */
async function buildNexusImport(
  doc: NexusDocument,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  const kind: ImportKind = doc.kind === 'mixed' ? 'backup' : doc.kind;

  const payload: ImportPayload = {};
  for (const key of COLLECTION_KEYS) {
    const rows = doc[key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (rows?.length) (payload as any)[key] = hydrate(key, rows as any[]);
  }
  if (doc.media && Object.keys(doc.media).length) payload.media = doc.media;
  if (doc.settings) payload.settings = doc.settings;

  // A single character or persona needs its avatar bytes even when the media
  // id in the file means nothing on this install.
  const avatar = subjectAvatar(doc);
  if (avatar) payload.avatarDataUrl = avatar;
  else {
    const subject = doc.characters?.length === 1 ? doc.characters[0] : null;
    if (subject?.avatarUrl?.startsWith('data:')) {
      payload.avatarDataUrl = subject.avatarUrl;
      subject.avatarUrl = '';
    }
  }

  const summary = documentCounts(doc)
    .filter((row) => COLLECTION_LABELS[row.key])
    .map((row) => `${row.count} ${COLLECTION_LABELS[row.key]}`);
  const images = Object.keys(payload.media ?? {}).length;
  if (images) summary.push(`${images} bundled images`);

  const result: ParsedImport = {
    ...base(kind, sourceName, format),
    title: subjectTitle(doc),
    summary: summary.length ? summary : ['Nothing to import.'],
    payload,
  };

  validateCharacters(result);

  if (!summary.length) {
    result.issues.push({ level: 'error', message: 'This file appears to contain no data.' });
  }
  if (doc.mediaMeta?.length && !images) {
    result.issues.push({
      level: 'warning',
      message:
        'This backup was created without bundled images. Characters and stories will restore, but their pictures will be missing.',
    });
  }
  if ([...(doc.providers ?? []), ...(doc.imageProviders ?? [])].some((p) => !p.apiKey)) {
    result.issues.push({
      level: 'info',
      message: 'API keys are never included in backups — re-enter them in Settings after restoring.',
    });
  }
  return result;
}

function base(kind: ImportKind, sourceName: string, sourceFormat: string): Omit<ParsedImport, 'payload' | 'title' | 'summary'> {
  return {
    id: uid('imp_'),
    kind,
    sourceName,
    sourceFormat,
    issues: [],
    conflicts: [],
  };
}

async function buildCharacterImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  // Nexus envelope shape: { character, avatar?, lorebooks? }
  const wrapper = isPlainObject(body) && isPlainObject(body.character) ? body : null;
  const source = wrapper ? wrapper.character : body;

  if (Array.isArray(body)) {
    const characters = body.map((item) => normalizeCharacter(item));
    const result: ParsedImport = {
      ...base('character', sourceName, format),
      title: `${characters.length} characters`,
      summary: characters.map((c) => `${c.name} — ${truncate(c.shortDescription || c.description, 70) || 'no description'}`),
      payload: { characters },
    };
    validateCharacters(result);
    return result;
  }

  const character = normalizeCharacter(source);
  const payload: ImportPayload = { characters: [character] };

  if (wrapper && typeof wrapper.avatar === 'string' && wrapper.avatar.startsWith('data:')) {
    payload.avatarDataUrl = wrapper.avatar;
  } else if (character.avatarUrl.startsWith('data:')) {
    payload.avatarDataUrl = character.avatarUrl;
    character.avatarUrl = '';
  }

  const embedded = extractEmbeddedLorebook(source);
  if (embedded) {
    payload.lorebooks = [{ ...embedded.lorebook, name: embedded.lorebook.name || `${character.name} lore` }];
    payload.loreEntries = embedded.entries;
    character.lorebookIds = [embedded.lorebook.id];
  }
  if (wrapper && Array.isArray(wrapper.lorebooks)) {
    payload.lorebooks = payload.lorebooks ?? [];
    payload.loreEntries = payload.loreEntries ?? [];
    for (const item of wrapper.lorebooks) {
      if (!isPlainObject(item) || !isPlainObject(item.lorebook)) continue;
      payload.lorebooks.push(item.lorebook as unknown as Lorebook);
      if (Array.isArray(item.entries)) payload.loreEntries.push(...(item.entries as LoreEntry[]));
    }
  }

  const result: ParsedImport = {
    ...base('character', sourceName, format),
    title: character.name,
    summary: buildCharacterSummary(character, payload),
    payload,
  };
  validateCharacters(result);
  return result;
}

function buildCharacterSummary(character: Character, payload: ImportPayload): string[] {
  const lines = [
    character.shortDescription || truncate(character.description, 120) || 'No description.',
    `${character.greetings.length} greeting${character.greetings.length === 1 ? '' : 's'}`,
  ];
  if (character.tags.length) lines.push(`Tags: ${character.tags.join(', ')}`);
  if (character.exampleDialogue.trim()) lines.push('Includes example dialogue');
  if (character.customFields.length) {
    lines.push(`${character.customFields.length} unrecognised field(s) preserved as custom fields`);
  }
  if (payload.avatarDataUrl) lines.push('Includes an embedded avatar image');
  if (payload.lorebooks?.length) {
    lines.push(
      `Includes ${payload.lorebooks.length} lorebook(s) with ${payload.loreEntries?.length ?? 0} entries`,
    );
  }
  return lines;
}

function validateCharacters(result: ParsedImport): void {
  for (const character of result.payload.characters ?? []) {
    if (!character.name.trim() || character.name === 'Unnamed Character') {
      result.issues.push({
        level: 'warning',
        message: 'No name was found in the file — it will be imported as "Unnamed Character". You can rename it after import.',
      });
    }
    if (!character.description.trim() && !character.personality.trim()) {
      result.issues.push({
        level: 'warning',
        message: `"${character.name}" has no description or personality; the AI will have very little to work with.`,
      });
    }
    if (!character.greetings.length) {
      result.issues.push({
        level: 'info',
        message: `"${character.name}" has no greeting. Chats will start empty.`,
      });
    }
  }
}

async function buildPersonaImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  const wrapper = isPlainObject(body) && isPlainObject(body.persona) ? body : null;
  const source = wrapper ? wrapper.persona : body;
  const persona = normalizePersona(source);
  const payload: ImportPayload = { personas: [persona] };
  if (wrapper && typeof wrapper.avatar === 'string' && wrapper.avatar.startsWith('data:')) {
    payload.avatarDataUrl = wrapper.avatar;
  } else if (persona.avatarUrl.startsWith('data:')) {
    payload.avatarDataUrl = persona.avatarUrl;
    persona.avatarUrl = '';
  }

  const result: ParsedImport = {
    ...base('persona', sourceName, format),
    title: persona.name,
    summary: [
      truncate(persona.personality, 120) || 'No personality text.',
      persona.traits.length ? `Traits: ${persona.traits.join(', ')}` : '',
      persona.customInstructions ? 'Includes custom instructions' : '',
      payload.avatarDataUrl ? 'Includes an embedded avatar image' : '',
    ].filter(Boolean),
    payload,
  };
  if (!persona.name.trim() || persona.name === 'Unnamed Persona') {
    result.issues.push({ level: 'warning', message: 'No name found; importing as "Unnamed Persona".' });
  }
  return result;
}

async function buildLorebookImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  // Nexus envelope: { lorebook, entries }
  if (isPlainObject(body) && isPlainObject(body.lorebook) && Array.isArray(body.entries)) {
    const lorebook = body.lorebook as unknown as Lorebook;
    const entries = (body.entries as LoreEntry[]).map((entry) =>
      normalizeLoreEntry(entry, lorebook.id),
    );
    // Preserve the exported ids so re-import round-trips cleanly.
    (body.entries as LoreEntry[]).forEach((original, i) => {
      if (original && typeof original.id === 'string') entries[i].id = original.id;
    });
    const result: ParsedImport = {
      ...base('lorebook', sourceName, format),
      title: lorebook.name || 'Imported Lorebook',
      summary: summarizeLorebook(entries),
      payload: { lorebooks: [lorebook], loreEntries: entries },
    };
    validateLore(result);
    return result;
  }

  const { lorebook, entries } = normalizeLorebook(body);
  if (!lorebook.name.trim()) lorebook.name = sourceName.replace(/\.[^.]+$/, '');
  const result: ParsedImport = {
    ...base('lorebook', sourceName, format),
    title: lorebook.name,
    summary: summarizeLorebook(entries),
    payload: { lorebooks: [lorebook], loreEntries: entries },
  };
  validateLore(result);
  return result;
}

function summarizeLorebook(entries: LoreEntry[]): string[] {
  const lines = [`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`];
  for (const entry of entries.slice(0, 8)) {
    lines.push(
      `${entry.name || 'Untitled'} — keys: ${entry.primaryKeys.join(', ') || '(none)'} · ${truncate(
        entry.content,
        60,
      )}`,
    );
  }
  if (entries.length > 8) lines.push(`…and ${entries.length - 8} more`);
  return lines;
}

function validateLore(result: ParsedImport): void {
  const entries = result.payload.loreEntries ?? [];
  if (!entries.length) {
    result.issues.push({
      level: 'error',
      message: 'No usable entries were found. A lorebook needs at least one entry with content.',
    });
    return;
  }
  const keyless = entries.filter((e) => !e.primaryKeys.length && e.activation === 'keyword');
  if (keyless.length) {
    result.issues.push({
      level: 'warning',
      message: `${keyless.length} entr${keyless.length === 1 ? 'y has' : 'ies have'} no keywords and will never trigger until you add some (or set them to Always Active).`,
    });
  }
  const empty = entries.filter((e) => !e.content.trim());
  if (empty.length) {
    result.issues.push({
      level: 'warning',
      message: `${empty.length} entr${empty.length === 1 ? 'y has' : 'ies have'} no content.`,
    });
  }
}

async function buildLoreEntryImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  const source = isPlainObject(body) && isPlainObject(body.entry) ? body.entry : body;
  const placeholder = newLorebook({ name: `Imported: ${sourceName.replace(/\.[^.]+$/, '')}` });
  const entry = normalizeLoreEntry(source, placeholder.id);
  return {
    ...base('lore-entry', sourceName, format),
    title: entry.name || 'Lore entry',
    summary: [
      `Keys: ${entry.primaryKeys.join(', ') || '(none)'}`,
      truncate(entry.content, 160) || 'No content.',
    ],
    payload: { lorebooks: [placeholder], loreEntries: [entry] },
  };
}

async function buildStoryImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  const wrapper = isPlainObject(body) && isPlainObject(body.story) ? body : null;
  const story = normalizeStory(wrapper ? wrapper.story : body);
  if (wrapper && isPlainObject(wrapper.story)) {
    // Preserve richer fields from our own export.
    const raw = wrapper.story as Partial<Story>;
    story.settings = raw.settings ?? {};
    story.memoryIds = raw.memoryIds ?? [];
  }

  const payload: ImportPayload = { stories: [story] };
  const summary: string[] = [
    truncate(story.description, 120) || 'No description.',
    story.scenario ? `Scenario: ${truncate(story.scenario, 90)}` : '',
  ].filter(Boolean);

  if (wrapper) {
    if (Array.isArray(wrapper.characters)) {
      payload.characters = (wrapper.characters as unknown[]).map((c) => {
        const character = normalizeCharacter(c);
        if (isPlainObject(c) && typeof c.id === 'string') character.id = c.id;
        return character;
      });
      story.characters = payload.characters.map((c, i) => ({
        characterId: c.id,
        primary: i === 0,
        note: '',
        enabled: true,
      }));
      summary.push(`${payload.characters.length} character(s) bundled`);
    }
    if (isPlainObject(wrapper.persona)) {
      const persona = normalizePersona(wrapper.persona);
      const rawPersonaId = (wrapper.persona as Record<string, unknown>).id;
      if (typeof rawPersonaId === 'string') persona.id = rawPersonaId;
      payload.personas = [persona];
      story.personaId = persona.id;
      summary.push(`Persona: ${persona.name}`);
    }
    if (Array.isArray(wrapper.lorebooks)) {
      payload.lorebooks = [];
      payload.loreEntries = [];
      for (const item of wrapper.lorebooks) {
        if (!isPlainObject(item)) continue;
        if (isPlainObject(item.lorebook)) {
          payload.lorebooks.push(item.lorebook as unknown as Lorebook);
          if (Array.isArray(item.entries)) {
            payload.loreEntries.push(...(item.entries as LoreEntry[]));
          }
        }
      }
      story.lorebookIds = payload.lorebooks.map((b) => b.id);
      summary.push(`${payload.lorebooks.length} lorebook(s), ${payload.loreEntries.length} entries`);
    }
    if (Array.isArray(wrapper.memories)) {
      payload.memories = (wrapper.memories as Memory[]).map((m) => ({ ...newMemory(), ...m }));
      summary.push(`${payload.memories.length} memories`);
    }
    if (Array.isArray(wrapper.chats)) {
      payload.chats = [];
      payload.branches = [];
      payload.messages = [];
      payload.alternatives = [];
      payload.checkpoints = [];
      for (const item of wrapper.chats) {
        if (!isPlainObject(item)) continue;
        if (isPlainObject(item.chat)) payload.chats.push(item.chat as unknown as Chat);
        if (Array.isArray(item.branches)) payload.branches.push(...(item.branches as Branch[]));
        if (Array.isArray(item.messages)) payload.messages.push(...(item.messages as Message[]));
        if (Array.isArray(item.alternatives)) {
          payload.alternatives.push(...(item.alternatives as MessageAlternative[]));
        }
        if (Array.isArray(item.checkpoints)) {
          payload.checkpoints.push(...(item.checkpoints as Checkpoint[]));
        }
      }
      summary.push(`${payload.chats.length} chat(s), ${payload.messages.length} messages`);
    }
    if (isPlainObject(wrapper.media)) payload.media = wrapper.media as Record<ID, string>;
  }

  const result: ParsedImport = {
    ...base('story', sourceName, format),
    title: story.title,
    summary,
    payload,
  };
  if (!story.title.trim()) {
    result.issues.push({ level: 'warning', message: 'The story has no title; it will import as "Imported Story".' });
    story.title = 'Imported Story';
  }
  return result;
}

async function buildChatImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  // Our own export shape.
  if (isPlainObject(body) && isPlainObject(body.chat) && Array.isArray(body.messages)) {
    const chat = body.chat as unknown as Chat;
    const payload: ImportPayload = {
      chats: [chat],
      branches: (body.branches as Branch[]) ?? [],
      messages: body.messages as Message[],
      alternatives: (body.alternatives as MessageAlternative[]) ?? [],
      checkpoints: (body.checkpoints as Checkpoint[]) ?? [],
      media: isPlainObject(body.media) ? (body.media as Record<ID, string>) : undefined,
    };
    if (!payload.branches?.length) {
      const branch = newBranch(chat.id, { id: chat.activeBranchId || uid() });
      chat.activeBranchId = branch.id;
      payload.branches = [branch];
      payload.messages = (payload.messages ?? []).map((m) => ({ ...m, branchId: branch.id }));
    }
    return {
      ...base('chat', sourceName, format),
      title: chat.title || 'Imported chat',
      summary: [
        `${payload.messages?.length ?? 0} messages`,
        `${payload.branches?.length ?? 0} branch(es)`,
        payload.checkpoints?.length ? `${payload.checkpoints.length} checkpoint(s)` : '',
      ].filter(Boolean),
      payload,
    };
  }

  // Generic { messages: [...] } log.
  const rawMessages = isPlainObject(body) && Array.isArray(body.messages) ? body.messages : [];
  const chat = newChat({
    title: firstOf(isPlainObject(body) ? body.title : '', sourceName.replace(/\.[^.]+$/, '')) || 'Imported chat',
  });
  const branch = newBranch(chat.id);
  chat.activeBranchId = branch.id;
  const messages: Message[] = [];
  /** Speaker name per imported assistant message, where the file named one. */
  const speakerOf = new Map<ID, string>();
  let order = 0;
  /** Keys seen on the first message, reported when no speaker can be found. */
  let sampleKeys: string[] = [];
  for (const raw of rawMessages) {
    if (!isPlainObject(raw)) continue;
    if (!sampleKeys.length) sampleKeys = Object.keys(raw);
    // Exports disagree about what to call the speaker, so try every spelling
    // seen in the wild before giving up. None of this parses prose — it only
    // reads fields the file already provides.
    const named = firstOf(
      raw.name,
      raw.sender,
      raw.from,
      raw.character,
      raw.char_name,
      raw.characterName,
      raw.author,
      raw.speaker,
      raw.speakerName,
      raw.bot_name,
      raw.botName,
      raw.participant,
      raw.persona,
    );
    // A boolean side-marker is the other common shape, and it decides the role
    // even when the file also names the speaker.
    const flagged =
      typeof raw.is_user === 'boolean'
        ? raw.is_user
        : typeof raw.isUser === 'boolean'
          ? raw.isUser
          : typeof raw.user === 'boolean'
            ? raw.user
            : null;
    const roleRaw = firstOf(raw.role, raw.sender, raw.from, raw.name).toLowerCase();
    const role: Message['role'] =
      flagged === true
        ? 'user'
        : flagged === false
          ? 'assistant'
          : roleRaw === 'user' || roleRaw === 'human'
            ? 'user'
            : roleRaw === 'system'
              ? 'system'
              : 'assistant';
    const content = firstOf(raw.content, raw.text, raw.message, raw.mes, raw.body, raw.value);
    if (!content.trim()) continue;
    const message = newMessage(chat.id, branch.id, { role, content, order });
    // An imported log is a record of play that already happened. Saying so is
    // what stops the compiler reading it as the assistant's own latest turn and
    // imitating it wholesale, lines for the user included.
    message.historical = true;
    // The export's own speaker field, not a guess parsed out of the prose. A
    // name that merely restates the role carries no information.
    if (role === 'assistant' && named && !ROLE_WORDS.has(named.toLowerCase())) {
      speakerOf.set(message.id, named.trim());
    }
    messages.push(message);
    order += 1;
  }
  chat.orderCounter = order;

  // A chat used to arrive with no cast at all: no character, no story, no
  // scene. The compiler then had nothing to describe and nobody to place in the
  // room, so the model reconstructed the character from prose alone — which is
  // as generic as it sounds. Where the file names its speakers, they become
  // real characters the user can then flesh out.
  const characters: Character[] = [];
  const byName = new Map<string, Character>();
  for (const name of speakerOf.values()) {
    if (byName.has(name.toLowerCase())) continue;
    const character = newCharacter({ name });
    byName.set(name.toLowerCase(), character);
    characters.push(character);
  }
  for (const message of messages) {
    const name = speakerOf.get(message.id);
    if (!name) continue;
    message.characterId = byName.get(name.toLowerCase())?.id ?? null;
    // The file named a speaker for this message, so its content is that one
    // character's turn rather than a scene containing several. That is what
    // lets the compiler put the name back on the wire.
    if (message.characterId) message.speakerScope = 'turn';
  }

  const stories: Story[] = [];
  if (characters.length) {
    // Whoever speaks most is the focal character, and whoever speaks in the
    // closing stretch is who the scene is currently with.
    const counts = new Map<ID, number>();
    for (const message of messages) {
      if (!message.characterId) continue;
      counts.set(message.characterId, (counts.get(message.characterId) ?? 0) + 1);
    }
    const primaryId =
      [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? characters[0].id;
    const recent = new Set(
      messages
        .slice(-12)
        .map((m) => m.characterId)
        .filter((id): id is ID => Boolean(id)),
    );
    if (!recent.size) recent.add(primaryId);

    const story = newStory({
      title: chat.title,
      description: `Imported from ${sourceName}.`,
      characters: characters.map((c) => ({
        characterId: c.id,
        primary: c.id === primaryId,
        note: '',
        enabled: true,
      })),
    });
    story.defaultChatId = chat.id;
    stories.push(story);
    chat.storyId = story.id;
    chat.scene = {
      ...emptyScene(),
      presentCharacterIds: [...recent],
      primaryCharacterId: primaryId,
      updatedAt: Date.now(),
    };
  }

  const result: ParsedImport = {
    ...base('chat', sourceName, format),
    title: chat.title,
    summary: [
      `${messages.length} messages`,
      characters.length
        ? `${characters.length} character(s) named in the file: ${characters
            .map((c) => c.name)
            .join(', ')}`
        : 'No speaker names in the file — add a character and set the scene after importing',
    ],
    payload: { chats: [chat], branches: [branch], messages, characters, stories },
  };
  if (!messages.length) {
    result.issues.push({ level: 'error', message: 'No messages could be read from this file.' });
  }
  if (!characters.length && messages.length) {
    result.issues.push({
      level: 'warning',
      message:
        'This file does not name who is speaking, so no characters could be created. ' +
        'The chat will import, but until you add a character and put them in the scene the ' +
        'model has no description of who it is playing.' +
        (sampleKeys.length
          ? ` Each message carries: ${sampleKeys.join(', ')}.`
          : ''),
    });
  }
  return result;
}

/** Words that name a role rather than a speaker. */
const ROLE_WORDS = new Set(['user', 'human', 'assistant', 'system', 'bot', 'ai', 'model', 'char']);

async function buildMemoryImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  const source = isPlainObject(body) && isPlainObject(body.memory) ? body.memory : body;
  const list = isPlainObject(body) && Array.isArray(body.memories) ? body.memories : [source];
  const memories = list
    .filter(isPlainObject)
    .map((raw) =>
      newMemory({
        ...(raw as Partial<Memory>),
        title: firstOf(raw.title, raw.name) || 'Imported memory',
        content: firstOf(raw.content, raw.text),
        tags: toStringList(raw.tags),
      }),
    )
    .filter((m) => m.content.trim());

  const result: ParsedImport = {
    ...base('memory', sourceName, format),
    title: memories.length === 1 ? memories[0].title : `${memories.length} memories`,
    summary: memories.slice(0, 8).map((m) => `${m.title} — ${truncate(m.content, 70)}`),
    payload: { memories },
  };
  if (!memories.length) {
    result.issues.push({ level: 'error', message: 'No memories with content were found.' });
  }
  return result;
}

async function buildBackupImport(
  body: unknown,
  sourceName: string,
  format: string,
): Promise<ParsedImport> {
  if (!isPlainObject(body)) throw new ImportError('The backup file is malformed.');

  const payload: ImportPayload = {
    characters: (body.characters as Character[]) ?? [],
    personas: (body.personas as Persona[]) ?? [],
    stories: (body.stories as Story[]) ?? [],
    chats: (body.chats as Chat[]) ?? [],
    branches: (body.branches as Branch[]) ?? [],
    messages: (body.messages as Message[]) ?? [],
    alternatives: (body.alternatives as MessageAlternative[]) ?? [],
    checkpoints: (body.checkpoints as Checkpoint[]) ?? [],
    memories: (body.memories as Memory[]) ?? [],
    lorebooks: (body.lorebooks as Lorebook[]) ?? [],
    loreEntries: (body.loreEntries as LoreEntry[]) ?? [],
    providers: (body.providers as Provider[]) ?? [],
    imageProviders: (body.imageProviders as ImageProvider[]) ?? [],
    storySummaries: (body.storySummaries as StorySummary[]) ?? [],
    sceneDeltas: (body.sceneDeltas as SceneDelta[]) ?? [],
    settings: isPlainObject(body.settings) ? (body.settings as unknown as Settings) : undefined,
    media: isPlainObject(body.media) ? (body.media as Record<ID, string>) : undefined,
  };

  const counts: string[] = [
    `${payload.characters!.length} characters`,
    `${payload.personas!.length} personas`,
    `${payload.stories!.length} stories`,
    `${payload.chats!.length} chats`,
    `${payload.messages!.length} messages`,
    `${payload.alternatives!.length} alternatives`,
    `${payload.branches!.length} branches`,
    `${payload.checkpoints!.length} checkpoints`,
    `${payload.memories!.length} memories`,
    `${payload.lorebooks!.length} lorebooks`,
    `${payload.loreEntries!.length} lore entries`,
    `${Object.keys(payload.media ?? {}).length} bundled images`,
    `${payload.storySummaries!.length} story summaries`,
    `${payload.providers!.length} text providers (keys not included)`,
    `${payload.imageProviders!.length} image providers (keys not included)`,
  ];

  const result: ParsedImport = {
    ...base('backup', sourceName, format),
    title: 'Full backup',
    summary: counts,
    payload,
  };

  const total =
    payload.characters!.length + payload.personas!.length + payload.stories!.length + payload.chats!.length;
  if (!total) {
    result.issues.push({ level: 'error', message: 'This backup appears to contain no data.' });
  }
  const mediaMissing =
    Array.isArray(body.mediaMeta) &&
    (body.mediaMeta as unknown[]).length > 0 &&
    !Object.keys(payload.media ?? {}).length;
  if (mediaMissing) {
    result.issues.push({
      level: 'warning',
      message:
        'This backup was created without bundled images. Characters and stories will restore, but their pictures will be missing.',
    });
  }
  if ([...payload.providers!, ...payload.imageProviders!].some((p) => !p.apiKey)) {
    result.issues.push({
      level: 'info',
      message: 'API keys are never included in backups — re-enter them in Settings after restoring.',
    });
  }
  return result;
}

/* ------------------------------------------------------------ txt / png */

async function parseText(read: ReadFile, text: string): Promise<ParsedImport> {
  const result = await buildFromText(text, read.name, 'character');
  result.needsKindChoice = true;
  result.rawText = text;
  result.sourceFormat = 'plain text';
  result.issues.unshift({
    level: 'info',
    message: 'Choose what this text file should become, then review the preview below before importing.',
  });
  return result;
}

/** Re-parses raw TXT into the requested entity kind. */
export async function buildFromText(
  text: string,
  sourceName: string,
  kind: ImportKind,
): Promise<ParsedImport> {
  const clean = text.replace(/\r\n/g, '\n').trim();
  const baseName = sourceName.replace(/\.[^.]+$/, '').trim() || 'Imported';
  const lines = clean.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  // A short first line followed by a blank line reads as a title.
  const hasTitleLine = firstLine.length > 0 && firstLine.length <= 80 && (lines[1] ?? '').trim() === '';
  const title = hasTitleLine ? firstLine.replace(/^#+\s*/, '') : baseName;
  const bodyText = hasTitleLine ? lines.slice(1).join('\n').trim() : clean;

  const result: Omit<ParsedImport, 'payload' | 'title' | 'summary'> = {
    ...base(kind, sourceName, 'plain text'),
    rawText: text,
    needsKindChoice: true,
  };

  switch (kind) {
    case 'persona': {
      const persona = newPersona({ name: title, personality: bodyText });
      return {
        ...result,
        title: persona.name,
        summary: [`Persona "${persona.name}"`, truncate(bodyText, 160)],
        payload: { personas: [persona] },
      };
    }
    case 'lore-entry': {
      const lorebook = newLorebook({ name: `Imported: ${baseName}` });
      const entry = newLoreEntry(lorebook.id, {
        name: title,
        content: bodyText,
        primaryKeys: [title].filter(Boolean),
      });
      return {
        ...result,
        title: entry.name,
        summary: [
          `Lore entry in a new lorebook "${lorebook.name}"`,
          `Keys: ${entry.primaryKeys.join(', ') || '(none — add some after import)'}`,
          truncate(bodyText, 160),
        ],
        payload: { lorebooks: [lorebook], loreEntries: [entry] },
      };
    }
    case 'story': {
      const story = newStory({ title, description: truncate(bodyText, 400), scenario: bodyText });
      return {
        ...result,
        title: story.title,
        summary: [`Story "${story.title}"`, truncate(bodyText, 160)],
        payload: { stories: [story] },
      };
    }
    case 'chat': {
      const chat = newChat({ title });
      const branch = newBranch(chat.id);
      chat.activeBranchId = branch.id;
      const messages = parseTranscript(clean, chat.id, branch.id);
      chat.orderCounter = messages.length;
      const parsed: ParsedImport = {
        ...result,
        title: chat.title,
        summary: [`Chat "${chat.title}"`, `${messages.length} message(s) detected`],
        payload: { chats: [chat], branches: [branch], messages },
      };
      if (!messages.length) {
        parsed.issues.push({
          level: 'warning',
          message:
            'No "Speaker: line" structure was found, so the whole file was imported as a single message.',
        });
      }
      return parsed;
    }
    case 'memory': {
      const memory = newMemory({ title, content: bodyText });
      return {
        ...result,
        title: memory.title,
        summary: [`Memory "${memory.title}"`, truncate(bodyText, 160)],
        payload: { memories: [memory] },
      };
    }
    case 'character':
    default: {
      const character = newCharacter({
        name: title,
        description: bodyText,
        shortDescription: truncate(bodyText, 140),
      });
      return {
        ...result,
        kind: 'character',
        title: character.name,
        summary: [`Character "${character.name}"`, truncate(bodyText, 160)],
        payload: { characters: [character] },
      };
    }
  }
}

/** Reads "Name: text" transcripts; falls back to one big message. */
function parseTranscript(text: string, chatId: ID, branchId: ID): Message[] {
  const speakerLine = /^([A-Za-z0-9 _'()\-.]{1,32}):\s*(.*)$/;
  const messages: Message[] = [];
  let current: { speaker: string; lines: string[] } | null = null;

  const push = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (!content) {
      current = null;
      return;
    }
    const isUser = /^(you|user|me)$/i.test(current.speaker);
    messages.push(
      newMessage(chatId, branchId, {
        role: isUser ? 'user' : 'assistant',
        content,
        order: messages.length,
      }),
    );
    current = null;
  };

  for (const line of text.split('\n')) {
    const match = speakerLine.exec(line);
    if (match) {
      push();
      current = { speaker: match[1].trim(), lines: match[2] ? [match[2]] : [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  push();

  if (messages.length < 2) {
    // Not a transcript — keep the content rather than losing it.
    return [
      newMessage(chatId, branchId, { role: 'assistant', content: text.trim(), order: 0 }),
    ];
  }
  return messages;
}

async function parseImage(read: ReadFile): Promise<ParsedImport> {
  const card = await readCharacterCardFromPng(read.file);
  if (card.ok && card.json) {
    const parsed = await buildCharacterImport(
      unwrapEnvelope(card.json),
      read.name,
      `PNG character card (${card.keyword} chunk)`,
    );
    parsed.payload.avatarFile = read.file;
    parsed.summary.push('The PNG itself will be used as the avatar');
    parsed.issues.push({
      level: 'info',
      message: 'Character metadata was read from the PNG. The original file is not modified.',
    });
    return parsed;
  }

  // Not a card — still useful as a plain avatar image.
  const character = newCharacter({ name: read.name.replace(/\.[^.]+$/, '') });
  const result: ParsedImport = {
    ...base('character', read.name, 'image'),
    title: character.name,
    summary: [
      'No character data found in this image.',
      'It will be imported as a new character using this picture as the avatar.',
    ],
    payload: { characters: [character], avatarFile: read.file },
  };
  result.issues.push({
    level: 'warning',
    message: card.error ?? 'No character metadata could be extracted from this image.',
  });
  return result;
}

/* ------------------------------------------------------------- conflicts */

export async function findConflicts(parsed: ParsedImport): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];

  const check = async <T extends { id: ID; name?: string; title?: string }>(
    items: T[] | undefined,
    existing: T[],
    kind: ImportKind,
  ) => {
    for (const item of items ?? []) {
      const nameOf = (v: T) => (v.name ?? v.title ?? '').trim().toLowerCase();
      const byId = existing.find((e) => e.id === item.id);
      if (byId) {
        conflicts.push({
          kind,
          existingId: byId.id,
          existingName: byId.name ?? byId.title ?? '',
          incomingName: item.name ?? item.title ?? '',
          reason: 'same-id',
        });
        continue;
      }
      const byName = nameOf(item) ? existing.find((e) => nameOf(e) === nameOf(item)) : undefined;
      if (byName) {
        conflicts.push({
          kind,
          existingId: byName.id,
          existingName: byName.name ?? byName.title ?? '',
          incomingName: item.name ?? item.title ?? '',
          reason: 'same-name',
        });
      }
    }
  };

  const [existingChars, existingPersonas, existingBooks, existingStories, existingChats] =
    await Promise.all([
      repo.characters.all(),
      repo.personas.all(),
      repo.lorebooks.all(),
      repo.stories.all(),
      repo.chats.all(),
    ]);

  await check(parsed.payload.characters, existingChars, 'character');
  await check(parsed.payload.personas, existingPersonas, 'persona');
  await check(parsed.payload.lorebooks, existingBooks, 'lorebook');
  await check(parsed.payload.stories, existingStories, 'story');
  await check(parsed.payload.chats, existingChats, 'chat');

  return conflicts;
}

/* ---------------------------------------------------------------- commit */

export interface CommitResult {
  counts: Record<string, number>;
  createdIds: {
    characters: ID[];
    personas: ID[];
    lorebooks: ID[];
    stories: ID[];
    chats: ID[];
    memories: ID[];
  };
  warnings: string[];
}

export interface CommitOptions {
  strategy: ConflictStrategy;
  /** Backup restore only: wipe the library first. */
  wipeFirst?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Writes a parsed import into storage.
 *
 * `copy`    — everything gets fresh ids; existing rows are untouched.
 * `replace` — incoming rows overwrite rows with the same id/name.
 * `merge`   — existing rows are kept but missing fields are filled in.
 */
export async function commitImport(
  parsed: ParsedImport,
  options: CommitOptions,
): Promise<CommitResult> {
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const createdIds: CommitResult['createdIds'] = {
    characters: [],
    personas: [],
    lorebooks: [],
    stories: [],
    chats: [],
    memories: [],
  };

  if (options.strategy === 'cancel') {
    return { counts, createdIds, warnings: ['Import cancelled.'] };
  }

  if (options.wipeFirst) {
    progress('Clearing existing library…');
    await wipeLibrary();
  }

  // id remapping applied consistently across every referencing entity.
  const idMap = new Map<ID, ID>();
  const remap = (id: ID | null | undefined): ID | null => {
    if (!id) return null;
    return idMap.get(id) ?? id;
  };

  const [existingChars, existingPersonas, existingBooks, existingStories, existingChats] =
    await Promise.all([
      repo.characters.all(),
      repo.personas.all(),
      repo.lorebooks.all(),
      repo.stories.all(),
      repo.chats.all(),
    ]);

  const resolve = <T extends { id: ID }>(
    incoming: T,
    existing: T[],
    matchName: (v: T) => string,
  ): { action: 'insert' | 'skip' | 'overwrite' | 'merge'; target?: T } => {
    const byId = existing.find((e) => e.id === incoming.id);
    const name = matchName(incoming).trim().toLowerCase();
    const byName = name ? existing.find((e) => matchName(e).trim().toLowerCase() === name) : undefined;
    const match = byId ?? byName;
    if (!match) return { action: 'insert' };

    if (options.strategy === 'copy') {
      const fresh = uid();
      idMap.set(incoming.id, fresh);
      incoming.id = fresh;
      return { action: 'insert' };
    }
    if (options.strategy === 'replace') {
      if (match.id !== incoming.id) idMap.set(incoming.id, match.id);
      incoming.id = match.id;
      return { action: 'overwrite', target: match };
    }
    // merge
    if (match.id !== incoming.id) idMap.set(incoming.id, match.id);
    incoming.id = match.id;
    return { action: 'merge', target: match };
  };

  /** Fills blanks in `target` from `incoming` without clobbering real data. */
  const mergeInto = <T extends Record<string, unknown>>(target: T, incoming: T): T => {
    const out: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(incoming)) {
      if (key === 'id' || key === 'createdAt') continue;
      const current = out[key];
      if (Array.isArray(value)) {
        const existingArr = Array.isArray(current) ? current : [];
        if (!existingArr.length) out[key] = value;
        else if (value.length && typeof value[0] === 'string') {
          out[key] = Array.from(new Set([...(existingArr as string[]), ...(value as string[])]));
        }
        continue;
      }
      if (typeof value === 'string') {
        if (!String(current ?? '').trim() && value.trim()) out[key] = value;
        continue;
      }
      if (current === undefined || current === null) out[key] = value;
    }
    return out as T;
  };

  /* ---- characters ---- */
  progress('Importing characters…');
  const charsToSave: Character[] = [];
  for (const incoming of parsed.payload.characters ?? []) {
    const character = { ...newCharacter(), ...incoming };
    const decision = resolve(character, existingChars, (c) => c.name);
    if (decision.action === 'merge' && decision.target) {
      charsToSave.push(mergeInto(decision.target, character));
    } else {
      charsToSave.push(character);
    }
    createdIds.characters.push(character.id);
  }

  /* ---- avatar / media ---- */
  if (parsed.payload.media && Object.keys(parsed.payload.media).length) {
    progress('Restoring images…');
    let done = 0;
    for (const [mediaId, dataUrl] of Object.entries(parsed.payload.media)) {
      try {
        await importDataUrl(dataUrl, { id: mediaId, filename: `restored-${mediaId}` });
        done += 1;
      } catch (err) {
        warnings.push(`Image ${mediaId} could not be restored: ${(err as Error).message}`);
      }
    }
    counts.media = done;
  }

  if (parsed.payload.avatarDataUrl || parsed.payload.avatarFile) {
    const owner = charsToSave[0] ?? null;
    const persona = parsed.payload.personas?.[0] ?? null;
    try {
      const meta = parsed.payload.avatarFile
        ? await saveMedia(parsed.payload.avatarFile, {
            ownerType: owner ? 'character' : 'persona',
            ownerId: owner?.id ?? persona?.id ?? null,
          })
        : await importDataUrl(parsed.payload.avatarDataUrl!, {
            ownerType: owner ? 'character' : 'persona',
            ownerId: owner?.id ?? persona?.id ?? null,
            filename: `${owner?.name ?? persona?.name ?? 'imported'}-avatar`,
          });
      if (owner) owner.avatarMediaId = meta.id;
      else if (persona) persona.avatarMediaId = meta.id;
      counts.media = (counts.media ?? 0) + 1;
    } catch (err) {
      warnings.push(`The avatar image could not be imported: ${(err as Error).message}`);
    }
  }

  /* ---- personas ---- */
  const personasToSave: Persona[] = [];
  for (const incoming of parsed.payload.personas ?? []) {
    const persona = { ...newPersona(), ...incoming };
    const decision = resolve(persona, existingPersonas, (p) => p.name);
    personasToSave.push(
      decision.action === 'merge' && decision.target ? mergeInto(decision.target, persona) : persona,
    );
    createdIds.personas.push(persona.id);
  }

  /* ---- lorebooks + entries ---- */
  progress('Importing lorebooks…');
  const booksToSave: Lorebook[] = [];
  const entriesToSave: LoreEntry[] = [];
  const replacedBookIds: ID[] = [];
  for (const incoming of parsed.payload.lorebooks ?? []) {
    const originalId = incoming.id;
    const lorebook = { ...newLorebook(), ...incoming };
    const decision = resolve(lorebook, existingBooks, (b) => b.name);
    if (lorebook.id !== originalId) idMap.set(originalId, lorebook.id);
    if (decision.action === 'overwrite') replacedBookIds.push(lorebook.id);
    booksToSave.push(
      decision.action === 'merge' && decision.target
        ? mergeInto(decision.target, lorebook)
        : lorebook,
    );
    createdIds.lorebooks.push(lorebook.id);
  }
  // Replacing a lorebook clears its old entries so a re-import is not additive.
  for (const bookId of replacedBookIds) {
    const old = await repo.loreEntries.byLorebook(bookId);
    await repo.loreEntries.removeMany(old.map((e) => e.id));
  }
  const existingEntryIds = new Set((await repo.loreEntries.all()).map((e) => e.id));
  for (const incoming of parsed.payload.loreEntries ?? []) {
    const entry = { ...newLoreEntry(incoming.lorebookId), ...incoming };
    entry.lorebookId = remap(entry.lorebookId) ?? entry.lorebookId;
    if (options.strategy === 'copy' || existingEntryIds.has(entry.id)) entry.id = uid();
    entriesToSave.push(entry);
  }

  /* ---- memories ---- */
  const memoriesToSave: Memory[] = (parsed.payload.memories ?? []).map((incoming) => {
    const memory = { ...newMemory(), ...incoming };
    if (options.strategy === 'copy') {
      const fresh = uid();
      idMap.set(memory.id, fresh);
      memory.id = fresh;
    }
    memory.sourceStoryId = remap(memory.sourceStoryId);
    memory.sourceChatId = remap(memory.sourceChatId);
    createdIds.memories.push(memory.id);
    return memory;
  });

  /* ---- stories ---- */
  progress('Importing stories…');
  const storiesToSave: Story[] = [];
  for (const incoming of parsed.payload.stories ?? []) {
    const story = { ...newStory(), ...incoming };
    const decision = resolve(story, existingStories, (s) => s.title);
    story.characters = (story.characters ?? []).map((link) => ({
      ...link,
      characterId: remap(link.characterId) ?? link.characterId,
    }));
    story.personaId = remap(story.personaId);
    story.lorebookIds = (story.lorebookIds ?? []).map((id) => remap(id) ?? id);
    story.memoryIds = (story.memoryIds ?? []).map((id) => remap(id) ?? id);
    story.coverMediaId = story.coverMediaId ?? null;
    story.backgroundMediaId = story.backgroundMediaId ?? null;
    storiesToSave.push(
      decision.action === 'merge' && decision.target ? mergeInto(decision.target, story) : story,
    );
    createdIds.stories.push(story.id);
  }

  /* ---- chats ---- */
  progress('Importing chats…');
  const chatsToSave: Chat[] = [];
  for (const incoming of parsed.payload.chats ?? []) {
    const chat = { ...newChat(), ...incoming };
    const decision = resolve(chat, existingChats, (c) => c.title);
    if (decision.action === 'overwrite') {
      await repo.deleteChatCascade(chat.id);
    }
    chat.storyId = remap(chat.storyId);
    chat.personaId = remap(chat.personaId);
    chat.lorebookIds = (chat.lorebookIds ?? []).map((id) => remap(id) ?? id);
    chatsToSave.push(chat);
    createdIds.chats.push(chat.id);
  }

  const branchesToSave: Branch[] = (parsed.payload.branches ?? []).map((incoming) => {
    const branch = { ...incoming };
    if (options.strategy === 'copy' && idMap.has(branch.chatId)) {
      const fresh = uid();
      idMap.set(branch.id, fresh);
      branch.id = fresh;
    }
    branch.chatId = remap(branch.chatId) ?? branch.chatId;
    branch.parentBranchId = remap(branch.parentBranchId);
    branch.createdFromMessageId = remap(branch.createdFromMessageId);
    return branch;
  });
  // Re-point chats at their (possibly remapped) active branch.
  for (const chat of chatsToSave) {
    chat.activeBranchId = remap(chat.activeBranchId) ?? chat.activeBranchId;
    if (!branchesToSave.some((b) => b.id === chat.activeBranchId)) {
      const fallback = branchesToSave.find((b) => b.chatId === chat.id);
      if (fallback) chat.activeBranchId = fallback.id;
    }
  }

  const messagesToSave: Message[] = (parsed.payload.messages ?? []).map((incoming) => {
    const message = { ...newMessage(incoming.chatId, incoming.branchId), ...incoming };
    if (options.strategy === 'copy' && idMap.has(message.chatId)) {
      const fresh = uid();
      idMap.set(message.id, fresh);
      message.id = fresh;
    }
    message.chatId = remap(message.chatId) ?? message.chatId;
    message.branchId = remap(message.branchId) ?? message.branchId;
    message.characterId = remap(message.characterId);
    message.personaId = remap(message.personaId);
    message.activeAlternativeId = remap(message.activeAlternativeId);
    return message;
  });

  const alternativesToSave: MessageAlternative[] = (parsed.payload.alternatives ?? []).map((alt) => ({
    ...alt,
    id: options.strategy === 'copy' ? (idMap.get(alt.id) ?? uid()) : alt.id,
    messageId: remap(alt.messageId) ?? alt.messageId,
    chatId: remap(alt.chatId) ?? alt.chatId,
  }));

  const checkpointsToSave: Checkpoint[] = (parsed.payload.checkpoints ?? []).map((cp) => ({
    ...cp,
    id: options.strategy === 'copy' ? uid() : cp.id,
    chatId: remap(cp.chatId) ?? cp.chatId,
    branchId: remap(cp.branchId) ?? cp.branchId,
    messageId: remap(cp.messageId) ?? cp.messageId,
    storyId: remap(cp.storyId),
  }));

  /* ---- write ---- */
  progress('Saving…');
  await Promise.all([
    repo.characters.saveMany(charsToSave),
    repo.personas.saveMany(personasToSave),
    repo.lorebooks.saveMany(booksToSave),
    repo.loreEntries.saveMany(entriesToSave),
    repo.memories.saveMany(memoriesToSave),
    repo.stories.saveMany(storiesToSave),
  ]);
  await Promise.all([
    repo.chats.saveMany(chatsToSave),
    repo.branches.saveMany(branchesToSave),
  ]);
  await Promise.all([
    repo.messages.saveMany(messagesToSave),
    repo.alternatives.saveMany(alternativesToSave),
    repo.checkpoints.saveMany(checkpointsToSave),
  ]);

  if (parsed.payload.providers?.length) {
    const existingProviders = await repo.providers.all();
    const merged = parsed.payload.providers.map((incoming) => {
      const current = existingProviders.find((p) => p.id === incoming.id);
      // A restore must never blank an API key the user already has locally.
      return { ...incoming, apiKey: current?.apiKey ?? '' };
    });
    await repo.providers.saveMany(merged);
    counts.providers = merged.length;
  }

  if (parsed.payload.imageProviders?.length) {
    const existing = await repo.imageProviders.all();
    const merged = parsed.payload.imageProviders.map((incoming) => {
      const current = existing.find((p) => p.id === incoming.id);
      // Same rule as text providers: a restore must never blank a local key.
      return { ...incoming, apiKey: current?.apiKey ?? '' };
    });
    await repo.imageProviders.saveMany(merged);
    counts.imageProviders = merged.length;
  }

  if (parsed.payload.sceneDeltas?.length) {
    await repo.sceneDeltas.saveMany(parsed.payload.sceneDeltas);
    counts.sceneDeltas = parsed.payload.sceneDeltas.length;
  }
  if (parsed.payload.storySummaries?.length) {
    await repo.storySummaries.saveMany(parsed.payload.storySummaries);
    counts.storySummaries = parsed.payload.storySummaries.length;
  }

  if (parsed.payload.settings) {
    const current = await repo.settingsRepo.load();
    await repo.settingsRepo.save({
      ...current,
      ...parsed.payload.settings,
      id: 'settings',
      migratedV2: current.migratedV2 || parsed.payload.settings.migratedV2,
    });
    counts.settings = 1;
  }

  counts.characters = charsToSave.length;
  counts.personas = personasToSave.length;
  counts.lorebooks = booksToSave.length;
  counts.loreEntries = entriesToSave.length;
  counts.memories = memoriesToSave.length;
  counts.stories = storiesToSave.length;
  counts.chats = chatsToSave.length;
  counts.messages = messagesToSave.length;
  counts.branches = branchesToSave.length;
  counts.alternatives = alternativesToSave.length;
  counts.checkpoints = checkpointsToSave.length;

  return { counts, createdIds, warnings };
}

async function wipeLibrary(): Promise<void> {
  const { ALL_DATA_STORES, dbClear, STORES } = await import('../storage/db');
  for (const store of ALL_DATA_STORES) {
    if (store === STORES.settings) continue; // settings are merged, not wiped
    await dbClear(store);
  }
}
