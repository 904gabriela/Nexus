/**
 * The tavern fixture: two innkeepers in one room, each with a secret and a
 * private lorebook, over a forked timeline carrying memories of every origin.
 *
 * Written straight into IndexedDB, like scene-fixture.ts, because every claim
 * it supports is about the compiled prompt rather than about the editors that
 * produce the data.
 */
import type { Page } from '@playwright/test';
import { boot, goto } from './helpers';

export interface Seed {
  /** Which branch the chat opens on. */
  activeBranchId?: 'main' | 'alt';
  /** Who is in the room. Defaults to Sera and Halda. */
  presentCharacterIds?: string[];
  /** The scene's declared focal character. Defaults to Sera. */
  primaryCharacterId?: string | null;
  /** Which cast link carries `primary`. 'none' leaves the story with no lead. */
  storyPrimary?: 'sera' | 'halda' | 'none';
  /** Adds a third character to the cast and the scene. */
  withToma?: boolean;
}

/**
 * Two characters in one room, each with a secret and a private lorebook, plus a
 * forked timeline carrying memories of every origin.
 *
 * One fixture covers all of it because these are all statements about the same
 * prompt: who is replying decides what is private, and which branch is being
 * played decides what has happened.
 */
export async function seedTavern(page: Page, seed: Seed = {}) {
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

    const character = (id: string, name: string, secrets: string, lorebookIds: string[]) => ({
      id,
      name,
      displayName: '',
      nickname: '',
      age: '38',
      gender: '',
      pronouns: 'they/them',
      species: 'human',
      race: '',
      occupation: 'innkeeper',
      role: '',
      tags: [],
      shortDescription: `${name} of the Nexus Tavern.`,
      description: `${name} keeps the Nexus Tavern through the long storm.`,
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
      secrets,
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
      lorebookIds,
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

    await put(
      'characters',
      character('sera', 'Sera', 'Sera keeps a false-bottomed drawer beneath the bar.', [
        'book-sera',
      ]),
    );
    await put(
      'characters',
      character('halda', 'Halda', 'Halda has been skimming coin from the harvest tithe.', [
        'book-halda',
      ]),
    );
    if (options.withToma) {
      await put(
        'characters',
        character('toma', 'Toma', 'Toma sold the storm-glass to a stranger on the road.', []),
      );
    }

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
      personality: 'Curious and reckless.',
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

    const book = (id: string, name: string, global = false) => ({
      id,
      name,
      description: '',
      tags: [],
      enabled: true,
      global,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put('lorebooks', book('book-sera', "Sera's own"));
    await put('lorebooks', book('book-halda', "Halda's own"));
    await put('lorebooks', book('book-world', 'Ashfell', true));

    // Every entry keys on the same word, so what fires is decided by scope
    // alone rather than by which text happened to mention what.
    const entry = (
      id: string,
      lorebookId: string,
      name: string,
      content: string,
      activation: string,
    ) => ({
      id,
      lorebookId,
      name,
      content,
      primaryKeys: ['ledger'],
      secondaryKeys: [],
      aliases: [],
      enabled: true,
      priority: 100,
      position: 'after-character',
      depth: 4,
      scanDepth: 0,
      matchMode: 'word-boundary',
      caseSensitive: false,
      activation,
      category: '',
      scope: '',
      comment: '',
      customFields: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put(
      'loreEntries',
      entry(
        'lore-sera',
        'book-sera',
        'The bar ledger',
        'The ledger lists every debt owed to the tavern.',
        'character-only',
      ),
    );
    await put(
      'loreEntries',
      entry(
        'lore-halda',
        'book-halda',
        'The tithe roll',
        'The ledger Halda fears is the tithe roll in the chapel.',
        'character-only',
      ),
    );
    await put(
      'loreEntries',
      entry(
        'lore-world',
        'book-world',
        'Ashfell',
        'Ashfell keeps its debts in ink and its grudges in stone.',
        'keyword',
      ),
    );

    /*
     * One memory of every origin, all pointing at m3 — a message that lives
     * past the fork — except where the point is that provenance is elsewhere.
     */
    const memory = (
      id: string,
      origin: string,
      title: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      origin,
      title,
      content,
      category: 'Event',
      importance: 'normal',
      pinned: false,
      sourceMessageIds: ['m3'],
      sourceChatId: 'tavern-chat',
      sourceStoryId: 'tavern-story',
      characterIds: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    await put(
      'memories',
      memory('mem-auto', 'auto', 'The cellar confession', 'Halda confessed to the theft in the cellar.'),
    );
    await put(
      'memories',
      memory('mem-manual', 'manual', 'A standing promise', 'Corin swore never to cross the Ashfell bridge again.'),
    );
    await put(
      'memories',
      memory('mem-imported', 'imported', 'Brought from elsewhere', 'The tavern sign was repainted the year of the flood.'),
    );
    // Pinned and critical, so it would rank first if scope did not come first.
    await put(
      'memories',
      memory('mem-pinned', 'auto', 'The oath at the hearth', 'Sera swore the hearth oath in front of witnesses.', {
        pinned: true,
        importance: 'critical',
      }),
    );
    // Extracted in a sibling chat of the same story: this chat's branch
    // structure says nothing about it.
    await put(
      'memories',
      memory('mem-otherchat', 'auto', 'From the other room', 'A courier left a sealed writ at the door.', {
        sourceMessageIds: ['elsewhere-1'],
        sourceChatId: 'other-chat',
      }),
    );
    // Its source message no longer exists anywhere.
    await put(
      'memories',
      memory('mem-dangling', 'auto', 'Orphaned', 'Someone broke the shutter latch in the night.', {
        sourceMessageIds: ['deleted-forever'],
      }),
    );

    const cast = [
      {
        characterId: 'sera',
        primary: (options.storyPrimary ?? 'sera') === 'sera',
        note: '',
        enabled: true,
      },
      {
        characterId: 'halda',
        primary: options.storyPrimary === 'halda',
        note: '',
        enabled: true,
      },
    ];
    if (options.withToma) {
      cast.push({ characterId: 'toma', primary: false, note: '', enabled: true });
    }

    await put('stories', {
      id: 'tavern-story',
      title: 'The Long Storm',
      description: '',
      scenario: 'Travellers wait out a storm in the Nexus Tavern.',
      authorNote: '',
      openingMessage: '',
      tags: [],
      characters: cast,
      personaId: 'corin',
      lorebookIds: [],
      memoryIds: [
        'mem-auto',
        'mem-manual',
        'mem-imported',
        'mem-pinned',
        'mem-otherchat',
        'mem-dangling',
      ],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: 'tavern-chat',
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });

    const present = options.presentCharacterIds ?? [
      'sera',
      'halda',
      ...(options.withToma ? ['toma'] : []),
    ];
    await put('chats', {
      id: 'tavern-chat',
      storyId: 'tavern-story',
      title: 'The common room',
      activeBranchId: options.activeBranchId ?? 'main',
      personaId: 'corin',
      favorite: false,
      archived: false,
      settings: {},
      direction: '',
      lorebookIds: [],
      orderCounter: 4,
      scene: {
        location: 'The common room of the Nexus Tavern',
        situation: 'The storm has kept everyone indoors for three days.',
        presentCharacterIds: present,
        primaryCharacterId:
          options.primaryCharacterId === undefined ? 'sera' : options.primaryCharacterId,
        objective: '',
        characterStates: {},
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });

    await put('branches', {
      id: 'main',
      chatId: 'tavern-chat',
      parentBranchId: null,
      createdFromMessageId: null,
      forkOrder: 0,
      name: 'Main',
      createdAt: now,
      updatedAt: now,
    });
    // Forked after m1, so m2 and m3 exist only on main.
    await put('branches', {
      id: 'alt',
      chatId: 'tavern-chat',
      parentBranchId: 'main',
      createdFromMessageId: 'm1',
      forkOrder: 1,
      name: 'Alternative',
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    const message = (id: string, order: number, role: 'user' | 'assistant', content: string) => ({
      id,
      chatId: 'tavern-chat',
      branchId: 'main',
      role,
      characterId: role === 'assistant' ? 'sera' : null,
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
    await put('messages', message('m0', 0, 'user', 'Evening.'));
    // "ledger" lives in the earliest shared turn so the lore keyword is in
    // scope on every branch and on turns the test does not type itself.
    await put(
      'messages',
      message('m1', 1, 'assistant', 'Sera sets down a cup, the ledger still open at her elbow.'),
    );
    await put('messages', message('m2', 2, 'user', 'Where did Halda go?'));
    await put('messages', message('m3', 3, 'assistant', 'Halda came up from the cellar white-faced.'));

    db.close();
  }, seed);

  await page.reload();
  await boot(page);
  await goto(page, '#/chat/tavern-chat');
}
