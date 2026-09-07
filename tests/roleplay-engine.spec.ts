/**
 * The roleplay engine, asserted against the request that actually leaves the app.
 *
 * These tests do not check the Context Inspector's opinion of the prompt. They
 * intercept Ollama's own endpoint and read the body the server would have
 * received, because every failure this suite exists to prevent — a character
 * walking in from old history, the user's persona being written by the model —
 * came from the gap between what the compiler assembled and what survived the
 * trip.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockOllama,
  resetDatabase,
  seedFixtures,
  sendMessage,
  readStore,
  reloadApp,
  setupOllamaProvider,
  startChat,
  type MockOllama,
} from './helpers';
import { seedHospitalScene } from './scene-fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/** The system message of the last request, which is where the framing lives. */
function systemOf(ollama: MockOllama): string {
  const body = ollama.requests.at(-1)?.body;
  const system = (body?.messages ?? []).find((m: any) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

async function generateOnce(page: Page, text = 'Hello.') {
  await startChat(page);
  await sendMessage(page, text);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({
    timeout: 20_000,
  });
}

test('the Ollama request carries num_ctx, clamped to what the model can hold', async ({
  page,
}) => {
  // The model reports an 8k window; the app is free to ask for more.
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await generateOnce(page);

  expect(ollama.requests.length).toBeGreaterThan(0);
  const options = ollama.requests.at(-1)!.body.options;

  // The whole point: the window is stated rather than left to Ollama's default.
  expect(options.num_ctx).toBeDefined();
  expect(typeof options.num_ctx).toBe('number');
  // And it never exceeds what the model reported it can hold.
  expect(options.num_ctx).toBeLessThanOrEqual(8192);
  expect(options.num_ctx).toBeGreaterThanOrEqual(2048);
});

test('an impossible context size is clamped instead of silently truncated', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // The configuration that caused the original failure: a context size far
  // beyond anything the model can hold. Settings live in IndexedDB — writing
  // this to localStorage, as this test used to, changed nothing at all.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const settings: any = await new Promise((r) => {
      const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      q.onsuccess = () => r(q.result);
    });
    settings.contextBudget = 513856;
    await new Promise<void>((r) => {
      const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);
  await generateOnce(page);

  // The setting really did take, so the clamp below is doing the work.
  expect((await readStore<any>(page, 'settings'))[0].contextBudget).toBe(513856);

  const options = ollama.requests.at(-1)!.body.options;
  expect(options.num_ctx).toBeLessThanOrEqual(8192);
});

test('the sampling settings still reach Ollama alongside the window', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await generateOnce(page);

  const options = ollama.requests.at(-1)!.body.options;
  expect(options).toHaveProperty('temperature');
  expect(options).toHaveProperty('top_p');
  expect(options).toHaveProperty('num_predict');
  expect(options).toHaveProperty('num_ctx');
});

test('the system message is present and is the first message', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await generateOnce(page);

  const messages = ollama.requests.at(-1)!.body.messages;
  expect(messages[0].role).toBe('system');
  expect(systemOf(ollama).length).toBeGreaterThan(0);
});

/* ==================================================== presence vs mention */

test.describe('presence is stated, never inferred from a name in the history', () => {
  async function openHospitalChat(page: Page, ollama: MockOllama, text = '*I giggle mischievously.*') {
    await goto(page, '#/chat/hospital-chat');
    await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeEditable();
    const before = ollama.requests.length;
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message' }).click();
    // Wait for the request itself. The send button is visible both before and
    // after a generation, so waiting on it proves nothing about whether one
    // happened.
    await expect
      .poll(() => ollama.requests.length, { timeout: 25_000 })
      .toBeGreaterThan(before);
    return systemOf(ollama);
  }

  test('TEST 1: only Reiko and Bakugo are named as present', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page);
    const system = await openHospitalChat(page, ollama);

    expect(system).toMatch(/Present:.*Reiko Ryuusui/);
    expect(system).toMatch(/Present:.*Katsuki Bakugo/);
    // The presence line must not name anyone else.
    const presentLine = /Present: (.*)/.exec(system)?.[1] ?? '';
    expect(presentLine).not.toMatch(/Edgeshot|Midoriya|Deku|Kirishima|Aizawa|Todoroki/);
  });

  test('TEST 2 & 3: Edgeshot appears in lore and history but never as present', async ({
    page,
  }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    // Fifty repetitions of a transcript naming Edgeshot — overwhelming evidence
    // that he exists, and none at all that he is in the room.
    await seedHospitalScene(page, { transcriptRepeats: 50 });
    const system = await openHospitalChat(page, ollama);

    const presentLine = /Present: (.*)/.exec(system)?.[1] ?? '';
    expect(presentLine).not.toContain('Edgeshot');
    // And the prompt says explicitly that other names are absent.
    expect(system).toMatch(/is absent|are absent|not in the scene/i);
  });

  test('TEST 4: the persona stays Reiko however often Deku appears in history', async ({
    page,
  }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page, { transcriptRepeats: 50 });
    const system = await openHospitalChat(page, ollama);

    expect(system).toMatch(/Reiko Ryuusui is the user/);
    expect(system).not.toMatch(/Deku is the user|Midoriya is the user/);
  });

  test('TEST 5: a cast member who is not present is marked as elsewhere', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page, { castKirishima: true });
    const system = await openHospitalChat(page, ollama);

    const presentLine = /Present: (.*)/.exec(system)?.[1] ?? '';
    expect(presentLine).not.toContain('Kirishima');
    expect(system).toMatch(/not in the scene: .*Kirishima|Kirishima.*\(not present\)/);
  });

  test('TEST 6: adding Kirishima to the scene makes him present', async ({ page }) => {
    const ollama = await mockOllama(page, ['Kirishima grins.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page, {
      castKirishima: true,
      presentCharacterIds: ['bakugo', 'kirishima'],
    });
    const system = await openHospitalChat(page, ollama);

    const presentLine = /Present: (.*)/.exec(system)?.[1] ?? '';
    expect(presentLine).toContain('Kirishima');
    expect(presentLine).toContain('Katsuki Bakugo');
  });

  test('TEST 7: the anti-persona-control rule holds in a one-character story', async ({
    page,
  }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    // One character in the cast — the configuration that previously emitted no
    // rule at all, because the rule lived inside a multi-character branch.
    await seedHospitalScene(page);
    const system = await openHospitalChat(page, ollama);

    expect(system).toMatch(
      /Never write Reiko Ryuusui's dialogue, actions, thoughts, or decisions/,
    );
  });

  test('TEST 5b: a disabled lore entry never activates', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page);
    const system = await openHospitalChat(page, ollama, 'Tell me about Stain.');

    // The keyword is in the user's own message and the entry is still disabled.
    expect(system).not.toContain('The Hero Killer');
  });

  test('TEST 8: regeneration keeps the same scene and persona', async ({ page }) => {
    const ollama = await mockOllama(page, ['First take.', 'Second take.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page);
    const first = await openHospitalChat(page, ollama);

    await page.getByRole('button', { name: /Regenerate/ }).first().click();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 25_000,
    });
    const second = systemOf(ollama);

    const sceneOf = (s: string) => /## Current scene[\s\S]*?(?=\n## |$)/.exec(s)?.[0] ?? '';
    expect(sceneOf(second)).toBe(sceneOf(first));
    expect(second).toMatch(/Reiko Ryuusui is the user/);
  });

  test('TEST 12: lorebook names and counts are not presented as world content', async ({
    page,
  }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
    await setupOllamaProvider(page);
    await seedHospitalScene(page);
    const system = await openHospitalChat(page, ollama);

    // Implementation vocabulary must never reach the model as narrative.
    expect(system).not.toMatch(/lorebook/i);
    expect(system).not.toMatch(/MHA CANON/);
    expect(system).not.toMatch(/context budget|token budget|Nexus|scan depth/i);
  });
});

