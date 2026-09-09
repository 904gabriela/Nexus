/**
 * The scene as the story left it.
 *
 * `chat.scene` is the canonical base a person writes. A SceneDelta is a change
 * the story itself established, kept beside the base and replayed over it, so
 * the prompt follows the transcript out of the kitchen without anyone retyping
 * where they are — and without the sibling branch, which never left, being told
 * it did.
 *
 * Replay is seeded directly here wherever the point is the engine rather than
 * the extractor: those tests must not depend on what a model chooses to say.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  captureDownload,
  goto,
  mockOllama,
  openStoryMap,
  readStore,
  resetDatabase,
  setupOllamaProvider,
  type MockOllama,
} from './helpers';
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

async function turn(page: Page, ollama: MockOllama, text: string) {
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
}

const deltas = (page: Page) => readStore<any>(page, 'sceneDeltas');
const chatRow = async (page: Page) =>
  (await readStore<any>(page, 'chats')).find((c: any) => c.id === 'chat-1');

/** A model reply for the scene extractor. */
function sceneReply(changes: unknown[]): string {
  return JSON.stringify({ changes });
}

const ROOFTOP = 'They leave the kitchen and step onto the rooftop.';

/* ------------------------------------------------------------ replay */

test('a change the story made reaches the next prompt', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', branchId: 'main', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).toContain('Location: the rooftop');
  expect(system).not.toContain('Location: The kitchen');
});

test('replay never writes to the canonical base', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', branchId: 'main', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // The prompt moved; what the author wrote did not.
  expect(systemOf(ollama)).toContain('Location: the rooftop');
  expect((await chatRow(page)).scene.location).toBe('The kitchen');
});

test('a sibling branch never inherits a change it did not live through', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    scene: { location: 'The kitchen' },
    // Established on C, whose messages branch D has never had.
    sceneDeltas: [
      { id: 'd-roof', branchId: 'c', sourceMessageIds: ['c11'], fields: { location: 'the rooftop' } },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain('Location: The kitchen');
  expect(systemOf(ollama)).not.toContain('the rooftop');
});

test('a descendant inherits its ancestor’s change; the ancestor does not inherit back', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      // On main, from a message C inherited.
      { id: 'd-hall', branchId: 'main', sourceMessageIds: ['m1'], fields: { location: 'the hallway' } },
      // On the branch below C, which C itself has never had.
      { id: 'd-deep', branchId: 'deep', sourceMessageIds: ['dp30'], fields: { location: 'the cellar' } },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain('Location: the hallway');
  expect(systemOf(ollama)).not.toContain('the cellar');
});

test('character state merges by character and never replaces the record', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: {
      presentCharacterIds: ['sera'],
      characterStates: { sera: 'standing behind the bar' },
    },
    sceneDeltas: [
      {
        id: 'd-sit',
        sourceMessageIds: ['m3'],
        fields: { characterStates: { corin: 'sitting by the fire' } },
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // Sera's line survives a delta that never mentioned her.
  expect(systemOf(ollama)).toContain('standing behind the bar');
});

/* ------------------------------------------------------------ reversal */

test('undoing the second change of two restores the first', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd1', sourceMessageIds: ['m1'], fields: { location: 'the rooftop' }, appliedAt: 1 },
      { id: 'd2', sourceMessageIds: ['m3'], fields: { location: 'the dorm' }, appliedAt: 2 },
    ],
  });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('button', { name: /Undo the story's change to Where/ }).click();
  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  await goto(page, '#/chat/chat-1');

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain('Location: the rooftop');
  expect((await deltas(page)).find((d: any) => d.id === 'd2').status).toBe('reversed');
});

test('undoing the first change of two leaves the second standing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd1', sourceMessageIds: ['m1'], fields: { location: 'the rooftop' }, appliedAt: 1, status: 'reversed' },
      { id: 'd2', sourceMessageIds: ['m3'], fields: { location: 'the dorm' }, appliedAt: 2 },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // Undoing an earlier move does not undo a later one.
  expect(systemOf(ollama)).toContain('Location: the dorm');
});

/* ------------------------------------------------------ source lifecycle */

test('deleting the turn a change was read from takes the change with it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(async () => (await deltas(page)).length, { timeout: 20_000 }).toBe(0);
  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain('Location: The kitchen');
});

test('rewriting the turn a change was read from voids it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Edit/ }).first().click();
  const editor = page.locator('.sheet').last().getByRole('textbox').first();
  await editor.fill('MAIN-THREE they stayed exactly where they were.');
  await page.locator('.sheet').last().getByRole('button', { name: /^Save/ }).first().click();

  await expect.poll(async () => (await deltas(page)).length, { timeout: 20_000 }).toBe(0);
});

