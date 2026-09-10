/**
 * Where two people stand, as the branch being played has seen it.
 *
 * `story.relationships` is the author's own record. A committed memory used to
 * be folded straight into it, which made a conclusion drawn on one branch look
 * exactly like something the author wrote, put it in front of every other
 * branch, and left no way back — the previous value survived only as a clause
 * inside a sentence.
 *
 * A RelationshipDelta records that change beside the base, naming the turns it
 * was read from. These tests seed the rows directly wherever the point is the
 * engine rather than the extractor, and check the canonical array is still
 * byte-for-byte what it was after every one of them.
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

const rows = (page: Page) => readStore<any>(page, 'relationshipDeltas');
const storyRow = async (page: Page) => (await readStore<any>(page, 'stories'))[0];
/** The canonical array, as a string, so a comparison is exact. */
const canonical = async (page: Page) => JSON.stringify((await storyRow(page)).relationships ?? []);

/** One memory row, for the cases where a change is waiting on one. */
async function seedMemory(page: Page, memory: Record<string, unknown>) {
  await page.evaluate(async (row) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const now = Date.now();
    await new Promise<void>((r) => {
      const q = db
        .transaction('memories', 'readwrite')
        .objectStore('memories')
        .put({
          origin: 'auto',
          category: 'Relationship',
          importance: 'normal',
          pinned: false,
          sourceMessageIds: ['m3'],
          sourceChatId: 'chat-1',
          sourceStoryId: 'forked-story',
          characterIds: [],
          tags: [],
          createdAt: now,
          updatedAt: now,
          ...row,
        });
      q.onsuccess = () => r();
    });
    db.close();
  }, memory);
  await page.reload();
  await boot(page);
}

const TRUST = 'Trust broken over the cellar.';
const CLOSER = 'They have grown closer since the storm.';
const AUTHORED = 'She has let them drink on credit for a year.';

/* -------------------------------------------------------------- replay */

test('a standing the story moved reaches the next prompt', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).toContain('## How they stand');
  // The newest change leads and what was there is kept behind it, which is the
  // sentence the model was always given — now computed rather than stored.
  expect(system).toContain(`${TRUST} (previously: ${AUTHORED})`);
  // And the author's record is exactly as they left it.
  expect((await storyRow(page)).relationships[0].summary).toBe(AUTHORED);
});

test('a pair the author never wrote down is still said', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(TRUST);
  expect(await canonical(page)).toBe('[]');
});

test('changes fold in the order the story made them', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationshipDeltas: [
      { id: 'rd-late', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST, appliedAt: 2 },
      { id: 'rd-early', branchId: 'main', sourceMessageIds: ['m1'], change: CLOSER, appliedAt: 1 },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // Ordered by the turn each was read from, not by the order they were stored.
  expect(systemOf(ollama)).toContain(`${TRUST} (previously: ${CLOSER})`);
});

test('a change still waiting on its memory says nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationshipDeltas: [
      { id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST, status: 'proposed' },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(TRUST);
});

test('accepting the memory a change came from is what applies it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationshipDeltas: [
      {
        id: 'rd-1',
        branchId: 'main',
        sourceMessageIds: ['m3'],
        sourceMemoryId: 'mem-1',
        change: TRUST,
        status: 'proposed',
      },
    ],
  });
  await seedMemory(page, {
    id: 'mem-1',
    title: 'A falling-out',
    content: 'Sera stopped trusting Corin over the cellar.',
    subjects: ['Sera', 'Corin'],
    basis: 'inferred',
    confidence: 0.4,
    status: 'proposed',
  });

  await goto(page, '#/memories');
  await page.getByRole('button', { name: /Needs review \(1\)/ }).click();
  await page.getByRole('button', { name: /Actions for A falling-out/ }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Accept/ }).first().click();
  await expect(page.getByText('Memory accepted')).toBeVisible({ timeout: 15_000 });

  // A change is only as believed as the memory it came from, so accepting that
  // memory is what puts it in force.
  await expect
    .poll(async () => (await rows(page))[0].status, { timeout: 20_000 })
    .toBe('applied');

  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(TRUST);
  expect(await canonical(page)).toBe('[]');
});

