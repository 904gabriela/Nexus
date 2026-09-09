/**
 * A forked chat, for asking which summary describes which timeline.
 *
 * One story, one cast, and a chat whose branches are the point:
 *
 *   main   m0 m1 m2 m3
 *             \
 *              c   c10 c11
 *              |     \
 *              |      deep  dp30
 *              d   d20 d21
 *
 * `c` and `d` both fork after m1, so they are siblings that share m0 and m1 and
 * nothing else. Orders are unique within the chat, as the app's own counter
 * makes them, and restart at zero in the optional second chat — which is what
 * makes a watermark unreadable across chats.
 */
import type { Page } from '@playwright/test';
import { boot, goto } from './helpers';

export interface SummarySeed {
  id: string;
  /** Omit both to write a legacy row, as stored before summaries knew this. */
  chatId?: string | null;
  branchId?: string | null;
  coveredThroughOrder: number;
  rollingSummary: string;
  currentSummary?: string;
}

export interface SceneDeltaSeed {
  id: string;
  branchId?: string;
  chatId?: string;
  sourceMessageIds: string[];
  fields: Record<string, unknown>;
  previous?: Record<string, unknown>;
  status?: 'proposed' | 'applied' | 'reversed' | 'superseded';
  basis?: string;
  confidence?: number;
  appliedAt?: number;
}

export interface RelationshipSeed {
  id: string;
  betweenIds: [string, string];
  label?: string;
  summary: string;
  manual?: boolean;
}

export interface RelationshipDeltaSeed {
  id: string;
  branchId?: string;
  chatId?: string;
  betweenIds?: [string, string];
  change: string;
  sourceMessageIds: string[];
  sourceMemoryId?: string | null;
  status?: 'proposed' | 'applied' | 'reversed';
  basis?: string;
  confidence?: number;
  appliedAt?: number;
}

export interface KnowledgeEdgeSeed {
  id: string;
  branchId?: string;
  chatId?: string;
  knowerId: string;
  subject:
    | { kind: 'memory'; id: string }
    | { kind: 'relationship'; betweenIds: [string, string] };
  basis?: string;
  toldById?: string | null;
  sourceMessageIds: string[];
  confidence?: number;
  status?: 'proposed' | 'applied' | 'reversed';
  appliedAt?: number;
}

export interface MemorySeed {
  id: string;
  title: string;
  content: string;
  basis?: string;
  statedById?: string | null;
  status?: string;
  confidence?: number;
  sourceMessageIds?: string[];
  sourceChatId?: string | null;
}

export interface BranchSeed {
  summaries?: SummarySeed[];
  /** Which branch of chat-1 is active. */
  activeBranchId?: 'main' | 'c' | 'd' | 'deep';
  /** Give the story a second chat, whose orders run 0–29. */
  secondChat?: boolean;
  /** Which chat the app opens on. */
  open?: 'chat-1' | 'chat-2';
  /** Settings to override before boot, e.g. summaryWindow. */
  settings?: Record<string, unknown>;
  /** Canonical base scene for chat-1. */
  scene?: Record<string, unknown>;
  sceneDeltas?: SceneDeltaSeed[];
  /** The story's canonical, author-owned standings. */
  relationships?: RelationshipSeed[];
  relationshipDeltas?: RelationshipDeltaSeed[];
  knowledgeEdges?: KnowledgeEdgeSeed[];
  memories?: MemorySeed[];
}

