/**
 * Which summary describes which timeline.
 *
 * A StorySummary used to be resolved by story alone while its watermark
 * counted messages in one chat's order space. That let a sibling branch read —
 * and then overwrite — a compression of events it never had, and let one
 * chat's watermark delete another chat's entire transcript, because every chat
 * counts from zero.
 *
 * These read Ollama's own request body: the summary prose lands in the system
 * block, the transcript in the message list, and both have to be checked
 * because suppressing history has two levers.
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

/** The system block: where summary prose lands. */
function systemOf(ollama: MockOllama): string {
  const body = ollama.requests.at(-1)?.body;
  const system = (body?.messages ?? []).find((m: any) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

/** Every message in the request: where the transcript lands. */
function transcriptOf(ollama: MockOllama): string {
  const body = ollama.requests.at(-1)?.body;
  return (body?.messages ?? [])
    .filter((m: any) => m.role !== 'system')
    .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
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

const C_SUMMARY = 'C-ONLY a stranger joined the household.';
const D_SUMMARY = 'D-ONLY nobody ever joined the household.';
const MAIN_SUMMARY = 'MAIN-SHARED the storm shut the roads.';

/* ------------------------------------------------------------ visibility */

test('a summary of the branch being played applies', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    summaries: [{ id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(C_SUMMARY);
});

test('a sibling branch never sees the other sibling’s summary', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    summaries: [{ id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  // D forked from main at m1 and never had C's events.
  expect(systemOf(ollama)).not.toContain(C_SUMMARY);
  // And D's own transcript is untouched: no watermark applied.
  expect(transcriptOf(ollama)).toContain('BRANCH-D-TWENTY');
});

test('an ancestor’s summary is inherited when it stops at the fork', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    // Covers m0–m1, exactly what C inherited.
    summaries: [{ id: 'sum-main', chatId: 'chat-1', branchId: 'main', coveredThroughOrder: 1, rollingSummary: MAIN_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(MAIN_SUMMARY);
  // Its compression is real: the messages it covers are no longer sent.
  const transcript = transcriptOf(ollama);
  expect(transcript).not.toContain('MAIN-ZERO');
  expect(transcript).toContain('BRANCH-C-TEN');
});

test('an ancestor’s summary that reaches past the fork is refused', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    // main played on to m3; C forked at m1 and never saw m2 or m3.
    summaries: [{ id: 'sum-main', chatId: 'chat-1', branchId: 'main', coveredThroughOrder: 3, rollingSummary: MAIN_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(MAIN_SUMMARY);
  // Nothing was suppressed on its behalf either.
  expect(transcriptOf(ollama)).toContain('MAIN-ZERO');
});

test('a descendant’s summary is invisible to its ancestor', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'main',
    summaries: [{ id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(C_SUMMARY);
  expect(transcriptOf(ollama)).toContain('MAIN-ZERO');
});

/* ------------------------------------------------------------ multi-chat */

test('one chat’s watermark never truncates another chat, nor clamps its window', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    secondChat: true,
    open: 'chat-2',
    // A legacy row: no chat, no branch, and a watermark from whichever chat
    // last summarised. Chat 2 counts 0–29, so 120 would erase all of it.
    summaries: [{ id: 'forked-story', coveredThroughOrder: 120, rollingSummary: MAIN_SUMMARY }],
    // Small enough that the second lever is visible if it fires.
    settings: { summaryWindow: 5 },
  });

  await turn(page, ollama, 'Go on.');
  const transcript = transcriptOf(ollama);

  // Lever one: the watermark must not remove the transcript.
  expect(transcript).toContain('CHAT2-LINE-0');
  expect(transcript).toContain('CHAT2-LINE-29');
  // Lever two: nor may the window be clamped to summaryWindow on its behalf.
  const kept = (transcript.match(/CHAT2-LINE-/g) ?? []).length;
  expect(kept).toBeGreaterThan(20);

  // Its prose still describes the story, as it did before, and is still sent.
  expect(systemOf(ollama)).toContain(MAIN_SUMMARY);
});

test('a legacy summary still applies to the only chat that could have made it', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'main',
    // One chat in the story, so there is only one order space this can be in.
    summaries: [{ id: 'forked-story', coveredThroughOrder: 1, rollingSummary: MAIN_SUMMARY }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(MAIN_SUMMARY);
  const transcript = transcriptOf(ollama);
  expect(transcript).not.toContain('MAIN-ZERO');
  expect(transcript).not.toContain('MAIN-ONE ');
  expect(transcript).toContain('MAIN-TWO');
});

/* ------------------------------------------------------------- writing */

test('summarising a branch writes that branch’s row and leaves its sibling alone', async ({
  page,
}) => {
  const ollama = await mockOllama(page, [
    'Sera nods.',
    JSON.stringify({
      currentSummary: 'D stands alone.',
      rollingSummary: D_SUMMARY,
      importantEvents: [],
      relationshipState: '',
      characterState: {},
    }),
  ]);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    summaries: [{ id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY }],
    // Summarise after a single foldable message.
    settings: { summaryWindow: 1, autoSummaryEvery: 1 },
  });

  await turn(page, ollama, 'Go on.');

  await expect
    .poll(async () => (await readStore<any>(page, 'storySummaries')).length, { timeout: 25_000 })
    .toBe(2);
  const rows = await readStore<any>(page, 'storySummaries');

  // C's row is byte-for-byte what it was: a sibling summarising must not
  // rewrite it, which is what the single per-story row used to do.
  const c = rows.find((r: any) => r.id === 'sum-c');
  expect(c.rollingSummary).toBe(C_SUMMARY);
  expect(c.branchId).toBe('c');

  // D got its own row, stamped with the timeline it describes.
  const d = rows.find((r: any) => r.id !== 'sum-c');
  expect(d.branchId).toBe('d');
  expect(d.chatId).toBe('chat-1');
  expect(d.storyId).toBe('forked-story');
  expect(d.id).not.toBe('forked-story');
  expect(d.rollingSummary).toBe(D_SUMMARY);
});

test('a branch-owned summary is seeded from the ancestor it inherited', async ({ page }) => {
  const ollama = await mockOllama(page, [
    'Sera nods.',
    JSON.stringify({
      currentSummary: 'Carried forward.',
      rollingSummary: `${MAIN_SUMMARY} ${C_SUMMARY}`,
      importantEvents: [],
      relationshipState: '',
      characterState: {},
    }),
  ]);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    summaries: [{ id: 'sum-main', chatId: 'chat-1', branchId: 'main', coveredThroughOrder: 1, rollingSummary: MAIN_SUMMARY }],
    settings: { summaryWindow: 1, autoSummaryEvery: 1 },
  });

  await turn(page, ollama, 'Go on.');
  await expect
    .poll(() => ollama.utility.length, { timeout: 25_000 })
    .toBeGreaterThan(0);

  // The ancestor's compression is handed to the model rather than thrown away
  // and recomputed — this is what makes reuse cheap instead of a copy.
  const sent = JSON.stringify(ollama.utility.at(-1)!.body);
  expect(sent).toContain('Previous summary:');
  expect(sent).toContain(MAIN_SUMMARY);

  // The ancestor's own row survives; C's is new.
  await expect
    .poll(async () => (await readStore<any>(page, 'storySummaries')).length, { timeout: 25_000 })
    .toBe(2);
  const rows = await readStore<any>(page, 'storySummaries');
  expect(rows.find((r: any) => r.id === 'sum-main').rollingSummary).toBe(MAIN_SUMMARY);
  expect(rows.find((r: any) => r.id !== 'sum-main').branchId).toBe('c');
});

/* ------------------------------------------------------------- lifecycle */

test('deleting a branch takes its summary and leaves the ancestor’s', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'main',
    summaries: [
      { id: 'sum-main', chatId: 'chat-1', branchId: 'main', coveredThroughOrder: 1, rollingSummary: MAIN_SUMMARY },
      { id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY },
    ],
  });

  await openStoryMap(page, 'branches');
  // Scoped to Branch C's own card — every branch row carries a Delete — and
  // identified by its switch button so no ancestor container can match first.
  await page
    .locator('.card')
    .filter({ has: page.getByRole('button', { name: 'Switch to branch Branch C' }) })
    .getByRole('button', { name: 'Delete' })
    .click();
  // The confirm is itself a sheet, stacked over the story map.
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();

  await expect
    .poll(async () => (await readStore<any>(page, 'storySummaries')).map((r: any) => r.id).sort(), {
      timeout: 20_000,
    })
    .toEqual(['sum-main']);
});