test('rejecting that memory takes the change with it', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationshipDeltas: [
      {
        id: 'rd-1',
        branchId: 'main',
        sourceMessageIds: ['m3'],
        sourceMemoryId: 'mem-1',
        change: TRUST,
        status: 'proposed',
      },
    ],
  });
  await seedMemory(page, {
    id: 'mem-1',
    title: 'A falling-out',
    content: 'Sera stopped trusting Corin over the cellar.',
    subjects: ['Sera', 'Corin'],
    basis: 'inferred',
    confidence: 0.4,
    status: 'proposed',
  });

  await goto(page, '#/memories');
  await page.getByRole('button', { name: /Needs review \(1\)/ }).click();
  await page.getByRole('button', { name: /Actions for A falling-out/ }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).first().click();

  await expect.poll(async () => (await rows(page)).length, { timeout: 20_000 }).toBe(0);
});

/* ---------------------------------------------------------- visibility */

test('a sibling branch never inherits the other sibling’s falling-out', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    relationshipDeltas: [
      { id: 'rd-c', branchId: 'c', sourceMessageIds: ['c10', 'c11'], change: TRUST },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // D forked from main at m1 and never lived through C's turns.
  expect(systemOf(ollama)).not.toContain(TRUST);
});

test('a descendant branch keeps what its ancestor established', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'deep',
    relationshipDeltas: [
      { id: 'rd-c', branchId: 'c', sourceMessageIds: ['c10'], change: TRUST },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // `deep` forks from `c` after c10, so c10 is on its timeline.
  expect(systemOf(ollama)).toContain(TRUST);
});

test('a change read from an exchange the branch only half has is dropped', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'deep',
    relationshipDeltas: [
      // deep forks from c at order 10, so c11 is not on its timeline.
      { id: 'rd-c', branchId: 'c', sourceMessageIds: ['c10', 'c11'], change: TRUST },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(TRUST);
});

test('switching branches writes nothing at all', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [
      { id: 'rd-c', branchId: 'c', sourceMessageIds: ['c10'], change: TRUST },
    ],
  });

  const before = await canonical(page);
  const deltasBefore = JSON.stringify(await rows(page));

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(TRUST);

  await openStoryMap(page, 'branches');
  await page.getByRole('button', { name: 'Switch to branch Branch D' }).click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  await turn(page, ollama, 'And here?');
  expect(systemOf(ollama)).not.toContain(TRUST);

  // Resolution alone decides what a branch sees. Nothing underneath moved.
  expect(await canonical(page)).toBe(before);
  expect(JSON.stringify(await rows(page))).toBe(deltasBefore);
});

/* ------------------------------------------------------------- manual */

test('a standing written by hand is never folded into', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [
      { id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED, manual: true },
    ],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  // `manual` means a person settled it.
  expect(system).toContain(AUTHORED);
  expect(system).not.toContain(TRUST);
});

test('a pair is the same pair whichever way round it was named', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [
      // The extractor names them in whatever order the sentence used.
      { id: 'rd-1', branchId: 'main', betweenIds: ['corin', 'sera'], sourceMessageIds: ['m3'], change: TRUST },
    ],
  });

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  // Folded into the row the author wrote, not said a second time beside it.
  expect(system).toContain(`${TRUST} (previously: ${AUTHORED})`);
  expect(system.match(/Trust broken over the cellar/g) ?? []).toHaveLength(1);
});

test('removing a hand-written standing lets the story’s own be heard again', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [
      { id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED, manual: true },
    ],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(AUTHORED);
  expect(systemOf(ollama)).not.toContain(TRUST);

  // This is why there is no `superseded` status: a hand-written row overrides
  // by existing, so removing it has to hand the story its voice back rather
  // than leave the change stamped out by a row that is no longer there.
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'Cast' }).click();
  await page
    .getByRole('button', { name: 'Remove the relationship between Sera and Corin' })
    .click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'And now?');
  const system = systemOf(ollama);
  expect(system).toContain(TRUST);
  expect(system).not.toContain(AUTHORED);
  // The delta was never touched to make that happen.
  expect((await rows(page))[0].status).toBe('applied');
});

