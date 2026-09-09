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
  field,
  goto,
  mockOllama,
  resetDatabase,
  setupOllamaProvider,
  type MockOllama,
} from './helpers';
import { seedTavern } from './tavern-fixture';
import { seedBranchedStory } from './branch-summary-fixture';

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

/**
 * Asks a named character to reply through the real speaker picker, which is the
 * only path that sets `respondingCharacterId` explicitly.
 */
async function askToReply(page: Page, ollama: MockOllama, name: string): Promise<string> {
  const before = ollama.requests.length;
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page
    .locator('.sheet')
    .last()
    .getByRole('button', { name: 'Ask another character to reply' })
    .click();
  await page.locator('.sheet').last().getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
  return systemOf(ollama);
}

/** Overwrites one settings key, then reboots so the app reads it back. */
async function patchSettings(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (values) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const settings: any = await new Promise((r) => {
      const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      q.onsuccess = () => r(q.result);
    });
    Object.assign(settings, values);
    await new Promise<void>((r) => {
      const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
      q.onsuccess = () => r();
    });
    db.close();
  }, patch);
  await page.reload();
  await boot(page);
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

test('the same group scene compiles differently for each responder', async ({ page }) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  await seedTavern(page);

  const asSera = await askToReply(page, ollama, 'Sera');
  const asHalda = await askToReply(page, ollama, 'Halda');

  // Each turn carries exactly one character's private material.
  expect(asSera).toContain('false-bottomed drawer');
  expect(asSera).not.toContain('skimming coin');
  expect(asHalda).toContain('skimming coin');
  expect(asHalda).not.toContain('false-bottomed drawer');

  // Character-only lore follows the same line.
  expect(asSera).toContain('every debt owed to the tavern');
  expect(asSera).not.toContain('tithe roll in the chapel');
  expect(asHalda).toContain('tithe roll in the chapel');
  expect(asHalda).not.toContain('every debt owed to the tavern');

  // What is public about the other character survives both turns, so the
  // scene is shared even though the private material is not.
  expect(asSera).toContain('Halda keeps the Nexus Tavern');
  expect(asHalda).toContain('Sera keeps the Nexus Tavern');
  for (const system of [asSera, asHalda]) {
    expect(system).toMatch(/Present:.*Sera/);
    expect(system).toMatch(/Present:.*Halda/);
    expect(system).toContain('Travellers wait out a storm in the Nexus Tavern.');
    // Global lore is not responder-scoped and must be in both.
    expect(system).toContain('Ashfell keeps its debts in ink');
  }

  // One speaker per turn, named once: the control block and the narrator's
  // brief must not disagree about who is leading.
  expect(asSera).toContain('Sera is the focus of this scene.');
  expect(asSera).not.toContain('Halda is the focus of this scene.');
  expect(asHalda).toContain('Halda is the focus of this scene.');
  expect(asHalda).not.toContain('Sera is the focus of this scene.');
});

test('with no story lead, the responder is the first cast member and only theirs is private', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  // No cast link carries `primary`, and the scene names no focal character
  // either: the fallback is on its own.
  await seedTavern(page, { storyPrimary: 'none', primaryCharacterId: null });

  const first = await turn(page, ollama, 'Who keeps the ledger?');
  const second = await turn(page, ollama, 'And who else?');

  // Exactly one character is the responder, and it is the same one twice.
  expect(first).toContain('Sera is the focus of this scene.');
  expect(second).toContain('Sera is the focus of this scene.');

  // The fallback does not hand over everybody's secrets.
  expect(first).toContain('false-bottomed drawer');
  expect(first).not.toContain('skimming coin');
  expect(first).not.toContain('tithe roll in the chapel');
});

test('a third character in the room is described without becoming a second speaker', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { withToma: true });

  const system = await turn(page, ollama, 'Who keeps the ledger?');

  expect(system).toMatch(/Present:.*Toma/);
  expect(system).toContain('Toma keeps the Nexus Tavern');
  // Only the responder's secret, however many people are present.
  expect(system).toContain('false-bottomed drawer');
  expect(system).not.toContain('skimming coin');
  expect(system).not.toContain('sold the storm-glass');
  expect((system.match(/is the focus of this scene\./g) ?? []).length).toBe(1);
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
  expect(system).toContain('Sera swore the hearth oath in front of witnesses.');
});

