/**
 * When a lore entry is allowed to speak.
 *
 * Keyword matching answers "is this relevant"; these three answer "is now the
 * time". They exist because a large worldbook fails in three specific ways: a
 * late revelation fires in the opening exchange, a location drops out of the
 * prompt the moment nobody says its name and the scene loses its footing, and
 * one common keyword re-triggers every single turn until it has crowded
 * everything else out of the context.
 *
 * All three are counted in messages on the timeline being played, and read off
 * the visible history rather than a record of what fired before — so a branch
 * that never said the word has, correctly, never triggered the entry.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockOllama,
  readStore,
  resetDatabase,
  setupOllamaProvider,
  type MockOllama,
} from './helpers';
import { seedBranchedStory } from './branch-summary-fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

function systemOf(ollama: MockOllama): string {
  const body = ollama.requests.at(-1)?.body;
  const system = (body?.messages ?? []).find((m: any) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

async function turn(page: Page, ollama: MockOllama, text: string) {
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
}

/*
 * The fixture's main branch is four messages, and each says something nothing
 * else does:
 *   m0 the door blew open   m1 Sera barred it   m2 the lamps guttered
 *   m3 the storm eased
 * so an entry can be keyed to a known distance back from now.
 */
const SECRET = 'The cellar was sealed from the inside, and only Sera knows why.';

/* --------------------------------------------------------------- delay */

test('a late revelation does not fire in a story too young for it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The cellar', keys: ['eased'], content: SECRET, delay: 10 }],
  });

  await turn(page, ollama, 'Go on.');
  // The keyword is right there in the last message. The story is four messages
  // long and this was asked to wait for ten.
  expect(systemOf(ollama)).not.toContain(SECRET);
});

test('and does fire once the story is long enough', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The cellar', keys: ['eased'], content: SECRET, delay: 2 }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

/* -------------------------------------------------------------- sticky */

test('a thread stays in the prompt between mentions', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [
      {
        id: 'l-1',
        name: 'The lamps',
        keys: ['lamps'],
        content: SECRET,
        // Only the newest message is scanned, and the lamps were two messages
        // back — so ordinary matching finds nothing.
        scanDepth: 1,
        sticky: 3,
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

test('and stops once it has been quiet long enough', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [
      {
        id: 'l-1',
        name: 'The lamps',
        keys: ['lamps'],
        content: SECRET,
        scanDepth: 1,
        // Two messages back, asked to last for one.
        sticky: 1,
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(SECRET);
});

/* ------------------------------------------------------------ cooldown */

test('a keyword that just fired rests instead of firing again', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The cellar', keys: ['eased'], content: SECRET, cooldown: 2 }],
  });

  await turn(page, ollama, 'Go on.');
  // "eased" arrived one message ago, so the entry fired then; it still matches
  // now, and is held back for the two messages it was asked to sit out.
  expect(systemOf(ollama)).not.toContain(SECRET);
});

test('a first mention fires, cooldown or not', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The lantern', keys: ['lantern'], content: SECRET, cooldown: 2 }],
  });

  // Nobody has said "lantern" before. A cooldown is a rest *after* firing;
  // an entry that has never fired has nothing to rest from. (This used to
  // count the mention that triggers it as the one to rest from, so any entry
  // with a cooldown could never fire on a fresh mention at all.)
  await turn(page, ollama, 'I lift the lantern.');
  expect(systemOf(ollama)).toContain(SECRET);
});

/*
 * A keyword said on most messages is the case cooldown exists for. The
 * fixture says "the" on m0, m2 and m3 and not on m1 or the new message, so
 * with a scan window that covers them all the entry is matched on every
 * step and the only question is the rhythm:
 *
 *   cooldown 1: fires m0 · rests m1 · fires m2 · rests m3 · fires now
 *   cooldown 2: fires m0 · rests m1, m2 · fires m3 · rests now
 */
