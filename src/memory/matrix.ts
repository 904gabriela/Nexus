/**
 * The memory matrix.
 *
 * Automatic memory used to ask the model "what are the durable facts here",
 * which is a question about a whole story asked of two messages. It answered by
 * restating the scene: what people were wearing, what mood they were in, things
 * the character sheet already said. The question that fits two messages is
 * *what changed* — and a change is small, dated, and about someone.
 *
 * So a memory here is typed rather than free prose:
 *
 *   subjects   who it is about, by name, so retrieval can find it
 *   basis      whether the story showed it, someone claimed it, or it was
 *              concluded — three different kinds of knowledge
 *   confidence how sure, which is what decides whether it commits silently
 *   status     proposed memories are never sent to the model
 *
 * Nothing here overwrites: a memory that replaces another records what it
 * replaces and the old one is kept, marked superseded. There is no contradiction
 * detector, because whether two statements about a story conflict has no ground
 * truth — a character can change their mind, and that is not an error to
 * reconcile.
 *
 * Every field is optional on the stored type. Memories written before this
 * existed are perfectly valid and must keep working, so read them through the
 * helpers below rather than off the object.
 */

import type {
  Character,
  DiscoveredPerson,
  ID,
  Memory,
  MemoryBasis,
  MemoryCategory,
  MemoryImportance,
  MemoryStatus,
  Message,
  Persona,
  Provider,
  RelationshipImpact,
  Story,
} from '../types';
import { MEMORY_CATEGORIES } from '../types';
import { complete } from '../ai/client';
import { newMemory } from '../types/factories';
import { truncate } from '../utils/text';
import { uid } from '../utils/uid';

/* --------------------------------------------------------------- reading */

/**
 * A memory saved before the matrix existed has no basis recorded. Treating it
 * as observed is the honest default: it was written by hand or drawn straight
 * from the transcript, and nothing about it was a claim or a guess.
 */
export function memoryBasis(memory: Memory): MemoryBasis {
  return memory.basis ?? 'observed';
}

/** Absent status means active — an old memory was never waiting for review. */
export function memoryStatus(memory: Memory): MemoryStatus {
  return memory.status ?? 'active';
}

