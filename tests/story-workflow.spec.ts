/**
 * Story and character workflow.
 *
 * Characters are the reusable library; a story is the campaign that borrows
 * them. The two things asserted here are the ones that were missing: getting
 * into a scene with a character without filling in a story form first, and a
 * story opening with a scene rather than a greeting.
 */
import { expect, test } from '@playwright/test';
import {
  boot,
  field,
  goto,
  mockAI,
  mockOllama,
  readStore,
  resetDatabase,
  seedFixtures,
  setupOllamaProvider,
  setupProvider,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

test('Chat on a character opens a scene, building the story it needs', async ({ page }) => {
  await seedFixtures(page);

  // A character in the library and in no story of their own — the state an
  // imported character arrives in.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const sera: any = await new Promise((r) => {
      const q = db.transaction('characters', 'readonly').objectStore('characters').get('c1');
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const q = db
        .transaction('characters', 'readwrite')
        .objectStore('characters')
        .put({ ...sera, id: 'c2', name: 'Halda', shortDescription: 'The caravan master.' });
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  const storiesBefore = (await readStore<any>(page, 'stories')).length;

  await goto(page, '#/characters');
  await page.getByRole('button', { name: 'Chat with Halda' }).click();

  // We are in a chat, not in a story form.
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  const stories = await readStore<any>(page, 'stories');
  expect(stories.length).toBe(storiesBefore + 1);
  const built = stories.find((s) => s.title === 'Halda');
  expect(built.characters).toEqual([
    { characterId: 'c2', primary: true, note: '', enabled: true },
  ]);

  // And the chat belongs to it, so the cast reaches the compiler.
  const chats = await readStore<any>(page, 'chats');
  expect(chats.some((c) => c.storyId === built.id)).toBe(true);
});

test('chatting with the same character twice returns to the same story', async ({ page }) => {
  await seedFixtures(page);
  // The seeded story already holds Sera alone, so it is her story.
  await goto(page, '#/characters');
  await page.getByRole('button', { name: 'Chat with Sera' }).click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  await goto(page, '#/characters');
  await page.getByRole('button', { name: 'Chat with Sera' }).click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });

  // Two chats, one story — Chat must not breed a story per tap.
  const stories = await readStore<any>(page, 'stories');
  expect(stories).toHaveLength(1);
  expect(stories[0].id).toBe('s1');
  const chats = await readStore<any>(page, 'chats');
  expect(chats.filter((c) => c.storyId === 's1').length).toBe(2);
});

test('a story can open with a written scene instead of a greeting', async ({ page }) => {
  const ai = await mockAI(page, [
    'Rain had been falling on Ashfell since noon, and the tavern smelled of wet wool and ' +
      'woodsmoke. Sera set down the glass she had been drying and looked at the door.',
  ]);
  await setupProvider(page);
  await seedFixtures(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await page.getByRole('button', { name: /Write an opening scene/ }).click();

  const opening = field(page, 'Opening scene');
  await expect(opening).toHaveValue(/wet wool and woodsmoke/, { timeout: 20_000 });

  // The brief the model was given is the story's own, not a character card.
  const request = ai.requests.at(-1)!.body;
  const system = request.messages.find((m: any) => m.role === 'system').content;
  const brief = request.messages.find((m: any) => m.role === 'user').content;
  expect(system).toMatch(/first passage of a story/);
  expect(system).toMatch(/greeting addressed to the reader is not an opening scene/i);
  expect(brief).toContain('Travellers wait out a storm in the Nexus Tavern.');
  expect(brief).toContain('Sera');
  // The player's persona is named as present and as off-limits.
  expect(brief).toMatch(/The player plays Corin/);
  expect(brief).toMatch(/never write their words, actions or thoughts/);

  // Nothing is committed until Save — this is a draft in a field.
  const stories = await readStore<any>(page, 'stories');
  expect(stories[0].openingMessage ?? '').not.toContain('wet wool');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => (await readStore<any>(page, 'stories'))[0].openingMessage, {
      timeout: 10_000,
    })
    .toContain('wet wool and woodsmoke');
});

test('writing an opening scene without a provider says so instead of failing silently', async ({
  page,
}) => {
  await seedFixtures(page);
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await page.getByRole('button', { name: /Write an opening scene/ }).click();

  await expect(page.getByText(/needs an AI provider/)).toBeVisible({ timeout: 15_000 });
});

/* ============================================== the story editor as a hub */

test('the world is its own section, and its rules reach the model', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();

  // Overview is what the story *is*; World is what is true in it.
  await expect(field(page, 'Summary')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'World' })).toBeVisible();

  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'World rules').fill('No one in Ashfell can lie inside the tavern.');
  await field(page, 'Timeline').fill('Spring: the cellar was sealed. Autumn: the storms began.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible();

  const stories = await readStore<any>(page, 'stories');
  expect(stories[0].rules).toContain('can lie');
  expect(stories[0].timeline).toContain('the cellar was sealed');
});

