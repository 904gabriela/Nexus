/**
 * The memory matrix.
 *
 * Two things are being asserted here, and they are the two that make automatic
 * memory safe to leave on:
 *
 *   1. A memory the extractor was not sure about is saved but *not used*. It
 *      reaches nothing until a person accepts it. The failure this prevents is
 *      the story quietly building on something the model made up.
 *   2. A claim and an observation stay distinguishable all the way into the
 *      prompt. A character's cover story must not harden into fact just
 *      because it got written down.
 *
 * Plus the usual obligation: memories saved before any of this existed keep
 * working exactly as they did.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  field,
  goto,
  mockOllama,
  readStore,
  resetDatabase,
  seedFixtures,
  setupOllamaProvider,
  sheetAction,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/** Writes memories straight to the store, as an existing install would hold them. */
async function seedMemories(page: Page, memories: Record<string, unknown>[]) {
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const now = Date.now();
    for (const row of rows) {
      await new Promise<void>((r) => {
        const q = db
          .transaction('memories', 'readwrite')
          .objectStore('memories')
          .put({
            origin: 'auto',
            category: 'Event',
            importance: 'normal',
            pinned: false,
            sourceMessageIds: [],
            sourceChatId: null,
            sourceStoryId: 's1',
            characterIds: [],
            tags: [],
            createdAt: now,
            updatedAt: now,
            ...row,
          });
        q.onsuccess = () => r();
      });
    }
    db.close();
  }, memories);
  await page.reload();
  await boot(page);
}

/**
 * Turns automatic memory on for every reply.
 *
 * Settings live in IndexedDB, and the toggle only reveals the interval field
 * once it is on, so writing the pair together is both simpler and less brittle
 * than driving two dependent controls.
 */
async function enableAutoMemoryEveryTurn(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const settings: any = await new Promise((r) => {
      const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      q.onsuccess = () => r(q.result);
    });
    settings.autoMemory = true;
    settings.autoMemoryEvery = 1;
    await new Promise<void>((r) => {
      const q = db.transaction('settings', 'readwrite').objectStore('settings').put(settings);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);
}

async function sendTurn(page: Page, ollama: { requests: unknown[] }, text: string) {
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 40_000 }).toBeGreaterThan(before);
  return (ollama.requests as any[]).at(-1)!.body;
}

function systemOf(body: any): string {
  return body.messages.find((m: any) => m.role === 'system').content;
}

test('a memory waiting for review is saved but never sent', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await seedMemories(page, [
    {
      id: 'm-proposed',
      title: 'The sealed cellar',
      content: 'Sera sealed the cellar herself the night the storm began.',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'inferred',
      confidence: 0.4,
      status: 'proposed',
    },
    {
      id: 'm-active',
      title: 'Credit at the bar',
      content: 'Sera has been letting Corin drink on credit for a year.',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'observed',
      confidence: 0.95,
      status: 'active',
    },
  ]);

  const system = systemOf(await sendTurn(page, ollama, 'Quiet tonight.'));

  // The accepted one is in the prompt; the proposal is not, however relevant
  // it looks. Being unsure is only meaningful if it changes what is sent.
  expect(system).toContain('letting Corin drink on credit');
  expect(system).not.toContain('sealed the cellar herself');
});

test('accepting a proposal is what puts it into the prompt', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await seedMemories(page, [
    {
      id: 'm-proposed',
      title: 'The sealed cellar',
      content: 'Sera sealed the cellar herself the night the storm began.',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'inferred',
      confidence: 0.4,
      status: 'proposed',
    },
  ]);

  await goto(page, '#/memories');
  await page.getByRole('button', { name: /Needs review \(1\)/ }).click();
  await expect(page.getByText('The sealed cellar')).toBeVisible();

  await page.getByRole('button', { name: /Actions for The sealed cellar/ }).click();
  await sheetAction(page, /^Accept/);
  await expect(page.getByText('Memory accepted')).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => (await readStore<any>(page, 'memories'))[0].status, { timeout: 15_000 })
    .toBe('active');

  const system = systemOf(await sendTurn(page, ollama, 'Quiet tonight.'));
  expect(system).toContain('sealed the cellar herself');
});