export function memoryConfidence(memory: Memory): number {
  const value = memory.confidence;
  if (typeof value !== 'number' || Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function memorySubjects(memory: Memory): string[] {
  return (memory.subjects ?? []).map((s) => s.trim()).filter(Boolean);
}

export function memorySupersedes(memory: Memory): ID[] {
  return memory.supersedes ?? [];
}

/** Whether this memory may be sent to the model. */
export function isUsable(memory: Memory): boolean {
  return memoryStatus(memory) === 'active';
}

/* ------------------------------------------------------------ extraction */

const EXTRACT_SYSTEM = `You watch a roleplay and record only what CHANGED in the latest exchange.

Return ONLY a JSON object, no prose around it, of the form:
{"changes": [...], "newPeople": [...]}

"newPeople" lists anyone NAMED in the exchange who is not in the cast you were
given, as {"name": string, "note": one short line on who they are}. Include a
person only if they were named. Do not include the cast, do not include the
narrator, and do not invent a name for someone the text left unnamed. An empty
list is the usual answer.

Each item of "changes":
{"title": string (max 60 chars),
 "content": string (1-2 short factual sentences, third person),
 "category": one of ["Plot","Event","Character","Relationship","World","Location","Item","Preference","System","Other"],
 "subjects": array of the names this is about,
 "basis": "observed" | "stated" | "inferred",
 "statedBy": the name of whoever said it, when basis is "stated", else null,
 "confidence": number between 0 and 1,
 "importance": "low" | "normal" | "high" | "critical",
 "relationship": {"between": [nameA, nameB], "change": string} or null}

basis means:
  "observed"  it happened in the text you were given
  "stated"    a character said it; they may be mistaken or lying
  "inferred"  you concluded it; the text did not say it

Record only what someone would still need many scenes from now and could not
work out from the scene itself. Do NOT record: clothing, passing mood, weather,
what a character sheet already says, or a retelling of the exchange.

If nothing durable changed, return []. An empty array is a good answer. Never
invent a detail to have something to report.`;

export interface ExtractionInput {
  messages: Message[];
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  chatId: ID | null;
  storyId: ID | null;
  /** Already-saved memories, so the same beat is not recorded twice. */
  existing: Memory[];
  /** Pin whatever is committed. Mirrors the existing setting. */
  pin?: boolean;
  /** Report people the story named who are not in the cast. Defaults to on. */
  discoverPeople?: boolean;
  signal?: AbortSignal;
}

/**
 * A confident observation is worth committing unattended. Anything hedged, and
 * anything the model concluded rather than saw, waits for a person — the cost
 * of a wrong memory is that the story quietly builds on it.
 */
export const AUTO_COMMIT_CONFIDENCE = 0.75;

export function decideStatus(basis: MemoryBasis, confidence: number): MemoryStatus {
  if (basis === 'inferred') return 'proposed';
  return confidence >= AUTO_COMMIT_CONFIDENCE ? 'active' : 'proposed';
}

function speakerName(message: Message, characters: Character[], persona: Persona | null): string {
  if (message.role === 'user') return persona?.displayName || persona?.name || 'User';
  const character = characters.find((c) => c.id === message.characterId);
  return character?.displayName || character?.name || 'Character';
}

function transcript(input: ExtractionInput): string {
  return input.messages
    .map((m) => `${speakerName(m, input.characters, input.persona)}: ${m.content.trim()}`)
    .join('\n\n');
}

interface ExtractionPayload {
  changes: unknown[];
  newPeople: unknown[];
}

function slice(text: string, open: string, close: string): unknown | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads the extractor's answer.
 *
 * The requested shape is an object with two lists, but a smaller model asked
 * for changes very often returns just the changes as a bare array. That answer
 * is complete and correct as far as it goes, so it is read rather than thrown
 * away — the alternative is discarding good work over a wrapper.
 */
function readExtraction(text: string): ExtractionPayload | null {
  const candidate = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;

  const object = slice(candidate, '{', '}');
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    const record = object as Record<string, unknown>;
    if (Array.isArray(record.changes) || Array.isArray(record.newPeople)) {
      return {
        changes: Array.isArray(record.changes) ? record.changes : [],
        newPeople: Array.isArray(record.newPeople) ? record.newPeople : [],
      };
    }
  }

  const array = slice(candidate, '[', ']');
  if (Array.isArray(array)) return { changes: array, newPeople: [] };

  return null;
}

const IMPORTANCES: MemoryImportance[] = ['low', 'normal', 'high', 'critical'];

/** Resolves a name the model wrote back to someone the app knows. */
export function resolveName(
  name: string,
  characters: Character[],
  persona: Persona | null,
): ID | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const character of characters) {
    if (
      character.name.trim().toLowerCase() === wanted ||
      (character.displayName ?? '').trim().toLowerCase() === wanted
    ) {
      return character.id;
    }
  }
  if (persona) {
    if (
      persona.name.trim().toLowerCase() === wanted ||
      (persona.displayName ?? '').trim().toLowerCase() === wanted
    ) {
      return persona.id;
    }
  }
  return null;
}

/**
 * Whether two memories are the same beat.
 *
 * Word overlap alone was the old test and it is too eager on prose: two
 * different scenes in the same tavern share most of their long words. Sharing a
 * subject as well is what makes it the same beat rather than the same setting.
 */
export function isSameBeat(candidate: Memory, existing: Memory): boolean {
  const overlap = wordOverlap(candidate.content, existing.content);
  if (overlap < 0.6) return false;

  const a = new Set(memorySubjects(candidate).map((s) => s.toLowerCase()));
  const b = new Set(memorySubjects(existing).map((s) => s.toLowerCase()));
  // When neither side names a subject there is nothing to disagree about, so
  // fall back to the older overlap-only rule.
  if (!a.size || !b.size) return true;
  for (const subject of a) if (b.has(subject)) return true;
  return false;
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4),
  );
}

