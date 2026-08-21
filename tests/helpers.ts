import { expect, type Page, type Route } from '@playwright/test';

/** A tiny, valid 4×4 PNG used wherever the suite needs a real image file. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P8//8/AzGAiYFI' +
    'MKpwVOGowlGFxCoEAFHwBQV1I2CkAAAAAElFTkSuQmCC',
  'base64',
);

/** Builds a PNG carrying a `chara` tEXt chunk, i.e. a real character card. */
export function makeCharacterCardPng(card: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const keyword = Buffer.from('chara', 'latin1');
  const data = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(payload, 'latin1')]);

  const type = Buffer.from('tEXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  const chunk = Buffer.concat([length, type, data, crc]);

  // Insert the chunk immediately after IHDR (offset 8 + 25 bytes).
  const head = PNG_BYTES.subarray(0, 33);
  const tail = PNG_BYTES.subarray(33);
  return Buffer.concat([head, chunk, tail]);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

export interface MockProvider {
  /** Replies handed out in order; the last one repeats. */
  replies: string[];
  requests: Array<{ body: any; url: string }>;
}

/**
 * Intercepts the OpenAI-compatible endpoints so generation is deterministic
 * and no network access is required.
 */
export async function mockAI(page: Page, replies: string[] = ['A mocked reply.']): Promise<MockProvider> {
  const state: MockProvider = { replies: [...replies], requests: [] };
  let index = 0;

  await page.route('**/v1/models', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: 'mock/test-model' }, { id: 'mock/other-model' }],
      }),
    });
  });

  await page.route('**/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    state.requests.push({ body, url: route.request().url() });
    const reply = state.replies[Math.min(index, state.replies.length - 1)] ?? 'A mocked reply.';
    index += 1;

    if (body?.stream) {
      const chunks = reply.match(/.{1,12}/gs) ?? [reply];
      const sse =
        chunks
          .map((chunk) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: sse,
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    });
  });

  return state;
}

/** Navigates via the hash router and waits for the app shell to settle. */
export async function goto(page: Page, hash: string) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForTimeout(220);
}

export async function boot(page: Page, hash = '#/dashboard') {
  await page.goto(`/${hash}`);
  await expect(page.locator('.app-shell')).toBeVisible();
  // Both navs exist in the DOM; CSS decides which one is visible per viewport.
  await expect(page.locator('#main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.loading-block')).toHaveCount(0, { timeout: 15_000 });
}

/** Reloads without changing the route — proves data survived a refresh. */
export async function reloadApp(page: Page) {
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('#main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.loading-block')).toHaveCount(0, { timeout: 15_000 });
}

/** Clicks an item inside an open bottom sheet / action sheet. */
export async function sheetAction(page: Page, label: string | RegExp) {
  const sheet = page.locator('.sheet').last();
  await sheet.getByRole('button', { name: label }).first().click();
}

export async function confirmDialog(page: Page, label: string | RegExp = /Delete|Confirm|Discard|Remove|Restore|Erase/) {
  const dialog = page.getByRole('dialog').last();
  await dialog.getByRole('button', { name: label }).first().click();
}

/** Counts rows in a given IndexedDB store, read from the page context. */
export async function countStore(page: Page, store: string): Promise<number> {
  return page.evaluate(async (storeName) => {
    return new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          resolve(-1);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const countRequest = tx.objectStore(storeName).count();
        countRequest.onsuccess = () => {
          resolve(countRequest.result);
          db.close();
        };
        countRequest.onerror = () => reject(countRequest.error);
      };
    });
  }, store);
}

export async function readStore<T = any>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (storeName) => {
    return new Promise<any[]>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const all = tx.objectStore(storeName).getAll();
        all.onsuccess = () => {
          // Blobs cannot cross the bridge; describe them instead.
          resolve(
            all.result.map((row: any) =>
              row && row.blob instanceof Blob
                ? { ...row, blob: { size: row.blob.size, type: row.blob.type } }
                : row,
            ),
          );
          db.close();
        };
        all.onerror = () => reject(all.error);
      };
    });
  }, store);
}

/** Wipes the local database so each spec starts from a known state. */
export async function resetDatabase(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        localStorage.clear();
        const request = indexedDB.deleteDatabase('nexus-tavern-pro');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
}

/** Configures a working mock provider through the real Settings UI. */
export async function setupProvider(page: Page) {
  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('https://mock.test/v1');
  await fieldIn(dialog, 'API key').fill('test-key-1234567890');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/Loaded 2 models/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Assert on the provider card, not the (hidden) <option> in the picker.
  await expect(
    page.locator('.card').filter({ hasText: /mock\/(test|other)-model/ }).first(),
  ).toBeVisible();
}

/** Downloads triggered by the app, captured as strings. */
export async function captureDownload(page: Page, trigger: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Exact-name field lookups. Label substring matching is too loose here — for
 * example "Age" also matches the "Add an image for Avatar" button.
 */
export function field(page: Page, name: string) {
  return page.getByRole('textbox', { name, exact: true });
}

export function fieldIn(scope: { getByRole: Page['getByRole'] }, name: string) {
  return scope.getByRole('textbox', { name, exact: true });
}
