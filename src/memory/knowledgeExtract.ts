/**
 * Who came to know of what, in one exchange.
 *
 * Deliberately not the memory extractor and not the scene extractor. Those
 * ask what happened and where; this asks the one question neither can — did a
 * particular character gain access to a particular claim — and it is a harder
 * question than it looks, because the words that describe learning something
 * are the same words that describe not learning it. "Ryu hadn't been told
 * about the secret" contains Ryu, and told, and the secret.
 *
 * Two things keep this honest. The model is never allowed to invent a subject:
 * it is handed a numbered list of the things already in scope — memories on
 * this branch, standings between the people in the room — and may only point
 * at one of them. And nothing it says is believed: every attribution is a
 * proposal, sitting in the Context Inspector until a person accepts it.
 *
 * What this does not do, and cannot: tell "Ryu now knew" from "Ryu had never
 * known" by any means other than the model's own reading. The evidence check
 * below rejects a quotation that does not appear in the exchange, which catches
 * a hallucinated sentence and nothing else. Whether the model reads a denial
 * as a denial is up to the model, which is why nothing here applies itself.
 */

import type {
  Character,
  ID,
  KnowledgeBasis,
  KnowledgeSubject,
  Memory,
  Persona,
  Provider,
  Relationship,
} from '../types';
import { complete } from '../ai/client';
import { resolveName } from './matrix';

/** One thing the model may attribute knowledge of. */
export interface KnowledgeSubjectCandidate {
  /** The label the model refers to it by: M1, M2, R1… */
  ref: string;
  subject: KnowledgeSubject;
  /** How it is described to the model. */
  label: string;
}

export interface KnowledgeCandidate {
  knowerId: ID;
  subject: KnowledgeSubject;
  basis: KnowledgeBasis;
  toldById: ID | null;
  confidence: number;
  /** The sentence it was read from. Checked, never stored. */
  evidence: string;
  /** The message(s) whose own text carries the evidence. */
  sourceMessageIds: ID[];
}

/**
 * The bases extraction may produce.
 *
 * `stated` is derived from a memory's own claimant and is never extracted;
 * `authored` is an author's explicit act and never a model's. Either one
 * arriving from the model is rejected outright rather than mapped to something
 * else, because a model reaching for them is a model confused about what it
 * is being asked.
 */
const EXTRACTABLE: KnowledgeBasis[] = ['witnessed', 'participated', 'told', 'discovered', 'inferred'];

export const KNOWLEDGE_SYSTEM = `You watch one exchange of a roleplay and decide whether any character CAME TO KNOW OF something during it.

You are given a numbered list of things already established in the story, and the latest exchange. Return ONLY a JSON object:
{"attributions": [...]}

Each item of "attributions":
{"who": the character's name,
 "subject": the label of the thing they came to know of, exactly as listed (for example "M2" or "R1"),
 "basis": "witnessed" | "participated" | "told" | "discovered" | "inferred",
 "toldBy": the name of whoever told them, when basis is "told", else null,
 "confidence": number between 0 and 1,
 "evidence": the exact sentence from the exchange that establishes it}

Report an attribution ONLY when the exchange shows the character has, by the end of it, gained access to the thing. Knowing of a thing is not believing it and does not make it true — a character can be told a lie and still now know of the claim.

These are NOT attributions:
- a denial or an absence ("Ryu hadn't been told", "Ryu knew nothing about it")
- someone being lied to about a different thing ("Sera lied to Ryu about the secret" says Ryu was told a falsehood, not the secret)
- a question ("Ryu asked whether Sera knew")
- a wish, plan or threat to tell ("she would tell him tomorrow")
- something the character already knew before this exchange
- the mere presence of a name near the thing

basis means:
  "witnessed"    the narration shows them seeing or hearing it happen
  "participated" they were part of the event the thing describes
  "told"         another character told them, in this exchange
  "discovered"   they found it out from something — a letter, a wound, a slip
  "inferred"     you worked out that they must now know; the text did not show it

Only use labels from the list. If nobody came to know of anything listed, return {"attributions": []}. An empty list is the usual and correct answer. Never invent an attribution to have something to report.`;

export interface KnowledgeExtractionInput {
  exchange: Array<{ id: ID; role: string; content: string }>;
  subjects: KnowledgeSubjectCandidate[];
  characters: Character[];
  persona: Persona | null;
  provider: Provider | null;
  signal?: AbortSignal;
}

/**
 * The things in scope, numbered for the model.
 *
 * Memories first, newest last, then the standings between people who are here.
 * A pair is offered by its names and resolved back to its ids, so the subject
 * stored is the pair and never a row — the same rule the knowledge layer keeps
 * everywhere.
 */