test('what a character claimed is sent as a claim, not as a fact', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await seedMemories(page, [
    {
      id: 'm-claim',
      title: 'No family left',
      content: 'Sera has no family living.',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'stated',
      statedById: 'c1',
      confidence: 0.9,
      status: 'active',
    },
  ]);

  const system = systemOf(await sendTurn(page, ollama, 'Quiet tonight.'));

  // The fact is there, and so is the fact that it is only her word for it. A
  // character who lies is a normal thing for a story to contain, and the model
  // cannot play that if the prompt has already decided the lie is true.
  expect(system).toContain('Sera has no family living.');
  expect(system).toMatch(/claimed by Sera; may not be true/);
});

test('accepting a replacement retires the old memory instead of deleting it', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await seedMemories(page, [
    {
      id: 'm-old',
      title: 'Sera drinks tea',
      content: 'Sera drinks tea in the evenings and never touches the ale.',
      category: 'Preference',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'observed',
      confidence: 1,
      status: 'active',
    },
    {
      id: 'm-new',
      title: 'Sera drinks ale now',
      content: 'Sera drinks ale in the evenings and has stopped touching the tea.',
      category: 'Preference',
      subjects: ['Sera'],
      characterIds: ['c1'],
      basis: 'observed',
      confidence: 0.6,
      status: 'proposed',
      supersedes: ['m-old'],
    },
  ]);

  await goto(page, '#/memories');
  await page.getByRole('button', { name: /Needs review \(1\)/ }).click();
  await page.getByRole('button', { name: /Actions for Sera drinks ale now/ }).click();
  await sheetAction(page, /^Accept/);
  await expect(page.getByText('Memory accepted')).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(
      async () => {
        const rows = await readStore<any>(page, 'memories');
        return rows.find((m) => m.id === 'm-old')?.status;
      },
      { timeout: 15_000 },
    )
    .toBe('superseded');

  // Retired, not destroyed: it is still the record of what the story believed
  // at the time, and it is still there to look at.
  const rows = await readStore<any>(page, 'memories');
  expect(rows.find((m) => m.id === 'm-old')).toBeTruthy();
  expect(rows.find((m) => m.id === 'm-new').status).toBe('active');

  const system = systemOf(await sendTurn(page, ollama, 'Quiet tonight.'));
  expect(system).toContain('drinks ale in the evenings');
  expect(system).not.toContain('drinks tea in the evenings');
});

test('a memory saved before any of this existed is still used', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // Exactly the shape an existing install holds: no basis, no status, no
  // subjects, no confidence. Reading through any of them would drop it.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const now = Date.now();
    await new Promise<void>((r) => {
      const q = db.transaction('memories', 'readwrite').objectStore('memories').put({
        id: 'm-legacy',
        origin: 'manual',
        title: 'The storm',
        content: 'The storm has been going for three days and the roads are shut.',
        category: 'Event',
        importance: 'normal',
        pinned: false,
        sourceMessageIds: [],
        sourceChatId: null,
        sourceStoryId: 's1',
        characterIds: [],
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);

  const system = systemOf(await sendTurn(page, ollama, 'Quiet tonight.'));
  expect(system).toContain('going for three days and the roads are shut');
  // And it is stated flatly, because nothing about it was a claim or a guess.
  expect(system).not.toMatch(/claimed|inferred/);

  // The list shows it too, without a review badge it never asked for.
  await goto(page, '#/memories');
  await expect(page.getByText('The storm').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Needs review \(/ })).toHaveCount(0);
});

test('a subject the user names pulls its memory in', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  await seedFixtures(page);

  const noise = Array.from({ length: 30 }, (_, i) => ({
    id: `noise-${i}`,
    title: `Market day ${i}`,
    content: `Something unremarkable happened on market day ${i}.`,
    importance: 'high',
    status: 'active',
    updatedAt: Date.now() + 1000 + i,
  }));

  await seedMemories(page, [
    ...noise,
    {
      id: 'm-subject',
      // Nothing in the title or tags says "Halda"; only the subject does. The
      // subject is the matrix's most useful output for retrieval, because it
      // names who a memory is about even when no character record exists.
      title: 'An old debt',
      content: 'A debt from before the storm was never settled.',
      subjects: ['Halda'],
      importance: 'low',
      status: 'active',
      updatedAt: Date.now() - 900_000,
    },
  ]);

  const system = systemOf(await sendTurn(page, ollama, 'Has Halda come through yet?'));
  expect(system).toContain('A debt from before the storm was never settled.');
});

