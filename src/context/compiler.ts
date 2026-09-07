/**
 * Context compiler.
 *
 * Builds the exact payload sent to the model and reports, part by part, what
 * went in, what was dropped, and why. The Context Inspector renders this
 * structure verbatim — there is no second, hidden code path.
 */

import type {
  Attachment,
  ChatContentPart,
  ChatCompletionMessage,
  Character,
  Chat,
  CompiledContext,
  ContextPart,
  LoreEntry,
  LoreMiss,
  Lorebook,
  MemoryHit,
  Memory,
  Message,
  MessagePipelineRow,
  Persona,
  SceneState,
  Settings,
  Story,
  StorySummary,
} from '../types';
import { LORE_TIER_RANK } from '../types';
import type { LoreTier } from '../types';
import { scanLore } from '../lore/matcher';
import { describeControl, describeScene, resolveScene, type ResolvedScene } from './scene';
import { describeNarration, describeTurnDirective } from './narration';
import { describeNarrationStyle, selectedPresets } from '../narration/presets';
import {
  describeRelationships,
  describeStoryState,
  relevantRelationships,
} from './storyState';
import { MEMORY_TIER_RANK, rankMemories } from '../memory/relevance';
import { memoryBasis } from '../memory/matrix';
import { truncate } from '../utils/text';
import { IMAGE_TOKEN_COST, estimateTokens } from './tokens';

export interface CompileInput {
  settings: Settings;
  story: Story | null;
  chat: Chat | null;
  characters: Character[];
  persona: Persona | null;
  memories: Memory[];
  lorebooks: Lorebook[];
  loreEntries: LoreEntry[];
  /** Timeline for the active branch, oldest first. */
  history: Message[];
  /** Draft the user is about to send (not yet persisted). */
  pendingUserText?: string;
  pendingAttachments?: Attachment[];
  /** One-off instruction for "regenerate with instruction". */
  instruction?: string;
  /** Which character is being asked to reply, in a multi-character story. */
  respondingCharacterId?: string | null;
  /**
   * Who and what is in the scene right now. Absent means undeclared, which
   * resolves to the focal character alone rather than the whole cast.
   */
  scene?: SceneState | null;
  /**
   * The real usable prompt window, negotiated with the provider. Overrides the
   * configured context size, which is an aspiration rather than a capability.
   */
  budgetOverride?: number;
  /** Long-run memory. When present, older history folds into this. */
  summary?: StorySummary | null;
  /** Resolves an attachment to a data URL for vision-capable providers. */
  imageResolver?: (attachment: Attachment) => string | undefined;
  visionEnabled?: boolean;
}

export interface CompileResult extends CompiledContext {
  loreMisses: LoreMiss[];
}

/** Substitutes {{char}} / {{user}} / {{persona}} style macros. */
export function applyMacros(
  text: string,
  vars: { char: string; user: string; scenario?: string },
): string {
  if (!text) return '';
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, vars.char)
    .replace(/\{\{user\}\}|<USER>/gi, vars.user)
    .replace(/\{\{persona\}\}/gi, vars.user)
    .replace(/\{\{scenario\}\}/gi, vars.scenario ?? '');
}

function line(label: string, value: string): string {
  return value && value.trim() ? `${label}: ${value.trim()}` : '';
}