test('deleting a branch takes its changes and leaves the ancestor’s', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'main',
    sceneDeltas: [
      { id: 'd-main', branchId: 'main', sourceMessageIds: ['m1'], fields: { location: 'the hallway' } },
      { id: 'd-c', branchId: 'c', sourceMessageIds: ['c11'], fields: { location: 'the rooftop' } },
    ],
  });

  await openStoryMap(page, 'branches');
  await page
    .locator('.card')
    .filter({ has: page.getByRole('button', { name: 'Switch to branch Branch C' }) })
    .getByRole('button', { name: 'Delete' })
    .click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();

  await expect
    .poll(async () => (await deltas(page)).map((d: any) => d.id).sort(), { timeout: 20_000 })
    .toEqual(['d-main']);
});

/* --------------------------------------------------------- user edits */

test('opening the scene editor and closing it changes nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  // The field shows what the story made true, so a blur must not read as an
  // edit and take the change back.
  const where = page.getByRole('textbox', { name: 'Where', exact: true });
  await expect(where).toHaveValue('the rooftop');
  await where.click();
  await page.getByRole('textbox', { name: 'What is happening', exact: true }).click();
  await page.waitForTimeout(300);

  expect((await deltas(page))[0].status).toBe('applied');
  expect((await chatRow(page)).scene.location).toBe('The kitchen');
});

test('writing over a derived field takes it back, and only that field', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen', situation: 'They were arguing.' },
    sceneDeltas: [
      { id: 'd-loc', sourceMessageIds: ['m1'], fields: { location: 'the rooftop' } },
      { id: 'd-sit', sourceMessageIds: ['m3'], fields: { situation: 'They have gone quiet.' } },
    ],
  });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  const where = page.getByRole('textbox', { name: 'Where', exact: true });
  await where.fill('the bedroom');
  await page.getByRole('textbox', { name: 'What is happening', exact: true }).click();

  await expect
    .poll(async () => (await deltas(page)).find((d: any) => d.id === 'd-loc').status, {
      timeout: 20_000,
    })
    .toBe('superseded');

  // The situation delta was not touched: editing where they are says nothing
  // about what is happening.
  expect((await deltas(page)).find((d: any) => d.id === 'd-sit').status).toBe('applied');
  expect((await chatRow(page)).scene.location).toBe('the bedroom');

  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).toContain('Location: the bedroom');
  expect(system).toContain('They have gone quiet.');
});

/* ---------------------------------------------------------- extraction */

test('a completed move is applied, announced and reaches the prompt', async ({ page }) => {
  const ollama = await mockOllama(page, [ROOFTOP, 'Sera nods.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.92,
        evidence: ROOFTOP,
      },
    ]),
    sceneReply([]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);

  const row = (await deltas(page))[0];
  expect(row.status).toBe('applied');
  expect(row.fields.location).toBe('the rooftop');
  expect(row.previous.location).toBe('The kitchen');
  expect(row.branchId).toBe('main');
  expect(row.chatId).toBe('chat-1');

  // Said in the story's words, with no implementation terminology.
  await expect(page.getByText('The scene moved to the rooftop.').first()).toBeVisible();

  await turn(page, ollama, 'And now?');
  expect(systemOf(ollama)).toContain('Location: the rooftop');
});

test('a change is attributed to the turn that established it', async ({ page }) => {
  const NARRATION = 'Kenta opens the door and steps onto the rooftop.';
  const ollama = await mockOllama(page, [NARRATION, 'ok']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.93,
        evidence: NARRATION,
      },
    ]),
    sceneReply([]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'Kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'We should get some air.');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);

  const row = (await deltas(page))[0];
  const messages = await readStore<any>(page, 'messages');
  const narration = messages.find((m: any) => m.content === NARRATION);
  const asked = messages.find((m: any) => m.content === 'We should get some air.');

  // The assistant turn narrated the move; the user turn only asked for air.
  // Naming both would leave it unanswerable which one established the change.
  expect(row.sourceMessageIds).toEqual([narration.id]);
  expect(row.sourceMessageIds).not.toContain(asked.id);
});

