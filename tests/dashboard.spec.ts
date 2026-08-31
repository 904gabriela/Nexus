/**
 * The dashboard.
 *
 * It used to open with eight action tiles and seven counters — every route in
 * the app on screen at once, none of them looking like the point. What it owes
 * the reader is what they were reading and what they can read next; creating
 * things lives behind one button.
 */
import { expect, test } from '@playwright/test';
import { boot, goto, readStore, resetDatabase, seedFixtures } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

test('the dashboard is a shelf, not a panel of every action in the app', async ({ page }) => {
  await seedFixtures(page);
  await goto(page, '#/dashboard');

  // The shelf carries the stories, with the title under each cover.
  await expect(page.locator('.shelf-item')).toHaveCount(1);
  await expect(page.locator('.shelf-item')).toContainText('The Long Storm');

  // The action grid and the counter grid are gone. Everything they reached is
  // still reachable — from the Library page and the create button.
  await expect(page.getByText('Quick actions')).toHaveCount(0);
  await expect(page.locator('.stat-grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create something new' })).toBeVisible();
});

test('the create button reaches everything the tile grid used to', async ({ page }) => {
  await seedFixtures(page);
  await goto(page, '#/dashboard');
  await page.getByRole('button', { name: 'Create something new' }).click();

  for (const label of [
    'New story',
    'New character',
    'New persona',
    'New lorebook',
    'New memory',
    'Import a file',
  ]) {
    await expect(page.getByRole('button', { name: new RegExp(label) })).toBeVisible();
  }

  await page.getByRole('button', { name: /New story/ }).click();
  await expect(page.getByRole('heading', { name: /New Story/ })).toBeVisible({ timeout: 10_000 });
});

test('the most recent chat is the first thing offered', async ({ page }) => {
  await seedFixtures(page);

  // Two chats in the seeded story, the second touched more recently.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const now = Date.now();
    const base = {
      storyId: 's1',
      personaId: 'p1',
      activeBranchId: null,
      orderCounter: 0,
      settings: {},
      direction: '',
      favorite: false,
      archived: false,
      scene: null,
      createdAt: now,
    };
    for (const [id, title, updatedAt] of [
      ['ch-old', 'The first night', now - 100_000],
      ['ch-new', 'The morning after', now],
    ] as const) {
      await new Promise<void>((r) => {
        const q = db
          .transaction('chats', 'readwrite')
          .objectStore('chats')
          .put({ ...base, id, title, updatedAt });
        q.onsuccess = () => r();
      });
    }
    db.close();
  });
  await page.reload();
  await boot(page);
  await goto(page, '#/dashboard');

  const first = page.locator('.section', { hasText: 'Continue' }).locator('.card-button').first();
  await expect(first).toContainText('The morning after');

  await first.click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const chats = await readStore<any>(page, 'chats');
  expect(chats.some((c) => c.id === 'ch-new')).toBe(true);
});
