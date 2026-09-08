import { expect, type Page, type Route } from '@playwright/test';

/** A tiny, valid 4×4 PNG used wherever the suite needs a real image file. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P8//8/AzGAiYFI' +
    'MKpwVOGowlGFxCoEAFHwBQV1I2CkAAAAAElFTkSuQmCC',
  'base64',
);

/** Builds a PNG carrying a `chara` tEXt chunk, i.e. a real character card. */
export function makeCharacterCardPng(card: unknown, chunkKeyword = 'chara'): Buffer {
  const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const keyword = Buffer.from(chunkKeyword, 'latin1');
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
export async function reloadApp(page: Page, hash?: string) {
  if (hash) {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
  }
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

/**
 * Clicks Save and waits for the write to land.
 *
 * Saving is asynchronous: the click returns before IndexedDB has the row. A
 * test that reloads on the next line reads back the state from before the
 * click, which is the same race that has now surfaced in five different tests
 * under full-suite load. Waiting for the toast the app already shows is the
 * fix, and it belongs here rather than in each caller.
 */
export async function saveAndSettle(
  scope: Page | ReturnType<Page['getByRole']>,
  page?: Page,
) {
  const root = page ?? (scope as Page);
  await (scope as Page).getByRole('button', { name: 'Save' }).first().click();
  await expect(root.getByText(/^Saved |saved$/i).first()).toBeVisible({ timeout: 15_000 });
}

/**
 * Opens the Context Inspector from a chat.
 *
 * It used to hang off the token chip in the header. The chip now appears only
 * when the prompt is actually over budget — a token count is a fact about the
 * request, not about the story — so the inspector's standing entry point is
 * Quick Settings, where the rest of the technical view lives.
 */
export async function openContextInspector(page: Page) {
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('button', { name: /^Context Inspector/ }).click();
  await expect(page.getByRole('button', { name: 'Close context inspector' })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Opens Response settings, which now lives in Quick Settings rather than the
 * chat menu — the menu kept a duplicate of it until the scene pass.
 */
export async function openResponseSettings(page: Page) {
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('button', { name: /^Response settings/ }).click();
}

/**
 * Opens the Story Map on one of its two views. Branches and the timeline used
 * to be separate chat-menu entries; they are tabs of one sheet now, reachable
 * from the header.
 */
export async function openStoryMap(page: Page, view: 'branches' | 'timeline' = 'branches') {
  await page.getByRole('button', { name: 'Story map' }).click();
  const sheet = page.locator('.sheet').last();
  await sheet
    .getByRole('tablist', { name: 'Story map views' })
    .getByRole('tab', { name: view === 'branches' ? /Branches/ : /Timeline/ })
    .click();
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

/** Numeric inputs expose role="spinbutton", not "textbox". */
export function numberField(page: Page, name: string) {
  return page.getByRole('spinbutton', { name, exact: true });
}

/** A message bubble containing `text`. Scoped so titles never match. */
export function bubble(page: Page, text: string) {
  return page.getByTestId('message-bubble').filter({ hasText: text });
}

/** Bubbles for one role only. */
export function bubbleByRole(page: Page, role: 'user' | 'assistant', text: string) {
  return page.locator(`[data-testid="message-bubble"][data-role="${role}"]`).filter({ hasText: text });
}

/** Intercepts image-generation endpoints with a real 1x1 PNG payload. */
export async function mockImageAI(
  page: Page,
  options: { fail?: boolean } = {},
): Promise<{ requests: Array<{ url: string; body: any }> }> {
  const state = { requests: [] as Array<{ url: string; body: any }> };
  const b64 = PNG_BYTES.toString('base64');

  const handler = async (route: Route) => {
    state.requests.push({ url: route.request().url(), body: route.request().postDataJSON() });
    if (options.fail) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Mock image failure' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ b64_json: b64 }] }),
    });
  };

  await page.route('**/images/generations', handler);
  await page.route('**/*:generateContent*', handler);
  return state;
}

/** Configures a mock image provider through the real Settings UI. */
export async function setupImageProvider(page: Page) {
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Image Generation' }).click();
  await page
    .getByRole('button', { name: /Add image provider|Add another image provider/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('https://mockimg.test/v1');
  await fieldIn(dialog, 'API key').fill('img-key-1234567890');
  await fieldIn(dialog, 'Image model').fill('mock-image-model');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.card').filter({ hasText: 'mock-image-model' }).first()).toBeVisible();
}

/**
 * Opens the action menu for the message containing `text`.
 * Targets by content rather than index, so a seeded greeting cannot shift it.
 */
export async function openMessageMenu(page: Page, text: string) {
  const article = page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: text }) })
    .first();
  await article.getByRole('button', { name: 'More message actions' }).click();
  await expect(page.locator('.sheet').last()).toBeVisible();
}

/**
 * A minimal but complete library — one character, persona, lorebook with an
 * entry, and a story wiring them together. Written straight into IndexedDB so
 * specs about other features do not spend a minute re-doing the editors.
 */
export async function seedFixtures(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const put = (store: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });

    await put('characters', {
      id: 'c1',
      name: 'Sera',
      displayName: '',
      nickname: '',
      age: '31',
      gender: 'female',
      pronouns: 'she/her',
      species: 'human',
      race: '',
      occupation: 'innkeeper',
      role: '',
      tags: [],
      shortDescription: 'The innkeeper.',
      description: 'Warm and watchful.',
      appearance: 'Dark braided hair, burn-scarred hands, grey wool dress.',
      physicalTraits: 'Tall, broad-shouldered.',
      personality: 'Wry and protective.',
      temperament: '',
      traits: [],
      backstory: '',
      history: '',
      goals: '',
      motivations: '',
      fears: '',
      secrets: '',
      likes: '',
      dislikes: '',
      hobbies: '',
      values: '',
      beliefs: '',
      scenario: '',
      greetings: [{ id: 'g1', label: 'Default', content: 'Sera looks up from the bar.' }],
      defaultGreetingId: 'g1',
      speakingStyle: '',
      speechPatterns: '',
      exampleDialogue: '',
      systemPrompt: '',
      authorNote: '',
      relationships: '',
      friends: '',
      enemies: '',
      family: '',
      romantic: '',
      home: 'Ashfell',
      location: 'the Nexus Tavern',
      faction: '',
      world: '',
      lorebookIds: [],
      creator: '',
      creatorNotes: '',
      version: '1',
      customFields: [],
      metadata: {},
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('personas', {
      id: 'p1',
      name: 'Corin',
      displayName: '',
      nickname: '',
      age: '',
      gender: '',
      pronouns: 'they/them',
      species: '',
      appearance: 'Travel-stained coat, short red hair.',
      personality: 'Curious and reckless.',
      traits: [],
      backstory: '',
      occupation: '',
      goals: '',
      likes: '',
      dislikes: '',
      speechStyle: '',
      customInstructions: '',
      tags: [],
      customFields: [],
      avatarMediaId: null,
      avatarUrl: '',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('lorebooks', {
      id: 'b1',
      name: 'Ashfell Lore',
      description: 'Seeded.',
      enabled: true,
      tags: [],
      global: false,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put('loreEntries', {
      id: 'e1',
      lorebookId: 'b1',
      name: 'Ashfell',
      content: 'The grey city on the volcano.',
      primaryKeys: ['Ashfell'],
      secondaryKeys: [],
      aliases: [],
      enabled: true,
      priority: 100,
      position: 'after-character',
      depth: 4,
      scanDepth: 0,
      matchMode: 'word-boundary',
      caseSensitive: false,
      activation: 'keyword',
      category: '',
      scope: 'any',
      comment: '',
      customFields: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    await put('stories', {
      id: 's1',
      title: 'The Long Storm',
      description: 'A seeded story.',
      scenario: 'Travellers wait out a storm in the Nexus Tavern.',
      authorNote: '',
      tags: [],
      characters: [{ characterId: 'c1', primary: true, note: '', enabled: true }],
      personaId: 'p1',
      lorebookIds: [],
      memoryIds: [],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: null,
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
    db.close();
  });
  await page.reload();
  await boot(page);
}

export async function startChat(page: Page) {
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible();
}

export async function sendMessage(page: Page, text: string) {
  const composer = field(page, 'Message');
  await expect(composer).toBeEditable();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(bubble(page, text).first()).toBeVisible({ timeout: 20_000 });
}

export interface MockOllama {
  replies: string[];
  /** Every body posted to /api/chat, in order — the roleplay turns. */
  requests: Array<{ body: any; url: string }>;
  /**
   * Background work: memory extraction and summaries, which go through
   * complete() to the OpenAI-compatible endpoint rather than /api/chat. Kept
   * separate so `requests.at(-1)` still means "the last roleplay turn".
   */
  utility: Array<{ body: any; url: string }>;
  /** What /api/show reports as the model's window. */
  contextLength: number;
}

/**
 * Intercepts Ollama's native API.
 *
 * Ollama is a different dialect from the OpenAI shim — options live in an
 * `options` object, streaming is newline-delimited JSON rather than SSE, and
 * the context window is negotiated through /api/show. Capturing the real body
 * here is what lets a test assert on what the server would actually receive
 * rather than on what the compiler believes it assembled.
 */
export async function mockOllama(
  page: Page,
  replies: string[] = ['A mocked reply.'],
  contextLength = 8192,
): Promise<MockOllama> {
  const state: MockOllama = { replies: [...replies], requests: [], utility: [], contextLength };
  let index = 0;

  await page.route('**/api/tags', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { name: 'llama3.1:latest', details: { parameter_size: '8B', quantization_level: 'Q4' } },
        ],
      }),
    });
  });

  await page.route('**/api/show', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model_info: { 'general.architecture': 'llama', 'llama.context_length': state.contextLength },
      }),
    });
  });

  /*
   * Background work — memory extraction, summaries — goes through complete(),
   * which posts to the OpenAI-compatible endpoint Ollama also serves rather
   * than to /api/chat. Left unrouted those calls escape to the network and the
   * feature silently does nothing under test. The reply queue is shared with
   * /api/chat so ordering across the two endpoints stays predictable.
   */
  await page.route('**/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    state.utility.push({ body, url: route.request().url() });
    const reply = state.replies[Math.min(index, state.replies.length - 1)] ?? 'A mocked reply.';
    index += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    });
  });

  await page.route('**/api/chat', async (route: Route) => {
    const body = route.request().postDataJSON();
    state.requests.push({ body, url: route.request().url() });
    const reply = state.replies[Math.min(index, state.replies.length - 1)] ?? 'A mocked reply.';
    index += 1;
    // Ollama streams NDJSON, one object per line, terminated by done:true.
    const lines =
      (reply.match(/.{1,16}/gs) ?? [reply])
        .map((chunk) => JSON.stringify({ message: { role: 'assistant', content: chunk }, done: false }))
        .join('\n') + '\n' + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines,
    });
  });

  return state;
}

/** Configures an Ollama provider through the real Settings UI. */
export async function setupOllamaProvider(page: Page, contextSize?: number) {
  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Base URL').fill('http://ollama.test:11434');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/Loaded|Found one model/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (contextSize !== undefined) {
    await goto(page, '#/settings');
    await page.getByRole('tab', { name: 'Context' }).click().catch(() => {});
    const field = numberField(page, 'Context size (tokens)');
    await field.fill(String(contextSize)).catch(() => {});
  }
}