test('deleting a chat takes the summaries that describe its timelines', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    secondChat: true,
    open: 'chat-2',
    summaries: [
      { id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY },
      { id: 'sum-2', chatId: 'chat-2', branchId: 'main-2', coveredThroughOrder: 5, rollingSummary: 'Chat two.' },
    ],
  });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();

  await expect
    .poll(async () => (await readStore<any>(page, 'storySummaries')).map((r: any) => r.id).sort(), {
      timeout: 20_000,
    })
    .toEqual(['sum-c']);
});

/* ---------------------------------------------------------- export/import */

test('a summary’s chat and branch survive a backup round-trip', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    summaries: [{ id: 'sum-c', chatId: 'chat-1', branchId: 'c', coveredThroughOrder: 11, rollingSummary: C_SUMMARY }],
  });

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  const backupJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });
  const exported = JSON.parse(backupJson);
  const rows = exported.payload?.storySummaries ?? exported.storySummaries;
  expect(rows.find((r: any) => r.id === 'sum-c')).toMatchObject({
    chatId: 'chat-1',
    branchId: 'c',
    coveredThroughOrder: 11,
  });

  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('button', { name: /Erase all local data/ }).click();
  const eraseDialog = page.getByRole('dialog');
  await eraseDialog.getByRole('textbox').first().fill('ERASE');
  await eraseDialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByText('All local data erased').first()).toBeVisible();

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  await page.getByRole('button', { name: 'Choose backup file' }).click();
  await page.locator('input[type=file][accept*="json"]').last().setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupJson),
  });
  await expect(page.getByText('This backup contains').first()).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Backup restored').first()).toBeVisible({ timeout: 30_000 });

  const restored = await readStore<any>(page, 'storySummaries');
  expect(restored.find((r: any) => r.id === 'sum-c')).toMatchObject({
    chatId: 'chat-1',
    branchId: 'c',
    coveredThroughOrder: 11,
  });
});