function wordOverlap(a: string, b: string): number {
  const left = significantWords(a);
  const right = significantWords(b);
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * State-like memories replace each other; event-like ones accumulate.
 *
 * "Reiko prefers tea" is a fact with one current value. "Reiko was attacked at
 * the bridge" is a thing that happened and stays happened, however many times
 * it happens again.
 */
const STATEFUL: MemoryCategory[] = ['Preference', 'Relationship', 'Character'];

/**
 * Finds memories the new one should replace: the same subject, the same kind of
 * fact, and close enough in wording to be about the same thing.
 *
 * This proposes only. Nothing is marked superseded until the new memory is
 * accepted, so a proposal that is rejected leaves the record untouched.
 */
export function findSuperseded(candidate: Memory, existing: Memory[]): ID[] {
  if (!STATEFUL.includes(candidate.category)) return [];
  const subjects = new Set(memorySubjects(candidate).map((s) => s.toLowerCase()));
  if (!subjects.size) return [];

  return existing
    .filter((memory) => {
      if (memory.id === candidate.id) return false;
      if (memoryStatus(memory) !== 'active') return false;
      if (memory.category !== candidate.category) return false;
      if (memory.pinned) return false; // Pinned is a person saying "keep this".
      const other = memorySubjects(memory).map((s) => s.toLowerCase());
      if (!other.some((s) => subjects.has(s))) return false;
      return wordOverlap(candidate.content, memory.content) >= 0.35;
    })
    .map((memory) => memory.id);
}

export interface ExtractedMemory {
  memory: Memory;
  /** Why it did or did not commit on its own, in the toast's words. */
  reason: string;
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
  /** People the exchange named who have no character record. */
  discovered: DiscoveredPerson[];
  /**
   * False when the model's answer could not be read as the requested JSON.
   *
   * This is different from finding nothing, and the two must not look the
   * same. The old code papered over an unreadable answer by falling back to a
   * mechanical extract of the exchange and saving that as a memory — a
   * "memory" the model never proposed, which is exactly the noise the matrix
   * exists to stop. Recording nothing is the right answer; recording nothing
   * *silently*, so a model that cannot produce JSON looks identical to a quiet
   * scene, is not.
   */
  readable: boolean;
}

/**
 * Runs the extractor over an exchange and returns saved-ready memories.
 *
 * Returns nothing freely: most exchanges change nothing worth keeping, and a
 * run that records nothing is the common case rather than a failure.
 */
export async function extractMemories(input: ExtractionInput): Promise<ExtractionResult> {
  const nothing: ExtractionResult = { memories: [], discovered: [], readable: true };
  if (!input.messages.length) return nothing;
  if (!input.provider || !input.provider.model) return nothing;

  // The cast is named so the extractor can tell an existing character from
  // someone new. Without it every reply "discovers" the people already in the
  // room.
  const known = [
    ...input.characters.map((c) => c.displayName || c.name),
    input.persona ? input.persona.displayName || input.persona.name : '',
  ]
    .map((n) => n.trim())
    .filter(Boolean);

  const reply = await complete({
    // Background work: it must never displace the roleplay request in the
    // inspector.
    purpose: 'utility',
    provider: input.provider,
    signal: input.signal,
    settings: { temperature: 0.2, maxTokens: 700, streaming: false },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      {
        role: 'user',
        content: [
          `Cast (already known): ${known.length ? known.join(', ') : 'nobody yet'}`,
          '',
          `Latest exchange:\n\n${truncate(transcript(input), 8000)}`,
        ].join('\n'),
      },
    ],
  });

  const payload = readExtraction(reply);
  if (!payload) return { memories: [], discovered: [], readable: false };

  const cast = input.characters;
  const results: ExtractedMemory[] = [];
  // Candidates are checked against what is already saved *and* against each
  // other, so one run cannot emit the same beat twice.
  const seen = [...input.existing];

  for (const row of payload.changes) {
    const parsed = toMemory(row, input, cast);
    if (!parsed) continue;
    if (seen.some((existing) => isSameBeat(parsed, existing))) continue;

    parsed.supersedes = findSuperseded(parsed, seen);
    const basis = memoryBasis(parsed);
    const confidence = memoryConfidence(parsed);
    // Retiring an existing memory is the one automatic action that removes
    // something the story already believed, so it always goes to a person
    // however sure the extractor sounds.
    parsed.status = parsed.supersedes.length ? 'proposed' : decideStatus(basis, confidence);

    seen.push(parsed);
    results.push({
      memory: parsed,
      reason:
        parsed.status === 'active'
          ? 'Observed directly, and confident.'
          : parsed.supersedes.length
            ? 'It would replace a memory you already have — waiting for you to accept it.'
            : basis === 'inferred'
              ? 'Inferred rather than shown — waiting for you to accept it.'
              : `Only ${Math.round(confidence * 100)}% sure — waiting for you to accept it.`,
    });
  }

  return {
    memories: results,
    discovered: input.discoverPeople === false ? [] : toDiscoveries(payload.newPeople, input),
    readable: true,
  };
}