/* ================================================ budgeting and the payload */

test('TEST 9: a large lorebook does not crowd out the scene', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, { transcriptRepeats: 50 });

  // Three hundred entries, every one of them keyed to a name that appears in
  // the pasted transcript. This is the shape of a real world-info database.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('nexus-tavern-pro');
      r.onsuccess = () => resolve(r.result);
    });
    const put = (v: unknown) =>
      new Promise<void>((resolve) => {
        const t = db.transaction('loreEntries', 'readwrite').objectStore('loreEntries').put(v);
        t.onsuccess = () => resolve();
      });
    const now = Date.now();
    for (let i = 0; i < 300; i += 1) {
      await put({
        id: `bulk-${i}`,
        lorebookId: 'mha',
        name: `World fact ${i}`,
        content: `Filler world detail number ${i}. `.repeat(20),
        primaryKeys: ['Edgeshot', 'Midoriya', 'Kirishima'],
        secondaryKeys: [],
        aliases: [],
        enabled: true,
        priority: 90,
        position: 'after-character',
        depth: 4,
        scanDepth: 0,
        matchMode: 'word-boundary',
        caseSensitive: false,
        activation: 'normal',
        category: '',
        scope: '',
        comment: '',
        customFields: [],
        order: i,
        createdAt: now,
        updatedAt: now,
      });
    }
    db.close();
  });
  await page.reload();
  await boot(page);

  await goto(page, '#/chat/hospital-chat');
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('*I giggle mischievously.*');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

  const body = ollama.requests.at(-1)!.body;
  const system = (body.messages ?? []).find((m: any) => m.role === 'system')?.content ?? '';

  // The scene survives, at the top, whatever the lorebook contains.
  expect(system).toMatch(/Present:.*Katsuki Bakugo/);
  expect(system).toMatch(/Reiko Ryuusui is the user/);
  // And only a slice of the database made the trip. Each entry repeats its
  // filler sentence twenty times, so entries are counted by their headings.
  const admitted = new Set(system.match(/World fact \d+/g) ?? []).size;
  expect(admitted).toBeGreaterThan(0);
  expect(admitted).toBeLessThanOrEqual(40);
});

test('TEST 10: the prompt is budgeted before sending, not truncated after', async ({ page }) => {
  // A deliberately small window: 2048 tokens against a 50× transcript.
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 2048);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, { transcriptRepeats: 50 });

  await goto(page, '#/chat/hospital-chat');
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('*I giggle mischievously.*');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

  const body = ollama.requests.at(-1)!.body;
  expect(body.options.num_ctx).toBeLessThanOrEqual(2048);

  // Nexus decided what to drop. The scene and the persona rule are still here,
  // which is exactly what server-side truncation would have removed first.
  const system = (body.messages ?? []).find((m: any) => m.role === 'system')?.content ?? '';
  expect(system).toMatch(/Present:/);
  expect(system).toMatch(/Reiko Ryuusui is the user/);
});

test('TEST 11: the recorded request matches what was posted', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);

  await goto(page, '#/chat/hospital-chat');
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Hello.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // What the inspector would show, read from the app itself.
  const recorded = await page.evaluate(() => (window as any).__nexusLastRequest ?? null);
  const posted = ollama.requests.at(-1)!.body;

  if (recorded) {
    expect(recorded.body.options.num_ctx).toBe(posted.options.num_ctx);
    expect(recorded.body.messages.length).toBe(posted.messages.length);
  }
  // Independently of the debug hook, the payload itself must carry the window.
  expect(posted.options.num_ctx).toBeGreaterThanOrEqual(2048);
});

/* ============================================ the oversized-context failure */

/**
 * The configuration that timed out against a real llama3.1: a 131,072-token
 * model, a chat asking for 173,700 tokens with a 32,000-token reply allowance,
 * a long transcript and a large lorebook. The old code answered that by telling
 * Ollama to allocate its entire window, which never returned a first token
 * before the connect deadline.
 */
async function seedOversizedCase(page: Page) {
  await seedHospitalScene(page, { transcriptRepeats: 200, castKirishima: true });
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const put = (store: string, v: unknown) =>
      new Promise<void>((r) => {
        const q = db.transaction(store, 'readwrite').objectStore(store).put(v);
        q.onsuccess = () => r();
      });
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get('hospital-chat');
      q.onsuccess = () => r(q.result);
    });
    chat.settings = { contextSize: 173700, maxTokens: 32000 };
    await put('chats', chat);

    const now = Date.now();
    for (let i = 0; i < 300; i += 1) {
      await put('loreEntries', {
        id: `bulk-${i}`,
        lorebookId: 'mha',
        name: `World fact ${i}`,
        content: `Filler world detail number ${i}. `.repeat(20),
        primaryKeys: ['Edgeshot', 'Midoriya', 'Kirishima'],
        secondaryKeys: [],
        aliases: [],
        enabled: true,
        priority: 90,
        position: 'after-character',
        depth: 4,
        scanDepth: 0,
        matchMode: 'word-boundary',
        caseSensitive: false,
        activation: 'normal',
        category: '',
        scope: '',
        comment: '',
        customFields: [],
        order: i,
        createdAt: now,
        updatedAt: now,
      });
    }
    db.close();
  });
  await page.reload();
  await boot(page);
}