export async function seedBranchedStory(page: Page, seed: BranchSeed = {}) {
  await page.evaluate(async (options) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const put = (store: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    const now = Date.now();

    await put('characters', {
      id: 'sera',
      name: 'Sera',
      displayName: '',
      nickname: '',
      age: '38',
      gender: '',
      pronouns: 'she/her',
      species: 'human',
      race: '',
      occupation: 'innkeeper',
      role: '',
      tags: [],
      shortDescription: 'The innkeeper.',
      description: 'Keeps the Nexus Tavern through the long storm.',
      appearance: '',
      physicalTraits: '',
      personality: 'Wry and watchful.',
      temperament: '',
      traits: [],
      backstory: '',
      history: '',
      goals: '',
      motivations: '',
      fears: '',
      secrets: '',
      likes: '',
      dislikes: '',
      hobbies: '',
      values: '',
      beliefs: '',
      scenario: '',
      greetings: [],
      defaultGreetingId: null,
      speakingStyle: '',
      speechPatterns: '',
      exampleDialogue: '',
      systemPrompt: '',
      authorNote: '',
      relationships: '',
      friends: '',
      enemies: '',
      family: '',
      romantic: '',
      home: '',
      location: '',
      faction: '',
      world: '',
      lorebookIds: [],
      creator: '',
      creatorNotes: '',
      version: '1',
      customFields: [],
      metadata: {},
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('personas', {
      id: 'corin',
      name: 'Corin',
      displayName: '',
      nickname: '',
      age: '',
      gender: '',
      pronouns: 'they/them',
      species: '',
      occupation: '',
      appearance: '',
      personality: 'Curious.',
      traits: [],
      backstory: '',
      goals: '',
      likes: '',
      dislikes: '',
      speechStyle: '',
      customFields: [],
      customInstructions: '',
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    await put('stories', {
      id: 'forked-story',
      title: 'The Fork',
      description: '',
      scenario: 'A storm, an inn, and a decision taken two ways.',
      authorNote: '',
      openingMessage: '',
      tags: [],
      characters: [{ characterId: 'sera', primary: true, note: '', enabled: true }],
      relationships: (options.relationships ?? []).map((r) => ({
        id: r.id,
        betweenIds: r.betweenIds,
        label: r.label ?? '',
        summary: r.summary,
        manual: r.manual ?? false,
        updatedAt: now,
      })),
      personaId: 'corin',
      lorebookIds: [],
      memoryIds: [],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: options.open === 'chat-2' ? 'chat-2' : 'chat-1',
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });

    const scene = {
      location: 'The Nexus Tavern',
      situation: 'The storm has shut the roads.',
      presentCharacterIds: ['sera'],
      primaryCharacterId: 'sera',
      objective: '',
      characterStates: {},
      updatedAt: now,
      ...(options.scene ?? {}),
    };

    await put('chats', {
      id: 'chat-1',
      storyId: 'forked-story',
      title: 'The forked chat',
      activeBranchId: options.activeBranchId ?? 'main',
      personaId: 'corin',
      favorite: false,
      archived: false,
      settings: {},
      direction: '',
      lorebookIds: [],
      orderCounter: 40,
      scene,
      createdAt: now,
      updatedAt: now,
    });

    const branch = (
      id: string,
      parentBranchId: string | null,
      forkOrder: number,
      name: string,
      chatId = 'chat-1',
    ) => ({
      id,
      chatId,
      parentBranchId,
      createdFromMessageId: null,
      forkOrder,
      name,
      createdAt: now,
      updatedAt: now,
    });
    await put('branches', branch('main', null, 0, 'Main'));
    // Both fork after m1, so they share m0 and m1 and diverge from there.
    await put('branches', branch('c', 'main', 1, 'Branch C'));
    await put('branches', branch('d', 'main', 1, 'Branch D'));
    await put('branches', branch('deep', 'c', 10, 'Deeper still'));

    const message = (
      id: string,
      branchId: string,
      order: number,
      content: string,
      chatId = 'chat-1',
    ) => ({
      id,
      chatId,
      branchId,
      role: order % 2 === 0 ? 'user' : 'assistant',
      characterId: order % 2 === 0 ? null : 'sera',
      content,
      attachments: [],
      order,
      model: '',
      tokens: 0,
      favorite: false,
      activeAlternativeId: null,
      createdAt: now + order,
      updatedAt: now + order,
    });

    await put('messages', message('m0', 'main', 0, 'MAIN-ZERO the door blew open.'));
    await put('messages', message('m1', 'main', 1, 'MAIN-ONE Sera barred it again.'));
    await put('messages', message('m2', 'main', 2, 'MAIN-TWO the lamps guttered.'));
    await put('messages', message('m3', 'main', 3, 'MAIN-THREE the storm eased.'));
    await put('messages', message('c10', 'c', 10, 'BRANCH-C-TEN a stranger came in.'));
    await put('messages', message('c11', 'c', 11, 'BRANCH-C-ELEVEN they took a room.'));
    await put('messages', message('d20', 'd', 20, 'BRANCH-D-TWENTY nobody came in.'));
    await put('messages', message('d21', 'd', 21, 'BRANCH-D-TWENTYONE the night stayed quiet.'));
    await put('messages', message('dp30', 'deep', 30, 'BRANCH-DEEP-THIRTY much later.'));

    if (options.secondChat) {
      await put('chats', {
        id: 'chat-2',
        storyId: 'forked-story',
        title: 'A separate chat',
        activeBranchId: 'main-2',
        personaId: 'corin',
        favorite: false,
        archived: false,
        settings: {},
        direction: '',
        lorebookIds: [],
        orderCounter: 30,
        scene,
        createdAt: now,
        updatedAt: now,
      });
      await put('branches', branch('main-2', null, 0, 'Main', 'chat-2'));
      // Its own counter, from zero — which is exactly why chat-1's watermark
      // cannot be read here.
      for (let i = 0; i < 30; i += 1) {
        await put(
          'messages',
          message(`s${i}`, 'main-2', i, `CHAT2-LINE-${i} another night entirely.`, 'chat-2'),
        );
      }
    }

    for (const s of options.summaries ?? []) {
      await put('storySummaries', {
        id: s.id,
        storyId: 'forked-story',
        ...(s.chatId === undefined ? {} : { chatId: s.chatId }),
        ...(s.branchId === undefined ? {} : { branchId: s.branchId }),
        currentSummary: s.currentSummary ?? 'Where things stand.',
        rollingSummary: s.rollingSummary,
        importantEvents: [],
        relationshipState: '',
        characterState: {},
        locked: false,
        coveredThroughOrder: s.coveredThroughOrder,
        lastGeneratedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const d of options.sceneDeltas ?? []) {
      await put('sceneDeltas', {
        id: d.id,
        chatId: d.chatId ?? 'chat-1',
        branchId: d.branchId ?? 'main',
        sourceMessageIds: d.sourceMessageIds,
        appliedAt: d.appliedAt ?? now,
        fields: d.fields,
        previous: d.previous ?? {},
        basis: d.basis ?? 'observed',
        confidence: d.confidence ?? 0.9,
        status: d.status ?? 'applied',
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const d of options.relationshipDeltas ?? []) {
      await put('relationshipDeltas', {
        id: d.id,
        chatId: d.chatId ?? 'chat-1',
        branchId: d.branchId ?? 'main',
        betweenIds: d.betweenIds ?? ['sera', 'corin'],
        change: d.change,
        sourceMemoryId: d.sourceMemoryId ?? null,
        sourceMessageIds: d.sourceMessageIds,
        appliedAt: d.appliedAt ?? now,
        basis: d.basis ?? 'observed',
        confidence: d.confidence ?? 0.9,
        status: d.status ?? 'applied',
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const e of options.knowledgeEdges ?? []) {
      await put('knowledgeEdges', {
        id: e.id,
        chatId: e.chatId ?? 'chat-1',
        branchId: e.branchId ?? 'main',
        knowerId: e.knowerId,
        subject: e.subject,
        basis: e.basis ?? 'witnessed',
        toldById: e.toldById ?? null,
        sourceMessageIds: e.sourceMessageIds,
        confidence: e.confidence ?? 0.9,
        status: e.status ?? 'applied',
        appliedAt: e.appliedAt ?? now,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const m of options.memories ?? []) {
      await put('memories', {
        id: m.id,
        origin: 'auto',
        title: m.title,
        content: m.content,
        category: 'Event',
        importance: 'normal',
        pinned: false,
        sourceMessageIds: m.sourceMessageIds ?? ['m2', 'm3'],
        sourceChatId: m.sourceChatId === undefined ? 'chat-1' : m.sourceChatId,
        sourceStoryId: 'forked-story',
        characterIds: [],
        tags: [],
        subjects: [],
        basis: m.basis ?? 'observed',
        confidence: m.confidence ?? 0.9,
        statedById: m.statedById ?? null,
        status: m.status ?? 'active',
        supersedes: [],
        relationshipImpact: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (options.settings) {
      const settings: any = await new Promise((r) => {
        const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
        q.onsuccess = () => r(q.result);
      });
      Object.assign(settings, options.settings);
      await new Promise<void>((r) => {
        const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
        q.onsuccess = () => r();
      });
    }

    db.close();
  }, seed);

  await page.reload();
  await boot(page);
  await goto(page, `#/chat/${seed.open ?? 'chat-1'}`);
}
