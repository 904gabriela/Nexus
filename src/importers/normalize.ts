/**
 * Field normalisation.
 *
 * Character/persona/lorebook JSON in the wild uses a dozen naming conventions
 * (SillyTavern v1 & v2 cards, TavernAI, Agnai, Tipsy exports, hand-written
 * files, and Nexus V2's own shape). Everything funnels through here so the rest
 * of the app only ever sees the canonical schema.
 */

import type { Character, CustomField, LoreEntry, Lorebook, Persona, Story } from '../types';
import {
  newCharacter,
  newGreeting,
  newLoreEntry,
  newLorebook,
  newPersona,
  newStory,
} from '../types/factories';
import { firstOf, toBool, toNumber, toStringList, toText } from '../utils/text';
import { uid } from '../utils/uid';

type Raw = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Pulls the payload out of the various wrapper shapes cards ship with. */
export function unwrapCard(input: unknown): { data: Raw; wrapper: Raw | null } {
  if (!isPlainObject(input)) return { data: {}, wrapper: null };
  // SillyTavern v2/v3: { spec: 'chara_card_v2', data: {...} }
  if (isPlainObject(input.data) && typeof input.spec === 'string') {
    return { data: input.data, wrapper: input };
  }
  // Some exports nest under `character` / `char`.
  for (const key of ['character', 'char', 'persona', 'story']) {
    if (isPlainObject(input[key])) return { data: input[key] as Raw, wrapper: input };
  }
  return { data: input, wrapper: null };
}

const CHARACTER_KNOWN_KEYS = new Set([
  'id',
  'name',
  'char_name',
  'display_name',
  'displayName',
  'nickname',
  'age',
  'gender',
  'sex',
  'pronouns',
  'species',
  'race',
  'occupation',
  'job',
  'role',
  'tags',
  'categories',
  'short_description',
  'shortDescription',
  'tagline',
  'summary',
  'description',
  'char_persona',
  'persona',
  'appearance',
  'looks',
  'physical_traits',
  'physicalTraits',
  'personality',
  'temperament',
  'traits',
  'backstory',
  'background',
  'history',
  'goals',
  'motivations',
  'fears',
  'secrets',
  'likes',
  'dislikes',
  'hobbies',
  'values',
  'beliefs',
  'scenario',
  'world_scenario',
  'greeting',
  'first_mes',
  'first_message',
  'firstMes',
  'firstMessage',
  'char_greeting',
  'alternate_greetings',
  'alternateGreetings',
  'alternate_gretings',
  'speaking_style',
  'speakingStyle',
  'speech_patterns',
  'speechPatterns',
  'example_dialogue',
  'mes_example',
  'example_dialogs',
  'exampleDialogue',
  'system_prompt',
  'system',
  'systemPrompt',
  'post_history_instructions',
  'author_note',
  'authorNote',
  'authors_note',
  'relationships',
  'friends',
  'enemies',
  'family',
  'romantic',
  'home',
  'location',
  'faction',
  'world',
  'creator',
  'creator_notes',
  'creatorNotes',
  'character_version',
  'version',
  'avatar',
  'image',
  'avatarUrl',
  'avatar_url',
  'metadata',
  'extensions',
  'character_book',
  'lorebook',
  'spec',
  'spec_version',
  'data',
  'favorite',
  'fav',
  'createdAt',
  'updatedAt',
  'create_date',
]);

function collectCustomFields(data: Raw, known: Set<string>): CustomField[] {
  const fields: CustomField[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (known.has(key)) continue;
    const text = toText(value);
    if (!text.trim()) continue;
    fields.push({ id: uid(), key, value: text });
  }
  return fields;
}

/** Normalises example dialogue arrays into the classic `<START>` block form. */
function normalizeExampleDialogue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (isPlainObject(entry)) {
          const role = firstOf(entry.role, entry.name, entry.speaker) || 'char';
          const content = toText(entry.content ?? entry.message ?? entry.text);
          return content ? `{{${role}}}: ${content}` : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return toText(value);
}

