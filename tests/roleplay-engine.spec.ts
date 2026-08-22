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
  // beyond anything the model can hold.
  await page.evaluate(() => {
    const raw = localStorage.getItem('nexus-settings');
    const settings = raw ? JSON.parse(raw) : {};
    settings.contextBudget = 513856;
    localStorage.setItem('nexus-settings', JSON.stringify(settings));
  });
  await page.reload();
  await boot(page);
  await generateOnce(page);

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
