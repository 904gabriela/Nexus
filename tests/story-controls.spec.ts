/**
 * The controls that describe the story, and whether they tell the truth.
 *
 * Two of these guard a specific failure the audit found: Quick Settings read
 * only the chat's narration presets while the compiler resolves
 * `chat ?? story ?? none`, so a story-level style was being sent while every
 * chip in the panel looked inactive — and the first tap silently replaced the
 * story's selection with a single chat-level one.
 *
 * The rest guard the composition: artwork must not sit under readable prose,
 * and the Story Map must reach both the branch tree and the chronological
 * spine.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockOllama,
  readStore,
  resetDatabase,
  seedFixtures,
  setupOllamaProvider,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/** Gives the seeded story a narration preset of its own. */
async function storyPresets(page: Page, ids: string[]) {
  await page.evaluate(async (presetIds) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const story: any = await new Promise((r) => {
      const q = db.transaction('stories', 'readonly').objectStore('stories').get('s1');
      q.onsuccess = () => r(q.result);
    });
    story.narrationPresetIds = presetIds;
    await new Promise<void>((r) => {
      const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
      q.onsuccess = () => r();
    });
    db.close();
  }, ids);
  await page.reload();
  await boot(page);
}

/** Into a chat via the stories list, the same way every other spec gets there. */
async function openChat(page: Page) {
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
}

async function sendAndRead(page: Page, ollama: { requests: any[] }, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);
  return ollama.requests.at(-1)!.body.messages.find((m: any) => m.role === 'system').content;
}

function chipState(page: Page, name: string) {
  return page.locator('.sheet').last().getByRole('button', { name, exact: true });
}

test('a preset inherited from the story shows as active, and is what gets sent', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await storyPresets(page, ['preset-detailed']);
  await openChat(page);

  // The chat has never chosen anything, so it inherits.
  const chats = await readStore<any>(page, 'chats');
  expect(chats[0].narrationPresetIds).toBeNull();

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await expect(chipState(page, 'Detailed')).toHaveAttribute('aria-pressed', 'true');
  await expect(chipState(page, 'Cinematic')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('From story')).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  // The panel said Detailed; the prompt has Detailed. They agree.
  expect(system).toMatch(/richer sensory/i);
});

test('opening the panel and changing nothing leaves the chat inheriting', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await storyPresets(page, ['preset-detailed']);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Close' }).first().click();

  // Merely looking must not write an override.
  const chats = await readStore<any>(page, 'chats');
  expect(chats[0].narrationPresetIds).toBeNull();
});

test('the first edit keeps what the story chose instead of replacing it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await storyPresets(page, ['preset-detailed']);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await chipState(page, 'Cinematic').click();

  await expect
    .poll(async () => (await readStore<any>(page, 'chats'))[0].narrationPresetIds, {
      timeout: 15_000,
    })
    // Detailed came from the story and survives; Cinematic is the addition.
    .toEqual(['preset-detailed', 'preset-cinematic']);

  await expect(chipState(page, 'Detailed')).toHaveAttribute('aria-pressed', 'true');
  await expect(chipState(page, 'Cinematic')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('This chat', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  // Both, combined — presets are not mutually exclusive.
  expect(system).toMatch(/richer sensory/i);
  expect(system).toMatch(/visual composition/i);
});

test('a chat can be handed back to the story it belongs to', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await storyPresets(page, ['preset-detailed']);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await chipState(page, 'Cinematic').click();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Use story presets' }).click();
  await expect
    .poll(async () => (await readStore<any>(page, 'chats'))[0].narrationPresetIds, {
      timeout: 15_000,
    })
    .toBeNull();

  // Back to inherited, and shown as such.
  await expect(chipState(page, 'Detailed')).toHaveAttribute('aria-pressed', 'true');
  await expect(chipState(page, 'Cinematic')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('From story')).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  expect(system).toMatch(/richer sensory/i);
  expect(system).not.toMatch(/visual composition/i);
});