test('a branch forked before the event does not remember it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { activeBranchId: 'alt' });

  const system = await turn(page, ollama, 'What happened downstairs?');

  // The alternative forked at m1: m3 never happened here, so neither did the
  // confession the app extracted from it.
  expect(system).not.toContain('Halda confessed to the theft in the cellar.');

  // Pinning is retrieval priority, not a claim about which timeline something
  // happened in. A pinned automatic memory from the abandoned branch stays
  // gone — this is the line the locked semantics must not cross.
  expect(system).not.toContain('Sera swore the hearth oath in front of witnesses.');

  // Memories the author wrote or imported are theirs, not observations about a
  // timeline, so they are untouched.
  expect(system).toContain('Corin swore never to cross the Ashfell bridge again.');
  expect(system).toContain('The tavern sign was repainted the year of the flood.');

  // A sibling chat's branch structure says nothing about this one's, so its
  // memories must not be filtered out for lack of a message id here.
  expect(system).toContain('A courier left a sealed writ at the door.');
});

test('an automatic memory whose source message is gone is dropped, not promoted', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { activeBranchId: 'main' });

  const system = await turn(page, ollama, 'What happened downstairs?');

  // Nothing on any branch can show it happened, so it does not reach the
  // model — and in particular it is not silently treated as a standing fact.
  expect(system).not.toContain('Someone broke the shutter latch in the night.');

  // It is still stored: this is a scoping rule, not a deletion.
  const ids = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const q = indexedDB.open('nexus-tavern-pro');
        q.onsuccess = () => {
          const all = q.result.transaction('memories', 'readonly').objectStore('memories').getAll();
          all.onsuccess = () => resolve(all.result.map((m: any) => m.id));
        };
      }),
  );
  expect(ids).toContain('mem-dangling');
});

test('branch scope is applied before ranking, not after the shortlist is cut', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { activeBranchId: 'alt' });
  // Room for exactly one memory. The off-branch pinned+critical memory would
  // win that slot on rank alone, so if scope were applied to the shortlist
  // instead of to the candidates, the prompt would carry no memory at all.
  await patchSettings(page, { maxMemories: 1 });
  await goto(page, '#/chat/tavern-chat');

  const system = await turn(page, ollama, 'What happened downstairs?');

  expect(system).not.toContain('Sera swore the hearth oath in front of witnesses.');
  expect(system).toMatch(
    /Corin swore never to cross the Ashfell bridge again\.|The tavern sign was repainted the year of the flood\.|A courier left a sealed writ at the door\./,
  );
});

/* ------------------------------------------- summary vs scene, and the tester */

test('long-run standing and the scene right now are separate blocks', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedTavern(page);

  // A summary that says where Sera stands over the whole story, and a scene
  // that says what is true of her this minute.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const now = Date.now();
    await new Promise<void>((r) => {
      const q = db
        .transaction('storySummaries', 'readwrite')
        .objectStore('storySummaries')
        .put({
          id: 'tavern-story',
          storyId: 'tavern-story',
          currentSummary: 'The storm has held the road shut for three nights.',
          rollingSummary: '',
          importantEvents: [],
          relationshipState: '',
          characterState: {
            sera: 'Has stopped denying she sealed the cellar; wants the debt forgiven.',
          },
          locked: false,
          coveredThroughOrder: -1,
          lastGeneratedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      q.onsuccess = () => r();
    });
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get('tavern-chat');
      q.onsuccess = () => r(q.result);
    });
    chat.scene.characterStates = { sera: 'Bleeding from a cut above the eye.' };
    await new Promise<void>((r) => {
      const q = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);
  await goto(page, '#/chat/tavern-chat');

  const system = await turn(page, ollama, 'Quiet tonight.');

  // The volatile line is the scene's, and only the scene's.
  const sceneBlock = system.slice(
    system.indexOf('## Current scene'),
    system.indexOf('## Who controls whom'),
  );
  expect(sceneBlock).toContain('- Sera: Bleeding from a cut above the eye.');

  // The durable line is the summary's, under its own heading, and it does not
  // restate where anyone is or what shape they are in.
  const standingBlock = system.slice(system.indexOf('## Where each character stands'));
  expect(standingBlock).toContain('Has stopped denying she sealed the cellar');
  expect(standingBlock).not.toContain('Bleeding from a cut above the eye');

  // Location, situation and objective stay the scene's alone.
  expect(sceneBlock).toContain('Location: The common room of the Nexus Tavern');
  expect(sceneBlock).toContain('Situation: The storm has kept everyone indoors');
  expect(system.indexOf('## Current scene')).toBeLessThan(
    system.indexOf('## Where each character stands'),
  );

  // No section is emitted twice: each present character is described once.
  for (const name of ['Sera', 'Halda']) {
    expect((system.match(new RegExp(`^# ${name}$`, 'gm')) ?? []).length).toBe(1);
  }
});

