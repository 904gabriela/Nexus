/**
 * The Nexus document format.
 *
 * Two things have to hold at once: everything the app writes today is one
 * shape, and every file it has ever written still imports. The second is the
 * reason these tests exercise the pre-schema envelopes by hand — nothing in
 * the app emits them any more, so only a test can keep them working.
 */
import { expect, test } from '@playwright/test';
import {
  boot,
  captureDownload,
  countStore,
  goto,
  readStore,
  resetDatabase,
  seedFixtures,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

async function importJson(page: import('@playwright/test').Page, name: string, value: unknown) {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(page.getByText(/Import preview/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  // A backup asks a second time before it writes.
  const restore = page.getByRole('button', { name: 'Restore', exact: true });
  if (await restore.isVisible().catch(() => false)) await restore.click();
  await page.waitForTimeout(800);
}

test('every export kind is the same document shape', async ({ page }) => {
  await seedFixtures(page);
  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Export' }).click();

  const characterJson = await captureDownload(page, async () => {
    await page.getByTestId('export-row-character').first().getByRole('button').click();
  });
  const storyJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: 'Export story: The Long Storm' }).click();
  });

  for (const [label, json] of [
    ['character', characterJson],
    ['story', storyJson],
  ] as const) {
    const doc = JSON.parse(json);
    // The envelope is identical; only which collections are filled differs.
    expect(doc.format, label).toBe('nexus');
    expect(doc.schema, label).toBe(1);
    expect(typeof doc.exportedAt, label).toBe('string');
    expect(doc.generator.app, label).toBe('Nexus');
    // Collections are flat arrays of the app's own rows — never nested pairs
    // or per-kind wrappers.
    expect(Array.isArray(doc.characters), label).toBe(true);
    expect(doc.data, label).toBeUndefined();
  }

  // The story carries its dependencies as siblings, not as nested bundles.
  const story = JSON.parse(storyJson);
  expect(story.stories).toHaveLength(1);
  expect(story.characters.length).toBeGreaterThan(0);
  expect(story.personas.length).toBeGreaterThan(0);
  // Empty collections are omitted rather than written as [], so a small
  // export stays small.
  expect(story.lorebooks).toBeUndefined();
});

test('a document Nexus wrote imports back into Nexus', async ({ page }) => {
  await seedFixtures(page);
  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Export' }).click();
  const characterJson = await captureDownload(page, async () => {
    await page.getByTestId('export-row-character').first().getByRole('button').click();
  });

  await resetDatabase(page);
  await page.reload();
  await boot(page);
  expect(await countStore(page, 'characters')).toBe(0);

  await importJson(page, 'sera.json', JSON.parse(characterJson));

  const characters = await readStore<any>(page, 'characters');
  expect(characters).toHaveLength(1);
  expect(characters[0].name).toBe('Sera');
  expect(characters[0].personality).toBe('Wry and protective.');
  // The round trip is lossless. Reading our own export through the card
  // normalisers used to rebuild the character from `first_mes` and card keys,
  // which know nothing about a greetings array — so greetings, the id and the
  // lorebook links were dropped on the way back in.
  expect(characters[0].greetings).toHaveLength(1);
  expect(characters[0].greetings[0].content).toBe('Sera looks up from the bar.');
  expect(characters[0].defaultGreetingId).toBe(characters[0].greetings[0].id);
  expect(characters[0].location).toBe('the Nexus Tavern');
});

/* ------------------------------------------------ pre-schema envelopes */

const LEGACY = (kind: string, data: unknown) => ({
  format: 'nexus-tavern-pro',
  kind,
  version: 5,
  exportedAt: '2025-01-01T00:00:00.000Z',
  data,
});