async function sendTurn(page: Page, ollama: MockOllama, text: string) {
  await goto(page, '#/chat/hospital-chat');
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);
  return ollama.requests.at(-1)!.body;
}

/** Rough token count of the whole payload, independent of the app's estimator. */
function payloadTokens(body: any): number {
  const chars = body.messages.reduce(
    (sum: number, m: any) =>
      sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  return Math.round(chars / 3.8);
}

test.describe('the oversized-context case that timed out against llama3.1', () => {
  test('a 131k model does not produce a 99k prompt or a 131k window', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
    await setupOllamaProvider(page);
    await seedOversizedCase(page);
    const body = await sendTurn(page, ollama, '*my face lits up mischievously*\n\n"oh? is that so?"');

    // Capacity is a ceiling, not a target.
    expect(body.options.num_ctx).toBeLessThan(32_000);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(2048);
    // And the prompt itself stays inside a practical budget.
    expect(payloadTokens(body)).toBeLessThan(20_000);
  });

  test('the reply allowance is capped and stays separate from the input budget', async ({
    page,
  }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
    await setupOllamaProvider(page);
    await seedOversizedCase(page);
    const body = await sendTurn(page, ollama, 'Hello.');

    // 32,000 was configured; a roleplay turn cannot use that and paying for it
    // on every message is what made the window enormous.
    expect(body.options.num_predict).toBeLessThanOrEqual(2048);
    expect(body.options.num_predict).toBeGreaterThan(0);
    // num_ctx must still hold prompt *and* reply.
    expect(body.options.num_ctx).toBeGreaterThan(body.options.num_predict);
  });

  test('the scene, the persona rule and recent turns survive the trim', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
    await setupOllamaProvider(page);
    await seedOversizedCase(page);
    const body = await sendTurn(page, ollama, '*I giggle mischievously.*');
    const system = body.messages.find((m: any) => m.role === 'system').content;

    expect(system).toMatch(/Present:.*Katsuki Bakugo/);
    expect(system).toMatch(/Never write Reiko Ryuusui's dialogue/);
    expect(system).toMatch(/Continue the scene/);
    // The newest turn is the last thing said, and is intact. The very last
    // message is the turn directive, which is sent after the user's turn by
    // design — so this asserts on the newest *user* message.
    const userTurns = body.messages.filter((m: any) => m.role === 'user');
    expect(userTurns.at(-1).content).toContain('giggle');
    expect(body.messages.at(-1).content).toContain('## This turn');
  });

  test('old transcript is dropped before recent turns are', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
    await setupOllamaProvider(page);
    await seedOversizedCase(page);
    const body = await sendTurn(page, ollama, 'Hello.');

    // 200 transcript turns were seeded; only a window of them may be sent.
    const assistantTurns = body.messages.filter((m: any) => m.role === 'assistant').length;
    expect(assistantTurns).toBeLessThan(200);
    expect(assistantTurns).toBeGreaterThan(0);
  });

  test('a 300-entry lorebook does not arrive whole', async ({ page }) => {
    const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
    await setupOllamaProvider(page);
    await seedOversizedCase(page);
    const body = await sendTurn(page, ollama, 'Hello.');
    const system = body.messages.find((m: any) => m.role === 'system').content;

    const admitted = new Set(system.match(/World fact \d+/g) ?? []).size;
    expect(admitted).toBeLessThanOrEqual(40);
  });
});

test('the request instructs continuation rather than acknowledgement', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  const body = await sendTurn(page, ollama, '*my face lits up mischievously*\n\n"oh? is that so?"');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // Continuation, control and presence — the three things a short user turn
  // needs the model to already know.
  expect(system).toMatch(/Continue the scene from where it stands/);
  expect(system).toMatch(/not a cue to acknowledge it and stop/);
  expect(system).toMatch(/Never write Reiko Ryuusui's dialogue, actions, thoughts, or decisions/);
  expect(system).toMatch(/You narrate the world and play everyone present except Reiko Ryuusui/);
  // And no word-count quota was smuggled in.
  expect(system).not.toMatch(/\b\d{3,}\s*words\b/i);
});

/* ================================ a transcript too large to fit, kept in part */

/**
 * Roleplay carried over by pasting a previous session arrives as one enormous
 * message. It cannot fit any budget, and dropping it whole took the exchange
 * the user's next turn was answering — leaving the model a scene heading and a
 * single line of input, which is exactly as generic as it sounds.
 */
async function seedPastedTranscript(page: Page) {
  await seedHospitalScene(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const filler =
      '*The afternoon light moved across the floor as they talked about nothing much.* '.repeat(900);
    const ending =
      '\n\nReiko: "I would bite you, you know. That is normal where I am from."\n' +
      'Bakugo: "...in private... it is not a problem."';
    await new Promise<void>((r) => {
      const q = db
        .transaction('messages', 'readwrite')
        .objectStore('messages')
        .put({
          id: 'transcript-0',
          chatId: 'hospital-chat',
          branchId: 'hospital-branch',
          role: 'assistant',
          characterId: 'bakugo',
          content: filler + ending,
          attachments: [],
          order: 0,
          model: '',
          tokens: 0,
          favorite: false,
          activeAlternativeId: null,
          historical: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);
}

test('an over-long transcript keeps its ending instead of vanishing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
  await setupOllamaProvider(page);
  await seedPastedTranscript(page);
  const body = await sendTurn(page, ollama, '*my face lits up mischievously*\n\n"oh? is that so?"');
  const all = body.messages.map((m: any) => String(m.content)).join('\n');

  // The exchange the user's turn is answering has to be there, or there is
  // nothing for the reply to be specific about.
  expect(all).toContain('I would bite you');
  expect(all).toContain('in private... it is not a problem');
  // It arrives as an excerpt, not whole.
  expect(all).toContain('earlier part of this message omitted');
  // And the budget still holds.
  expect(payloadTokens(body)).toBeLessThan(20_000);
});

test('the excerpt is the end of the transcript, not the beginning', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 131072);
  await setupOllamaProvider(page);
  await seedPastedTranscript(page);
  const body = await sendTurn(page, ollama, 'Hello.');
  const assistant = body.messages.find((m: any) => m.role === 'assistant');

  // The tail carries the recent exchange; the head is what gets elided.
  const content = String(assistant.content);
  expect(content.indexOf('I would bite you')).toBeGreaterThan(content.length / 2);
  expect(content.startsWith('[…earlier part')).toBe(true);
});

test('characters may read the user without the model deciding for them', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  const body = await sendTurn(page, ollama, '*I giggle mischievously.*');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  expect(system).toMatch(/You may have characters read Reiko Ryuusui/);
  expect(system).toMatch(/Never state what Reiko Ryuusui actually thinks, intends, or does next/);
});

