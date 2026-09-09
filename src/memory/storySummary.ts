/**
 * Long-run memory.
 *
 * A months-long roleplay cannot keep sending its entire history, and simply
 * truncating it makes the model forget its own plot. The rolling summary
 * compacts everything older than the verbatim window, so the model keeps the
 * thread while the token cost stays flat.
 *
 * Every generation has a deterministic local fallback so the feature works
 * without an AI provider.
 */

import type {
  Branch,
  Character,
  ID,
  Message,
  Persona,
  Provider,
  Story,
  StorySummary,
} from '../types';
import { complete } from '../ai/client';
import { branchChain } from '../services/timeline';
import { newStorySummary } from '../types/factories';
import { uid } from '../utils/uid';
import { truncate } from '../utils/text';

export interface SummarizeStoryInput {
  story: Story;
  existing: StorySummary | null;
  characters: Character[];
  persona: Persona | null;
  /** Full branch timeline, oldest first. */
  timeline: Message[];
  /** Messages newer than this stay verbatim and are not folded in. */
  window: number;
  provider: Provider | null;
  signal?: AbortSignal;
}

export interface SummaryDraft {
  currentSummary: string;
  rollingSummary: string;
  importantEvents: string[];
  relationshipState: string;
  characterState: Record<string, string>;
  coveredThroughOrder: number;
  generatedBy: 'ai' | 'fallback';
  note?: string;
}

function speakerName(
  message: Message,
  characters: Character[],
  persona: Persona | null,
): string {
  if (message.role === 'user') return persona?.displayName || persona?.name || 'User';
  const character = characters.find((c) => c.id === message.characterId);
  return character?.displayName || character?.name || 'Character';
}

function transcript(messages: Message[], characters: Character[], persona: Persona | null): string {
  return messages
    .map((m) => `${speakerName(m, characters, persona)}: ${m.content.trim()}`)
    .join('\n\n');
}

const SUMMARY_SYSTEM = `You maintain the long-term memory of an ongoing roleplay.
You will receive the previous summary (which may be empty) and the transcript of scenes that have since occurred.
Produce an updated memory. Return ONLY a JSON object with these keys:
{
  "currentSummary": string,      // 2-5 sentences: where the story stands right now
  "rollingSummary": string,      // the previous summary merged with the new scenes, compact but complete
  "importantEvents": string[],   // up to 12 short factual beats, newest last
  "relationshipState": string,   // 1-3 sentences on how the characters stand with each other
  "characterState": { "<character name>": string }  // one short line per character: where they stand and what they want
}
Character state is long-run standing, not a scene report: what each character has become, what they are committed to, what they are after.
Do not put their present location or physical condition here — those belong to the current scene and change from turn to turn.
Never invent events. Preserve earlier facts unless the new scenes contradict them. No commentary.`;

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Which messages have not yet been folded into the rolling summary. */
export function pendingMessages(input: SummarizeStoryInput): Message[] {
  const covered = input.existing?.coveredThroughOrder ?? -1;
  // Everything except the verbatim window is a candidate for summarising.
  const foldable = input.timeline.slice(0, Math.max(0, input.timeline.length - input.window));
  return foldable.filter((m) => m.order > covered);
}