test('the summary the model is asked to write is standing, not a scene report', async ({ page }) => {
  const ollama = await mockOllama(page, ['{"currentSummary":"Nothing yet."}']);
  await setupOllamaProvider(page);
  await seedTavern(page);

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'The story so far' }).click();
  const before = ollama.utility.length;
  await page.getByRole('button', { name: /^(Generate|Regenerate)$/ }).click();
  await expect.poll(() => ollama.utility.length, { timeout: 25_000 }).toBeGreaterThan(before);

  const sent = JSON.stringify(ollama.utility.at(-1)!.body);
  expect(sent).toContain('where they stand and what they want');
  expect(sent).toContain('Do not put their present location or physical condition here');
  // The old contract asked for exactly what the scene already owns.
  expect(sent).not.toContain('condition, location, goal');
});

test('the lorebook tester still judges a character-only entry on its own rules', async ({
  page,
}) => {
  await mockOllama(page, ['Unused.']);
  await setupOllamaProvider(page);
  await seedTavern(page);

  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Tools' }).click();
  await page.getByRole('textbox', { name: 'Test text', exact: true }).fill('Show me the ledger.');

  // In test mode every book counts as attached, so a character-only entry is
  // judged on its keywords rather than on who happens to be replying — the
  // tester has no responder to scope to.
  await expect(page.getByText('The bar ledger').first()).toBeVisible();
  await expect(page.getByText('The tithe roll').first()).toBeVisible();
  await expect(page.getByText(/Keyword matched: ledger/).first()).toBeVisible();
});

/* --------------------------------------------- who the scene asks to reply */

test('a re-cast scene answers with its own lead, not the story’s', async ({ page }) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  // The user took Sera out of the room and put Halda at the centre of it.
  // The story still carries its original `primary` flag on Sera.
  await seedTavern(page, {
    storyPrimary: 'sera',
    primaryCharacterId: 'halda',
    presentCharacterIds: ['halda'],
  });

  const system = await turn(page, ollama, 'Who keeps the ledger?');

  expect(system).toContain('Halda is the focus of this scene.');
  expect(system).not.toContain('Sera is the focus of this scene.');

  // The cast of the scene is what the user set it to. A stale story-level
  // flag must not seat someone at the table again.
  const present = /Present: (.*)/.exec(system)?.[1] ?? '';
  expect(present).toContain('Halda');
  expect(present).not.toContain('Sera');
  expect(system).toContain('Elsewhere in this world, not in the scene: Sera');

  // And with the responder goes the private material: Halda's, not Sera's.
  expect(system).toContain('skimming coin');
  expect(system).toContain('tithe roll in the chapel');
  expect(system).not.toContain('false-bottomed drawer');
  expect(system).not.toContain('every debt owed to the tavern');
});

test('a scene with no lead of its own still defers to the story’s', async ({ page }) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  // Halda is the story's lead but the second name in the room, so only the
  // story-level flag can put her in the chair — falling back to "first
  // present character" would answer Sera.
  await seedTavern(page, {
    storyPrimary: 'halda',
    primaryCharacterId: null,
    presentCharacterIds: ['sera', 'halda'],
  });

  const system = await turn(page, ollama, 'Who keeps the ledger?');

  expect(system).toContain('Halda is the focus of this scene.');
  expect(system).toContain('skimming coin');
  expect(system).not.toContain('false-bottomed drawer');
  // Both are still in the room: this is about who answers, not who is here.
  expect(system).toMatch(/Present:.*Sera/);
  expect(system).toMatch(/Present:.*Halda/);
});