/* ==================================================== speaker attribution */

test('an assistant turn names its speaker when the scene holds more than one', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Kirishima grins.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, {
    castKirishima: true,
    presentCharacterIds: ['bakugo', 'kirishima'],
  });

  // Two turns, so the second request carries the first as attributed history.
  await sendTurn(page, ollama, 'Hello you two.');
  const body = await sendTurn(page, ollama, 'And you?');

  const assistant = body.messages.filter((m: any) => m.role === 'assistant');
  expect(assistant.length).toBeGreaterThan(0);
  // The reply Nexus stored is attributed to whoever spoke it, so the model can
  // tell one voice from another instead of guessing.
  const attributed = assistant.some((m: any) =>
    /^(Katsuki Bakugo|Eijiro Kirishima):/.test(String(m.content)),
  );
  expect(attributed).toBe(true);
});

test('a carried-over transcript is not given a single speaker label', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, {
    castKirishima: true,
    presentCharacterIds: ['bakugo', 'kirishima'],
  });
  const body = await sendTurn(page, ollama, 'Hello.');

  // The seeded transcript is historical and labels its own speakers inline;
  // stamping one name on a passage containing several would misdescribe it.
  const transcript = body.messages.find(
    (m: any) => m.role === 'assistant' && String(m.content).includes('the fire') === false &&
      String(m.content).includes('Bakugo: "Tch."'),
  );
  if (transcript) {
    expect(String(transcript.content).startsWith('Katsuki Bakugo:')).toBe(false);
  }
});

test('the prompt reconciles a transcript that contains the user’s own lines', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  const body = await sendTurn(page, ollama, '*I giggle mischievously.*');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // The carried-over scene shows the assistant writing Reiko; the rule says not
  // to. Left unreconciled the model has to choose between them, and a hedged,
  // generic reply is one way it can choose.
  expect(system).toMatch(/contains lines for Reiko Ryuusui as well as for the cast/);
  expect(system).toMatch(/not a\s+pattern to continue/);
  expect(system).toMatch(/belong to the user alone/);
});

/* ================================================== message-pipeline trace */

test('every sent message carries its provenance', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  await sendTurn(page, ollama, '*I giggle mischievously.*');

  // Read the trace through the view the user actually has, so the test covers
  // the whole chain rather than an internal structure nobody can see.
  await page.getByRole('button', { name: /Context|Inspector/i }).first().click();
  await page.getByRole('tab', { name: 'Provider request' }).click();

  const rows = page.locator('.ctx-part');
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });

  // Row zero is the assembled system prompt, and the turn just sent is traced
  // as a user message — the two ends of the pipeline the user needs to see.
  const labels = await page.locator('.ctx-part-label').allInnerTexts();
  // Row zero is the assembled prompt; the newest turn is the user's and comes
  // last; the carried-over transcript is attributed and flagged historical.
  expect(labels[0]).toContain('#0 · system');
  // The user's turn is the last *conversational* row; the turn directive is
  // appended after it and is traced too.
  expect(labels.at(-1)).toMatch(/· system · Nexus \(turn directive\)/);
  expect(labels.at(-2)).toMatch(/· user · Reiko Ryuusui/);
  expect(labels.some((l) => l.includes('historical'))).toBe(true);
  expect(labels.some((l) => /· assistant · Katsuki Bakugo/.test(l))).toBe(true);
});

/* ============================== the conversation must not be sieved for size */

/**
 * The shape from a real failing request: long assistant prose alternating with
 * one-line user turns. The budget used to reject every long reply and accept
 * every short question, handing the model six of the user's turns in a row with
 * the answers missing.
 */
async function seedUnevenConversation(page: Page, pairs: number) {
  await seedHospitalScene(page);
  await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const put = (v: unknown) =>
      new Promise<void>((r) => {
        const q = db.transaction('messages', 'readwrite').objectStore('messages').put(v);
        q.onsuccess = () => r();
      });
    const now = Date.now();
    // Clear the seeded transcript so only this conversation is present.
    await new Promise<void>((r) => {
      const q = db.transaction('messages', 'readwrite').objectStore('messages').delete('transcript-0');
      q.onsuccess = () => r();
      q.onerror = () => r();
    });
    for (let i = 0; i < n; i += 1) {
      await put({
        id: `u${i}`, chatId: 'hospital-chat', branchId: 'hospital-branch', role: 'user',
        characterId: null, content: `Question number ${i}?`, attachments: [], order: i * 2,
        model: '', tokens: 0, favorite: false, activeAlternativeId: null,
        createdAt: now + i * 2, updatedAt: now + i * 2,
      });
      await put({
        id: `a${i}`, chatId: 'hospital-chat', branchId: 'hospital-branch', role: 'assistant',
        characterId: 'bakugo',
        content: `Answer number ${i}. ` + 'He spoke at length about the matter. '.repeat(120),
        attachments: [], order: i * 2 + 1, model: '', tokens: 0, favorite: false,
        activeAlternativeId: null, createdAt: now + i * 2 + 1, updatedAt: now + i * 2 + 1,
      });
    }
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get('hospital-chat');
      q.onsuccess = () => r(q.result);
    });
    chat.orderCounter = n * 2;
    await new Promise<void>((r) => {
      const q = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
      q.onsuccess = () => r();
    });
    db.close();
  }, pairs);
  await page.reload();
  await boot(page);
}

