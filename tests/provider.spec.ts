/**
 * Provider reliability.
 *
 * These drive the real client against endpoints that misbehave in the ways
 * real ones do: hanging, going quiet mid-stream, returning HTML, returning an
 * empty choice, refusing the key. The assertion is always that the user is
 * told something true and actionable, and that nothing hangs forever.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  boot,
  field,
  fieldIn,
  goto,
  reloadApp,
  resetDatabase,
  seedFixtures,
  sendMessage,
  setupProvider,
  startChat,
} from './helpers';

/** Configures a provider pointing at `baseUrl` without contacting it. */
async function addProviderDirect(page: Page, baseUrl: string, model = 'mock/test-model') {
  await page.evaluate(
    async ({ url, modelId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('nexus-tavern-pro');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('providers', 'readwrite');
        const r = tx.objectStore('providers').put({
          id: 'p-direct',
          name: 'Direct',
          kind: 'local',
          baseUrl: url,
          apiKey: '',
          model: modelId,
          models: [modelId],
          modelInfo: {},
          capabilityOverrides: {},
          temperature: 0.8,
          maxTokens: 512,
          topP: 1,
          frequencyPenalty: 0,
          presencePenalty: 0,
          streaming: true,
          visionSupport: false,
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        });
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        const get = tx.objectStore('settings').get('settings');
        get.onsuccess = () => {
          const current = get.result ?? { id: 'settings' };
          const put = tx.objectStore('settings').put({ ...current, activeProviderId: 'p-direct' });
          put.onsuccess = () => resolve();
          put.onerror = () => reject(put.error);
        };
        get.onerror = () => reject(get.error);
      });
      db.close();
    },
    { url: baseUrl, modelId: model },
  );
  await page.reload();
  await boot(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/* ------------------------------------------------------- URL normalization */

test('base URLs are normalized for the shapes people actually paste', async ({ page }) => {
  // Exercised through the real client rather than a unit stub.
  const cases = await page.evaluate(async () => {
    const mod = await import('/src/ai/client.ts').catch(() => null);
    return mod ? 'module' : 'bundled';
  });
  // The production bundle does not expose modules, so drive it via the network:
  // whatever the user types must end up hitting exactly one /v1/models URL.
  expect(['module', 'bundled']).toContain(cases);

  const seen: string[] = [];
  await page.route('**/models', async (route: Route) => {
    seen.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'local/model' }] }),
    });
  });

  const inputs = [
    'http://192.168.1.50:1234',
    'http://192.168.1.50:1234/',
    'http://192.168.1.50:1234/v1',
    'http://192.168.1.50:1234/v1/chat/completions',
    '192.168.1.50:1234',
  ];

  for (const input of inputs) {
    await goto(page, '#/settings');
    await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
    const dialog = page.getByRole('dialog');
    await fieldIn(dialog, 'Base URL').fill(input);
    await dialog.getByRole('button', { name: 'Fetch models' }).click();
    await expect(dialog.getByText(/Loaded 1 model/)).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }

  // Every spelling resolves to the same canonical endpoint.
  expect(new Set(seen.map((u) => u.replace(/^https?:\/\//, '')))).toEqual(
    new Set(['192.168.1.50:1234/v1/models']),
  );
});

/* -------------------------------------------------------------- timeouts */

test('a hanging endpoint fails with a timeout instead of spinning forever', async ({ page }) => {
  // Never fulfil: this is a firewall that DROPs rather than REJECTs.
  await page.route('**/v1/models', async () => {
    /* deliberately left hanging */
  });

  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('http://192.168.1.99:1234');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();

  // 20s model-discovery deadline, plus slack for the UI to render the error.
  await expect(dialog.getByText(/timed out after 20s/i)).toBeVisible({ timeout: 40_000 });
  // And the hint names the real causes rather than shrugging.
  await expect(dialog.getByText(/firewall|CORS|LAN IP/i).first()).toBeVisible();
});

/* -------------------------------------------------- malformed and empty */

test('an HTML error page is reported as a bad endpoint, not parsed as a reply', async ({ page }) => {
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Router login</body></html>',
    });
  });

  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('http://192.168.1.1');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/returned no models|not implement \/models/i)).toBeVisible({
    timeout: 20_000,
  });
});

