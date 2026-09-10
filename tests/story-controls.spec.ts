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

/* ==================================================== authoring the scene */

/**
 * The scene fields the compiler has always read but nothing could write.
 * These assert the whole path: the panel shows what is stored, an edit is
 * persisted through the existing chat patch, and the edit reaches the prompt.
 */

function sceneField(page: Page, label: string) {
  return page.locator('.sheet').last().getByRole('textbox', { name: label, exact: true });
}

async function readScene(page: Page) {
  return (await readStore<any>(page, 'chats'))[0].scene;
}

test('the scene as stored is what the panel shows', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  const chatId = (await readStore<any>(page, 'chats'))[0].id;
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get(id);
      q.onsuccess = () => r(q.result);
    });
    chat.scene = {
      ...chat.scene,
      location: 'The back room',
      situation: 'The roads have been shut for three days.',
      objective: 'Find out who sealed the cellar.',
    };
    await new Promise<void>((r) => {
      const q = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
      q.onsuccess = () => r();
    });
    db.close();
  }, chatId);
  await page.reload();
  await boot(page);
  await goto(page, `#/chat/${chatId}`);
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await expect(sceneField(page, 'Where')).toHaveValue('The back room');
  await expect(sceneField(page, 'What is happening')).toHaveValue(
    'The roads have been shut for three days.',
  );
  await expect(sceneField(page, 'Right now')).toHaveValue('Find out who sealed the cellar.');
});

test('each scene field can be written, and reaches the model', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await sceneField(page, 'Where').fill('The Nexus Tavern, back room');
  await sceneField(page, 'What is happening').fill('The storm has shut the roads for a third night.');
  await sceneField(page, 'Right now').fill('Get Sera to admit who sealed the cellar.');
  // Committing happens on blur, so the last field needs to lose focus.
  await page.locator('.sheet').last().getByRole('heading', { name: 'This scene' }).click();

  await expect
    .poll(async () => (await readScene(page)).objective, { timeout: 15_000 })
    .toBe('Get Sera to admit who sealed the cellar.');

  const scene = await readScene(page);
  expect(scene.location).toBe('The Nexus Tavern, back room');
  expect(scene.situation).toBe('The storm has shut the roads for a third night.');
  // Writing one field must not disturb the others.
  expect(scene.presentCharacterIds).toEqual([]);
  expect(scene.characterStates).toEqual({});

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  expect(system).toContain('Location: The Nexus Tavern, back room');
  expect(system).toContain('Situation: The storm has shut the roads for a third night.');
  expect(system).toContain('Right now: Get Sera to admit who sealed the cellar.');
});

test('clearing a scene field empties it rather than leaving the old text', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await sceneField(page, 'Where').fill('The back room');
  await sceneField(page, 'Right now').click();
  await expect.poll(async () => (await readScene(page)).location, { timeout: 15_000 }).toBe(
    'The back room',
  );

  await sceneField(page, 'Where').fill('');
  await sceneField(page, 'Right now').click();
  await expect.poll(async () => (await readScene(page)).location, { timeout: 15_000 }).toBe('');

  await page.getByRole('button', { name: 'Close' }).first().click();
  const system = await sendAndRead(page, ollama, 'Evening.');
  // Scoped to the scene block: the seeded character carries a Location field of
  // her own, and that one is supposed to be there.
  const sceneBlock = system.split('## ').find((s: string) => s.startsWith('Current scene')) ?? '';
  expect(sceneBlock).not.toContain('Location:');
});

