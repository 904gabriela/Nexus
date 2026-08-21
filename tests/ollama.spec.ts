/**
 * Telling a blocked request apart from an unreachable one.
 *
 * A browser reports both as the same opaque "Failed to fetch", so the client
 * probes before it accuses. Getting this wrong sends people to rewrite firewall
 * rules for a server that was answering the whole time — these tests pin the
 * two cases apart.
 *
 * The full cross-origin behaviour cannot be simulated by route interception,
 * so tools/verify-ollama.mjs covers that against a real server on a real LAN
 * address. What is checked here is the classification and what it says.
 */
import { expect, test, type Route } from '@playwright/test';
import { boot, fieldIn, goto, resetDatabase } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/** Opens the provider editor with a base URL filled in. */
async function openEditor(page: import('@playwright/test').Page, baseUrl: string, kind?: string) {
  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  if (kind) await dialog.locator('select').first().selectOption(kind);
  // An empty string means "keep the preset the kind just filled in".
  if (baseUrl) await fieldIn(dialog, 'Base URL').fill(baseUrl);
  return dialog;
}

test('Ollama is a provider kind of its own, with no model to type first', async ({ page }) => {
  const dialog = await openEditor(page, '', 'ollama');
  await expect(fieldIn(dialog, 'Base URL')).toHaveValue(/11434/);
  await expect(dialog).toContainText(/discovered from Ollama itself/i);
});

test('models are discovered from Ollama\'s own endpoint and a lone model is selected', async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route('**/api/tags', async (route: Route) => {
    asked.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [{ name: 'llama3.1:latest', details: { parameter_size: '8.0B' } }],
      }),
    });
  });

  const dialog = await openEditor(page, 'http://192.168.1.49:11434', 'ollama');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/Found one model and selected it/)).toBeVisible({
    timeout: 15_000,
  });
  expect(asked.some((u) => u.endsWith('/api/tags'))).toBe(true);
  // Selected, not merely listed.
  await expect(dialog.locator('select').last()).toHaveValue('llama3.1:latest');
});

test('a reachable server with no model chosen is not reported as a connection failure', async ({
  page,
}) => {
  await page.route('**/api/tags', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ name: 'a:latest' }, { name: 'b:latest' }] }),
    });
  });

  const dialog = await openEditor(page, 'http://192.168.1.49:11434', 'ollama');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  // Two separate states: the server is fine, the model is not chosen.
  await expect(dialog.getByText(/Server reachable — choose a model/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByText('Connection failed')).toHaveCount(0);
  await expect(dialog.getByText(/2 models available/)).toBeVisible();
});

test('a host that answers nothing is reported as unreachable', async ({ page }) => {
  // Both the request and the reachability probe fail, which is what a dead
  // host looks like.
  await page.route('**://192.168.1.49:11434/**', (route: Route) => route.abort('connectionrefused'));

  const dialog = await openEditor(page, 'http://192.168.1.49:11434', 'ollama');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText(/Nothing answered at that address/)).toBeVisible({
    timeout: 20_000,
  });
});

test('a loopback address is NOT blamed when the page is itself served from loopback', async ({
  page,
}) => {
  // These tests run against 127.0.0.1, where 127.0.0.1 for the model is
  // perfectly correct — the accusation is only safe when the page came from
  // somewhere else, which tools/verify-lan-hint.mjs covers over a real LAN
  // address. Guards against warning people off a URL that is actually right.
  await page.route('**/api/tags', (route: Route) => route.abort('connectionrefused'));
  await page.route('**://127.0.0.1:11434/**', (route: Route) => route.abort('connectionrefused'));

  const dialog = await openEditor(page, 'http://127.0.0.1:11434', 'ollama');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText(/Nothing answered at that address/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(dialog.getByText(/points at this device/i)).toHaveCount(0);
});