export function normalizeCharacter(input: unknown): Character {
  const { data, wrapper } = unwrapCard(input);
  const base = newCharacter();

  const greetings = base.greetings;
  const primaryGreeting = firstOf(
    data.first_mes,
    data.firstMes,
    data.first_message,
    data.firstMessage,
    data.greeting,
    data.char_greeting,
  );
  if (primaryGreeting.trim()) greetings.push(newGreeting(primaryGreeting, 'Default greeting'));

  const alternates = [
    ...toStringListLoose(data.alternate_greetings),
    ...toStringListLoose(data.alternateGreetings),
    // Typo present in some real-world exports.
    ...toStringListLoose(data.alternate_gretings),
  ];
  alternates.forEach((text, i) => {
    if (text.trim()) greetings.push(newGreeting(text, `Alternate ${i + 1}`));
  });

  const name = firstOf(data.name, data.char_name, data.displayName, data.display_name, wrapper?.name);

  const character: Character = {
    ...base,
    name: name || 'Unnamed Character',
    displayName: firstOf(data.display_name, data.displayName),
    nickname: firstOf(data.nickname),
    age: firstOf(data.age),
    gender: firstOf(data.gender, data.sex),
    pronouns: firstOf(data.pronouns),
    species: firstOf(data.species),
    race: firstOf(data.race),
    occupation: firstOf(data.occupation, data.job),
    role: firstOf(data.role),
    tags: [...toStringList(data.tags), ...toStringList(data.categories)],
    shortDescription: firstOf(data.short_description, data.shortDescription, data.tagline, data.summary),
    description: firstOf(data.description, data.char_persona, data.persona),
    appearance: firstOf(data.appearance, data.looks),
    physicalTraits: firstOf(data.physical_traits, data.physicalTraits),
    personality: firstOf(data.personality),
    temperament: firstOf(data.temperament),
    traits: toStringList(data.traits),
    backstory: firstOf(data.backstory, data.background),
    history: firstOf(data.history),
    goals: firstOf(data.goals),
    motivations: firstOf(data.motivations),
    fears: firstOf(data.fears),
    secrets: firstOf(data.secrets),
    likes: firstOf(data.likes),
    dislikes: firstOf(data.dislikes),
    hobbies: firstOf(data.hobbies),
    values: firstOf(data.values),
    beliefs: firstOf(data.beliefs),
    scenario: firstOf(data.scenario, data.world_scenario),
    greetings,
    defaultGreetingId: greetings[0]?.id ?? null,
    speakingStyle: firstOf(data.speaking_style, data.speakingStyle),
    speechPatterns: firstOf(data.speech_patterns, data.speechPatterns),
    exampleDialogue: normalizeExampleDialogue(
      data.mes_example ?? data.example_dialogue ?? data.exampleDialogue ?? data.example_dialogs,
    ),
    systemPrompt: firstOf(data.system_prompt, data.systemPrompt, data.system),
    authorNote: firstOf(
      data.author_note,
      data.authorNote,
      data.authors_note,
      data.post_history_instructions,
    ),
    relationships: firstOf(data.relationships),
    friends: firstOf(data.friends),
    enemies: firstOf(data.enemies),
    family: firstOf(data.family),
    romantic: firstOf(data.romantic),
    home: firstOf(data.home),
    location: firstOf(data.location),
    faction: firstOf(data.faction),
    world: firstOf(data.world),
    creator: firstOf(data.creator, wrapper?.creator),
    creatorNotes: firstOf(data.creator_notes, data.creatorNotes),
    version: firstOf(data.character_version, data.version) || '1.0',
    avatarUrl: pickAvatarUrl(data),
    favorite: toBool(data.favorite ?? data.fav, false),
    customFields: collectCustomFields(data, CHARACTER_KNOWN_KEYS),
    metadata: isPlainObject(data.extensions)
      ? (data.extensions as Record<string, unknown>)
      : isPlainObject(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : {},
  };

  return character;
}

/** Avatar values that are actual URLs/data URLs (not ST's "none" sentinel). */
function pickAvatarUrl(data: Raw): string {
  const raw = firstOf(data.avatarUrl, data.avatar_url, data.avatar, data.image);
  if (!raw || raw === 'none') return '';
  if (/^(https?:|data:)/i.test(raw)) return raw;
  return '';
}

function toStringListLoose(value: unknown): string[] {
  // Alternate greetings are long multi-line strings — never comma-split them.
  if (Array.isArray(value)) return value.map((v) => toText(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

/** Character cards may carry an embedded lorebook. */
export function extractEmbeddedLorebook(
  input: unknown,
): { lorebook: Lorebook; entries: LoreEntry[] } | null {
  const { data } = unwrapCard(input);
  const book = data.character_book ?? data.lorebook ?? data.world_info;
  if (!isPlainObject(book)) return null;
  const parsed = normalizeLorebook(book);
  if (!parsed.entries.length) return null;
  return parsed;
}

const PERSONA_KNOWN_KEYS = new Set([
  'id',
  'name',
  'display_name',
  'displayName',
  'nickname',
  'age',
  'gender',
  'sex',
  'pronouns',
  'species',
  'appearance',
  'description',
  'persona',
  'personality',
  'traits',
  'backstory',
  'background',
  'occupation',
  'job',
  'goals',
  'likes',
  'dislikes',
  'speech_style',
  'speechStyle',
  'speaking_style',
  'custom_instructions',
  'customInstructions',
  'instructions',
  'tags',
  'avatar',
  'avatarUrl',
  'avatar_url',
  'image',
  'isDefault',
  'is_default',
  'createdAt',
  'updatedAt',
]);

export function normalizePersona(input: unknown): Persona {
  const { data } = unwrapCard(input);
  const base = newPersona();
  return {
    ...base,
    name: firstOf(data.name, data.display_name, data.displayName) || 'Unnamed Persona',
    displayName: firstOf(data.display_name, data.displayName),
    nickname: firstOf(data.nickname),
    age: firstOf(data.age),
    gender: firstOf(data.gender, data.sex),
    pronouns: firstOf(data.pronouns),
    species: firstOf(data.species),
    appearance: firstOf(data.appearance),
    personality: firstOf(data.personality, data.description, data.persona),
    traits: toStringList(data.traits),
    backstory: firstOf(data.backstory, data.background),
    occupation: firstOf(data.occupation, data.job),
    goals: firstOf(data.goals),
    likes: firstOf(data.likes),
    dislikes: firstOf(data.dislikes),
    speechStyle: firstOf(data.speech_style, data.speechStyle, data.speaking_style),
    customInstructions: firstOf(data.custom_instructions, data.customInstructions, data.instructions),
    tags: toStringList(data.tags),
    avatarUrl: pickAvatarUrl(data),
    isDefault: toBool(data.isDefault ?? data.is_default, false),
    customFields: collectCustomFields(data, PERSONA_KNOWN_KEYS),
  };
}

const ENTRY_KNOWN_KEYS = new Set([
  'id',
  'uid',
  'name',
  'title',
  'key',
  'keys',
  'keywords',
  'primaryKeys',
  'primary_keys',
  'keysecondary',
  'secondary_keys',
  'secondaryKeys',
  'aliases',
  'content',
  'entry',
  'text',
  'value',
  'enabled',
  'disable',
  'constant',
  'priority',
  'order',
  'insertion_order',
  'position',
  'depth',
  'scan_depth',
  'scanDepth',
  'category',
  'scope',
  'comment',
  'selective',
  'caseSensitive',
  'case_sensitive',
  'matchMode',
  'match_whole_words',
  'extensions',
  'activation',
  'lorebookId',
  'createdAt',
  'updatedAt',
]);

function normalizePosition(value: unknown): LoreEntry['position'] {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('author')) return 'author-note';
  if (text.includes('depth') || text === '4' || text === '2') return 'at-depth';
  if (text.includes('before') || text === '0') return 'before-character';
  if (text.includes('after') || text === '1') return 'after-character';
  return 'after-character';
}

export function normalizeLoreEntry(input: unknown, lorebookId: string, index = 0): LoreEntry {
  if (!isPlainObject(input)) return newLoreEntry(lorebookId);
  const data = input;
  const primary = [
    ...toStringList(data.primaryKeys ?? data.primary_keys),
    ...toStringList(data.keys),
    ...toStringList(data.key),
    ...toStringList(data.keywords),
  ];
  const secondary = [
    ...toStringList(data.secondaryKeys ?? data.secondary_keys),
    ...toStringList(data.keysecondary),
  ];
  const content = firstOf(data.content, data.entry, data.text, data.value);
  const enabled = data.disable !== undefined ? !toBool(data.disable) : toBool(data.enabled, true);
  const name =
    firstOf(data.name, data.title, data.comment) || primary[0] || `Entry ${index + 1}`;

  const matchMode: LoreEntry['matchMode'] =
    data.matchMode === 'partial' || data.match_whole_words === false
      ? 'partial'
      : data.matchMode === 'exact-phrase'
        ? 'exact-phrase'
        : 'word-boundary';

  const isConstant = toBool(data.constant, false);

  return newLoreEntry(lorebookId, {
    name,
    content,
    primaryKeys: dedupe(primary),
    secondaryKeys: dedupe(secondary),
    aliases: dedupe(toStringList(data.aliases)),
    enabled,
    priority: toNumber(data.priority, 100),
    position: normalizePosition(data.position),
    depth: toNumber(data.depth, 4),
    scanDepth: toNumber(data.scan_depth ?? data.scanDepth, 0),
    // SillyTavern world info carries these three, and Nexus used to drop them
    // silently — an imported book behaved differently here for reasons nothing
    // on screen explained.
    delay: toNumber(data.delay, 0),
    sticky: toNumber(data.sticky, 0),
    cooldown: toNumber(data.cooldown, 0),
    matchMode,
    caseSensitive: toBool(data.caseSensitive ?? data.case_sensitive, false),
    activation:
      typeof data.activation === 'string' &&
      ['always', 'keyword', 'story-only', 'chat-only', 'character-only'].includes(data.activation)
        ? (data.activation as LoreEntry['activation'])
        : isConstant
          ? 'always'
          : 'keyword',
    category: firstOf(data.category),
    scope: firstOf(data.scope) || 'any',
    comment: firstOf(data.comment),
    order: toNumber(data.order ?? data.insertion_order, index),
    customFields: collectCustomFields(data, ENTRY_KNOWN_KEYS),
  });
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Accepts every lorebook shape we've seen:
 *   { name, entries: [...] }            — Nexus / character_book
 *   { entries: { "0": {...} } }         — SillyTavern world info
 *   [ {...}, {...} ]                    — bare entry array
 *   { name, keys, content }             — a single flattened entry (V2 style)
 */
export function normalizeLorebook(input: unknown): { lorebook: Lorebook; entries: LoreEntry[] } {
  const { data } = unwrapCard(input);
  const book = newLorebook({
    name: firstOf(data.name, data.title, (data as Raw).book_name) || 'Imported Lorebook',
    description: firstOf(data.description, data.desc),
    tags: toStringList(data.tags),
    enabled: toBool(data.enabled, true),
    global: toBool(data.global, false),
    scanDepth: toNumber(data.scanDepth ?? data.scan_depth, 0),
  });

  let rawEntries: unknown[] = [];
  if (Array.isArray(input)) {
    rawEntries = input;
    book.name = 'Imported Lorebook';
  } else if (Array.isArray(data.entries)) {
    rawEntries = data.entries;
  } else if (isPlainObject(data.entries)) {
    rawEntries = Object.values(data.entries);
  } else if (Array.isArray(data.lore)) {
    rawEntries = data.lore;
  } else if (isPlainObject(data.originalData) && Array.isArray((data.originalData as Raw).entries)) {
    rawEntries = (data.originalData as Raw).entries as unknown[];
  } else if (data.content || data.keys || data.key || data.keywords) {
    // A flattened single-entry lorebook (the shape V2 produced).
    rawEntries = [data];
  }

  const entries = rawEntries
    .map((entry, i) => normalizeLoreEntry(entry, book.id, i))
    .filter((entry) => entry.content.trim() || entry.primaryKeys.length);

  return { lorebook: book, entries };
}

export function normalizeStory(input: unknown): Story {
  const { data } = unwrapCard(input);
  return newStory({
    title: firstOf(data.title, data.name) || 'Imported Story',
    description: firstOf(data.description, data.summary),
    scenario: firstOf(data.scenario, data.premise),
    authorNote: firstOf(data.authorNote, data.author_note, data.authors_note),
    tags: toStringList(data.tags),
  });
}