/** Deterministic extractive fallback used when no provider is configured. */
export function fallbackSummary(input: SummarizeStoryInput): SummaryDraft {
  const pending = pendingMessages(input);
  const source = pending.length ? pending : input.timeline;
  const previous = input.existing;

  const sentences: Array<{ text: string; score: number; index: number }> = [];
  let index = 0;
  for (const message of source) {
    const speaker = speakerName(message, input.characters, input.persona);
    const parts = message.content
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25);
    for (const sentence of parts) {
      let score = Math.min(sentence.length / 70, 2);
      if (/\b[A-Z][a-z]{2,}\b/.test(sentence)) score += 1;
      if (/\b(never|always|must|promise|swear|betray|kill|die|love|leave|return|reveal)\b/i.test(sentence)) {
        score += 1.5;
      }
      if (/^["“']/.test(sentence)) score -= 0.5;
      sentences.push({ text: `${speaker}: ${sentence}`, score, index });
      index += 1;
    }
  }

  sentences.sort((a, b) => b.score - a.score);
  const picked = sentences.slice(0, 10);
  picked.sort((a, b) => a.index - b.index);

  const newEvents = picked.slice(0, 6).map((s) => truncate(s.text, 140));
  const importantEvents = [...(previous?.importantEvents ?? []), ...newEvents].slice(-12);

  const rolling = [previous?.rollingSummary ?? '', picked.map((s) => `• ${truncate(s.text, 160)}`).join('\n')]
    .filter((s) => s.trim())
    .join('\n');

  const lastOrder = source.length ? source[source.length - 1].order : (previous?.coveredThroughOrder ?? -1);

  return {
    currentSummary:
      picked
        .slice(-3)
        .map((s) => truncate(s.text, 180))
        .join(' ') || previous?.currentSummary || '',
    rollingSummary: truncate(rolling, 4000),
    importantEvents,
    relationshipState: previous?.relationshipState ?? '',
    characterState: previous?.characterState ?? {},
    coveredThroughOrder: lastOrder,
    generatedBy: 'fallback',
    note:
      'Summarised locally without AI. Edit it freely — this is a draft, nothing is saved until you press Save.',
  };
}

export async function generateStorySummary(input: SummarizeStoryInput): Promise<SummaryDraft> {
  const pending = pendingMessages(input);
  const source = pending.length ? pending : input.timeline;

  if (!source.length) {
    const existing = input.existing ?? newStorySummary(input.story.id);
    return {
      currentSummary: existing.currentSummary,
      rollingSummary: existing.rollingSummary,
      importantEvents: existing.importantEvents,
      relationshipState: existing.relationshipState,
      characterState: existing.characterState,
      coveredThroughOrder: existing.coveredThroughOrder,
      generatedBy: 'fallback',
      note: 'There is nothing new to summarise yet.',
    };
  }

  if (!input.provider?.model) {
    return {
      ...fallbackSummary(input),
      note:
        'No AI provider is configured, so this summary was built locally. Edit it before saving, ' +
        'or set up a provider in Settings for a better one.',
    };
  }

  const previousBlock = input.existing?.rollingSummary?.trim()
    ? `Previous summary:\n${input.existing.rollingSummary}\n\n`
    : '';

  try {
    const reply = await complete({
      // Background work: never let it overwrite the inspector's view of the
      // roleplay request.
      purpose: 'utility',
      provider: input.provider,
      signal: input.signal,
      settings: { temperature: 0.3, maxTokens: 1200, streaming: false },
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: `${previousBlock}New scenes:\n\n${truncate(
            transcript(source, input.characters, input.persona),
            16000,
          )}`,
        },
      ],
    });

    const parsed = extractJson(reply);
    if (!parsed) {
      return {
        ...fallbackSummary(input),
        note: 'The AI reply was not valid JSON, so a local summary was used instead.',
      };
    }

    const asStringArray = (value: unknown): string[] =>
      Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : [];

    const characterState: Record<string, string> = {};
    if (parsed.characterState && typeof parsed.characterState === 'object') {
      for (const [name, value] of Object.entries(parsed.characterState as Record<string, unknown>)) {
        // The model answers with display names; map back to ids where we can.
        const match = input.characters.find(
          (c) =>
            (c.displayName || c.name).toLowerCase() === name.toLowerCase() ||
            c.name.toLowerCase() === name.toLowerCase(),
        );
        characterState[match?.id ?? name] = String(value).trim();
      }
    }

    return {
      currentSummary: String(parsed.currentSummary ?? '').trim(),
      rollingSummary: String(parsed.rollingSummary ?? '').trim(),
      importantEvents: asStringArray(parsed.importantEvents),
      relationshipState: String(parsed.relationshipState ?? '').trim(),
      characterState,
      coveredThroughOrder: source[source.length - 1].order,
      generatedBy: 'ai',
    };
  } catch (err) {
    return {
      ...fallbackSummary(input),
      note: `AI summarisation failed (${(err as Error).message}). A local summary was used instead.`,
    };
  }
}

export function applyDraft(summary: StorySummary, draft: SummaryDraft): StorySummary {
  return {
    ...summary,
    currentSummary: draft.currentSummary,
    rollingSummary: draft.rollingSummary,
    importantEvents: draft.importantEvents,
    relationshipState: draft.relationshipState,
    characterState: draft.characterState,
    coveredThroughOrder: draft.coveredThroughOrder,
    lastGeneratedAt: Date.now(),
  };
}

/* ------------------------------------------------- which summary applies */

export interface SummaryScope {
  /** Every branch the app knows about; ancestry is resolved from these. */
  branches: Branch[];
  /** The branch being played, and the chat it belongs to. */
  branchId: ID | null;
  chatId: ID | null;
  /**
   * How many chats this story has. A legacy row carries no chat, and a
   * watermark is only readable in the order space that produced it, so one
   * chat means the row can be adopted and several means it cannot.
   */
  storyChatCount: number;
}

export interface ResolvedSummary {
  /**
   * The summary as it applies here.
   *
   * When the watermark cannot be trusted it is normalised to -1 rather than
   * left as a number from some other chat's counter, so everything downstream
   * that reasons about coverage — the compiler, pendingMessages,
   * shouldAutoSummarize — is right without knowing why.
   */
  summary: StorySummary;
  /** The branch this row is treated as belonging to; null when unknowable. */
  ownerBranchId: ID | null;
  /** Whether `coveredThroughOrder` may be applied to this chat's history. */
  watermarkTrusted: boolean;
}