test('world rules and the timeline are sent, and are not confused with the scene', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const story: any = await new Promise((r) => {
      const q = db.transaction('stories', 'readonly').objectStore('stories').get('s1');
      q.onsuccess = () => r(q.result);
    });
    story.rules = 'No one can lie inside the tavern.';
    story.timeline = 'Spring: the cellar was sealed.';
    await new Promise<void>((r) => {
      const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Any rooms left?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const system = ollama.requests
    .at(-1)!
    .body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toContain('No one can lie inside the tavern.');
  expect(system).toContain('Spring: the cellar was sealed.');
  // A rule holds; a timeline is the past. Neither is the scene running now.
  expect(system).toMatch(/These hold for the whole story/);
  expect(system).toMatch(/the story’s past, not the current scene/);
});

/* ================================================= the character builder */

test('the character builder shows five fields, and hides none of the rest', async ({ page }) => {
  await goto(page, '#/character/new');

  // Essentials is what a character actually needs, and it is what you land on.
  for (const label of ['Name', 'Description', 'Personality']) {
    await expect(field(page, label)).toBeVisible();
  }
  await expect(page.getByText('Avatar', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add greeting' })).toBeVisible();

  // The twenty-odd others are not on screen competing with them.
  await expect(page.getByRole('textbox', { name: 'Backstory' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Example dialogue' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Secrets' })).toHaveCount(0);

  // Details folds them into sections that open on demand — collapsed, not gone.
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.locator('.disclosure')).toHaveCount(5);
  await expect(page.getByRole('textbox', { name: 'Backstory' })).toHaveCount(0);
  await page.locator('.disclosure > summary', { hasText: 'Background' }).click();
  await expect(field(page, 'Backstory')).toBeVisible();

  // Advanced holds the prompt-shaping fields, open by default because someone
  // who reached this tab came looking for them.
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await expect(field(page, 'Example dialogue')).toBeVisible();
  await expect(field(page, 'System prompt')).toBeVisible();
  await expect(field(page, "Author's note")).toBeVisible();
});

test('a validation failure returns to the tab that holds the broken field', async ({ page }) => {
  await goto(page, '#/character/new');
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();

  // The name is required and lives in Essentials, so that is where you end up.
  await expect(page.getByRole('tab', { name: 'Essentials' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('A character needs a name.')).toBeVisible();
});

/* ================================= story state and relationships (Phase 2) */

test('where the story stands is sent, and does not restate the scene', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'Arc').fill('The long storm');
  await field(page, 'Time').fill('Third night of the storm');
  await field(page, 'Active tension').fill('Nobody has mentioned the cellar since it was sealed.');
  await field(page, 'Working towards').fill('Getting through the season without opening it.');
  await field(page, 'Open threads').fill('Who sealed the cellar');
  await field(page, 'Open threads').press('Enter');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible();

  const stories = await readStore<any>(page, 'stories');
  expect(stories[0].state.arc).toBe('The long storm');
  expect(stories[0].state.threads).toContain('Who sealed the cellar');

  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Quiet tonight.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const system = ollama.requests.at(-1)!.body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toContain('## Where the story stands');
  expect(system).toContain('Arc: The long storm');
  expect(system).toContain('Time: Third night of the storm');
  expect(system).toMatch(/Active tension: Nobody has mentioned the cellar/);
  expect(system).toMatch(/Unresolved:\n- Who sealed the cellar/);

  // It sits under the scene and above the story's static setup: a live
  // situation outranks what was true before play began, and is outranked by
  // what is happening in the room this minute.
  expect(system.indexOf('## Current scene')).toBeLessThan(system.indexOf('## Where the story stands'));
  expect(system.indexOf('## Where the story stands')).toBeLessThan(system.indexOf('## Scenario'));
});

test('a relationship reaches the model only when both people are in the scene', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // Sera is in the scene; Halda is in the cast but not present.
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
    const write = (store: string, v: any) =>
      new Promise<void>((r) => {
        const q = db.transaction(store, 'readwrite').objectStore(store).put(v);
        q.onsuccess = () => r();
      });

    const sera = await read('characters', 'c1');
    await write('characters', { ...sera, id: 'c2', name: 'Halda' });

    const story = await read('stories', 's1');
    story.characters = [
      { characterId: 'c1', primary: true, note: '', enabled: true },
      { characterId: 'c2', primary: false, note: '', enabled: true },
    ];
    story.relationships = [
      {
        id: 'rel-present',
        betweenIds: ['c1', 'p1'],
        label: 'old friends',
        summary: 'She has been letting him drink on credit for a year.',
        manual: true,
        updatedAt: Date.now(),
      },
      {
        id: 'rel-absent',
        betweenIds: ['c2', 'p1'],
        label: 'never met',
        summary: 'Halda has only heard the name.',
        manual: true,
        updatedAt: Date.now(),
      },
    ];
    await write('stories', story);
    db.close();
  });
  await page.reload();
  await boot(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Evening.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const system = ollama.requests.at(-1)!.body.messages.find((m: any) => m.role === 'system').content;
  expect(system).toContain('## How they stand');
  expect(system).toContain('letting him drink on credit');
  // Halda is in the cast but not in the room, so her standing is background.
  // A cast of eight has twenty-eight pairs; sending them all is how a prompt
  // grows quadratically with a cast that is mostly elsewhere.
  expect(system).not.toContain('Halda has only heard the name');
});

test('a story saved before these fields existed still opens and still sends', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // Exactly the shape an existing install holds: no `state`, no
  // `relationships`. Reading through either would take the editor down.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const story: any = await new Promise((r) => {
      const q = db.transaction('stories', 'readonly').objectStore('stories').get('s1');
      q.onsuccess = () => r(q.result);
    });
    delete story.state;
    delete story.relationships;
    await new Promise<void>((r) => {
      const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await expect(field(page, 'Arc')).toBeVisible();
  await page.getByRole('tab', { name: /Cast/ }).click();
  await expect(page.getByRole('heading', { name: 'Relationships' })).toBeVisible();

  // And an empty story state sends nothing rather than an empty heading.
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill('Evening.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);

  const system = ollama.requests.at(-1)!.body.messages.find((m: any) => m.role === 'system').content;
  expect(system).not.toContain('## Where the story stands');
  expect(system).not.toContain('## How they stand');
});
