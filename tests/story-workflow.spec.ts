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
  readStore,
  resetDatabase,
  seedFixtures,
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
  await page.getByRole('button', { name: /Write an opening scene/ }).click();

  await expect(page.getByText(/needs an AI provider/)).toBeVisible({ timeout: 15_000 });
});