test('a pre-schema character export still imports, lorebooks and all', async ({ page }) => {
  await importJson(
    page,
    'old-character.json',
    LEGACY('character', {
      character: {
        id: 'old-c1',
        name: 'Wren',
        description: 'A courier.',
        personality: 'Impatient.',
        greetings: [{ id: 'g', label: 'Default', content: 'Wren checks the road.' }],
        defaultGreetingId: 'g',
        lorebookIds: ['old-b1'],
      },
      // The nested pair shape the old envelope used.
      lorebooks: [
        {
          lorebook: { id: 'old-b1', name: 'Roads', enabled: true },
          entries: [
            { id: 'old-e1', lorebookId: 'old-b1', name: 'The North Road', content: 'Long and cold.' },
          ],
        },
      ],
    }),
  );

  const characters = await readStore<any>(page, 'characters');
  expect(characters.map((c) => c.name)).toContain('Wren');
  const lorebooks = await readStore<any>(page, 'lorebooks');
  expect(lorebooks.map((b) => b.name)).toContain('Roads');
  const entries = await readStore<any>(page, 'loreEntries');
  expect(entries.map((e) => e.name)).toContain('The North Road');
});

test('a pre-schema story export still brings its nested chats across', async ({ page }) => {
  await importJson(
    page,
    'old-story.json',
    LEGACY('story', {
      story: {
        id: 'old-s1',
        title: 'The Salt Road',
        scenario: 'A caravan, mid-season.',
        characters: [{ characterId: 'old-c2', primary: true, note: '', enabled: true }],
        lorebookIds: [],
        memoryIds: [],
      },
      characters: [{ id: 'old-c2', name: 'Halda', description: 'The caravan master.' }],
      persona: { id: 'old-p1', name: 'Ferrin' },
      lorebooks: [],
      memories: [{ id: 'old-m1', title: 'The bridge fell', content: 'In spring.' }],
      // Chats used to nest everything hanging off them.
      chats: [
        {
          chat: { id: 'old-ch1', storyId: 'old-s1', title: 'Day one', activeBranchId: 'old-br1' },
          branches: [{ id: 'old-br1', chatId: 'old-ch1', name: 'Main' }],
          messages: [
            { id: 'old-msg1', chatId: 'old-ch1', branchId: 'old-br1', role: 'user', content: 'How far?' },
            {
              id: 'old-msg2',
              chatId: 'old-ch1',
              branchId: 'old-br1',
              role: 'assistant',
              content: 'Two days, if the pass holds.',
            },
          ],
          alternatives: [],
          checkpoints: [],
        },
      ],
    }),
  );

  expect((await readStore<any>(page, 'stories')).map((s) => s.title)).toContain('The Salt Road');
  expect((await readStore<any>(page, 'characters')).map((c) => c.name)).toContain('Halda');
  expect((await readStore<any>(page, 'personas')).map((p) => p.name)).toContain('Ferrin');
  expect((await readStore<any>(page, 'memories')).map((m) => m.title)).toContain('The bridge fell');
  // The nesting is what the lift exists for: these are separate collections now.
  expect((await readStore<any>(page, 'chats')).map((c) => c.title)).toContain('Day one');
  const messages = await readStore<any>(page, 'messages');
  expect(messages.map((m) => m.content)).toContain('Two days, if the pass holds.');
});

test('a pre-schema backup still restores', async ({ page }) => {
  await importJson(
    page,
    'old-backup.json',
    LEGACY('backup', {
      characters: [{ id: 'b-c1', name: 'Ilse', description: 'A locksmith.' }],
      personas: [],
      stories: [],
      chats: [],
      branches: [],
      messages: [],
      alternatives: [],
      checkpoints: [],
      memories: [],
      lorebooks: [],
      loreEntries: [],
      mediaMeta: [],
      mediaIncluded: false,
      providers: [],
      imageProviders: [],
      storySummaries: [],
    }),
  );

  expect((await readStore<any>(page, 'characters')).map((c) => c.name)).toContain('Ilse');
});

test('a pre-schema envelope with an unrecognised payload falls through to detection', async ({
  page,
}) => {
  // Carrying the old marker is not a promise about the payload. A file whose
  // data does not match any shape the app ever wrote is better handled by the
  // foreign-format detectors than rejected outright.
  await importJson(
    page,
    'hand-edited.json',
    LEGACY('character', { name: 'Orrin', description: 'Hand-written, not exported.' }),
  );

  expect((await readStore<any>(page, 'characters')).map((c) => c.name)).toContain('Orrin');
});