test('history is a contiguous window, never a sieve of whatever fits', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedUnevenConversation(page, 12);
  const body = await sendTurn(page, ollama, 'And now?');

  const roles: string[] = body.messages.map((m: any) => m.role);
  // No run of user turns with the replies between them missing.
  let run = 0;
  let longestUserRun = 0;
  for (const role of roles) {
    run = role === 'user' ? run + 1 : 0;
    longestUserRun = Math.max(longestUserRun, run);
  }
  expect(longestUserRun).toBeLessThanOrEqual(2);

  // And no question arrives orphaned: the reply that followed it is present,
  // whole or excerpted. An excerpt keeps the end of a message, so the answer's
  // opening words may be gone while the turn itself is there.
  const assistantTurns = body.messages.filter((m: any) => m.role === 'assistant').length;
  const userTurns = body.messages.filter((m: any) => m.role === 'user').length;
  expect(assistantTurns).toBeGreaterThanOrEqual(userTurns - 1);
});

test('the newest exchange survives even when older ones cannot', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedUnevenConversation(page, 12);
  const body = await sendTurn(page, ollama, 'And now?');
  const text = body.messages.map((m: any) => String(m.content)).join('\n');

  // Trimming takes from the far end of the conversation, not the near one.
  expect(text).toContain('Answer number 11.');
  const newestUserTurn = body.messages.filter((m: any) => m.role === 'user').at(-1);
  expect(newestUserTurn.content).toContain('And now?');
});

/* ================================================= imported chats get a cast */

/**
 * A chat imported from another app used to arrive as messages and nothing else
 * — no character, no story, no scene. The compiler then had nobody to describe
 * and nobody to place in the room, so the model reconstructed the character
 * from prose alone. Where the export names its speakers, they become real
 * characters.
 */
test('an imported chat log builds its cast from the named speakers', async ({ page }) => {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'fictionlab-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'The Long Winter',
        messages: [
          { name: 'Reiko', role: 'user', content: 'Are you coming back?' },
          { name: 'Patrick', role: 'assistant', content: 'He set the glass down. "Always."' },
          { name: 'Reiko', role: 'user', content: 'Promise?' },
          { name: 'Patrick', role: 'assistant', content: 'A long pause. "I promise."' },
        ],
      }),
    ),
  });

  await expect(page.getByText(/Import preview/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await page.waitForTimeout(800);

  // The speaker the file named is now a character in its own right.
  const characters = await readStore(page, 'characters');
  expect(characters.map((c: any) => c.name)).toContain('Patrick');
  // A role word is not a speaker, so no character is invented for "user".
  expect(characters.map((c: any) => c.name)).not.toContain('user');

  // The chat belongs to a story with that cast, and the scene names who is in it.
  const chats = await readStore(page, 'chats');
  const chat = chats[0];
  expect(chat.storyId).toBeTruthy();
  const patrick = characters.find((c: any) => c.name === 'Patrick');
  expect(chat.scene.primaryCharacterId).toBe(patrick.id);
  expect(chat.scene.presentCharacterIds).toContain(patrick.id);

  // Assistant turns are attributed, so the compiler can name who spoke.
  const messages = await readStore(page, 'messages');
  const assistantTurns = messages.filter((m: any) => m.role === 'assistant');
  expect(assistantTurns.length).toBe(2);
  expect(assistantTurns.every((m: any) => m.characterId === patrick.id)).toBe(true);
  // And the whole log is marked as prior play rather than turns taken here.
  expect(messages.every((m: any) => m.historical === true)).toBe(true);
});

test('a chat with no story still has a cast when its scene names one', async ({ page }) => {
  const ollama = await mockOllama(page, ['Patrick sets the glass down.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);

  // The shape an imported chat arrives in: characters exist in the library, but
  // the chat belongs to no story. The cast used to be empty regardless.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get('hospital-chat');
      q.onsuccess = () => r(q.result);
    });
    chat.storyId = null;
    chat.scene = {
      location: 'A quiet kitchen',
      situation: 'Late, and he has only just come in.',
      presentCharacterIds: ['bakugo'],
      primaryCharacterId: 'bakugo',
      objective: '',
      characterStates: {},
      updatedAt: Date.now(),
    };
    await new Promise<void>((r) => {
      const q = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  const body = await sendTurn(page, ollama, 'You are late.');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // The character is in the room and described, with no story involved.
  expect(system).toMatch(/Present:.*Katsuki Bakugo/);
  expect(system).toContain('Explosive hero student.');
  expect(system).toMatch(/Never write Reiko Ryuusui's dialogue/);
});

test('an export that marks sides with a boolean still gets roles and a cast', async ({ page }) => {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'boolean-sides.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'The Saint',
        messages: [
          { is_user: true, author: 'Reiko', text: 'You are late.' },
          { is_user: false, author: 'Patrick Moretti', text: 'He set the glass down.' },
          { is_user: true, author: 'Reiko', text: 'Again.' },
          { is_user: false, author: 'Patrick Moretti', text: 'A long pause.' },
        ],
      }),
    ),
  });

  await expect(page.getByText(/Import preview/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await page.waitForTimeout(800);

  // The boolean decides the role; the author field names the character.
  const messages = await readStore(page, 'messages');
  expect(messages.filter((m: any) => m.role === 'user')).toHaveLength(2);
  expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(2);
  const characters = await readStore(page, 'characters');
  expect(characters.map((c: any) => c.name)).toContain('Patrick Moretti');
});

test('a file with no speaker field says which keys it does have', async ({ page }) => {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'anonymous.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'Hello.' },
          { role: 'assistant', content: 'Hello yourself.' },
        ],
      }),
    ),
  });

  // The warning has to be actionable: naming the keys present turns a dead end
  // into the one fact needed to support the format.
  await expect(page.getByText(/Each message carries: role, content/)).toBeVisible({
    timeout: 15_000,
  });
});