/**
 * The one summary that describes the timeline being played.
 *
 * A summary is a compression of one sequence of events. Resolving it by story
 * alone let a sibling branch read — and then overwrite — a summary of events it
 * never had, and let one chat's watermark delete another chat's transcript,
 * because every chat counts its messages from zero.
 *
 * A row is usable when its branch is the played branch or an ancestor of it,
 * and its coverage stops at or before the point the played branch leaves that
 * ancestor. That cutoff is the same `forkOrder` resolveTimeline uses, so a
 * summary can never claim to cover a message the branch cannot see.
 */
export function resolveSummaryForBranch(
  /** Rows belonging to this story. */
  summaries: StorySummary[],
  scope: SummaryScope,
): ResolvedSummary | null {
  if (!scope.branchId) return null;
  const chain = branchChain(scope.branches, scope.branchId);
  if (!chain.length) return null;
  const rootId = chain[0].id;

  // Where the played branch leaves each of its ancestors.
  const cutoffOf = new Map<ID, number>();
  for (let i = 0; i < chain.length; i += 1) {
    const next = chain[i + 1];
    cutoffOf.set(chain[i].id, next ? next.forkOrder : Number.MAX_SAFE_INTEGER);
  }

  const candidates: ResolvedSummary[] = [];
  for (const row of summaries) {
    if (row.branchId) {
      // Not on this branch's ancestry: a sibling, a descendant, or another
      // chat entirely. Branches never cross chats, so this covers both.
      const cutoff = cutoffOf.get(row.branchId);
      if (cutoff === undefined) continue;
      if (row.chatId && row.chatId !== scope.chatId) continue;
      if (row.coveredThroughOrder > cutoff) continue;
      candidates.push({ summary: row, ownerBranchId: row.branchId, watermarkTrusted: true });
      continue;
    }

    // Legacy row. With a single chat in the story there is only one order
    // space it could have come from, so it is this chat's original timeline.
    if (scope.storyChatCount <= 1 && (!row.chatId || row.chatId === scope.chatId)) {
      if (row.coveredThroughOrder > (cutoffOf.get(rootId) ?? 0)) continue;
      candidates.push({ summary: row, ownerBranchId: rootId, watermarkTrusted: true });
      continue;
    }

    // Several chats share this story, so which one produced the watermark is
    // not recoverable. The prose still describes the story — it was shown in
    // every chat of it before — but the number is guesswork, and guessing it
    // deletes a transcript.
    candidates.push({
      summary: { ...row, coveredThroughOrder: -1 },
      ownerBranchId: null,
      watermarkTrusted: false,
    });
  }

  // Deepest usable compression first; a readable watermark always beats one
  // that has been given up on.
  candidates.sort(
    (a, b) =>
      Number(b.watermarkTrusted) - Number(a.watermarkTrusted) ||
      b.summary.coveredThroughOrder - a.summary.coveredThroughOrder ||
      b.summary.updatedAt - a.summary.updatedAt,
  );
  return candidates[0] ?? null;
}

/**
 * The row a new summary for this branch must be written to.
 *
 * Branching never copies messages, and it does not copy summaries either: a
 * branch reuses its ancestor's compression until it has enough new material of
 * its own, and only then does it get a row. That row is seeded from the
 * ancestor — which `generateStorySummary` then carries forward as
 * `Previous summary:` — so nothing is regenerated and nothing is lost. The
 * ancestor's own row, and any sibling's, is never written to.
 */
export function ownedSummaryRow(
  resolved: ResolvedSummary | null,
  scope: { storyId: ID; chatId: ID; branchId: ID },
): StorySummary {
  if (!resolved) {
    return newStorySummary(scope.storyId, { chatId: scope.chatId, branchId: scope.branchId });
  }
  // Already this branch's own — including a legacy row adopted as this chat's
  // original timeline, which is stamped in place rather than duplicated.
  if (resolved.ownerBranchId === scope.branchId) {
    return {
      ...resolved.summary,
      storyId: scope.storyId,
      chatId: scope.chatId,
      branchId: scope.branchId,
    };
  }
  return {
    ...resolved.summary,
    id: uid(),
    storyId: scope.storyId,
    chatId: scope.chatId,
    branchId: scope.branchId,
    createdAt: Date.now(),
  };
}

/** True when enough new messages have accumulated to warrant a refresh. */
export function shouldAutoSummarize(
  summary: StorySummary | null,
  timeline: Message[],
  window: number,
  every: number,
): boolean {
  if (every <= 0) return false;
  if (summary?.locked) return false;
  const covered = summary?.coveredThroughOrder ?? -1;
  const foldable = timeline.slice(0, Math.max(0, timeline.length - window));
  const pending = foldable.filter((m) => m.order > covered).length;
  return pending >= every;
}