test('a keyword said every message fires again once its cooldown has passed', async ({
  page,
}) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The article', keys: ['the'], content: SECRET, cooldown: 1 }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

test('and stays out while it has not', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The article', keys: ['the'], content: SECRET, cooldown: 2 }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).not.toContain(SECRET);
});

test('and with no cooldown the same entry arrives', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The cellar', keys: ['eased'], content: SECRET }],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

/* ------------------------------------------------- sticky and secondary */

test('stickiness never revives an entry that never qualified', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [
      {
        id: 'l-1',
        name: 'The lamps',
        keys: ['lamps'],
        // Nobody in the fixture is called Halda, so the primary keyword two
        // messages back was never enough on its own.
        secondaryKeys: ['Halda'],
        content: SECRET,
        scanDepth: 1,
        sticky: 3,
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // An entry that never fired has nothing to stay open from.
  expect(systemOf(ollama)).not.toContain(SECRET);
});

test('and does hold an entry whose secondary keyword was there', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [
      {
        id: 'l-1',
        name: 'The lamps',
        keys: ['lamps'],
        // Same message: "the lamps guttered".
        secondaryKeys: ['guttered'],
        content: SECRET,
        scanDepth: 1,
        sticky: 3,
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

/* ---------------------------------------------------------------- tester */

test('the tester judges a delayed entry on its words, and says so', async ({ page }) => {
  await mockOllama(page, ['Unused.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    lore: [{ id: 'l-1', name: 'The cellar', keys: ['eased'], content: SECRET, delay: 5 }],
  });

  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Tools' }).click();
  await page.getByRole('textbox', { name: 'Test text', exact: true }).fill('the storm eased');

  // Pasted text has no story length, so the tester cannot honestly say the
  // story is too young. It used to: one line of text counted as a story one
  // message long, and every entry with a delay was "held back" forever.
  await expect(page.getByText(/Keyword matched: eased/).first()).toBeVisible();
  await expect(page.getByText(/Held back/)).toHaveCount(0);
  await expect(page.getByText(/Delay is not applied here/)).toBeVisible();
});

/* ---------------------------------------------------------- branches */

test('a branch that never said the word has never triggered the entry', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'c',
    lore: [
      {
        id: 'l-1',
        name: 'The stranger',
        keys: ['stranger'],
        content: SECRET,
        scanDepth: 1,
        sticky: 5,
      },
    ],
  });

  // Branch C said "a stranger came in" two messages back, so stickiness holds
  // it open even though the newest message does not mention them.
  await turn(page, ollama, 'Go on.');
  expect(systemOf(ollama)).toContain(SECRET);
});

test('and its sibling, which never met them, does not', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.']);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, {
    activeBranchId: 'd',
    lore: [
      {
        id: 'l-1',
        name: 'The stranger',
        keys: ['stranger'],
        content: SECRET,
        scanDepth: 1,
        sticky: 5,
      },
    ],
  });

  await turn(page, ollama, 'Go on.');
  // D forked before the stranger arrived. Nothing to stay open about.
  expect(systemOf(ollama)).not.toContain(SECRET);
});

/* ------------------------------------------------------------- import */

test('a lorebook that carries these settings keeps them', async ({ page }) => {
  await mockOllama(page, ['Sera nods.']);
  await goto(page, '#/transfer');

  await page.locator('input[type=file]').first().setInputFiles({
    name: 'timing-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name: 'Imported timing book',
        entries: {
          '0': {
            key: ['rooftop'],
            content: 'The rooftop is where they go to be unheard.',
            delay: 5,
            sticky: 4,
            cooldown: 3,
          },
        },
      }),
    ),
  });
  await expect(page.getByText('Import preview — Lorebook')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();

  // These used to be dropped on the floor, so an imported book behaved
  // differently here for reasons nothing on screen explained.
  await expect
    .poll(async () => (await readStore<any>(page, 'loreEntries')).length, { timeout: 20_000 })
    .toBe(1);
  const [entry] = await readStore<any>(page, 'loreEntries');
  expect(entry.delay).toBe(5);
  expect(entry.sticky).toBe(4);
  expect(entry.cooldown).toBe(3);
});