test('an orphaned chat can be given a story, and the cast reaches the model', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera looks up from the bar.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // An export that names nobody: the importer can only make a story-less chat,
  // which is exactly the state that used to be permanent.
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'anonymous.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'Orphan',
        messages: [
          { role: 'user', content: 'Is the storm easing?' },
          { role: 'assistant', content: 'Not yet. The shutters are still complaining.' },
        ],
      }),
    ),
  });
  await expect(page.getByText(/Import preview/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await page.waitForTimeout(800);

  const imported = (await readStore<any>(page, 'chats')).find((c) => c.title === 'Orphan');
  expect(imported).toBeTruthy();
  expect(imported.storyId).toBeFalsy();

  await goto(page, `#/chat/${imported.id}`);
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.getByRole('button', { name: /Move to story/ }).click();
  await page.getByRole('button', { name: /The Long Storm/ }).click();

  // The move is a property of the chat row, so it survives a reload.
  await expect
    .poll(async () => (await readStore<any>(page, 'chats')).find((c) => c.id === imported.id)?.storyId, {
      timeout: 10_000,
    })
    .toBe('s1');
  await reloadApp(page, `#/chat/${imported.id}`);

  const body = await (async () => {
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeEditable();
    const before = ollama.requests.length;
    await composer.fill('Any rooms left?');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);
    return ollama.requests.at(-1)!.body;
  })();

  // The point of the move: the story's cast now describes the scene, where
  // before the model was handed a transcript and no one to play.
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toMatch(/Present:.*Sera/);
  expect(system).toContain('Warm and watchful.');

  // The messages themselves are untouched — the move is reversible.
  const messages = await readStore<any>(page, 'messages');
  const carried = messages.filter((m) => m.chatId === imported.id && m.historical === true);
  expect(carried.length).toBe(2);
});

/* =================================================== the narrator's brief */

test('the model is framed as the narrator, not as the character', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  const body = await sendTurn(page, ollama, 'You look terrible.');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // The frame itself: an author writing a scene, not a person in it.
  expect(system).toMatch(/You are not a character in this scene/);
  expect(system).toMatch(/You are the author writing it/);
  // And named against the focal character specifically, which is the confusion
  // that actually happens — the model deciding it *is* Bakugo.
  expect(system).toMatch(/Katsuki Bakugo is someone you write about, not someone you are/);

  // The brief settles who is writing before describing what they write about.
  expect(system.indexOf('You are the narrator')).toBeLessThan(system.indexOf('## Current scene'));
});

test('bare dialogue is ruled out without imposing a shape on the reply', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);
  const body = await sendTurn(page, ollama, 'You look terrible.');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  expect(system).toMatch(/the next page of a novel/);
  expect(system).toMatch(/nothing but a quoted line is a transcript, not a scene/);

  // No quota of any kind smuggled in alongside it: not a word count, not a
  // paragraph count, not a required list of components.
  expect(system).not.toMatch(/\b\d+\s*(words|sentences|paragraphs)\b/i);
  expect(system).toMatch(/length and shape follow the scene, not a quota/);
});

test('the speaker prefix is labelled as a label, not a script format', async ({ page }) => {
  const ollama = await mockOllama(page, ['Kirishima grins.'], 8192);
  await setupOllamaProvider(page);
  // Two in the room is what turns attribution on in the first place.
  await seedHospitalScene(page, {
    castKirishima: true,
    presentCharacterIds: ['bakugo', 'kirishima'],
  });

  const body = await sendTurn(page, ollama, 'Both of you, sit down.');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toMatch(/a label saying who was speaking, not the format to write in/);
});

test('example dialogue is framed as a voice sample, not a length template', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera looks up.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const character: any = await new Promise((r) => {
      const q = db.transaction('characters', 'readonly').objectStore('characters').get('c1');
      q.onsuccess = () => r(q.result);
    });
    character.exampleDialogue = '{{user}}: Any rooms?\nSera: "One. Take it or the road."';
    await new Promise<void>((r) => {
      const q = db.transaction('characters', 'readwrite').objectStore('characters').put(character);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  await startChat(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Any rooms left?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);
  const system = ollama.requests
    .at(-1)!
    .body.messages.find((m: any) => m.role === 'system').content;

  // The sample still reaches the model — this is not about removing it.
  expect(system).toContain('Take it or the road.');
  // But it arrives labelled, so it teaches voice rather than brevity.
  expect(system).toMatch(/How Sera sounds/);
  expect(system).toMatch(/not a shape for your turn/);
});

test('an install that never edited the stock prompt is moved off "stay in character"', async ({
  page,
}) => {
  // The wording as it shipped, still sitting in an existing install's settings.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const settings: any = await new Promise((r) => {
      const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      q.onsuccess = () => r(q.result);
    });
    settings.globalSystemPrompt =
      'You are a masterful roleplay partner. Stay in character, write vivid, immersive prose, ' +
      'and never break the fourth wall or speak as the user unless explicitly asked.';
    await new Promise<void>((r) => {
      const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await reloadApp(page, '#/dashboard');

  const migrated = (await readStore<any>(page, 'settings'))[0];
  expect(migrated.globalSystemPrompt).not.toMatch(/Stay in character/);
  expect(migrated.globalSystemPrompt).toMatch(/narrating an unfolding story/);
});

test('a system prompt the user wrote themselves is never rewritten', async ({ page }) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const settings: any = await new Promise((r) => {
      const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      q.onsuccess = () => r(q.result);
    });
    settings.globalSystemPrompt = 'Stay in character. Write short, clipped replies. No purple prose.';
    await new Promise<void>((r) => {
      const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await reloadApp(page, '#/dashboard');

  // It resembles the old default and contradicts the new framing, and it is
  // still theirs. Only the exact stock string is migrated.
  const kept = (await readStore<any>(page, 'settings'))[0];
  expect(kept.globalSystemPrompt).toBe(
    'Stay in character. Write short, clipped replies. No purple prose.',
  );
});

/* ======================================= the shallow-response regression */

/**
 * The benchmark turn, asserted end to end.
 *
 * A short expression plus a short line — and the line is a question, which is
 * what used to draw a one-sentence conversational answer out of a chat-tuned
 * model. Nothing here asserts the generated prose: a mocked model returns
 * whatever it is told to. What is provable is that the instruction reaches the
 * model, in the position that gives it weight, with the scene intact.
 */
test('the benchmark turn arrives with the narrative directive last', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, { castKirishima: true, transcriptRepeats: 3 });

  const body = await sendTurn(page, ollama, 'my face lits up mischievously\n\n"oh? is that so?"');
  const messages = body.messages;
  const system = messages.find((m: any) => m.role === 'system').content;
  const last = messages.at(-1);

  /* --- the directive, and where it sits ------------------------------- */
  // Last, after the user's turn. Position is the point: the narrator's brief
  // alone sat ninety lines above the turn it governed.
  expect(last.role).toBe('system');
  expect(last.content).toContain('## This turn');
  expect(last.content).toMatch(/It is not a question addressed to you/);
  expect(last.content).toMatch(/Play it forward/);
  expect(last.content).toMatch(/instead of stopping once the message has been acknowledged/);
  // Depth follows the scene, and no quota was smuggled in with it.
  expect(last.content).toMatch(/a light exchange can be brief, a charged one earns space/);
  expect(last.content).not.toMatch(/\b\d+\s*(words|sentences|paragraphs)\b/i);

  /* --- control ------------------------------------------------------- */
  expect(last.content).toMatch(/Never write Reiko Ryuusui/);
  expect(system).toMatch(/Reiko Ryuusui is the user/);
  expect(system).toMatch(/Never write Reiko Ryuusui's dialogue, actions, thoughts, or decisions/);
  expect(system).toMatch(/You narrate the world and play everyone present except Reiko Ryuusui/);
  expect(system).toMatch(/You are not a character in this scene/);

  /* --- presence ------------------------------------------------------ */
  const presentLine = /Present: (.*)/.exec(system)?.[1] ?? '';
  expect(presentLine).toContain('Reiko Ryuusui');
  expect(presentLine).toContain('Katsuki Bakugo');
  // Named all through the transcript and the lore, and still not in the room.
  expect(presentLine).not.toMatch(/Edgeshot|Midoriya|Deku|Kirishima|Aizawa/);
  expect(system).toMatch(/not in the scene: .*Kirishima|Kirishima.*\(not present\)/);

  /* --- the turn itself, and the play it continues --------------------- */
  const userTurns = messages.filter((m: any) => m.role === 'user');
  expect(userTurns.at(-1).content).toContain('my face lits up mischievously');
  expect(userTurns.at(-1).content).toContain('oh? is that so?');
  const transcript = messages
    .filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.content)
    .join('\n');
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).toMatch(/hospital room|Bakugo/);
});