/**
 * Turns the extractor's `newPeople` into records worth showing.
 *
 * The filtering here is the whole feature. A model asked "who is new" will
 * cheerfully answer with the narrator, a title, a species, or somebody already
 * in the room, and every one of those becomes a prompt the user has to dismiss.
 * Anything that resolves to somebody known is dropped, and so is anything that
 * does not look like a name.
 */
function toDiscoveries(rows: unknown[], input: ExtractionInput): DiscoveredPerson[] {
  const at = Date.now();
  const out: DiscoveredPerson[] = [];
  const taken = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    if (!isPlausibleName(name)) continue;

    const key = name.toLowerCase();
    if (taken.has(key)) continue;
    // Already someone the app knows: not a discovery.
    if (resolveName(name, input.characters, input.persona)) continue;

    taken.add(key);
    out.push({
      id: uid('disc_'),
      name,
      note: truncate(String(record.note ?? '').trim(), 200),
      sourceMessageIds: input.messages.map((m) => m.id),
      dismissed: false,
      updatedAt: at,
    });
  }

  return out;
}

/**
 * Words the model reaches for when it has nobody to report but feels obliged
 * to fill the list. None of them is a person.
 */
const NOT_A_NAME = new Set([
  'narrator',
  'nobody',
  'none',
  'unknown',
  'unnamed',
  'someone',
  'stranger',
  'user',
  'character',
  'the narrator',
  'n/a',
]);

function isPlausibleName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  if (NOT_A_NAME.has(name.toLowerCase())) return false;
  // A name, not a sentence about one. Four words is generous for "Sera of the
  // Ashfell Road" and still excludes a description.
  if (name.split(/\s+/).length > 4) return false;
  return /\p{Lu}/u.test(name);
}

/**
 * Records newly named people on the story.
 *
 * Never re-proposes: a name already discovered, already dismissed, or already
 * in the cast is skipped, so the same courier does not reappear every few
 * turns. Returns null when nothing is new, so the caller can skip the write.
 */
export function applyDiscoveries(
  story: Story,
  discovered: DiscoveredPerson[],
  characters: Character[],
): Story | null {
  if (!discovered.length) return null;

  const existing = story.discovered ?? [];
  const seen = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  // The story's own cast, by name — a character can be added to the cast by
  // hand between one discovery and the next.
  const castIds = new Set(story.characters.map((link) => link.characterId));
  for (const character of characters) {
    if (!castIds.has(character.id)) continue;
    seen.add(character.name.trim().toLowerCase());
    if (character.displayName) seen.add(character.displayName.trim().toLowerCase());
  }

  const fresh = discovered.filter((person) => !seen.has(person.name.trim().toLowerCase()));
  if (!fresh.length) return null;

  return {
    ...story,
    discovered: [...existing, ...fresh],
    updatedAt: Date.now(),
  };
}

