/**
 * Writing styles: readable, editable, yours to keep.
 *
 * The styles have always combined and always reached the model as one block.
 * What these cover is the part that was missing — that a person can read what
 * a style says, change it, make their own, name a combination and apply it in
 * one tap — and that every one of those changes is the text the model then
 * receives, not a label on a screen.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockAI,
  resetDatabase,
  setupProvider,
  type MockProvider,
} from './helpers';
import { seedBranchedStory } from './branch-summary-fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

async function send(page: Page, ai: MockProvider, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable({ timeout: 20_000 });
  const before = ai.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ai.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
  return ai.requests.at(-1)!.body;
}

const styleCard = (page: Page, id: string) => page.locator(`[data-preset-id="${id}"]`);

async function openStyle(page: Page, id: string) {
  const card = styleCard(page, id);
  await card.getByRole('button', { name: /^Expand / }).click();
  return card;
}

async function chooseStyle(page: Page, name: string) {
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();
}

const composerBadge = (page: Page) => page.locator('.composer-style');
/** The saved-combination chips in Chat settings, apart from the composer badge that names one. */
const savedChip = (page: Page, name: string) =>
  page.locator('[aria-label="Saved combinations"]').getByRole('button', { name });

/* ------------------------------------------------------------- editing */

test('editing a built-in style changes what is sent, and reset restores it', async ({ page }) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/styles');
  const card = await openStyle(page, 'preset-detailed');
  await card.getByRole('textbox', { name: 'Instruction' }).fill('ZZ-EDITED: dwell on textures.');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Built-in, edited')).toBeVisible();

  await goto(page, '#/chat/chat-1');
  await chooseStyle(page, 'Detailed');
  let body = await send(page, ai, 'Go on.');
  expect(JSON.stringify(body.messages)).toContain('ZZ-EDITED: dwell on textures.');

  // Reset puts the shipped text back, and that is what goes out next.
  await goto(page, '#/styles');
  const again = await openStyle(page, 'preset-detailed');
  await again.getByRole('button', { name: 'Reset to built-in' }).click();
  await expect(again.getByText('Built-in', { exact: true })).toBeVisible();

  await goto(page, '#/chat/chat-1');
  body = await send(page, ai, 'And?');
  const text = JSON.stringify(body.messages);
  expect(text).not.toContain('ZZ-EDITED');
  expect(text).toContain('Use richer sensory and environmental description');
});

test('a style of your own reaches the model, and can be deleted', async ({ page }) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/styles');
  await page.getByRole('button', { name: 'New style' }).click();
  // A new style opens ready to write.
  const card = page.locator('[data-testid="style-card"]').filter({ hasText: 'Yours' }).first();
  await card.getByRole('textbox', { name: 'Name' }).fill('Whispered');
  await card.getByRole('textbox', { name: 'Instruction' }).fill('ZZ-WHISPER: keep voices low.');
  await card.getByRole('button', { name: 'Save', exact: true }).click();

  await goto(page, '#/chat/chat-1');
  await chooseStyle(page, 'Whispered');
  const body = await send(page, ai, 'Go on.');
  expect(JSON.stringify(body.messages)).toContain('- Whispered: ZZ-WHISPER: keep voices low.');

  await goto(page, '#/styles');
  const mine = page.locator('[data-testid="style-card"]').filter({ hasText: 'Whispered' });
  await mine.getByRole('button', { name: /^Expand / }).click();
  await mine.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('[data-testid="style-card"]').filter({ hasText: 'Whispered' })).toHaveCount(0);
});

test('duplicating a built-in makes a copy that is yours', async ({ page }) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/styles');
  const card = await openStyle(page, 'preset-slow-burn');
  await card.getByRole('button', { name: 'Duplicate' }).click();
  const copy = page.locator('[data-testid="style-card"]').filter({ hasText: 'Slow Burn (copy)' });
  await expect(copy).toHaveCount(1);
  await expect(copy.getByText('Yours')).toBeVisible();
  // The original is untouched.
  await expect(styleCard(page, 'preset-slow-burn').getByText('Built-in', { exact: true })).toBeVisible();
});

/* -------------------------------------------------------- combinations */

test('a saved combination applies in one tap, reply settings included', async ({ page }) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/styles');
  await page.getByRole('button', { name: 'New combination' }).click();
  const card = page.locator('[data-testid="combination-card"]').first();
  await card.getByRole('textbox', { name: 'Name' }).fill('My MHA RP');
  await card.getByRole('button', { name: 'Slow Burn', exact: true }).click();
  await card.getByRole('button', { name: 'Detailed', exact: true }).click();
  await card.getByRole('switch', { name: 'Set reply settings with it' }).click();
  await card.getByRole('spinbutton', { name: 'Temperature' }).fill('0.6');
  await card.getByRole('button', { name: 'Save', exact: true }).click();

  await goto(page, '#/chat/chat-1');
  await expect(composerBadge(page)).toContainText('Default style');
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await savedChip(page, 'My MHA RP').click();
  await page.getByRole('button', { name: 'Close' }).first().click();

  // The composer names the combination, not the two styles.
  await expect(composerBadge(page)).toContainText('My MHA RP');
  await expect(composerBadge(page)).toContainText('as Corin');

  const body = await send(page, ai, 'Go on.');
  const text = JSON.stringify(body.messages);
  expect(text).toContain('- Slow Burn:');
  expect(text).toContain('- Detailed:');
  expect(body.temperature).toBe(0.6);
});

test('the styles in force can be kept under a name from Chat settings', async ({ page }) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/chat/chat-1');
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('button', { name: 'Cinematic', exact: true }).click();
  await page.getByRole('button', { name: 'Save this combination…' }).click();
  await page.getByRole('textbox', { name: 'Combination name' }).fill('Night scenes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Now listed, and shown as the one in force.
  await expect(savedChip(page, 'Night scenes')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(composerBadge(page)).toContainText('Night scenes');

  await goto(page, '#/styles');
  // The name lives in an input, which text filters do not read.
  const card = page
    .locator('[data-testid="combination-card"]')
    .filter({ has: page.locator('input[value="Night scenes"]') });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Cinematic', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

/* ---------------------------------------------------------------- badge */

test('the composer says how it writes and who you are, and opens the sheet', async ({ page }) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await goto(page, '#/chat/chat-1');
  await expect(composerBadge(page)).toContainText('Default style');
  await expect(composerBadge(page)).toContainText('as Corin');

  await chooseStyle(page, 'Detailed');
  await expect(composerBadge(page)).toContainText('Detailed');
  await chooseStyle(page, 'Slow Burn');
  await expect(composerBadge(page)).toContainText('Detailed + Slow Burn');

  await composerBadge(page).click();
  await expect(page.getByText('Chat settings').first()).toBeVisible();
});