export function knowledgeSubjects(
  memories: Memory[],
  relationships: Relationship[],
  nameOf: (id: ID) => string,
): KnowledgeSubjectCandidate[] {
  const out: KnowledgeSubjectCandidate[] = [];
  memories.forEach((memory, index) => {
    const title = memory.title.trim() || memory.content.trim().slice(0, 80);
    if (!title) return;
    out.push({
      ref: `M${index + 1}`,
      subject: { kind: 'memory', id: memory.id },
      label: title,
    });
  });
  relationships.forEach((row, index) => {
    if (!Array.isArray(row.betweenIds) || row.betweenIds.length !== 2) return;
    out.push({
      ref: `R${index + 1}`,
      subject: { kind: 'relationship', betweenIds: row.betweenIds },
      label: `how ${nameOf(row.betweenIds[0])} and ${nameOf(row.betweenIds[1])} stand with each other`,
    });
  });
  return out;
}

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

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Which messages actually contain the quoted sentence.
 *
 * A quotation that appears nowhere is the cheapest sign of a fabricated
 * attribution and costs nothing to refuse. It is also the provenance: the
 * turn that carries the sentence is the turn the knowledge came from.
 */
function groundingMessages(
  evidence: string,
  exchange: KnowledgeExtractionInput['exchange'],
): ID[] {
  const wanted = normalise(evidence);
  if (!wanted) return [];
  return exchange.filter((m) => normalise(m.content).includes(wanted)).map((m) => m.id);
}

/** Parses one model reply into candidates. Exported so it can be tested alone. */
export function parseKnowledgeAttributions(
  reply: string,
  input: Pick<KnowledgeExtractionInput, 'exchange' | 'subjects' | 'characters' | 'persona'>,
): KnowledgeCandidate[] {
  const parsed = extractJson(reply);
  const raw = Array.isArray(parsed?.attributions) ? (parsed!.attributions as unknown[]) : [];
  const byRef = new Map(input.subjects.map((s) => [s.ref.toUpperCase(), s.subject]));

  const out: KnowledgeCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    // The knower has to be someone the story has. A name the app cannot
    // resolve is not a character; it may be the model's own invention.
    const knowerId = resolveName(String(record.who ?? ''), input.characters, input.persona);
    if (!knowerId) continue;

    // The subject has to be one that was offered. This is what stops the model
    // conjuring a secret into being by attributing knowledge of it.
    const subject = byRef.get(String(record.subject ?? '').trim().toUpperCase());
    if (!subject) continue;

    const rawBasis = String(record.basis ?? '');
    if (!(EXTRACTABLE as string[]).includes(rawBasis)) continue;
    const basis = rawBasis as KnowledgeBasis;

    const toldById =
      basis === 'told'
        ? resolveName(String(record.toldBy ?? ''), input.characters, input.persona)
        : null;
    // Being told by yourself is not being told.
    if (toldById && toldById === knowerId) continue;

    const rawConfidence = Number(record.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0;

    const evidence = String(record.evidence ?? '').trim();
    const sourceMessageIds = groundingMessages(evidence, input.exchange);
    if (!sourceMessageIds.length) continue;

    out.push({ knowerId, subject, basis, toldById, confidence, evidence, sourceMessageIds });
  }
  return out;
}

/** Asks the model who came to know of what. */
export async function extractKnowledge(
  input: KnowledgeExtractionInput,
): Promise<KnowledgeCandidate[]> {
  if (!input.provider?.model || !input.exchange.length || !input.subjects.length) return [];

  const subjectBlock = input.subjects.map((s) => `[${s.ref}] ${s.label}`).join('\n');
  const exchangeBlock = input.exchange
    .map((m) => `${m.role === 'user' ? 'User' : 'Story'}: ${m.content.trim()}`)
    .join('\n\n');

  try {
    const reply = await complete({
      // Background work, kept off the roleplay request and its queue.
      purpose: 'utility',
      provider: input.provider,
      signal: input.signal,
      settings: { temperature: 0.1, maxTokens: 600, streaming: false },
      messages: [
        { role: 'system', content: KNOWLEDGE_SYSTEM },
        {
          role: 'user',
          content: `Things already established:\n${subjectBlock}\n\nThe latest exchange:\n\n${exchangeBlock}`,
        },
      ],
    });
    return parseKnowledgeAttributions(reply, input);
  } catch {
    // Nothing noticed is the situation we were already in; it must never
    // break the reply that just arrived.
    return [];
  }
}