/* ---------------------------------------------------- rows from before 8.4 */

test('a standing the old extractor wrote is marked, and can be kept or cleared', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    // `manual: false` in the canonical array can only be a row the old
    // destructive write left behind: nothing writes one there any more.
    relationships: [{ id: 'rel-old', betweenIds: ['sera', 'corin'], summary: TRUST }],
  });

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'Cast' }).click();
  await expect(page.getByText(/The story wrote this before Nexus recorded/)).toBeVisible();

  // Keeping it makes it the author's, and the notice goes.
  await page
    .getByRole('button', { name: 'Keep the relationship between Sera and Corin as written' })
    .click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  const story = (await readStore<any>(page, 'stories'))[0];
  expect(story.relationships[0].manual).toBe(true);
  expect(story.relationships[0].summary).toBe(TRUST);

  // And it is still sent, unchanged: keeping is not a rewrite.
  await goto(page, '#/chat/chat-1');
  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(TRUST);
});

/* ------------------------------------------------------------ reversal */

test('undoing a change puts the standing back without touching the record', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  const before = await canonical(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page
    .getByRole('button', { name: "Undo the story's change to Sera and Corin" })
    .click();
  await expect
    .poll(async () => (await rows(page))[0].status, { timeout: 20_000 })
    .toBe('reversed');
  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});

  await turn(page, ollama, 'Go on.');
  const system = systemOf(ollama);
  expect(system).not.toContain(TRUST);
  expect(system).toContain(AUTHORED);
  // Undo is a status change; the author's array was never in the loop.
  expect(await canonical(page)).toBe(before);
});

/*
 * Nothing stops an author writing the same pair twice. The prompt folds the
 * story's change into the first row and leaves the second alone, and Undo
 * has to agree with that: it belongs on the row that shows the change, and
 * nowhere if the first row was written by hand.
 */
test('undo sits on the row the change was folded into', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [
      { id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED },
      { id: 'rel-2', betweenIds: ['corin', 'sera'], summary: 'Written twice.', manual: true },
    ],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await expect(page.getByText(TRUST).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: "Undo the story's change to Sera and Corin" }),
  ).toHaveCount(1);
});

test('and is nowhere when that first row was written by hand', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [
      { id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED, manual: true },
      { id: 'rel-2', betweenIds: ['corin', 'sera'], summary: 'Written twice.' },
    ],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await expect(page.getByText(AUTHORED).first()).toBeVisible();
  // The hand-written row stands as written and nothing was folded anywhere,
  // so there is no change to undo — an Undo here would have offered to
  // reverse something the sheet does not show.
  await expect(page.getByText(TRUST)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Undo the story's change/ })).toHaveCount(0);
});

/* ------------------------------------------------------ source lifecycle */

test('deleting the turn a change was read from takes the change with it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  const before = await canonical(page);

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(async () => (await rows(page)).length, { timeout: 20_000 }).toBe(0);
  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(TRUST);
  expect(await canonical(page)).toBe(before);
});

test('rewriting the turn a change was read from voids it', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  const before = await canonical(page);

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Edit/ }).first().click();
  const editor = page.locator('.sheet').last().getByRole('textbox').first();
  await editor.fill('MAIN-THREE they never fell out at all.');
  await page.locator('.sheet').last().getByRole('button', { name: /^Save/ }).first().click();

  await expect.poll(async () => (await rows(page)).length, { timeout: 20_000 }).toBe(0);
  expect(await canonical(page)).toBe(before);
});

test('deleting a branch takes its changes and leaves the ancestor’s', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'main',
    relationshipDeltas: [
      { id: 'rd-main', branchId: 'main', sourceMessageIds: ['m1'], change: CLOSER },
      { id: 'rd-c', branchId: 'c', sourceMessageIds: ['c11'], change: TRUST },
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
    .poll(async () => (await rows(page)).map((d: any) => d.id).sort(), { timeout: 20_000 })
    .toEqual(['rd-main']);
});