export function describeCharacter(character: Character, detailed = true): string {
  const name = character.displayName || character.name;
  const parts: string[] = [`# ${name}`];

  const identity = [
    line('Nickname', character.nickname),
    line('Age', character.age),
    line('Gender', character.gender),
    line('Pronouns', character.pronouns),
    line('Species', character.species),
    line('Race', character.race),
    line('Occupation', character.occupation),
    line('Role', character.role),
  ].filter(Boolean);
  if (identity.length) parts.push(identity.join('\n'));

  const body = [
    line('Summary', character.shortDescription),
    line('Description', character.description),
    line('Appearance', character.appearance),
    line('Physical traits', character.physicalTraits),
    line('Personality', character.personality),
    line('Temperament', character.temperament),
    line('Traits', character.traits.join(', ')),
  ].filter(Boolean);
  if (body.length) parts.push(body.join('\n'));

  if (detailed) {
    const background = [
      line('Backstory', character.backstory),
      line('History', character.history),
      line('Goals', character.goals),
      line('Motivations', character.motivations),
      line('Fears', character.fears),
      line('Secrets', character.secrets),
      line('Likes', character.likes),
      line('Dislikes', character.dislikes),
      line('Hobbies', character.hobbies),
      line('Values', character.values),
      line('Beliefs', character.beliefs),
    ].filter(Boolean);
    if (background.length) parts.push(background.join('\n'));

    const relations = [
      line('Relationships', character.relationships),
      line('Friends', character.friends),
      line('Enemies', character.enemies),
      line('Family', character.family),
      line('Romantic', character.romantic),
    ].filter(Boolean);
    if (relations.length) parts.push(relations.join('\n'));

    const world = [
      line('Home', character.home),
      line('Location', character.location),
      line('Faction', character.faction),
      line('World', character.world),
    ].filter(Boolean);
    if (world.length) parts.push(world.join('\n'));

    const voice = [
      line('Speaking style', character.speakingStyle),
      line('Speech patterns', character.speechPatterns),
    ].filter(Boolean);
    if (voice.length) parts.push(voice.join('\n'));

    const custom = character.customFields
      .filter((f) => f.key.trim() && f.value.trim())
      .map((f) => line(f.key, f.value));
    if (custom.length) parts.push(custom.join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}

export function describePersona(persona: Persona): string {
  const name = persona.displayName || persona.name;
  return [
    `# ${name} (the user's persona)`,
    [
      line('Nickname', persona.nickname),
      line('Age', persona.age),
      line('Gender', persona.gender),
      line('Pronouns', persona.pronouns),
      line('Species', persona.species),
      line('Occupation', persona.occupation),
    ]
      .filter(Boolean)
      .join('\n'),
    [
      line('Appearance', persona.appearance),
      line('Personality', persona.personality),
      line('Traits', persona.traits.join(', ')),
      line('Backstory', persona.backstory),
      line('Goals', persona.goals),
      line('Likes', persona.likes),
      line('Dislikes', persona.dislikes),
      line('Speech style', persona.speechStyle),
    ]
      .filter(Boolean)
      .join('\n'),
    persona.customFields
      .filter((f) => f.key.trim() && f.value.trim())
      .map((f) => line(f.key, f.value))
      .join('\n'),
    persona.customInstructions.trim(),
  ]
    .filter((s) => s && s.trim())
    .join('\n\n');
}

/** Below this an excerpt is too small to carry a scene, so nothing is kept. */
const MIN_EXCERPT_TOKENS = 192;

/**
 * The end of an over-long message, cut at a paragraph where possible.
 *
 * Roleplay continued from a pasted transcript arrives as one enormous message
 * whose *last* few hundred words are the exchange the next turn answers. Taking
 * the tail keeps that; taking the head or dropping the message keeps nothing
 * that matters.
 */
function tailExcerpt(content: string, budgetTokens: number): string | null {
  if (budgetTokens < MIN_EXCERPT_TOKENS) return null;
  // The estimator averages ~3.8 characters a token on prose; leave headroom.
  const chars = Math.max(0, Math.floor(budgetTokens * 3.4));
  if (chars <= 0 || content.length <= chars) return null;

  let cut = content.length - chars;
  // Prefer a paragraph break, then a sentence, so the excerpt starts cleanly.
  const paragraph = content.indexOf('\n\n', cut);
  if (paragraph !== -1 && paragraph - cut < chars / 3) cut = paragraph + 2;
  else {
    const sentence = content.search(/[.!?*"]\s/u) === -1 ? -1 : content.indexOf('. ', cut);
    if (sentence !== -1 && sentence - cut < chars / 4) cut = sentence + 2;
  }

  return `[…earlier part of this message omitted…]\n\n${content.slice(cut)}`;
}

/**
 * Marks a memory the story has not actually confirmed.
 *
 * A claim and an observation read identically once they are both a line of
 * prose in the prompt, and the model has no way to tell them apart — so a
 * character's cover story would harden into fact. Saying who claimed it lets
 * the model keep treating it as something that might be untrue.
 */
function basisSuffix(memory: Memory, input: CompileInput): string {
  const basis = memoryBasis(memory);
  if (basis === 'observed') return '';
  if (basis === 'inferred') return ' — inferred, not confirmed';
  // The claimant can be the persona as easily as a character: the person
  // playing can assert something about the world too, and it is no more
  // confirmed for that.
  const claimant =
    input.characters.find((c) => c.id === memory.statedById) ??
    (input.persona?.id === memory.statedById ? input.persona : null);
  const name = claimant?.displayName || claimant?.name;
  return name ? ` — claimed by ${name}; may not be true` : ' — claimed, not confirmed';
}

function memoryReason(memory: Memory): string {
  if (memory.pinned) return 'Pinned';
  if (memory.importance === 'critical') return 'Critical importance';
  if (memory.importance === 'high') return 'High importance';
  if (memory.importance === 'normal') return 'Normal importance';
  return 'Low importance';
}

const IMPORTANCE_RANK: Record<Memory['importance'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * How far back lore may look, and how many entries may land, whatever the
 * settings say. These are guard rails on a runaway configuration rather than
 * opinions about lorebook size: the database stays as large as the author
 * wants, the per-request slice does not.
 */
const MAX_LORE_SCAN = 40;
const MAX_LORE_ENTRIES = 40;
/** Trailing messages that count as the live conversation. */
const RECENT_WINDOW = 6;

/**
 * Kinds that survive any budget squeeze.
 *
 * Lore, memories, scenario and story blurb are all droppable: losing them costs
 * colour. Losing the persona or the scene costs the model its grip on who is
 * speaking and who is present, which is the failure this whole pass exists to
 * prevent.
 */
const UNDROPPABLE = new Set<ContextPart['kind']>(['system', 'scene', 'persona', 'instruction']);

/**
 * Where a lore hit sits in the trimming order.
 *
 * Relevance dominates the author's own priority — an entry that matched only in
 * old history ranks below one about someone in the room, whatever number the
 * lorebook gave it — but the whole band stays below the persona and the scene.
 * Lore is world knowledge; it must never outrank who is in the room, and it
 * must always remain droppable when the budget runs out.
 */
function lorePriority(hit: { tier: LoreTier; entry: { priority: number } }): number {
  return 620 + LORE_TIER_RANK[hit.tier] * 25 + Math.min(Math.max(hit.entry.priority, 0), 99) / 5;
}

/** Priority tiers, higher survives trimming (spec §44). */
/** The turn directive's part id. It is emitted as the last message, not in the system block. */
const TURN_DIRECTIVE_ID = 'turn-directive';

const PRIORITY = {
  system: 1000,
  /** Presence and control. Above everything the world merely knows. */
  scene: 970,
  /**
   * The narrator's brief. Above the scene, because who is writing has to be
   * settled before what they are writing about, and above the global system
   * prompt's tier-mate `global` so a stock "stay in character" cannot be the
   * last word on the model's role.
   */
  narration: 975,
  /**
   * Where the story stands, and how the people in the room stand with each
   * other. Live situation, so above the story's static setup; wider than the
   * scene, so below it.
   */
  storyState: 862,
  relationships: 858,
  /** A cast member who is not in the scene: recognisable, not detailed. */
  absentCharacter: 640,
  global: 950,
  /** The user's own identity. Outranks every character description. */
  persona: 920,
  character: 900,
  story: 800,
  scenario: 790,
  pinnedMemory: 780,
  criticalMemory: 770,
  lore: 700,
  memory: 600,
  authorNote: 880,
  /** Above the author's note: set from inside the chat, for this chat only. */
  direction: 890,
  instruction: 990,
  summary: 820,
  recentHistory: 500,
  olderHistory: 100,
} as const;

function part(
  id: string,
  label: string,
  kind: ContextPart['kind'],
  content: string,
  reason: string,
  priority: number,
): ContextPart {
  return {
    id,
    label,
    kind,
    content,
    tokens: estimateTokens(content),
    reason,
    included: true,
    priority,
  };
}

/**
 * How often the context has been assembled, and how long it took.
 *
 * Compiling is the most expensive synchronous work in the app — it scans every
 * lorebook, ranks memories and estimates tokens for the whole history. Counting
 * it is what makes "typing must not rebuild the context" an assertion rather
 * than an intention, so the counter is part of the app rather than a test hook.
 */
export const compileStats = { calls: 0, totalMs: 0, lastMs: 0 };

export function compileContext(input: CompileInput): CompileResult {
  const started = performance.now();
  try {
    return compileContextInner(input);
  } finally {
    compileStats.calls += 1;
    compileStats.lastMs = performance.now() - started;
    compileStats.totalMs += compileStats.lastMs;
  }
}

function compileContextInner(input: CompileInput): CompileResult {
  const { settings, story, chat, characters, persona } = input;

  const activeCharacters = characters.filter(Boolean);

  // Presence is resolved before anything else: it decides which characters are
  // described in full, which are sketched, and who may speak at all.
  const scene: ResolvedScene = resolveScene({
    scene: input.scene ?? chat?.scene ?? null,
    cast: activeCharacters,
    respondingCharacterId: input.respondingCharacterId,
  });
  const responding = scene.primary;

  const charName = responding ? responding.displayName || responding.name : 'the character';
  const userName = persona ? persona.displayName || persona.name : 'User';
  const macroVars = { char: charName, user: userName, scenario: story?.scenario ?? '' };
  const macro = (text: string) => applyMacros(text, macroVars);

  // The negotiated window wins over the configured one. A Context size of
  // 513,856 is a wish; what the model can actually hold is a fact, and building
  // to the wish is what got the prompt silently truncated at the server.
  const configured =
    chat?.settings.contextSize ?? story?.settings.contextSize ?? settings.contextBudget ?? 8192;
  // The override has already had the reply's share taken out of it, so the
  // reserve is only applied to the configured figure — subtracting it from both
  // would charge for the reply twice.
  const budget = Math.max(
    512,
    input.budgetOverride ?? configured - (settings.reserveForResponse ?? 0),
  );

  /* ------------------------------------------------------- gather parts */

  const parts: ContextPart[] = [];

  if (settings.globalSystemPrompt.trim()) {
    parts.push(
      part(
        'system',
        'System instructions',
        'system',
        macro(settings.globalSystemPrompt),
        'Always included — global system prompt from Settings.',
        PRIORITY.system,
      ),
    );
  }

  if (settings.globalInstructions.trim()) {
    parts.push(
      part(
        'global',
        'Global instructions',
        'global',
        macro(settings.globalInstructions),
        'Always included — global instructions from Settings.',
        PRIORITY.global,
      ),
    );
  }

  // Who is writing, settled before anything about the world. Without this the
  // highest-priority block in the prompt is the global system prompt, whose
  // stock wording casts the model as one character answering in turn — and a
  // model cast that way replies with a line of dialogue and no scene around it.
  const carriedTranscript = input.history.some((m) => m.historical);
  const narrationInput = {
    scene,
    personaName: userName,
    hasCarriedTranscript: carriedTranscript,
  };
  parts.push(
    part(
      'narration',
      'You are the narrator',
      'scene',
      macro(describeNarration(narrationInput)),
      'Always included — Nexus narrates a world rather than playing one character.',
      PRIORITY.narration,
    ),
  );
  // How the narrator writes, as opposed to what it knows. The chat's selection
  // wins over the story's; `null` on the chat means inherit, while an empty
  // array is a deliberate "none", which is why the check is for null.
  const presetIds = chat?.narrationPresetIds ?? story?.narrationPresetIds ?? [];
  const styleBlock = describeNarrationStyle(
    selectedPresets(presetIds, settings.narrationPresets ?? []),
  );
  if (styleBlock.trim()) {
    parts.push(
      part(
        'narration-style',
        'Narration style',
        'scene',
        macro(styleBlock),
        `${presetIds.length} narration preset(s) selected for this chat.`,
        PRIORITY.narration - 1,
      ),
    );
  }

  // Sent as the final message rather than inside the system block — see the
  // splice at the end of this function. It is registered here so its tokens are
  // budgeted and it appears in the inspector like every other part.
  parts.push(
    part(
      TURN_DIRECTIVE_ID,
      'This turn',
      'instruction',
      macro(describeTurnDirective(narrationInput)),
      'Sent last, after the history, where it cannot be crowded out.',
      PRIORITY.instruction,
    ),
  );

  // Presence and control, stated once, in a tier that cannot be trimmed.
  // Both blocks are emitted for every chat, including one-character chats:
  // the rule that the model must not write the user used to live inside a
  // multi-character branch, so the commonest configuration had no rule at all.
  parts.push(
    part(
      'scene',
      'Current scene',
      'scene',
      macro(describeScene(scene, userName)),
      scene.declared
        ? 'Scene state declared for this chat.'
        : 'No scene declared — presence falls back to the focal character.',
      PRIORITY.scene,
    ),
  );
  // A pasted transcript is a record of what happened, not a turn just taken.
  // Without saying so, the model reads it as its own most recent output and
  // imitates it wholesale — including the user's lines, and including every
  // character who happened to be named in it.
  if (carriedTranscript) {
    parts.push(
      part(
        'historical-frame',
        'Earlier roleplay',
        'scene',
        'Part of the conversation below is a record of earlier roleplay, not ' +
          'events happening now. Treat the names in it as the story’s past. ' +
          'Who is in the scene is defined above, not by who appears in that record.\n\n' +
          `That record was written as a whole scene, so it contains lines for ` +
          `${userName} as well as for the cast. That is how it was set down, not a ` +
          `pattern to continue: from here ${userName}'s words, actions and choices ` +
          `belong to the user alone.`,
        'The history contains messages carried in from earlier play.',
        PRIORITY.scene - 10,
      ),
    );
  }

  parts.push(
    part(
      'control',
      'Who controls whom',
      'scene',
      macro(describeControl(scene, userName)),
      'The persona is the user; the model narrates everyone else present.',
      PRIORITY.scene - 5,
    ),
  );

  // Characters in the scene are described in full. Characters who merely exist
  // in this story get a one-line sketch: enough to be recognisable if the story
  // brings them in, not enough to crowd out the scene that is actually running.
  activeCharacters.forEach((character, index) => {
    const isResponder = character.id === responding?.id;
    const isPresent = scene.present.some((c) => c.id === character.id);
    if (!isPresent) {
      const sketch = character.shortDescription.trim() || character.description.trim();
      parts.push(
        part(
          `character:${character.id}`,
          `Character — ${character.displayName || character.name} (not in the scene)`,
          'character',
          macro(
            `# ${character.displayName || character.name} (not present)\n` +
              (sketch ? truncate(sketch, 240) : 'Part of this world; not in the current scene.'),
          ),
          'In the cast but not in the scene — summarised rather than described.',
          PRIORITY.absentCharacter - index,
        ),
      );
      return;
    }
    parts.push(
      part(
        `character:${character.id}`,
        `Character — ${character.displayName || character.name}${isResponder ? ' (speaking)' : ''}`,
        'character',
        macro(describeCharacter(character, true)),
        isResponder
          ? 'The character generating this reply.'
          : `Present in the scene (#${index + 1}).`,
        isResponder ? PRIORITY.character : PRIORITY.character - 10 - index,
      ),
    );

    if (character.systemPrompt.trim()) {
      parts.push(
        part(
          `character-system:${character.id}`,
          `${character.displayName || character.name} — system prompt`,
          'system',
          macro(character.systemPrompt),
          'Character-specific system prompt.',
          PRIORITY.system - 5,
        ),
      );
    }
    // Example dialogue used to be pasted in raw. Character-card examples are
    // short quoted exchanges, and a block of those sitting unlabelled in the
    // system prompt reads as a template for the shape of a reply, not a sample
    // of a voice — which is one way a narrator ends up writing two lines of
    // dialogue and nothing else. Saying what it is for costs three sentences.
    if (character.exampleDialogue.trim()) {
      const name = character.displayName || character.name;
      parts.push(
        part(
          `character-examples:${character.id}`,
          `${name} — example dialogue`,
          'character',
          macro(
            `## How ${name} sounds\n` +
              `The lines below are a sample of ${name}'s voice: word choice, rhythm, ` +
              `temperament, what they will and will not say. Match the voice.\n` +
              `Do not match their length or their layout — they are excerpts lifted out of ` +
              `scenes, not a shape for your turn.\n\n` +
              character.exampleDialogue,
          ),
          'Example dialogue teaches the model the character voice.',
          PRIORITY.character - 100,
        ),
      );
    }
  });

  // Per-story character notes, for characters in the scene. A note about how
  // someone stands in this story is scene context; for someone who is not here
  // it is backstory, and backstory that reads like current state is what makes
  // an absent character feel available.
  for (const link of story?.characters ?? []) {
    if (!link.enabled || !link.note.trim()) continue;
    const character = scene.present.find((c) => c.id === link.characterId);
    if (!character) continue;
    parts.push(
      part(
        `character-note:${link.characterId}`,
        `${character.displayName || character.name} — story note`,
        'story',
        macro(link.note),
        'Per-story note attached to this character.',
        PRIORITY.character - 20,
      ),
    );
  }

  if (persona) {
    parts.push(
      part(
        `persona:${persona.id}`,
        `Persona — ${persona.displayName || persona.name}`,
        'persona',
        macro(describePersona(persona)),
        'The persona the user is playing.',
        PRIORITY.persona,
      ),
    );
  }

  // The wider situation, and the standings inside it. Both are story-owned and
  // both are filtered by what the scene actually holds: a relationship between
  // two people who are not here is background, not context.
  const stateBlock = macro(describeStoryState(story?.state));
  if (stateBlock.trim()) {
    parts.push(
      part(
        'story-state',
        'Where the story stands',
        'story',
        stateBlock,
        'Current arc, time, tension and open threads for this story.',
        PRIORITY.storyState,
      ),
    );
  }

  if (story) {
    const participants: Array<{ id: string; name: string }> = [
      ...scene.present.map((c) => ({ id: c.id, name: c.displayName || c.name })),
      ...(persona ? [{ id: persona.id, name: persona.displayName || persona.name }] : []),
    ];
    const presentIds = new Set(participants.map((p) => p.id));
    const active = relevantRelationships(story.relationships, presentIds);
    const relationshipBlock = macro(describeRelationships(active, participants));
    if (relationshipBlock.trim()) {
      parts.push(
        part(
          'relationships',
          'How they stand',
          'story',
          relationshipBlock,
          `${active.length} relationship(s) between people in this scene.`,
          PRIORITY.relationships,
        ),
      );
    }
  }

  if (story) {
    const storyBlock = [
      story.title ? `# Story: ${story.title}` : '',
      story.description.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (storyBlock.trim()) {
      parts.push(
        part(
          `story:${story.id}`,
          'Story',
          'story',
          macro(storyBlock),
          'Story title and description.',
          PRIORITY.story,
        ),
      );
    }
    const scenario = story.scenario.trim() || responding?.scenario?.trim() || '';
    if (scenario) {
      parts.push(
        part(
          'scenario',
          'Scenario',
          'scenario',
          macro(`## Scenario\n${scenario}`),
          story.scenario.trim() ? 'Story scenario.' : 'Falls back to the character scenario.',
          PRIORITY.scenario,
        ),
      );
    }
    // What holds for the whole campaign, as opposed to the situation the
    // scenario describes. Rules rank with the scenario because breaking them
    // breaks the world; the timeline sits just under, being history.
    if (story.rules?.trim()) {
      parts.push(
        part(
          'rules',
          'World rules',
          'story',
          macro(
            `## How this world works\n${story.rules.trim()}\n\n` +
              'These hold for the whole story. Do not write anything that contradicts them.',
          ),
          'World rules set for this story.',
          PRIORITY.scenario + 1,
        ),
      );
    }
    if (story.timeline?.trim()) {
      parts.push(
        part(
          'timeline',
          'Timeline',
          'story',
          macro(
            `## What has already happened\n${story.timeline.trim()}\n\n` +
              'This is the story’s past, not the current scene.',
          ),
          'Story timeline.',
          PRIORITY.scenario - 1,
        ),
      );
    }
  } else if (responding?.scenario?.trim()) {
    parts.push(
      part(
        'scenario',
        'Scenario',
        'scenario',
        macro(`## Scenario\n${responding.scenario}`),
        'Character scenario (no story attached).',
        PRIORITY.scenario,
      ),
    );
  }

  /* ------------------------------------------------------ story summary */

  // Long-run memory sits above lore and below the cast: it is the story's
  // spine, and dropping it is what makes a months-old roleplay lose the plot.
  const summary = settings.useStorySummary ? (input.summary ?? null) : null;
  if (summary) {
    if (summary.currentSummary.trim()) {
      parts.push(
        part(
          'summary-current',
          'Story summary — where things stand',
          'memory',
          macro(`## Story so far\n${summary.currentSummary}`),
          'Long-run memory: the current state of the story.',
          PRIORITY.summary,
        ),
      );
    }
    if (summary.rollingSummary.trim()) {
      parts.push(
        part(
          'summary-rolling',
          'Story summary — history',
          'memory',
          macro(`## Earlier history (compacted)\n${summary.rollingSummary}`),
          'Long-run memory: replaces older messages that were trimmed from history.',
          PRIORITY.summary - 5,
        ),
      );
    }
    if (summary.importantEvents.length) {
      parts.push(
        part(
          'summary-events',
          'Story summary — key events',
          'memory',
          macro(`## Key events\n${summary.importantEvents.map((e) => `- ${e}`).join('\n')}`),
          'Long-run memory: beats flagged as never-forget.',
          PRIORITY.summary - 10,
        ),
      );
    }
    if (summary.relationshipState.trim()) {
      parts.push(
        part(
          'summary-relationships',
          'Story summary — relationships',
          'memory',
          macro(`## Relationships\n${summary.relationshipState}`),
          'Long-run memory: how the cast stands with each other.',
          PRIORITY.summary - 15,
        ),
      );
    }
    const states = Object.entries(summary.characterState).filter(([, v]) => v.trim());
    if (states.length) {
      parts.push(
        part(
          'summary-character-state',
          'Story summary — character state',
          'memory',
          macro(
            `## Character state\n${states
              .map(([id, state]) => {
                const character = activeCharacters.find((c) => c.id === id);
                return `- ${character?.displayName || character?.name || id}: ${state}`;
              })
              .join('\n')}`,
          ),
          'Long-run memory: each character\u2019s current condition and goal.',
          PRIORITY.summary - 20,
        ),
      );
    }
  }

  /* --------------------------------------------------------------- lore */

  // History arrives with each message's active alternative already applied.
  //
  // The window is bounded for its own sake. A scan depth of 80,000 multiplied
  // out to a slice of the entire history, so every name in a pasted transcript
  // — Edgeshot, Deku, half of class 1-A — activated its own entry as though the
  // roleplay were about them. Depth still controls how far back to look; it no
  // longer controls whether looking back is bounded at all.
  const scanDepth = Math.min(Math.max(settings.loreScanDepth || 8, 1), MAX_LORE_SCAN);
  const recentTexts = input.history.slice(-scanDepth).map((m) => m.content);

  const loreScan = scanLore({
    recentTexts,
    // The user's unsent message is the strongest evidence of what this turn is
    // about, so it is scanned as its own band rather than appended to history.
    currentText: input.pendingUserText ?? '',
    sceneNames: [
      ...scene.present.map((c) => c.displayName || c.name),
      scene.location,
      scene.situation,
    ].filter(Boolean),
    recentWindow: RECENT_WINDOW,
    // The turn is identified by the newest message, so a regeneration of the
    // same turn rolls the same probabilities.
    turnSeed: input.history.at(-1)?.id ?? chat?.id ?? '',
    ambientText: [story?.scenario ?? '', persona?.personality ?? ''].filter(Boolean).join('\n'),
    lorebooks: input.lorebooks,
    entries: input.loreEntries,
    scope: {
      source: story ? 'story' : 'chat',
      storyLorebookIds: story?.lorebookIds ?? [],
      chatLorebookIds: chat?.lorebookIds ?? [],
      characterLorebookIds: activeCharacters.flatMap((c) => c.lorebookIds),
    },
    defaultScanDepth: scanDepth,
    maxEntries: Math.min(Math.max(settings.maxLoreEntries || 12, 1), MAX_LORE_ENTRIES),
  });

  /**
   * Entries destined for the message list rather than the system prompt.
   * `at-depth` means "N turns from the end", which is a position in the
   * conversation and cannot be expressed by sorting the system block.
   */
  const atDepthLore: Array<{ depth: number; content: string }> = [];

  for (const hit of loreScan.hits) {
    const heading = hit.entry.name ? `## ${hit.entry.name}` : '';
    const content = macro([heading, hit.entry.content].filter(Boolean).join('\n'));

    if (hit.entry.position === 'at-depth') {
      atDepthLore.push({ depth: Math.max(0, hit.entry.depth || 0), content });
      // Still recorded as a part so the inspector accounts for its tokens.
      parts.push(
        part(
          `lore:${hit.entry.id}`,
          `Lore — ${hit.entry.name || 'Untitled entry'} (${hit.lorebookName})`,
          'lore',
          '',
          `${hit.reason} — injected ${hit.entry.depth} message(s) from the end.`,
          lorePriority(hit),
        ),
      );
      continue;
    }

    // Position decides where in the system block an entry lands. It was stored
    // and shown in the editor but never read, so an author who placed a rule
    // before the character description got it after, every time.
    const positional =
      hit.entry.position === 'before-character'
        ? PRIORITY.character + 30
        : hit.entry.position === 'author-note'
          ? PRIORITY.authorNote - 1
          : lorePriority(hit);

    parts.push(
      part(
        `lore:${hit.entry.id}`,
        `Lore — ${hit.entry.name || 'Untitled entry'} (${hit.lorebookName})`,
        'lore',
        content,
        hit.reason,
        positional,
      ),
    );
  }

  /* ------------------------------------------------------------ memories */

  // Ranked against the scene rather than by importance alone. The old order —
  // pinned, then importance, then recency — could not see what was happening,
  // so a memory about someone who is not in the room outranked one about the
  // moment being played simply for being newer.
  const rankedMemories = rankMemories({
    memories: input.memories,
    storyId: story?.id ?? null,
    presentCharacterIds: scene.present.map((c) => c.id),
    sceneText: [scene.location, scene.situation, scene.objective, ...scene.present.map((c) => c.name)]
      .filter(Boolean)
      .join('\n'),
    currentText: input.pendingUserText ?? '',
    recentText: input.history
      .slice(-RECENT_WINDOW)
      .map((m) => m.content)
      .join('\n'),
    limit: Math.max(0, settings.maxMemories),
  });

  const memoryHits: MemoryHit[] = [];
  for (const ranked of rankedMemories) {
    const memory = ranked.memory;
    const reason = `${ranked.reason} ${memoryReason(memory)}.`;
    memoryHits.push({ memory, reason });
    // Pinned and critical keep their own tiers, as before. Everything else is
    // banded by relevance so a scene-relevant memory outranks a background one
    // however important the background one calls itself.
    const priority = memory.pinned
      ? PRIORITY.pinnedMemory
      : memory.importance === 'critical'
        ? PRIORITY.criticalMemory
        : PRIORITY.memory + MEMORY_TIER_RANK[ranked.tier] * 8 + IMPORTANCE_RANK[memory.importance];
    parts.push(
      part(
        `memory:${memory.id}`,
        `Memory — ${memory.title || 'Untitled'}`,
        'memory',
        macro(
          `## ${memory.title || 'Memory'} [${memory.category}]${basisSuffix(memory, input)}\n${memory.content}`,
        ),
        `Included because: ${reason}.`,
        priority,
      ),
    );
  }

  /* -------------------------------------------------------- author note */

  const authorNote = [story?.authorNote ?? '', responding?.authorNote ?? '']
    .filter((s) => s.trim())
    .join('\n\n');
  if (authorNote.trim()) {
    parts.push(
      part(
        'author-note',
        "Author's note",
        'author-note',
        macro(authorNote),
        "Author's note is injected near the end for maximum steering weight.",
        PRIORITY.authorNote,
      ),
    );
  }

  // Set from inside the conversation. Sits in the same high tier as the
  // author's note, so it steers just as strongly and survives trimming.
  if (chat?.direction?.trim()) {
    parts.push(
      part(
        'direction',
        'Direction',
        'direction',
        macro(chat.direction),
        'Direction you set for this chat. Applies to this chat only.',
        PRIORITY.direction,
      ),
    );
  }

  if (input.instruction?.trim()) {
    parts.push(
      part(
        'instruction',
        'Regeneration instruction',
        'instruction',
        macro(input.instruction),
        'One-off instruction supplied for this generation.',
        PRIORITY.instruction,
      ),
    );
  }

  /* ---------------------------------------------------------- budgeting */

  const fixedTokens = parts.reduce((sum, p) => sum + p.tokens, 0);

  // History is budgeted separately: newest messages are kept first.
  const historyParts: ContextPart[] = [];
  const historyLimit = Math.max(1, settings.historyLimit || 200);
  // Anything the rolling summary already covers is represented above, so only
  // the verbatim window needs to be sent. This is what keeps a 5,000-message
  // story inside a fixed token budget.
  const summarised =
    summary && summary.rollingSummary.trim()
      ? input.history.filter((m) => m.order > summary.coveredThroughOrder)
      : input.history;
  const effectiveLimit = summary?.rollingSummary.trim()
    ? Math.min(historyLimit, Math.max(2, settings.summaryWindow || 30))
    : historyLimit;
  const consideredHistory = summarised.slice(-effectiveLimit);

  for (let i = consideredHistory.length - 1; i >= 0; i -= 1) {
    const message = consideredHistory[i];
    const content = message.content;
    if (!content.trim() && !message.attachments.length) continue;
    const distanceFromEnd = consideredHistory.length - 1 - i;
    const speaker =
      message.role === 'user'
        ? userName
        : activeCharacters.find((c) => c.id === message.characterId)?.name ?? charName;
    historyParts.unshift({
      id: `history:${message.id}`,
      label: `${speaker} (${message.role})`,
      kind: 'history',
      content,
      tokens:
        estimateTokens(content) +
        message.attachments.filter((a) => a.kind === 'image').length * IMAGE_TOKEN_COST,
      reason: distanceFromEnd < 10 ? 'Recent message.' : `Message #${i + 1} in this branch.`,
      included: true,
      priority: distanceFromEnd < 10 ? PRIORITY.recentHistory : PRIORITY.olderHistory,
    });
  }

  const pendingTokens = input.pendingUserText
    ? estimateTokens(input.pendingUserText) +
      (input.pendingAttachments?.length ?? 0) * IMAGE_TOKEN_COST
    : 0;

  const excluded: ContextPart[] = [];
  let historyBudget = budget - fixedTokens - pendingTokens;

  const keptHistory: ContextPart[] = [];
  /** Part ids that were shortened, and what they originally cost. */
  const excerpted = new Map<string, number>();
  for (let i = historyParts.length - 1; i >= 0; i -= 1) {
    const hp = historyParts[i];
    if (historyBudget - hp.tokens < 0 && keptHistory.length > 0) {
      // A message too large to fit used to be dropped whole. For a roleplay
      // continued by pasting a transcript, that single message *is* the entire
      // previous story — so the turn the user is actually replying to went
      // missing, and the model was left with a scene heading and one line of
      // input. Keep the end of it instead: the tail is the part the current
      // turn refers to.
      const excerpt = tailExcerpt(hp.content, historyBudget);
      if (excerpt) {
        const tokens = estimateTokens(excerpt);
        excerpted.set(hp.id, hp.tokens);
        historyBudget -= tokens;
        keptHistory.unshift({
          ...hp,
          content: excerpt,
          tokens,
          reason: 'Too large for the budget — kept the most recent part.',
        });
        excluded.push({
          ...hp,
          included: false,
          reason: 'Only the end of this message fitted the context budget.',
        });
        continue;
      }
      // Everything older stops here. Skipping this message and carrying on to
      // older ones sieves the conversation instead of windowing it: long
      // assistant turns get rejected while the one-line questions between them
      // fit, and the model is handed six of the user's questions in a row with
      // the answers missing. A shorter unbroken conversation is worth far more
      // than a longer one full of holes.
      for (let j = i; j >= 0; j -= 1) {
        excluded.push({
          ...historyParts[j],
          included: false,
          reason: 'Trimmed — older than the context budget.',
        });
      }
      break;
    }
    historyBudget -= hp.tokens;
    keptHistory.unshift(hp);
  }

  // If fixed parts alone blow the budget, drop the lowest-priority ones.
  let finalParts = parts;
  let overBudget = false;
  let totalFixed = fixedTokens;
  if (totalFixed + pendingTokens > budget) {
    overBudget = true;
    const sorted = [...parts].sort((a, b) => a.priority - b.priority);
    const dropped = new Set<string>();
    for (const candidate of sorted) {
      if (totalFixed + pendingTokens <= budget) break;
      // Never drop what the roleplay cannot run without. This is a rule about
      // what a part *is*, not where it happened to land in the ordering: a
      // numeric cliff silently reclassifies things whenever a priority moves,
      // and the parts that must survive are exactly the ones that say who the
      // user is, who is in the room, and what the model must not do.
      if (UNDROPPABLE.has(candidate.kind)) continue;
      dropped.add(candidate.id);
      totalFixed -= candidate.tokens;
      excluded.push({
        ...candidate,
        included: false,
        reason: `${candidate.reason} — dropped: context budget exceeded.`,
      });
    }
    finalParts = parts.filter((p) => !dropped.has(p.id));
  }

  const allParts = [...finalParts, ...keptHistory];
  const totalTokens = allParts.reduce((sum, p) => sum + p.tokens, 0) + pendingTokens;

  /* ------------------------------------------------------ build payload */

  const systemPrompt = finalParts
    .filter((p) => p.kind !== 'history' && p.id !== TURN_DIRECTIVE_ID)
    .sort((a, b) => b.priority - a.priority)
    .map((p) => p.content)
    .filter(Boolean)
    .join('\n\n---\n\n');

  const payload: ChatCompletionMessage[] = [];
  const pipeline: MessagePipelineRow[] = [];
  const trace = (
    row: Omit<MessagePipelineRow, 'index' | 'head' | 'tail'>,
    content: string,
  ) => {
    pipeline.push({
      ...row,
      index: payload.length - 1,
      head: content.slice(0, 150),
      tail: content.length > 150 ? content.slice(-300) : '',
    });
  };

  if (systemPrompt.trim()) {
    payload.push({ role: 'system', content: systemPrompt });
    trace(
      {
        apiRole: 'system',
        storedRole: null,
        sender: 'Nexus (assembled prompt)',
        characterId: null,
        historical: false,
        excerpted: false,
        originalTokens: estimateTokens(systemPrompt),
        finalTokens: estimateTokens(systemPrompt),
      },
      systemPrompt,
    );
  }

  const messageById = new Map(consideredHistory.map((m) => [`history:${m.id}`, m]));
  for (const hp of keptHistory) {
    const message = messageById.get(hp.id);
    if (!message) continue;
    const attributed = attribute(message, hp.content, scene);
    payload.push(toApiMessage(message, attributed, input));
    trace(
      {
        apiRole: message.role,
        storedRole: message.role,
        sender:
          message.role === 'user'
            ? userName
            : activeCharacters.find((c) => c.id === message.characterId)?.name ?? charName,
        characterId: message.characterId ?? null,
        historical: Boolean(message.historical),
        excerpted: excerpted.has(hp.id),
        originalTokens: excerpted.get(hp.id) ?? hp.tokens,
        finalTokens: estimateTokens(attributed),
      },
      attributed,
    );
  }

  if (input.pendingUserText || input.pendingAttachments?.length) {
    const text = input.pendingUserText ?? '';
    payload.push(
      toApiMessage(
        {
          role: 'user',
          attachments: input.pendingAttachments ?? [],
        } as Message,
        text,
        input,
      ),
    );
    trace(
      {
        apiRole: 'user',
        storedRole: null,
        sender: `${userName} (this turn)`,
        characterId: null,
        historical: false,
        excerpted: false,
        originalTokens: estimateTokens(text),
        finalTokens: estimateTokens(text),
      },
      text,
    );
  }

  // `at-depth` lore is spliced into the conversation, counting back from the
  // newest message. Deepest first so that inserting one does not shift the
  // index the next was measured against.
  for (const item of [...atDepthLore].sort((a, b) => b.depth - a.depth)) {
    const index = Math.max(
      systemPrompt.trim() ? 1 : 0,
      payload.length - Math.max(0, item.depth),
    );
    payload.splice(index, 0, { role: 'system', content: item.content });
  }

  // The turn directive goes last, after the user's message.
  //
  // Position is the whole point. Dumping the real request showed the narrator's
  // brief ninety lines above the turn it governs, with the scene, the cast, the
  // story, the lore and the entire transcript in between — so the final thing
  // the model read was a short user line that happened to be a question, and a
  // chat-tuned model answers a question. This is the same brief's last word,
  // sitting where it cannot be crowded out.
  const turnDirective = finalParts.find((p) => p.id === TURN_DIRECTIVE_ID)?.content ?? '';
  if (turnDirective.trim()) {
    payload.push({ role: 'system', content: turnDirective });
    trace(
      {
        apiRole: 'system',
        storedRole: null,
        sender: 'Nexus (turn directive)',
        characterId: null,
        historical: false,
        excerpted: false,
        originalTokens: estimateTokens(turnDirective),
        finalTokens: estimateTokens(turnDirective),
      },
      turnDirective,
    );
  }

  return {
    systemPrompt,
    messages: payload,
    pipeline,
    parts: allParts,
    excluded,
    totalTokens,
    budget,
    overBudget: overBudget || totalTokens > budget,
    loreHits: loreScan.hits,
    loreMisses: loreScan.misses,
    memoryHits,
  };
}


/**
 * Names the speaker of an assistant turn, on the wire.
 *
 * The compiler has always worked out who was speaking, but only to label the
 * row in the Context Inspector — the message that actually left carried
 * `{ role: 'assistant', content }` and nothing else. In a scene with more than
 * one character that throws away the only thing distinguishing one voice from
 * another, and the model has to guess who it just was.
 *
 * A transcript carried over from an earlier session is left alone: it already
 * labels its own speakers inline, and prefixing one name onto a passage
 * containing several would be a lie about its contents.
 */
function attribute(message: Message, content: string, scene: ResolvedScene): string {
  if (message.role !== 'assistant') return content;
  // Historical messages used to be skipped wholesale. That was right for a
  // pasted transcript — one message holding a whole scene has no single
  // speaker, and naming one would be false — but it also threw away the
  // attribution an imported log carries per message, which the file itself
  // supplied. The distinction is what the content *is*, not how it got here.
  if (message.historical && message.speakerScope !== 'turn') return content;
  if (scene.present.length < 2) return content;
  const speaker = scene.present.find((c) => c.id === message.characterId);
  if (!speaker) return content;
  const name = speaker.displayName || speaker.name;
  if (!name || content.trimStart().startsWith(`${name}:`)) return content;
  return `${name}: ${content}`;
}

function toApiMessage(
  message: Message,
  content: string,
  input: CompileInput,
): ChatCompletionMessage {
  const images = (message.attachments ?? []).filter((a) => a.kind === 'image');
  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'file' && a.text);

  let text = content;
  for (const file of textFiles) {
    text += `\n\n[Attached file: ${file.filename}]\n${file.text}`;
  }

  if (!images.length || !input.visionEnabled || !input.imageResolver) {
    const noted = images.length
      ? `${text}\n\n[${images.length} image attachment${images.length > 1 ? 's' : ''}: ${images
          .map((i) => i.filename)
          .join(', ')}]`
      : text;
    return { role: message.role, content: noted };
  }

  const contentParts: ChatContentPart[] = [];
  if (text.trim()) contentParts.push({ type: 'text', text });
  for (const image of images) {
    const url = input.imageResolver(image);
    if (url) contentParts.push({ type: 'image_url', image_url: { url } });
  }
  if (!contentParts.length) contentParts.push({ type: 'text', text });
  return { role: message.role, content: contentParts };
}

/** Flattens a compiled context to plain text for copy-to-clipboard. */
export function contextToText(compiled: CompiledContext): string {
  const lines: string[] = ['===== SYSTEM =====', compiled.systemPrompt, ''];
  for (const message of compiled.messages) {
    if (message.role === 'system') continue;
    const body =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((p) => (p.type === 'text' ? p.text : `[image: ${p.image_url.url.slice(0, 48)}…]`))
            .join('\n');
    lines.push(`===== ${message.role.toUpperCase()} =====`, body, '');
  }
  lines.push(`===== ESTIMATE: ${compiled.totalTokens} / ${compiled.budget} tokens =====`);
  return lines.join('\n');
}
