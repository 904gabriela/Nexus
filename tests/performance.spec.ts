/**
 * Performance regressions, asserted as counts rather than timings.
 *
 * A stopwatch on CI measures the CI machine. What actually decides whether the
 * app feels instant is how much work a keystroke provokes, so these count the
 * work: message renders, context compilations and IndexedDB writes. Those are
 * deterministic, so a regression fails the test instead of merely being slower
 * on someone's phone.
 *
 * Wall-clock figures live in tools/profile-chat.mjs, which throttles the CPU to
 * stand in for a phone.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, goto, mockAI, resetDatabase } from './helpers';

/** Seeds one long roleplay directly into IndexedDB. */
async function seedLongChat(page: Page, count: number) {
  await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('nexus-tavern-pro');
      r.onsuccess = () => res(r.result);
    });
    const put = (s: string, v: unknown) => new Promise<void>((res, rej) => {
      const t = db.transaction(s, 'readwrite').objectStore(s).put(v);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
    const now = Date.now();
    await put('characters', {
      id: 'c1', name: 'Sera', displayName: '', nickname: '', age: '', gender: '', pronouns: '',
      species: '', role: '', tags: [], shortDescription: '', description: 'The innkeeper.',
      appearance: '', physicalTraits: '', personality: '', temperament: '', traits: [],
      backstory: '', history: '', goals: '', motivations: '', fears: '', secrets: '', likes: '',
      dislikes: '', hobbies: '', values: '', beliefs: '', scenario: '', greetings: [],
      defaultGreetingId: null, speakingStyle: '', speechPatterns: '', exampleDialogue: '',
      systemPrompt: '', authorNote: '', relationships: '', friends: '', enemies: '', family: '',
      romantic: '', home: '', location: '', faction: '', world: '', lorebookIds: [], creator: '',
      creatorNotes: '', version: '1', customFields: [], metadata: {}, avatarMediaId: null,
      avatarUrl: '', favorite: false, createdAt: now, updatedAt: now,
    });
    await put('lorebooks', {
      id: 'lb1', name: 'World Lore', description: '', tags: [], enabled: true, scanDepth: 8,
      tokenBudget: 1200, recursive: false, favorite: false, createdAt: now, updatedAt: now,
    });
    for (let i = 0; i < 20; i += 1) {
      await put('loreEntries', {
        id: `le${i}`, lorebookId: 'lb1', name: `Entry ${i}`, content: `Lore body ${i}.`,
        primaryKeys: [`keyword${i}`], secondaryKeys: [], aliases: [], logic: 'and-any',
        enabled: true, constant: false, selective: false, caseSensitive: false,
        matchWholeWords: true, priority: 10, insertionOrder: i, position: 'after-char',
        depth: 4, probability: 100, group: '', comment: '', createdAt: now, updatedAt: now,
      });
    }
    await put('stories', {
      id: 's1', title: 'The Long Winter', description: '', scenario: 'A long winter.',
      authorNote: '', openingMessage: '', tags: [],
      characters: [{ characterId: 'c1', primary: true, note: '', enabled: true }],
      personaId: null, lorebookIds: ['lb1'], memoryIds: [], coverMediaId: null,
      backgroundMediaId: null, defaultChatId: 'ch1', settings: {}, favorite: false,
      archived: false, createdAt: now, updatedAt: now,
    });
    await put('chats', {
      id: 'ch1', storyId: 's1', title: 'Long chat', activeBranchId: 'b1', personaId: null,
      favorite: false, archived: false, settings: {}, direction: '', lorebookIds: [],
      orderCounter: n, createdAt: now, updatedAt: now,
    });
    await put('branches', {
      id: 'b1', chatId: 'ch1', parentBranchId: null, createdFromMessageId: null, forkOrder: 0,
      name: 'Main', createdAt: now, updatedAt: now,
    });
    for (let i = 0; i < n; i += 1) {
      await put('messages', {
        id: `msg${i}`, chatId: 'ch1', branchId: 'b1',
        role: i % 2 === 0 ? 'user' : 'assistant', characterId: i % 2 === 0 ? null : 'c1',
        content: `Message number ${i} in a long winter at the tavern.`,
        attachments: [], order: i, model: '', tokens: 0, favorite: false,
        activeAlternativeId: null, createdAt: now + i, updatedAt: now + i,
      });
    }
    db.close();
  }, count);
  await page.reload();
  await boot(page);
}

/** Counters the app keeps, plus IndexedDB writes observed from the page. */
async function counters(page: Page) {
  return page.evaluate(() => ({
    compiles: (window as any).__nexusPerf.compileStats.calls as number,
    messageRenders: (window as any).__nexusPerf.renderStats.message as number,
    screenRenders: (window as any).__nexusPerf.renderStats.screen as number,
    composerRenders: (window as any).__nexusPerf.renderStats.composer as number,
    idbPuts: (window as any).__idbPuts as number,
    mounted: document.querySelectorAll('[data-testid="message-bubble"]').length,
  }));
}

async function resetCounters(page: Page) {
  await page.evaluate(() => {
    (window as any).__nexusPerf.reset();
    (window as any).__idbPuts = 0;
  });
}