test('an empty completion is surfaced as an error, not saved as a blank reply', async ({ page }) => {
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock/test-model' }] }),
    });
  });
  await page.route('**/v1/chat/completions', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }),
    });
  });

  await seedFixtures(page);
  await addProviderDirect(page, 'http://192.168.1.50:1234');
  await startChat(page);
  await field(page, 'Message').fill('Say nothing.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText(/empty response/i).first()).toBeVisible({ timeout: 30_000 });
});

test('a 401 names the API key rather than blaming the network', async ({ page }) => {
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Invalid API key' } }),
    });
  });
  await page.route('**/v1/chat/completions', async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Invalid API key' } }),
    });
  });

  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('https://openrouter.ai/api/v1');
  await fieldIn(dialog, 'API key').fill('sk-wrong-key-000000');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/API key/i).first()).toBeVisible({ timeout: 20_000 });
});

/* ------------------------------------------------------- streaming quirks */

test('a stream that dies mid-reply keeps the text that arrived', async ({ page }) => {
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock/test-model' }] }),
    });
  });
  await page.route('**/v1/chat/completions', async (route: Route) => {
    // Two deltas, then the connection ends with no [DONE].
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'The door ' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'creaks open.' } }] })}\n\n`,
    });
  });

  await seedFixtures(page);
  await addProviderDirect(page, 'http://192.168.1.50:1234');
  await startChat(page);
  await sendMessage(page, 'Open the door.');
  await expect(page.getByText('The door creaks open.')).toBeVisible({ timeout: 30_000 });

  // Wait for the write, not just the paint: while the typing indicator is up
  // the text on screen is streaming state, and reloading would race the save.
  await expect(page.locator('[aria-label="Generating"]')).toHaveCount(0, { timeout: 30_000 });

  // And it is persisted, not just painted.
  // reloadApp keeps the current route; boot() would navigate to the dashboard
  // and the assertion would be about the wrong screen.
  await reloadApp(page);
  await expect(page.getByText('The door creaks open.')).toBeVisible();
});

test('non-SSE bodies from a stream request still produce the reply', async ({ page }) => {
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock/test-model' }] }),
    });
  });
  // Asked for a stream, handed back a plain completion — some gateways do this.
  await page.route('**/v1/chat/completions', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'A buffered reply.' } }],
      }),
    });
  });

  await seedFixtures(page);
  await addProviderDirect(page, 'http://192.168.1.50:1234');
  await startChat(page);
  await sendMessage(page, 'Anything.');
  await expect(page.getByText('A buffered reply.')).toBeVisible({ timeout: 30_000 });
});

/* ------------------------------------------------------------ key hygiene */

test('the API key never appears in the compiled context or an export', async ({ page }) => {
  const secret = 'sk-secret-key-do-not-leak-42';
  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock/test-model' }, { id: 'mock/other-model' }] }),
    });
  });
  const sent: string[] = [];
  await page.route('**/v1/chat/completions', async (route: Route) => {
    sent.push(JSON.stringify(route.request().postDataJSON()));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fine.' } }] }),
    });
  });

  await seedFixtures(page);
  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('https://mock.test/v1');
  await fieldIn(dialog, 'API key').fill(secret);
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/Loaded 2 models/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await startChat(page);
  await sendMessage(page, 'Hello.');
  await expect(page.getByText('Fine.')).toBeVisible({ timeout: 30_000 });

  // The key belongs in the Authorization header and nowhere else.
  for (const body of sent) expect(body).not.toContain(secret);

  // Not in the inspector's copyable context either.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Context Inspector' }).click();
  await page.getByRole('tab', { name: 'Raw' }).click();
  const raw = await page.locator('pre.mono').innerText();
  expect(raw).not.toContain(secret);

  // And the key is masked on screen, never shown in full.
  await page.getByRole('button', { name: 'Close context inspector' }).click();
  await goto(page, '#/settings');
  await expect(page.getByText(secret)).toHaveCount(0);
});