test('the role that established a change is recoverable from the stored delta', async ({
  page,
}) => {
  const NARRATION = 'Kenta opens the door and steps onto the rooftop.';
  const ollama = await mockOllama(page, [NARRATION, 'ok']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.93,
        evidence: NARRATION,
      },
    ]),
    sceneReply([]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'Kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'We should get some air.');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);

  // Resolving the stored ids back to messages answers "who said so", which is
  // what the contract said provenance would support.
  const row = (await deltas(page))[0];
  const messages = await readStore<any>(page, 'messages');
  const roles = row.sourceMessageIds.map(
    (id: string) => messages.find((m: any) => m.id === id)?.role,
  );
  expect(roles).toEqual(['assistant']);
});

test('the extractor is told which sentences are not scene changes', async ({ page }) => {
  const ollama = await mockOllama(page, [ROOFTOP]);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(() => ollama.scene.length, { timeout: 25_000 }).toBeGreaterThan(0);

  const sent = JSON.stringify(ollama.scene.at(-1)!.body);
  expect(sent).toContain('has ALREADY HAPPENED');
  expect(sent).toContain('an intention or a decision');
  expect(sent).toContain('movement that has not arrived');
  expect(sent).toContain('merely visible or mentioned');
  expect(sent).toContain('something that happened earlier');
  // And the current scene is given, so a restatement is not read as a change.
  expect(sent).toContain('The kitchen');

  // Nothing changed, so nothing was written.
  expect(await deltas(page)).toHaveLength(0);
});

test('a change the exchange does not support is refused', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera wipes the bar and says nothing.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the observatory tower',
        basis: 'observed',
        confidence: 0.99,
        evidence: 'They climbed to the observatory tower.',
      },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'Anything happening?');
  await expect.poll(() => ollama.scene.length, { timeout: 25_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // Neither the quoted sentence nor the value appears in the exchange, so the
  // claim has nothing holding it up however sure the model says it is.
  expect(await deltas(page)).toHaveLength(0);
});

test('an inferred change is only ever proposed', async ({ page }) => {
  const ollama = await mockOllama(page, [ROOFTOP, 'Sera nods.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'inferred',
        confidence: 0.99,
        evidence: ROOFTOP,
      },
    ]),
    sceneReply([]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);
  expect((await deltas(page))[0].status).toBe('proposed');

  await turn(page, ollama, 'And now?');
  expect(systemOf(ollama)).toContain('Location: The kitchen');
});

test('an observed change below the threshold is only proposed', async ({ page }) => {
  const ollama = await mockOllama(page, [ROOFTOP]);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.5,
        evidence: ROOFTOP,
      },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);
  expect((await deltas(page))[0].status).toBe('proposed');
});

test('the objective is never taken automatically', async ({ page }) => {
  const ollama = await mockOllama(page, ['They agree the point is now to find the key.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'objective',
        character: null,
        value: 'find the key',
        basis: 'observed',
        confidence: 0.99,
        evidence: 'They agree the point is now to find the key.',
      },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { objective: 'Get through the night.' },
    settings: { sceneEvolution: 'apply' },
  });

  await turn(page, ollama, 'What now?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);
  // What the scene is driving at is the user's to set, however sure the model is.
  expect((await deltas(page))[0].status).toBe('proposed');
});

test('the propose setting never applies anything by itself', async ({ page }) => {
  const ollama = await mockOllama(page, [ROOFTOP, 'Sera nods.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.99,
        evidence: ROOFTOP,
      },
    ]),
    sceneReply([]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'propose' },
  });

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 25_000 }).toBe(1);
  expect((await deltas(page))[0].status).toBe('proposed');

  await turn(page, ollama, 'And now?');
  expect(systemOf(ollama)).toContain('Location: The kitchen');
});

test('a fresh install follows the scene without being asked', async ({ page }) => {
  // The reply is the narration the change is read from, so the quoted evidence
  // is genuinely in the exchange — the extractor refuses a claim it cannot
  // find, which is the point of that check.
  const ollama = await mockOllama(page, [ROOFTOP]);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.99,
        evidence: ROOFTOP,
      },
    ]),
  ];
  await setupOllamaProvider(page);
  // No sceneEvolution override: whatever a new install ships with.
  await seedBranchedStory(page, { scene: { location: 'The kitchen' } });

  /*
   * This shipped 'off' while scene evolution was new, and the cost of that
   * caution was an engine that followed nothing until you found a switch you
   * had no reason to know existed. It ships on now. The assertion that 'off'
   * genuinely means off has not gone anywhere — it is the test below.
   */
  expect((await readStore<any>(page, 'settings'))[0].sceneEvolution).toBe('apply');

  await turn(page, ollama, 'Where are we going?');
  await expect.poll(async () => (await deltas(page)).length, { timeout: 20_000 }).toBe(1);
  expect((await deltas(page))[0]).toMatchObject({ status: 'applied' });
  // And the canonical base a person wrote is still theirs.
  expect((await chatRow(page)).scene.location).toBe('The kitchen');
});