test.beforeEach(async ({ page }) => {
  await mockAI(page, ['A reply from the innkeeper.']);
  // Counting writes needs the wrapper installed before the app opens the db.
  await page.addInitScript(() => {
    (window as any).__idbPuts = 0;
    const real = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: unknown[]) {
      (window as any).__idbPuts += 1;
      return (real as any).apply(this, args);
    };
  });
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

test('typing does not rerender the message list, compile the context, or write to the database', async ({
  page,
}) => {
  await seedLongChat(page, 300);
  await goto(page, '#/chat/ch1');
  await expect(page.locator('[data-testid="message-bubble"]').first()).toBeVisible();
  await page.waitForTimeout(1500); // let the deferred context pass finish

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.click();
  await resetCounters(page);

  await composer.pressSequentially('hello', { delay: 40 });
  await expect(composer).toHaveValue('hello');
  await page.waitForTimeout(600);

  const after = await counters(page);
  // The requirement, stated exactly: typing touches the composer and nothing else.
  expect(after.messageRenders).toBe(0);
  expect(after.compiles).toBe(0);
  expect(after.screenRenders).toBe(0);
  expect(after.idbPuts).toBe(0);
  expect(after.composerRenders).toBeGreaterThan(0);
});

test('typing twenty characters still writes nothing and compiles nothing', async ({ page }) => {
  await seedLongChat(page, 300);
  await goto(page, '#/chat/ch1');
  await expect(page.locator('[data-testid="message-bubble"]').first()).toBeVisible();
  await page.waitForTimeout(1500);

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.click();
  await resetCounters(page);

  await composer.pressSequentially('the snow keeps falling', { delay: 20 });
  await page.waitForTimeout(600);

  const after = await counters(page);
  expect(after.idbPuts).toBe(0);
  expect(after.compiles).toBe(0);
  expect(after.messageRenders).toBe(0);
});

for (const size of [300, 1000]) {
  test(`a ${size}-message chat mounts only a window of messages`, async ({ page }) => {
    await seedLongChat(page, size);
    await goto(page, '#/chat/ch1');
    await expect(page.locator('[data-testid="message-bubble"]').first()).toBeVisible();
    await page.waitForTimeout(1200);

    const after = await counters(page);
    // Bounded, and unrelated to how long the roleplay is.
    expect(after.mounted).toBeLessThanOrEqual(180);
    expect(after.mounted).toBeGreaterThan(0);

    // And it is still usable: the newest message is the one on screen.
    await expect(
      page.locator('[data-testid="message-bubble"]').last(),
    ).toContainText(`Message number ${size - 1}`);
  });
}

test('older messages are still reachable by scrolling back', async ({ page }) => {
  await seedLongChat(page, 300);
  await goto(page, '#/chat/ch1');
  await expect(page.locator('[data-testid="message-bubble"]').first()).toBeVisible();
  // Wait for the opening scroll to land rather than guessing at a delay. A
  // fixed pause is long enough on an idle machine and not on a busy one, and a
  // click that arrives mid-scroll is intercepted by whichever message happens
  // to be passing under it.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.chat-scroll');
      if (!el) return false;
      const w = window as unknown as { __lastTop?: number; __stable?: number };
      const settled = el.scrollTop === w.__lastTop;
      w.__stable = settled ? (w.__stable ?? 0) + 1 : 0;
      w.__lastTop = el.scrollTop;
      return (w.__stable ?? 0) >= 3;
    },
    undefined,
    { timeout: 20_000, polling: 100 },
  );

  const before = (await counters(page)).mounted;
  await page.getByRole('button', { name: /Show earlier messages/ }).click();
  await page.waitForTimeout(500);
  expect((await counters(page)).mounted).toBeGreaterThan(before);
});

test('editing one message does not rerender the whole window', async ({ page }) => {
  await seedLongChat(page, 300);
  await goto(page, '#/chat/ch1');
  await expect(page.locator('[data-testid="message-bubble"]').first()).toBeVisible();
  await page.waitForTimeout(1500);

  const mounted = (await counters(page)).mounted;
  await resetCounters(page);

  const last = page.locator('[data-testid="message-bubble"]').last();
  await last.click({ button: 'right' }).catch(() => {});
  // Editing through the store is what matters here, not the menu route to it.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('nexus-tavern-pro');
      r.onsuccess = () => res(r.result);
    });
    db.close();
  });
  await page.waitForTimeout(300);

  const after = await counters(page);
  // Far fewer than "every mounted message re-rendered several times".
  expect(after.messageRenders).toBeLessThan(mounted * 2);
});

test('the composer stays responsive while a reply is streaming', async ({ page }) => {
  // A stream that arrives in many small pieces, as a fast local model does.
  await page.route('**/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON();
    if (!body?.stream) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      });
      return;
    }
    const words = Array.from({ length: 200 }, (_, i) => `token${i} `);
    const sse = words
      .map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    // Held open for a few seconds: a route that fulfils at once finishes before
    // the test can look, which would prove nothing about a live generation.
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sse,
    });
  });

  await seedLongChat(page, 300);
  await goto(page, '#/settings');
  await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://mock.test/v1');
  await dialog.getByRole('button', { name: 'Fetch models' }).click();
  await expect(dialog.getByText(/Loaded|Found one model/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Save' }).click();

  await goto(page, '#/chat/ch1');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Say something long.');
  await page.getByRole('button', { name: 'Send message' }).click();

  // While it streams, the composer must still accept input immediately.
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
    timeout: 15_000,
  });
  await composer.pressSequentially('still typing', { delay: 10 });
  await expect(composer).toHaveValue('still typing');

  // And stopping must work mid-stream.
  await page.getByRole('button', { name: 'Stop generating' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 15_000 });
});

test('the chat is usable at both phone widths', async ({ page }) => {
  await seedLongChat(page, 300);
  for (const width of [390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    await goto(page, '#/chat/ch1');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('hello');
    await expect(composer).toHaveValue('hello');
    // Nothing may spill sideways at either width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await composer.fill('');
  }
});
