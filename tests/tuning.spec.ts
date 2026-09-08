/**
 * Tuning a reply from inside the chat, and choosing what a story opens with.
 *
 * The opening-message tests matter twice over: they cover the new field, and
 * they cover the fallback it was threaded through, since a story that predates
 * the field must still open with its character's greeting.
 */
import { expect, test } from '@playwright/test';
import {
  boot,
  field,
  goto,
  mockAI,
  readStore,
  reloadApp,
  resetDatabase,
  seedFixtures,
  sendMessage,
  setupProvider,
  sheetAction,
  startChat,
  openResponseSettings,
} from './helpers';

/** The provider mounted for the current test, so requests can be inspected. */
let provider: Awaited<ReturnType<typeof mockAI>>;

test.beforeEach(async ({ page }) => {
  provider = await mockAI(page, ['She pours something dark and says nothing.']);
  await page.goto('/');
  await resetDatabase(page);
  // The reload is what recreates the object stores; seeding into a
  // just-deleted database would find no stores to write to.
  await page.reload();
  await boot(page);
  await seedFixtures(page);
  await setupProvider(page);
});

/**
 * Waits for the next outgoing request and returns it. sendMessage() resolves as
 * soon as the user's bubble renders, which can be before the request leaves.
 */
async function nextRequest(count: number) {
  await expect.poll(() => provider.requests.length, { timeout: 20_000 }).toBeGreaterThan(count - 1);
  return provider.requests.at(-1)!.body;
}

/** Response settings, which lives in Quick Settings rather than the chat menu. */
async function openTuning(page: import('@playwright/test').Page) {
  await openResponseSettings(page);
  await expect(page.getByRole('textbox', { name: /Direction sent to the AI/ })).toBeVisible();
}

test('a story with no opening message still opens with the character greeting', async ({ page }) => {
  // The seeded story predates the opening-message field, so it has none.
  await startChat(page);
  await expect(page.locator('[data-testid="message-bubble"]').first()).toContainText(
    'Sera looks up from the bar.',
  );
});

test("a story's own opening message replaces the character greeting", async ({ page }) => {
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Actions for/ }).first().click();
  await sheetAction(page, /^Edit/);
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'Opening scene').fill('Snow has sealed the pass.');
  await page.getByRole('button', { name: 'Save' }).first().click();

  await startChat(page);
  const first = page.locator('[data-testid="message-bubble"]').first();
  await expect(first).toContainText('Snow has sealed the pass.');
  await expect(first).not.toContainText('Sera looks up from the bar.');
});

test('direction set inside the chat reaches the model and survives a reload', async ({ page }) => {
  await startChat(page);
  await openTuning(page);

  await page.getByRole('button', { name: 'More dialogue' }).click();
  // The nudge must write the literal sentence, so what is shown is what is sent.
  await expect(page.getByRole('textbox', { name: /Direction sent to the AI/ })).toHaveValue(
    /Favour spoken dialogue over narration\./,
  );
  await page.getByRole('button', { name: 'Apply' }).click();

  const before = provider.requests.length;
  await sendMessage(page, 'What is she pouring?');
  expect(JSON.stringify(await nextRequest(before + 1))).toContain(
    'Favour spoken dialogue over narration.',
  );

  // Stored, not merely held in memory.
  const [chat] = await readStore<{ direction: string }>(page, 'chats');
  expect(chat.direction).toContain('Favour spoken dialogue over narration.');

  // The tuning already in force is still readable without opening the sheet —
  // it moved from the chat menu to Quick Settings along with the control.
  await reloadApp(page);
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await expect(page.locator('.sheet').last()).toContainText('1 direction');
});

test('a temperature set for one chat does not affect its sibling', async ({ page }) => {
  await startChat(page);
  await openTuning(page);

  await page.getByRole('button', { name: 'Override' }).first().click();
  await page.getByRole('slider', { name: /Temperature/ }).first().fill('0.15');
  await page.getByRole('button', { name: 'Apply' }).click();

  const before = provider.requests.length;
  await sendMessage(page, 'She sets down the bottle.');
  expect((await nextRequest(before + 1)).temperature).toBeCloseTo(0.15, 3);

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, /New chat in this story/);
  // Wait for the new chat to actually become active: sending too early would
  // generate in the old one and test nothing.
  await expect(page.locator('[data-testid="message-bubble"]')).toHaveCount(1);
  const beforeSibling = provider.requests.length;
  await sendMessage(page, 'A different night.');
  expect((await nextRequest(beforeSibling + 1)).temperature).not.toBeCloseTo(0.15, 3);
});