test('turned off, nothing is asked of the model and nothing is recorded', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  ollama.sceneReplies = [
    sceneReply([
      {
        field: 'location',
        character: null,
        value: 'the rooftop',
        basis: 'observed',
        confidence: 0.99,
        evidence: ROOFTOP,
      },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'off' },
  });

  await turn(page, ollama, 'Where are we going?');
  await page.waitForTimeout(700);
  // Off is off: the extractor is never called, so it costs nothing at all.
  expect(ollama.scene).toHaveLength(0);
  expect(await deltas(page)).toHaveLength(0);
});

test('all three scene-change modes persist across a reload', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {});

  for (const mode of ['propose', 'apply', 'off'] as const) {
    await goto(page, '#/settings');
    await page.getByRole('tab', { name: 'Memory' }).click().catch(() => {});
    await page
      .getByRole('combobox', { name: 'When the story moves the scene' })
      .selectOption(mode);
    await expect
      .poll(async () => (await readStore<any>(page, 'settings'))[0].sceneEvolution)
      .toBe(mode);
    await page.reload();
    await boot(page);
    expect((await readStore<any>(page, 'settings'))[0].sceneEvolution).toBe(mode);
  }
});

test('turning scene changes off asks the model nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    settings: { sceneEvolution: 'off' },
  });

  await turn(page, ollama, 'Where are we going?');
  await page.waitForTimeout(700);
  expect(ollama.scene).toHaveLength(0);
  expect(await deltas(page)).toHaveLength(0);
});

/* ------------------------------------------------------- fork and transfer */

test('a chat forked from here keeps the scene it was forked from', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: {
      location: 'The kitchen',
      situation: 'They were arguing.',
      objective: 'Settle it.',
      presentCharacterIds: ['sera'],
      primaryCharacterId: 'sera',
      characterStates: { sera: 'furious' },
    },
  });

  // Forking a chat is a message action: "Start new chat from here".
  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page
    .locator('.sheet')
    .last()
    .getByRole('button', { name: 'Start new chat from here' })
    .click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Create chat' }).click();

  await expect
    .poll(async () => (await readStore<any>(page, 'chats')).length, { timeout: 20_000 })
    .toBe(2);
  const forked = (await readStore<any>(page, 'chats')).find((c: any) => c.id !== 'chat-1');
  expect(forked.scene).toMatchObject({
    location: 'The kitchen',
    situation: 'They were arguing.',
    objective: 'Settle it.',
    presentCharacterIds: ['sera'],
    primaryCharacterId: 'sera',
    characterStates: { sera: 'furious' },
  });
});

async function eraseEverything(page: Page) {
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('button', { name: /Erase all local data/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('ERASE');
  await dialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByText('All local data erased').first()).toBeVisible();
}

async function restore(page: Page, json: string, name: string) {
  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  await page.getByRole('button', { name: 'Choose backup file' }).click();
  await page.locator('input[type=file][accept*="json"]').last().setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });
  await expect(page.getByText('This backup contains').first()).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Backup restored').first()).toBeVisible({ timeout: 30_000 });
}

async function backupOf(page: Page): Promise<string> {
  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  return captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });
}

test('scene changes survive a backup round-trip', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    sceneDeltas: [
      { id: 'd-roof', branchId: 'main', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  const backupJson = await backupOf(page);
  const exported = JSON.parse(backupJson);
  expect((exported.sceneDeltas ?? []).find((r: any) => r.id === 'd-roof')).toMatchObject({
    chatId: 'chat-1',
    branchId: 'main',
    status: 'applied',
  });

  await eraseEverything(page);
  expect(await deltas(page)).toHaveLength(0);

  await restore(page, backupJson, 'backup.json');
  expect((await deltas(page)).find((d: any) => d.id === 'd-roof')).toMatchObject({
    chatId: 'chat-1',
    branchId: 'main',
    fields: { location: 'the rooftop' },
    status: 'applied',
  });
});

test('a backup written before scene changes existed still restores', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, { scene: { location: 'The kitchen' } });

  const legacy = JSON.parse(await backupOf(page));
  delete legacy.sceneDeltas;

  await eraseEverything(page);
  await restore(page, JSON.stringify(legacy), 'legacy.json');

  expect(await deltas(page)).toHaveLength(0);
  expect((await chatRow(page)).scene.location).toBe('The kitchen');
});