test('a carried script transcript is called a label even with one character present', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  // One character in the scene, and a transcript written as `Bakugo: "..."`.
  // The clause used to be gated on the cast size, so this — the case where
  // script-teaching is worst — was the one configuration it never covered.
  await seedHospitalScene(page);

  const body = await sendTurn(page, ollama, '*I giggle.*');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toMatch(/a label saying who was speaking, not the format to write in/);
});

/* ============================================== narration style presets */

test('narration presets combine, and reach the model as one block', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const story: any = await new Promise((r) => {
      const q = db.transaction('stories', 'readonly').objectStore('stories').get('mha-story');
      q.onsuccess = () => r(q.result);
    });
    story.narrationPresetIds = ['preset-detailed', 'preset-slow-burn', 'preset-cinematic'];
    await new Promise<void>((r) => {
      const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  const body = await sendTurn(page, ollama, 'You look terrible.');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // All three, in one block, as separate emphases rather than run together.
  expect(system).toContain('## Narration style');
  expect(system).toMatch(/- Detailed: Use richer sensory/);
  expect(system).toMatch(/- Slow Burn: Let emotional tension build/);
  expect(system).toMatch(/- Cinematic: Emphasise visual composition/);
  // A preset shapes how the scene is written, and says nothing about length.
  expect(system).toMatch(/none of them asks for a particular length/);
});

test('no preset selected sends no style block at all', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);

  const body = await sendTurn(page, ollama, 'You look terrible.');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).not.toContain('## Narration style');
});

test('a chat can override the story it belongs to', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const read = (store: string, id: string) =>
      new Promise<any>((r) => {
        const q = db.transaction(store, 'readonly').objectStore(store).get(id);
        q.onsuccess = () => r(q.result);
      });
    const write = (store: string, value: any) =>
      new Promise<void>((r) => {
        const q = db.transaction(store, 'readwrite').objectStore(store).put(value);
        q.onsuccess = () => r();
      });

    const story = await read('stories', 'mha-story');
    story.narrationPresetIds = ['preset-fast-paced'];
    await write('stories', story);

    const chat = await read('chats', 'hospital-chat');
    chat.narrationPresetIds = ['preset-slow-burn'];
    await write('chats', chat);
    db.close();
  });
  await page.reload();
  await boot(page);

  const body = await sendTurn(page, ollama, 'You look terrible.');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toMatch(/- Slow Burn:/);
  expect(system).not.toMatch(/- Fast Paced:/);
});

/* ================================ attribution inside historical roleplay */

/**
 * An imported log names a speaker per message, so the attribution is the
 * file's own — not a guess parsed out of prose. The compiler used to throw it
 * away: `attribute()` skipped every historical message, which was right for a
 * pasted transcript holding a whole scene and wrong for a per-turn log.
 */
test('an imported multi-character log keeps its attribution on the wire', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);

  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'two-speakers.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        title: 'The ward',
        messages: [
          { name: 'Reiko', role: 'user', content: 'You both look terrible.' },
          { name: 'Bakugo', role: 'assistant', content: 'Tch. Speak for yourself.' },
          { name: 'Kirishima', role: 'assistant', content: 'He has been saying that all morning.' },
          { name: 'Reiko', role: 'user', content: 'Has he now.' },
          { name: 'Bakugo', role: 'assistant', content: 'Shut it, hair-for-brains.' },
        ],
      }),
    ),
  });
  await expect(page.getByText(/Import preview/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await page.waitForTimeout(800);

  // Both speakers became characters, and the scene holds both.
  const messages = await readStore<any>(page, 'messages');
  const attributed = messages.filter((m) => m.speakerScope === 'turn');
  expect(attributed.length).toBe(3);
  expect(attributed.every((m: any) => m.historical === true && m.characterId)).toBe(true);

  const chat = (await readStore<any>(page, 'chats'))[0];
  await goto(page, `#/chat/${chat.id}`);
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Both of you, quiet.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const body = ollama.requests.at(-1)!.body;
  const assistantTurns = body.messages
    .filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.content);

  // Who said what survives the trip. Anonymous assistant turns are exactly
  // what made a two-character log unreadable.
  expect(assistantTurns.some((c: string) => c.startsWith('Bakugo:'))).toBe(true);
  expect(assistantTurns.some((c: string) => c.startsWith('Kirishima:'))).toBe(true);
  // The user's own turns stay user turns — never relabelled as a character.
  const userTurns = body.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
  expect(userTurns.some((c: string) => c.includes('You both look terrible.'))).toBe(true);
  expect(assistantTurns.every((c: string) => !c.startsWith('Reiko:'))).toBe(true);
});