test('deleting the chat takes the changes read from its turns', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    secondChat: true,
    relationshipDeltas: [
      { id: 'rd-1', chatId: 'chat-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST },
      { id: 'rd-2', chatId: 'chat-2', branchId: 'main-2', sourceMessageIds: ['s3'], change: CLOSER },
    ],
  });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();

  // A change is a claim about one chat's turns, so it cannot outlive them.
  await expect
    .poll(async () => (await rows(page)).map((d: any) => d.id).sort(), { timeout: 20_000 })
    .toEqual(['rd-2']);
});

test('deleting the story takes every change in it', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    secondChat: true,
    relationshipDeltas: [
      { id: 'rd-1', chatId: 'chat-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST },
      { id: 'rd-2', chatId: 'chat-2', branchId: 'main-2', sourceMessageIds: ['s3'], change: CLOSER },
    ],
  });

  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Actions for The Fork/ }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).first().click();

  await expect.poll(async () => (await rows(page)).length, { timeout: 20_000 }).toBe(0);
});

test('a duplicated chat is a new timeline, and carries no derived rows', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    scene: { location: 'The kitchen' },
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
    sceneDeltas: [
      { id: 'sd-1', branchId: 'main', sourceMessageIds: ['m3'], fields: { location: 'the rooftop' } },
    ],
  });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Duplicate chat' }).click();
  await expect
    .poll(async () => (await readStore<any>(page, 'chats')).length, { timeout: 20_000 })
    .toBe(2);

  /*
   * Deliberate, not an oversight. A copy gets fresh message ids, so a delta
   * carried across would name turns that no longer exist — either its
   * provenance gets rewritten to point at messages it was never read from, or
   * it can never resolve again. The copy starts from what the author wrote.
   */
  const copy = (await readStore<any>(page, 'chats')).find((c: any) => c.id !== 'chat-1');
  expect((await rows(page)).filter((d: any) => d.chatId === copy.id)).toHaveLength(0);
  expect(
    (await readStore<any>(page, 'sceneDeltas')).filter((d: any) => d.chatId === copy.id),
  ).toHaveLength(0);
  // The canonical base does come along.
  expect(copy.scene.location).toBe('The kitchen');
  expect((await rows(page)).map((d: any) => d.id)).toEqual(['rd-1']);
});

/* ------------------------------------------------------- export/import */

async function eraseEverything(page: Page) {
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('button', { name: /Erase all local data/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('ERASE');
  await dialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByText('All local data erased').first()).toBeVisible();
}

async function backupOf(page: Page): Promise<string> {
  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  return captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });
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

test('relationship changes survive a backup round-trip', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
    relationshipDeltas: [{ id: 'rd-1', branchId: 'main', sourceMessageIds: ['m3'], change: TRUST }],
  });

  const backupJson = await backupOf(page);
  const exported = JSON.parse(backupJson);
  expect((exported.relationshipDeltas ?? []).find((r: any) => r.id === 'rd-1')).toMatchObject({
    chatId: 'chat-1',
    branchId: 'main',
    change: TRUST,
    status: 'applied',
  });

  // "Erase all local data" walks a hand-written list of stores; a new one that
  // is not on it survives an erase, which is how a private record outlives the
  // act of destroying it.
  await eraseEverything(page);
  expect(await rows(page)).toHaveLength(0);

  await restore(page, backupJson, 'backup.json');
  expect((await rows(page)).find((d: any) => d.id === 'rd-1')).toMatchObject({
    branchId: 'main',
    change: TRUST,
    sourceMessageIds: ['m3'],
    status: 'applied',
  });
});

test('a backup written before relationship changes existed still restores', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: AUTHORED }],
  });

  const legacy = JSON.parse(await backupOf(page));
  delete legacy.relationshipDeltas;

  await eraseEverything(page);
  await restore(page, JSON.stringify(legacy), 'legacy.json');

  expect(await rows(page)).toHaveLength(0);
  expect((await storyRow(page)).relationships[0].summary).toBe(AUTHORED);
});