test('turning every style off is a deliberate none, not a fallback to the story', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await storyPresets(page, ['preset-detailed']);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await chipState(page, 'Detailed').click();

  await expect
    .poll(async () => (await readStore<any>(page, 'chats'))[0].narrationPresetIds, {
      timeout: 15_000,
    })
    .toEqual([]);

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  expect(system).not.toMatch(/richer sensory/i);
});

test('story artwork never renders underneath the transcript', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // A deliberately loud cover: the worst case for prose sitting over art.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 600;
    const g = canvas.getContext('2d')!;
    for (let i = 0; i < 60; i += 1) {
      g.fillStyle = `hsl(${(i * 37) % 360} 95% ${55 + (i % 3) * 15}%)`;
      g.fillRect((i * 61) % 900, (i * 43) % 600, 190, 150);
    }
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const put = (store: string, value: any) =>
      new Promise<void>((r) => {
        const q = db.transaction(store, 'readwrite').objectStore(store).put(value);
        q.onsuccess = () => r();
      });
    const now = Date.now();
    await put('media', {
      id: 'cover1', filename: 'c.png', mimeType: 'image/png', size: blob.size,
      width: 900, height: 600, ownerType: 'story-cover', ownerId: 's1', tags: [],
      source: 'upload', createdAt: now, updatedAt: now,
    });
    await put('mediaBlobs', { id: 'cover1', blob });
    const story: any = await new Promise((r) => {
      const q = db.transaction('stories', 'readonly').objectStore('stories').get('s1');
      q.onsuccess = () => r(q.result);
    });
    story.coverMediaId = 'cover1';
    await put('stories', story);
    db.close();
  });
  await page.reload();
  await boot(page);
  await openChat(page);
  await expect(page.locator('.chat-bg')).toBeAttached({ timeout: 15_000 });

  const geometry = await page.evaluate(() => {
    const art = document.querySelector('.chat-bg')!.getBoundingClientRect();
    const scroll = document.querySelector('.chat-scroll')!.getBoundingClientRect();
    return { artBottom: art.bottom, artHeight: art.height, scrollTop: scroll.top };
  });

  // The whole point: the artwork ends before anything readable begins. This is
  // a geometric fact rather than a matter of opacity, because prose that sits
  // over an image has its contrast decided by the image.
  expect(geometry.artHeight).toBeGreaterThan(0);
  expect(geometry.artBottom).toBeLessThanOrEqual(geometry.scrollTop + 1);

  // And no message overlaps it either.
  const overlap = await page.evaluate(() => {
    const art = document.querySelector('.chat-bg')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('.msg')).some(
      (el) => el.getBoundingClientRect().top < art.bottom,
    );
  });
  expect(overlap).toBe(false);
});

test('the story map reaches both the branch tree and the timeline', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  await page.getByRole('button', { name: 'Story map' }).click();
  const sheet = page.locator('.sheet').last();
  // The map's own tab strip, not the timeline's filter chips inside it.
  const views = sheet.getByRole('tablist', { name: 'Story map views' });
  await expect(sheet.getByText('Story map', { exact: true })).toBeVisible();

  // The branch tree — the view that was previously three taps deep.
  await expect(page.getByTestId('branch-row').first()).toBeVisible({ timeout: 15_000 });

  await views.getByRole('tab', { name: /Timeline/ }).click();
  await expect(page.getByText(/oldest first/)).toBeVisible({ timeout: 15_000 });

  // Still one surface: switching back finds the tree where it was.
  await views.getByRole('tab', { name: /Branches/ }).click();
  await expect(page.getByTestId('branch-row').first()).toBeVisible();
});

test('the story page leads with the story, not with a form', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await seedFixtures(page);
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();

  // The heading is the story, not the verb.
  await expect(page.getByRole('heading', { name: /The Long Storm/ })).toBeVisible();
  await expect(page.getByText('Edit Story')).toHaveCount(0);

  // And the first action offered is to play it.
  await expect(page.getByRole('button', { name: /Start the story|Continue story/ })).toBeVisible();
});