test('a whole-scene message is never given one character’s name', async ({ page }) => {
  const ollama = await mockOllama(page, ['Kirishima grins.'], 8192);
  await setupOllamaProvider(page);
  // Two present, so attribution is switched on — and a carried transcript that
  // holds the whole scene, which has no single speaker to name.
  await seedHospitalScene(page, {
    castKirishima: true,
    presentCharacterIds: ['bakugo', 'kirishima'],
  });

  const body = await sendTurn(page, ollama, 'You are both impossible.');
  const carried = body.messages.filter(
    (m: any) => m.role === 'assistant' && m.content.includes('The hospital room was quiet'),
  );
  expect(carried.length).toBeGreaterThan(0);
  // Naming a speaker here would be a lie: the message contains several.
  for (const message of carried) {
    expect(message.content).not.toMatch(/^Katsuki Bakugo:/);
    expect(message.content).not.toMatch(/^Kirishima:/);
  }
  // Instead the prompt says what the record is, and that it is not a pattern.
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toMatch(/a record of earlier roleplay, not events happening now/);
});

test('historical Reiko dialogue does not license writing Reiko now', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  // The seeded transcript contains `Reiko: "How are you feeling?"`.
  await seedHospitalScene(page, { transcriptRepeats: 5 });

  const body = await sendTurn(page, ollama, 'Well?');
  const all = body.messages.map((m: any) => String(m.content)).join('\n');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // The contradiction is real and has to be named, not hidden: the record does
  // contain her lines, and the prompt says so and says it is not a pattern.
  expect(all).toMatch(/Reiko: "How are you feeling\?"/);
  expect(system).toMatch(/contains lines for Reiko Ryuusui as well as for the cast/);
  expect(system).toMatch(/not a pattern to continue/);
  expect(system).toMatch(/Reiko Ryuusui's words, actions and choices belong to the user alone/);
  // And the control rule still stands, in both the system block and the last word.
  expect(system).toMatch(/Never write Reiko Ryuusui's dialogue, actions, thoughts, or decisions/);
  expect(body.messages.at(-1).content).toMatch(/Never write Reiko Ryuusui/);
});

test('a seeded story opening is not attributed to the focal character', async ({ page }) => {
  const ollama = await mockOllama(page, ['Kirishima grins.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // An opening is the scene, not the character taking a turn — even though it
  // is filed under them, and even with attribution switched on.
  await startChat(page);
  const seeded = (await readStore<any>(page, 'messages')).find((m) => m.order === 0);
  expect(seeded.historical).toBe(true);
  expect(seeded.speakerScope).toBe('scene');

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Evening.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const opening = ollama.requests
    .at(-1)!
    .body.messages.find((m: any) => m.content.includes('Sera looks up from the bar'));
  expect(opening).toBeTruthy();
  expect(opening.content).not.toMatch(/^Sera:/);
});

/* ============================== memory retrieval is ranked by the scene */

/**
 * Seeds a story with far more memories than the budget admits, exactly one of
 * which is about the person in the room.
 */
async function seedManyMemories(page: Page) {
  await seedHospitalScene(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const put = (v: unknown) =>
      new Promise<void>((r) => {
        const q = db.transaction('memories', 'readwrite').objectStore('memories').put(v);
        q.onsuccess = () => r();
      });
    const now = Date.now();
    const base = {
      origin: 'manual',
      category: 'Event',
      pinned: false,
      sourceMessageIds: [],
      sourceChatId: null,
      sourceStoryId: 'mha-story',
      tags: [],
      createdAt: now,
      updatedAt: now,
    };

    // Forty newer, higher-importance memories about nobody in the room.
    for (let i = 0; i < 40; i += 1) {
      await put({
        ...base,
        id: `noise-${i}`,
        title: `Sports festival heat ${i}`,
        content: `Something happened in heat ${i} of the sports festival.`,
        importance: 'high',
        characterIds: [],
        updatedAt: now + 1000 + i,
      });
    }

    // One older, merely-normal memory about the character who is present.
    await put({
      ...base,
      id: 'about-bakugo',
      title: 'The promise',
      content: 'Bakugo promised Reiko he would stop pretending it did not hurt.',
      importance: 'normal',
      characterIds: ['bakugo'],
      updatedAt: now - 500_000,
    });

    // And one about a topic the user is about to raise, by tag.
    await put({
      ...base,
      id: 'about-cellar',
      title: 'The sealed door',
      content: 'The recovery ward has a door nobody uses.',
      importance: 'low',
      characterIds: [],
      tags: ['cellar'],
      updatedAt: now - 900_000,
    });
    db.close();
  });
  await page.reload();
  await boot(page);
}

test('a memory about someone in the room outranks forty newer ones that are not', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedManyMemories(page);

  const body = await sendTurn(page, ollama, 'You never say when it hurts.');
  const system = body.messages.find((m: any) => m.role === 'system').content;

  // The one about the person actually present is in, on merit rather than on
  // recency: it is older and less important than every memory competing.
  expect(system).toContain('Bakugo promised Reiko he would stop pretending');
  // And the noise did not fill the budget ahead of it.
  const noiseCount = (system.match(/Something happened in heat/g) ?? []).length;
  expect(noiseCount).toBeLessThan(40);
});

test('a memory is pulled in by what the user just said', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedManyMemories(page);

  // Nothing about this memory is important or recent; the only thing linking
  // it to the scene is the word the user typed.
  const body = await sendTurn(page, ollama, 'What is behind the cellar door?');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toContain('The recovery ward has a door nobody uses.');
});

test('a memory from another story stays out of this one', async ({ page }) => {
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedManyMemories(page);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const q = db
        .transaction('memories', 'readwrite')
        .objectStore('memories')
        .put({
          id: 'other-story',
          origin: 'manual',
          title: 'A different world',
          content: 'The dragon of Ashfell was never found.',
          category: 'Event',
          importance: 'critical',
          pinned: false,
          sourceMessageIds: [],
          sourceChatId: null,
          sourceStoryId: 'some-other-story',
          characterIds: [],
          tags: [],
          createdAt: Date.now(),
          updatedAt: Date.now() + 9_000_000,
        });
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  const body = await sendTurn(page, ollama, 'You never say when it hurts.');
  const system = body.messages.find((m: any) => m.role === 'system').content;
  // Newest and critical, and still background: it belongs to another story and
  // nothing in this scene touched it.
  expect(system).not.toContain('The dragon of Ashfell');
  expect(system).toContain('Bakugo promised Reiko');
});
