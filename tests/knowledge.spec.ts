/**
 * Who knows of what, and what that costs the prompt: nothing.
 *
 * A KnowledgeEdge records that a character has heard something. Not that they
 * believe it, not that it is true, and — the point of this version — not
 * anything the model is told. Knowledge is recorded and shown; generation is
 * exactly what it was.
 *
 * The load-bearing test is the first one. Everything else here checks that the
 * layer resolves like every other derived layer in Nexus; that one checks it
 * stays out of the way.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  captureDownload,
  goto,
  mockOllama,
  openContextInspector,
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

/** Every message actually sent, so a leak anywhere in the payload is caught. */
function payloadOf(ollama: MockOllama): string {
  return JSON.stringify(ollama.requests.at(-1)?.body?.messages ?? []);
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

const edges = (page: Page) => readStore<any>(page, 'knowledgeEdges');
const ANNOTATE = { knowledgeMode: 'annotate' };
const SECRET = 'The cellar was sealed from the inside.';

async function openKnowledgeTab(page: Page) {
  await openContextInspector(page);
  await page.getByRole('tab', { name: 'Knowledge' }).click();
}

/** The sheets live on the chat route, so leaving it is enough to shut them. */
async function closeInspector(page: Page) {
  await page.getByRole('button', { name: 'Close context inspector' }).click();
}

/* ------------------------------------------------------------ zero cost */

test('knowledge changes nothing about what is sent', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.', 'Sera nods again.']);
  await setupOllamaProvider(page);

  /*
   * Identical story, identical memory, identical turn, tracking on — the only
   * difference between the two runs is whether an attribution exists. Seeding
   * the memory in just one of them would measure the memory's own tokens and
   * prove nothing about knowledge.
   */
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
  });
  await turn(page, ollama, 'Go on.');
  const withoutEdges = { system: systemOf(ollama), payload: payloadOf(ollama) };

  await resetDatabase(page);
  await page.reload();
  await boot(page);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        basis: 'told',
        toldById: 'corin',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });
  await turn(page, ollama, 'Go on.');

  // Byte-identical, both in the system block and in the whole message payload.
  expect(systemOf(ollama)).toBe(withoutEdges.system);
  expect(payloadOf(ollama)).toBe(withoutEdges.payload);
  // And nothing about the attribution leaked in under another name.
  expect(payloadOf(ollama)).not.toContain('knows of');
  expect(payloadOf(ollama)).not.toContain('told by');
});

test('tracking off records nothing and shows nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  // The rows are there; the default setting simply does not consult them.
  expect(await edges(page)).toHaveLength(1);
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
});

/* ----------------------------------------------------------- inspection */

test('an attribution is shown, with how it was come by', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The sealed cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        basis: 'told',
        toldById: 'corin',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText('The sealed cellar')).toBeVisible();
  await expect(page.getByText(/Sera/).first()).toBeVisible();
  await expect(page.getByText(/told by Corin/)).toBeVisible();
});

test('several people can know of one thing, separately', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The sealed cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-sera',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        basis: 'witnessed',
        sourceMessageIds: ['m2'],
      },
      {
        id: 'k-corin',
        knowerId: 'corin',
        subject: { kind: 'memory', id: 'mem-1' },
        basis: 'told',
        toldById: 'sera',
        sourceMessageIds: ['m3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/witnessed/)).toBeVisible();
  await expect(page.getByText(/told by Sera/)).toBeVisible();
  // Sera told Corin. That says nothing about Sera beyond her own edge, and it
  // certainly did not create one for anybody else.
  expect(await edges(page)).toHaveLength(2);
});

/* ---------------------------------------------------------- visibility */