test('extraction commits what it saw and holds back what it concluded', async ({ page }) => {
  // The first reply is the roleplay turn; the second is the extractor's answer.
  const ollama = await mockOllama(
    page,
    [
      'Sera sets down the glass. "I promise you," she says, "the cellar stays shut."',
      JSON.stringify([
        {
          title: 'Sera promised the cellar stays shut',
          content: 'Sera promised Corin that the cellar would stay sealed.',
          category: 'Event',
          subjects: ['Sera', 'Corin'],
          basis: 'observed',
          confidence: 0.95,
          importance: 'high',
          relationship: { between: ['Sera', 'Corin'], change: 'A promise made and not yet tested.' },
        },
        {
          title: 'Sera is frightened of the cellar',
          content: 'Sera is frightened of whatever is behind the cellar door.',
          category: 'Character',
          subjects: ['Sera'],
          basis: 'inferred',
          confidence: 0.9,
          importance: 'normal',
          relationship: null,
        },
        {
          title: 'The cellar was sealed by the last owner',
          content: 'The cellar was sealed by the previous owner, not by Sera.',
          category: 'World',
          subjects: ['Sera'],
          basis: 'stated',
          statedBy: 'Sera',
          confidence: 0.9,
          importance: 'normal',
          relationship: null,
        },
      ]),
      'Sera says it again, quieter.',
      '[]',
    ],
    8192,
  );
  await setupOllamaProvider(page);
  await seedFixtures(page);

  // Automatic memory, every turn, so one exchange is enough to see it work.
  await enableAutoMemoryEveryTurn(page);

  await sendTurn(page, ollama, 'Promise me you will not open it again.');

  await expect
    .poll(async () => (await readStore<any>(page, 'memories')).length, { timeout: 40_000 })
    .toBe(3);

  const rows = await readStore<any>(page, 'memories');
  const observed = rows.find((m) => m.basis === 'observed');
  const inferred = rows.find((m) => m.basis === 'inferred');
  const stated = rows.find((m) => m.basis === 'stated');

  // Seen and confident: it commits unattended.
  expect(observed.status).toBe('active');
  expect(observed.subjects).toEqual(['Sera', 'Corin']);
  // Concluded, however confident it says it is: a person decides.
  expect(inferred.status).toBe('proposed');
  // Her word for it is worth recording, and it is recorded as her word: the
  // claimant is resolved from the name the extractor gave, not guessed from
  // whichever turn happens to be last.
  expect(stated.status).toBe('active');
  expect(stated.statedById).toBe('c1');

  /*
   * And the beat that moved two people is recorded beside the story rather
   * than into it.
   *
   * This assertion used to read `story.relationships[0].summary`, because the
   * extractor used to write there. It no longer does, and that is the point of
   * the change rather than a gap in it: folding a conclusion into the author's
   * own array made derived knowledge indistinguishable from authored
   * knowledge, carried it onto branches that never lived through it, and left
   * no way to take it back. The row below is the same conclusion, with the
   * turns it was read from attached — and the effective standing it produces
   * is asserted straight after, so the change is still checked end to end.
   */
  await expect
    .poll(async () => (await readStore<any>(page, 'relationshipDeltas')).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const [impact] = await readStore<any>(page, 'relationshipDeltas');
  expect(impact.change).toBe('A promise made and not yet tested.');
  // Committed memory, so the change is in force rather than waiting.
  expect(impact.status).toBe('applied');
  expect([...impact.betweenIds].sort()).toEqual(['c1', 'p1']);
  expect(impact.sourceMemoryId).toBe(observed.id);
  expect(impact.sourceMessageIds.length).toBeGreaterThan(0);
  // Carried from the memory, so how the claim was arrived at survives with it.
  expect(impact.basis).toBe('observed');

  // The author's record is untouched.
  const story = (await readStore<any>(page, 'stories'))[0];
  expect(story.relationships ?? []).toEqual([]);

  // And resolution puts it back together: the next prompt says where they now
  // stand, with the words the extractor used.
  const next = systemOf(await sendTurn(page, ollama, 'Say it again.'));
  expect(next).toContain('## How they stand');
  expect(next).toContain('A promise made and not yet tested.');
});

test('extraction never overwrites a relationship someone wrote by hand', async ({ page }) => {
  const ollama = await mockOllama(
    page,
    [
      'Sera sets down the glass. "I promise you," she says, "the cellar stays shut."',
      JSON.stringify([
        {
          title: 'A promise',
          content: 'Sera promised Corin the cellar would stay sealed.',
          category: 'Event',
          subjects: ['Sera', 'Corin'],
          basis: 'observed',
          confidence: 0.95,
          importance: 'high',
          relationship: { between: ['Sera', 'Corin'], change: 'A promise made and not yet tested.' },
        },
      ]),
    ],
    8192,
  );
  await setupOllamaProvider(page);
  await seedFixtures(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'Cast' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await field(page, 'Where they stand now').fill(
    'She has been letting them drink on credit for a year.',
  );
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  await enableAutoMemoryEveryTurn(page);

  await sendTurn(page, ollama, 'Promise me you will not open it again.');

  await expect
    .poll(async () => (await readStore<any>(page, 'memories')).length, { timeout: 40_000 })
    .toBe(1);

  // `manual` means a person settled it. An extractor writing over that is
  // exactly what makes automatic systems untrustworthy.
  const story = (await readStore<any>(page, 'stories'))[0];
  expect(story.relationships).toHaveLength(1);
  expect(story.relationships[0].summary).toBe(
    'She has been letting them drink on credit for a year.',
  );
});

/* ================================================ automatic character discovery */

test('a person the story names is offered to the cast, not added to it', async ({ page }) => {
  const ollama = await mockOllama(
    page,
    [
      'Sera sets down the glass. "Halda will not come through in this," she says.',
      JSON.stringify({
        changes: [
          {
            title: 'The road is shut',
            content: 'The caravan road is shut until the storm passes.',
            category: 'World',
            subjects: ['Sera'],
            basis: 'observed',
            confidence: 0.9,
            importance: 'normal',
            relationship: null,
          },
        ],
        newPeople: [
          { name: 'Halda', note: 'The caravan master, expected through the pass.' },
          // Neither of these is a person, and both are what a model reaches
          // for when it feels obliged to fill the list.
          { name: 'Narrator', note: 'The narrator.' },
          { name: 'Sera', note: 'The innkeeper.' },
        ],
      }),
    ],
    8192,
  );
  await setupOllamaProvider(page);
  await seedFixtures(page);
  await enableAutoMemoryEveryTurn(page);

  await sendTurn(page, ollama, 'Promise me the road stays open.');

  await expect
    .poll(
      async () => (await readStore<any>(page, 'stories'))[0].discovered?.length ?? 0,
      { timeout: 40_000 },
    )
    .toBe(1);

  const story = (await readStore<any>(page, 'stories'))[0];
  expect(story.discovered[0].name).toBe('Halda');
  expect(story.discovered[0].dismissed).toBe(false);
  // Discovering is not creating: the library is untouched until someone says so.
  const characters = await readStore<any>(page, 'characters');
  expect(characters.map((c: any) => c.name)).toEqual(['Sera']);

  // And it is offered where the cast is decided.
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: 'Cast' }).click();
  await expect(page.getByText('Named in the story')).toBeVisible();
  await expect(page.getByText('The caravan master, expected through the pass.')).toBeVisible();

  await page.getByRole('button', { name: 'Add to cast' }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => (await readStore<any>(page, 'characters')).length, { timeout: 15_000 })
    .toBe(2);
  const after = (await readStore<any>(page, 'stories'))[0];
  expect(after.discovered).toHaveLength(0);
  expect(after.characters).toHaveLength(2);
});

test('someone already dismissed is not offered again', async ({ page }) => {
  const ollama = await mockOllama(
    page,
    [
      'Sera shrugs. "Halda knows the road."',
      JSON.stringify({
        changes: [],
        newPeople: [{ name: 'Halda', note: 'The caravan master.' }],
      }),
    ],
    8192,
  );
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
    story.discovered = [
      {
        id: 'disc-halda',
        name: 'Halda',
        note: 'The caravan master.',
        sourceMessageIds: [],
        dismissed: true,
        updatedAt: Date.now(),
      },
    ];
    await new Promise<void>((r) => {
      const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
      q.onsuccess = () => r();
    });
    db.close();
  });
  await page.reload();
  await boot(page);
  await enableAutoMemoryEveryTurn(page);

  await sendTurn(page, ollama, 'Promise me the road stays open.');

  // Give the upkeep pass time to run before concluding nothing was added.
  await page.waitForTimeout(4000);
  const story = (await readStore<any>(page, 'stories'))[0];
  expect(story.discovered).toHaveLength(1);
  expect(story.discovered[0].dismissed).toBe(true);
});