test('setting the scene does not disturb who is in it', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  // Declared presence, put there the way an import would.
  const chatId = (await readStore<any>(page, 'chats'))[0].id;
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const chat: any = await new Promise((r) => {
      const q = db.transaction('chats', 'readonly').objectStore('chats').get(id);
      q.onsuccess = () => r(q.result);
    });
    chat.scene = { ...chat.scene, presentCharacterIds: ['c1'], primaryCharacterId: 'c1' };
    await new Promise<void>((r) => {
      const q = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
      q.onsuccess = () => r();
    });
    db.close();
  }, chatId);
  await page.reload();
  await boot(page);
  await goto(page, `#/chat/${chatId}`);
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  const before = await readScene(page);
  expect(before.presentCharacterIds).toEqual(['c1']);

  await page.getByRole('button', { name: 'Quick settings' }).click();

  await sceneField(page, 'Where').fill('The back room');
  await sceneField(page, 'Right now').click();
  await expect.poll(async () => (await readScene(page)).location, { timeout: 15_000 }).toBe(
    'The back room',
  );

  const after = await readScene(page);
  expect(after.presentCharacterIds).toEqual(before.presentCharacterIds);
  expect(after.primaryCharacterId).toBe(before.primaryCharacterId);
});

test('how a character is right now is scene-local, and never touches the character', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  const characterBefore = (await readStore<any>(page, 'characters')).find(
    (c: any) => c.id === 'c1',
  );

  await page.getByRole('button', { name: 'Quick settings' }).click();
  await sceneField(page, 'Sera').fill('Guarded, hands burnt.');
  await page.locator('.sheet').last().getByRole('heading', { name: 'This scene' }).click();

  await expect
    .poll(async () => (await readScene(page)).characterStates, { timeout: 15_000 })
    .toEqual({ c1: 'Guarded, hands burnt.' });

  await page.reload();
  await boot(page);
  expect((await readScene(page)).characterStates).toEqual({ c1: 'Guarded, hands burnt.' });

  // The character record is untouched — this is how she is now, not who she is.
  const characterAfter = (await readStore<any>(page, 'characters')).find(
    (c: any) => c.id === 'c1',
  );
  expect(characterAfter).toEqual(characterBefore);

  const chatId = (await readStore<any>(page, 'chats'))[0].id;
  await goto(page, `#/chat/${chatId}`);
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const system = await sendAndRead(page, ollama, 'Evening.');
  expect(system).toContain('- Sera: Guarded, hands burnt.');
});

test('quick settings opens on the scene, not on generation settings', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  await page.getByRole('button', { name: 'Quick settings' }).click();
  const headings = await page
    .locator('.sheet')
    .last()
    .locator('.qs-heading')
    .allTextContents();
  expect(headings).toEqual(['This scene', 'How it writes', 'What it remembers', 'Go to']);
});

test('the chat menu keeps the long tail and drops what quick settings now owns', async ({
  page,
}) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await openChat(page);

  await page.getByRole('button', { name: 'Chat menu' }).click();
  const sheet = page.locator('.sheet').last();
  const labels = await sheet.locator('.action-list button > span').allTextContents();
  // Label and description share one span, so an entry is matched by prefix.
  const has = (label: string) => labels.some((text) => text.trim().startsWith(label));

  // One name for one sheet.
  expect(has('Story map')).toBe(true);
  expect(has('Branches')).toBe(false);
  expect(has('Story timeline')).toBe(false);
  // Owned by Quick Settings now.
  expect(has('Response settings')).toBe(false);
  expect(has('Context Inspector')).toBe(false);
  expect(has('Change your persona')).toBe(false);
  // The long tail stays.
  for (const kept of ['Checkpoints', 'Rename chat', 'Duplicate chat', 'Export chat', 'Delete chat']) {
    expect(has(kept)).toBe(true);
  }

  // And everything removed is still reachable where it moved to.
  //
  // The sheet takes focus on a short timer after opening, and Escape is
  // handled by the panel, not the page — so pressing it before focus has
  // landed sends the key to <body>, the sheet stays up, and its backdrop
  // swallows the next click. Wait for focus first, then Escape still gets to
  // prove it closes the sheet.
  await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'Quick settings' }).click();
  for (const moved of ['Persona', 'Response settings', 'Context Inspector']) {
    await expect(sheet.getByRole('button', { name: new RegExp(`^${moved}`) })).toBeVisible();
  }
});