function toMemory(
  row: unknown,
  input: ExtractionInput,
  cast: Character[],
): Memory | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;

  const content = String(record.content ?? '').trim();
  if (!content) return null;

  const subjects = Array.isArray(record.subjects)
    ? [...new Set(record.subjects.map((s) => String(s).trim()).filter(Boolean))]
    : [];

  const rawBasis = String(record.basis ?? '');
  const basis: MemoryBasis =
    rawBasis === 'stated' || rawBasis === 'inferred' || rawBasis === 'observed'
      ? rawBasis
      : // An unrecognised basis is not an observation. Guessing 'observed'
        // would let a hallucinated fact commit unattended.
        'inferred';

  const rawConfidence = Number(record.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0.5;

  const rawCategory = String(record.category ?? '') as MemoryCategory;
  const category = MEMORY_CATEGORIES.includes(rawCategory) ? rawCategory : 'Other';

  const rawImportance = String(record.importance ?? '') as MemoryImportance;
  const importance = IMPORTANCES.includes(rawImportance) ? rawImportance : 'normal';

  const characterIds = subjects
    .map((name) => resolveName(name, cast, input.persona))
    .filter((id): id is ID => Boolean(id));

  // A claim belongs to whoever made it, and only the extractor knows which of
  // the two speakers that was. Guessing from the exchange — taking the last
  // assistant turn — attributes the user's own claims to the character, so an
  // unresolvable name leaves it unattributed instead.
  const claimant =
    basis === 'stated' ? resolveName(String(record.statedBy ?? ''), cast, input.persona) : null;

  return newMemory({
    origin: 'auto',
    title: truncate(String(record.title ?? '').trim() || content, 60),
    content,
    category,
    importance,
    pinned: Boolean(input.pin),
    sourceMessageIds: input.messages.map((m) => m.id),
    sourceChatId: input.chatId,
    sourceStoryId: input.storyId,
    characterIds: [...new Set(characterIds)],
    // The subjects are what retrieval matches on, so they are tags too.
    tags: ['auto', ...subjects.map((s) => s.toLowerCase())],
    subjects,
    basis,
    confidence,
    statedById: claimant,
    supersedes: [],
    relationshipImpact: toRelationshipImpact(record.relationship, input, cast),
  });
}

function toRelationshipImpact(
  value: unknown,
  input: ExtractionInput,
  cast: Character[],
): RelationshipImpact | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const between = Array.isArray(record.between) ? record.between.map((n) => String(n)) : [];
  if (between.length !== 2) return null;

  const change = String(record.change ?? '').trim();
  if (!change) return null;

  const ids = between.map((name) => resolveName(name, cast, input.persona));
  // Both ends must be someone the app knows, or the relationship would point at
  // nothing and could never be shown.
  if (!ids[0] || !ids[1] || ids[0] === ids[1]) return null;

  return { betweenIds: [ids[0], ids[1]], change };
}

/*
 * Relationship impacts used to be folded into `story.relationships` from here.
 * That made a conclusion the extractor drew indistinguishable from what the
 * author wrote, carried it onto branches that never lived through it, and left
 * no way back. They are read by `relationshipDeltasFrom` in ./relationships
 * now, and recorded as rows the branch can resolve and the user can undo.
 */

/* ------------------------------------------------------------- accepting */

/**
 * Accepting a proposed memory is what makes its supersessions real.
 *
 * Returns every memory that needs saving: the accepted one, and the ones it
 * replaces. The replaced ones are marked, never deleted — a superseded memory
 * is still the record of what the story believed at the time.
 */
export function acceptMemory(memory: Memory, all: Memory[]): Memory[] {
  const at = Date.now();
  const replaced = memorySupersedes(memory)
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is Memory => Boolean(m) && memoryStatus(m!) === 'active')
    .map((m) => ({ ...m, status: 'superseded' as const, updatedAt: at }));

  return [{ ...memory, status: 'active' as const, updatedAt: at }, ...replaced];
}