test('a sibling branch never inherits an attribution', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    activeBranchId: 'd',
    memories: [{ id: 'mem-1', title: 'BRANCH-C-SECRET', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        branchId: 'c',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['c10', 'c11'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
});

test('a descendant branch keeps what its ancestor established', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    activeBranchId: 'deep',
    // Sourced from a turn `deep` can actually see: c forks from main at m1, so
    // main's later messages are not on this timeline at all.
    memories: [
      { id: 'mem-1', title: 'ANCESTOR-SECRET', content: SECRET, sourceMessageIds: ['c10'] },
    ],
    knowledgeEdges: [
      {
        id: 'k-1',
        branchId: 'c',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['c10'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText('ANCESTOR-SECRET')).toBeVisible();
});

test('half an exchange is not enough to attribute anything', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    activeBranchId: 'deep',
    memories: [{ id: 'mem-1', title: 'HALF-SEEN', content: SECRET }],
    knowledgeEdges: [
      // deep forks from c after c10, so c11 is not on its timeline.
      {
        id: 'k-1',
        branchId: 'c',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['c10', 'c11'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
});

test('a proposal is recorded and not yet counted', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'WAITING', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m2', 'm3'],
        status: 'proposed',
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
  expect(await edges(page)).toHaveLength(1);
});

/* ------------------------------------------------------------ toldById */

test('toldById is exposed only for told, and the row is left alone', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'STRAY-TELLER', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        // Over-specified rather than corrupt: a witness with a teller recorded.
        basis: 'witnessed',
        toldById: 'corin',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/witnessed/)).toBeVisible();
  await expect(page.getByText(/told by/)).toHaveCount(0);

  // Normalised on the way out, never by rewriting what was stored.
  expect((await edges(page))[0].toldById).toBe('corin');
});

/* -------------------------------------------------- relationship subject */

test('a pair is the same pair whichever way round it was named', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'], summary: 'Old friends.' }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'relationship', betweenIds: ['corin', 'sera'] },
        basis: 'discovered',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText('Sera and Corin')).toBeVisible();
});

test('an attribution about a pair survives the standing being rewritten', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    relationships: [
      { id: 'rel-1', betweenIds: ['sera', 'corin'], summary: 'Old friends.', manual: true },
    ],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'relationship', betweenIds: ['sera', 'corin'] },
        basis: 'discovered',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText('Sera and Corin')).toBeVisible();
  await closeInspector(page);

  /*
   * Removing the hand-written standing flips that pair's effective row from the
   * author's id to a synthesised one. An edge keyed by the row would have
   * stopped matching here, silently. It is keyed by the pair.
   */
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
  await openKnowledgeTab(page);
  // Still there, and honest that there is no standing to show it against.
  await expect(page.getByText('Sera and Corin')).toBeVisible();
  await expect(page.getByText(/no standing right now/)).toBeVisible();
  expect(await edges(page)).toHaveLength(1);
});

/* ------------------------------------------------------ stated memories */

test('a claim someone made is knowledge they hold, without a row for it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [
      {
        id: 'mem-stated',
        title: 'Sera on the cellar',
        content: SECRET,
        basis: 'stated',
        statedById: 'sera',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText('Sera on the cellar')).toBeVisible();
  await expect(page.getByText(/derived from a stated memory, not stored/)).toBeVisible();
  // Derivation, not migration: nothing was written.
  expect(await edges(page)).toHaveLength(0);
});

test('a claim still waiting for review derives nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [
      {
        id: 'mem-proposed',
        title: 'Sera on the cellar',
        content: SECRET,
        basis: 'stated',
        statedById: 'sera',
        status: 'proposed',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  // The compiler does not send a proposal; the inspector must not say someone
  // knows of one either. Until it is accepted it is not yet a claim.
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
  await expect(page.getByText('Sera on the cellar')).toHaveCount(0);
});

test('a memory nobody claimed derives nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [
      { id: 'mem-1', title: 'Observed', content: SECRET, basis: 'observed', statedById: null },
    ],
  });

  await turn(page, ollama, 'Go on.');
  await openKnowledgeTab(page);
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
});

/* ------------------------------------------------------------ lifecycle */

test('deleting the turn an attribution rests on takes it away', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m3'],
      },
    ],
  });

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(0);
});