test('asking a named character to reply outranks both leads', async ({ page }) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  await seedTavern(page, { storyPrimary: 'sera', primaryCharacterId: 'halda', withToma: true });

  const system = await askToReply(page, ollama, 'Toma');

  expect(system).toContain('Toma is the focus of this scene.');
  expect(system).toContain('sold the storm-glass');
  expect(system).not.toContain('false-bottomed drawer');
  expect(system).not.toContain('skimming coin');
});

test('a scene lead pointing at nobody falls back to the room, not to the story', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['A reply.']);
  await setupOllamaProvider(page);
  // The scene names a character that no longer exists. The story's lead is
  // Halda; the first character in the room is Sera.
  await seedTavern(page, {
    storyPrimary: 'halda',
    primaryCharacterId: 'a-character-that-was-deleted',
    presentCharacterIds: ['sera', 'halda'],
  });

  const system = await turn(page, ollama, 'Who keeps the ledger?');

  // resolveScene already defines this: an id it cannot resolve is discarded,
  // and the lead becomes the first character actually in the scene. That is
  // the scene-first answer, so it is left as it is rather than reaching back
  // to the story-level flag.
  expect(system).toContain('Sera is the focus of this scene.');
  expect(system).not.toContain('Halda is the focus of this scene.');
  // Still exactly one responder, and still only their secrets.
  expect((system.match(/is the focus of this scene\./g) ?? []).length).toBe(1);
  expect(system).toContain('false-bottomed drawer');
  expect(system).not.toContain('skimming coin');
});

/* --------------------------------------------- people the story has named */

test('someone the story named is described to the model', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    discovered: [
      { id: 'p-halda', name: 'Halda', note: 'A caravan driver who never arrived.' },
    ],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  // Discovery used to stop at the Cast tab: the model was never told, so the
  // next turn it invented whoever had just walked in.
  expect(system).toContain('## People the story has named');
  expect(system).toContain('Halda: A caravan driver who never arrived.');
  // And it is told not to fill in the rest.
  expect(system).toContain('do not invent a history for them');
});

test('a name from a sibling branch is not someone this branch has heard of', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    discovered: [
      { id: 'p-halda', name: 'Halda', note: 'Came in from the storm.', sourceMessageIds: ['c10'] },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain('Halda');
});

test('a descendant branch still knows the name its ancestor heard', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'deep',
    discovered: [
      { id: 'p-halda', name: 'Halda', note: 'Came in from the storm.', sourceMessageIds: ['c10'] },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain('Halda');
});

test('someone the author turned down is not mentioned', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    discovered: [
      { id: 'p-halda', name: 'Halda', note: 'A caravan driver.', dismissed: true },
      { id: 'p-tam', name: 'Tam', note: 'The stablehand.' },
    ],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).toContain('Tam');
  expect(system).not.toContain('Halda');
});

test('a story that has named nobody says nothing about it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {});

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain('People the story has named');
});

/* ------------------------------------------------- which aim governs a reply */

test('with two aims in play, the model is told which one governs the reply', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { objective: 'Get Sera to say who sealed the cellar.' },
  });

  // A story-level aim, set alongside the scene's own.
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'Working towards').fill('Getting through the season without opening it.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);

  // Both aims reach the model, as they should.
  expect(system).toContain('Get Sera to say who sealed the cellar.');
  expect(system).toContain('Getting through the season without opening it.');
  // And now it is told which one this reply is for, instead of guessing and
  // steering for the long arc in the middle of a quiet conversation.
  expect(system).toContain('What the scene is working on right now comes first');
});

test('a story aim on its own needs no ladder', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {});

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'Working towards').fill('Getting through the season.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).toContain('Getting through the season.');
  // Nothing to disambiguate, so nothing is spent saying so.
  expect(system).not.toContain('comes first in this reply');
});
