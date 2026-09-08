/**
 * Continuity foundations, asserted against the request that leaves the app.
 *
 * Three claims, each of which used to be false:
 *
 *  1. A secret belongs to one character. Every present character's secrets were
 *     in every prompt, so the model could hint at something the speaker has no
 *     way of knowing.
 *  2. `character-only` lore means "this character's own knowledge". It was
 *     gated on the whole cast, which made it mean "anyone in this story".
 *  3. A branch cannot remember what only happened on a sibling branch.
 *     Automatic memories carry the messages they were extracted from; a branch
 *     that cannot see any of those messages never witnessed the event.
 *
 * As in roleplay-engine.spec.ts, these read Ollama's own request body rather
 * than the Context Inspector: what matters is what the server receives.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockOllama,
  resetDatabase,
  setupOllamaProvider,
  type MockOllama,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

function systemOf(ollama: MockOllama): string {
  const body = ollama.requests.at(-1)?.body;
  const system = (body?.messages ?? []).find((m: any) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

/** Sends one turn in an already-open chat and returns the compiled system block. */
async function turn(page: Page, ollama: MockOllama, text: string): Promise<string> {
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
  return systemOf(ollama);
}

/* ------------------------------------------------------------------ seeds */

interface Seed {
  /** Which branch the chat opens on. */
  activeBranchId?: 'main' | 'alt';
}

/**
 * Two characters in one room, each with a secret and a private lorebook, plus a
 * forked timeline carrying one automatic and one hand-written memory.
 *
 * One fixture covers all three claims because they are all statements about the
 * same prompt: who is replying decides what is private, and which branch is
 * being played decides what has happened.
 */
async function seedTavern(page: Page, seed: Seed = {}) {
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

    const character = (
      id: string,
      name: string,
      secrets: string,
      lorebookIds: string[],
    ) => ({
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
      character(
        'sera',
        'Sera',
        'Sera keeps a false-bottomed drawer beneath the bar.',
        ['book-sera'],
      ),
    );
    await put(
      'characters',
      character(
        'halda',
        'Halda',
        'Halda has been skimming coin from the harvest tithe.',
        ['book-halda'],
      ),
    );

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

    const book = (id: string, name: string) => ({
      id,
      name,
      description: '',
      tags: [],
      enabled: true,
      global: false,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put('lorebooks', book('book-sera', "Sera's own"));
    await put('lorebooks', book('book-halda', "Halda's own"));

    // Both entries key on the same word, so only the responder's may fire.
    const entry = (id: string, lorebookId: string, name: string, content: string) => ({
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
      activation: 'character-only',
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
      entry('lore-sera', 'book-sera', 'The bar ledger', 'The ledger lists every debt owed to the tavern.'),
    );
    await put(
      'loreEntries',
      entry('lore-halda', 'book-halda', 'The tithe roll', 'The ledger Halda fears is the tithe roll in the chapel.'),
    );

    // One memory the app extracted from a turn, one the author wrote by hand.
    // Both point at the same message, which lives past the fork.
    await put('memories', {
      id: 'mem-auto',
      origin: 'auto',
      title: 'The cellar confession',
      content: 'Halda confessed to the theft in the cellar.',
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
    });
    await put('memories', {
      id: 'mem-manual',
      origin: 'manual',
      title: 'A standing promise',
      content: 'Corin swore never to cross the Ashfell bridge again.',
      category: 'Fact',
      importance: 'normal',
      pinned: false,
      sourceMessageIds: ['m3'],
      sourceChatId: 'tavern-chat',
      sourceStoryId: 'tavern-story',
      characterIds: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    await put('stories', {
      id: 'tavern-story',
      title: 'The Long Storm',
      description: '',
      scenario: 'Travellers wait out a storm in the Nexus Tavern.',
      authorNote: '',
      openingMessage: '',
      tags: [],
      characters: [
        { characterId: 'sera', primary: true, note: '', enabled: true },
        { characterId: 'halda', primary: false, note: '', enabled: true },
      ],
      personaId: 'corin',
      lorebookIds: [],
      memoryIds: ['mem-auto', 'mem-manual'],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: 'tavern-chat',
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });

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
        presentCharacterIds: ['sera', 'halda'],
        primaryCharacterId: 'sera',
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
    await put('messages', message('m1', 1, 'assistant', 'Sera sets down a cup without being asked.'));
    await put('messages', message('m2', 2, 'user', 'Where did Halda go?'));
    await put('messages', message('m3', 3, 'assistant', 'Halda came up from the cellar white-faced.'));

    db.close();
  }, seed);

  await page.reload();
  await boot(page);
  await goto(page, '#/chat/tavern-chat');
}

/* ------------------------------------------------ per-responder compilation */

test('only the replying character brings their secrets and their own lore', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera wipes the bar.']);
  await setupOllamaProvider(page);
  await seedTavern(page);

  const system = await turn(page, ollama, 'Who keeps the ledger?');

  // Sera is the story's primary and the scene's, so she is the responder.
  // ("(speaking)" is the Context Inspector's label for the same part; the
  // prompt itself says it in the control block.)
  expect(system).toContain('Sera is the focus of this scene.');

  // Her own secret and her own character-only lore are hers to have.
  expect(system).toContain('false-bottomed drawer');
  expect(system).toContain('every debt owed to the tavern');

  // Halda's are not, even though Halda is standing right there.
  expect(system).not.toContain('skimming coin');
  expect(system).not.toContain('tithe roll in the chapel');

  // And withholding them did not remove Halda from the scene: the group is
  // still described and still present.
  expect(system).toMatch(/Present:.*Halda/);
  expect(system).toContain('Halda keeps the Nexus Tavern');
});

/* ---------------------------------------------- branch-derived memory scope */

test('the branch that lived the scene remembers it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { activeBranchId: 'main' });

  const system = await turn(page, ollama, 'What happened downstairs?');

  // m3 is on this branch, so the memory extracted from it applies.
  expect(system).toContain('Halda confessed to the theft in the cellar.');
  expect(system).toContain('Corin swore never to cross the Ashfell bridge again.');
});

test('a branch forked before the event does not remember it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { activeBranchId: 'alt' });

  const system = await turn(page, ollama, 'What happened downstairs?');

  // The alternative forked at m1: m3 never happened here, so neither did the
  // confession the app extracted from it.
  expect(system).not.toContain('Halda confessed to the theft in the cellar.');

  // A memory the author wrote is theirs, not an observation about a timeline,
  // so it is untouched. This is the line the scope rule must not cross.
  expect(system).toContain('Corin swore never to cross the Ashfell bridge again.');
});