test('rewriting that turn takes it away too', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m3'],
      },
    ],
  });

  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'MAIN-THREE' }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Edit/ }).first().click();
  const editor = page.locator('.sheet').last().getByRole('textbox').first();
  await editor.fill('MAIN-THREE nobody said anything at all.');
  await page.locator('.sheet').last().getByRole('button', { name: /^Save/ }).first().click();

  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(0);
});

test('deleting a branch takes its attributions and leaves the ancestor’s', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-main',
        branchId: 'main',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m1'],
      },
      {
        id: 'k-c',
        branchId: 'c',
        knowerId: 'corin',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['c11'],
      },
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
    .poll(async () => (await edges(page)).map((e: any) => e.id).sort(), { timeout: 20_000 })
    .toEqual(['k-main']);
});

test('deleting the memory takes the attributions about it', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  await goto(page, '#/memories');
  await page.getByRole('button', { name: /Actions for The cellar/ }).click();
  await page.locator('.sheet').last().getByRole('button', { name: /^Delete/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).first().click();

  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(0);
});

test('deleting the chat takes the attributions read from its turns', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    secondChat: true,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-1',
        chatId: 'chat-1',
        branchId: 'main',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m3'],
      },
      {
        id: 'k-2',
        chatId: 'chat-2',
        branchId: 'main-2',
        knowerId: 'corin',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['s3'],
      },
    ],
  });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();

  await expect
    .poll(async () => (await edges(page)).map((e: any) => e.id).sort(), { timeout: 20_000 })
    .toEqual(['k-2']);
});

/* --------------------------------------------------------- memory matrix */

test('the library counts contexts, and never claims one story-wide answer', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
    knowledgeEdges: [
      {
        id: 'k-main',
        branchId: 'main',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['m3'],
      },
      {
        id: 'k-c',
        branchId: 'c',
        knowerId: 'corin',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['c11'],
      },
      // Still waiting in the inspector: not tracked, so not counted.
      {
        id: 'k-d',
        branchId: 'd',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        sourceMessageIds: ['d21'],
        status: 'proposed',
      },
    ],
  });

  await goto(page, '#/memories');
  // Two branches recorded different people. That is two contexts, not one
  // settled fact about who knows — the page has no timeline to decide with.
  // The proposal on the third branch is nobody's knowledge yet.
  await expect(page.getByText('Knowledge tracked · 2 contexts')).toBeVisible();
  await expect(page.getByText(/Known-of by/)).toHaveCount(0);
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

test('attributions survive a backup round-trip, and derived ones are not in it', async ({
  page,
}) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    settings: ANNOTATE,
    memories: [
      { id: 'mem-1', title: 'The cellar', content: SECRET },
      {
        id: 'mem-stated',
        title: 'Sera said so',
        content: SECRET,
        basis: 'stated',
        statedById: 'sera',
      },
    ],
    knowledgeEdges: [
      {
        id: 'k-1',
        knowerId: 'sera',
        subject: { kind: 'memory', id: 'mem-1' },
        basis: 'told',
        toldById: 'corin',
        sourceMessageIds: ['m2', 'm3'],
      },
    ],
  });

  const backupJson = await backupOf(page);
  const exported = JSON.parse(backupJson);
  expect(exported.knowledgeEdges ?? []).toHaveLength(1);
  expect(exported.knowledgeEdges[0]).toMatchObject({
    id: 'k-1',
    knowerId: 'sera',
    basis: 'told',
    toldById: 'corin',
  });

  await eraseEverything(page);
  expect(await edges(page)).toHaveLength(0);

  await restore(page, backupJson, 'backup.json');
  expect((await edges(page)).find((e: any) => e.id === 'k-1')).toMatchObject({
    knowerId: 'sera',
    basis: 'told',
    toldById: 'corin',
    status: 'applied',
  });
});

test('a backup written before any of this still restores', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
  });

  const legacy = JSON.parse(await backupOf(page));
  delete legacy.knowledgeEdges;

  await eraseEverything(page);
  await restore(page, JSON.stringify(legacy), 'legacy.json');

  expect(await edges(page)).toHaveLength(0);
  expect((await readStore<any>(page, 'memories'))[0].title).toBe('The cellar');
});
