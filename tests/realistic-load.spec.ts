/**
 * The prompt under a realistic load.
 *
 * Every other test hands the compiler a small story where everything fits and
 * nothing has to be chosen. The one story that found four wrong choices in a
 * row was nothing like that: a scenario that was the whole previous
 * transcript and also the opening message, a character sheet with every
 * field filled, five imported lorebooks holding 280 entries — most placed
 * "before the character", the same entry several times over, one always-on
 * essay of five thousand tokens keyed to everyday words — and a budget a
 * quarter of what all that would cost.
 *
 * This seeds a synthetic story of that shape and holds the compiler to the
 * things that must be true whatever it has to sacrifice: the character being
 * played is described, the persona is described, the turn being answered and
 * the reply before it are there, nothing the inspector says was left out is
 * sent anyway, nothing is sent twice, and the total stays inside the budget.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  goto,
  mockAI,
  openContextInspector,
  resetDatabase,
  setupProvider,
  type MockProvider,
} from './helpers';
import { seedBranchedStory } from './branch-summary-fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/* ------------------------------------------------------------- the story */

const OPENING_TAIL = 'and the lantern guttered for the last time that night.';
const CARD_MARK = 'She keeps a ledger of every debt owed to the inn, in a hand nobody else can read.';
const PERSONA_MARK = 'Corin carries a letter he has never opened.';
const ESSAY_MARK = 'Standing is read from a hundred small signals, and honorifics follow it.';
const TWIN_MARK = 'The well behind the inn has been dry since the second winter.';
const DEEP_MARK = 'Let a pause stretch before anyone answers.';

/** Prose of roughly `tokens` tokens, built from ordinary words that lore keys on. */
function prose(tokens: number, seed: string): string {
  const sentences = [
    'The storm pressed on the door and the lamps guttered in their brackets.',
    'Sera counted the coins twice and said nothing about the stranger by the fire.',
    'Outside the inn the road had gone to mud and the night was long.',
    'Somebody laughed in the corner and the silence after it was worse.',
    `${seed} was the word nobody said aloud.`,
  ];
  const out: string[] = [];
  let length = 0;
  let i = 0;
  while (length < tokens * 3.8) {
    const s = sentences[i % sentences.length];
    out.push(s);
    length += s.length + 1;
    i += 1;
    if (i % 6 === 0) out.push('\n\n');
  }
  return out.join(' ');
}

async function seedRealisticStory(page: Page, settings: Record<string, unknown>) {
  await seedBranchedStory(page, { settings });

  const opening = `${prose(17000, 'Rain')}\n\n${OPENING_TAIL}`;
  const description = prose(3000, 'Debt');
  const card = {
    description: `${prose(500, 'Ledger')} ${CARD_MARK}`,
    appearance: prose(100, 'Grey'),
    personality: prose(400, 'Wry'),
    backstory: prose(300, 'Winter'),
    goals: 'Keep the inn through the storm.',
    fears: 'The cellar.',
    likes: 'Quiet mornings.',
    dislikes: 'Being owed money.',
    relationships: 'Corin: an old friend who drinks on credit.',
    speakingStyle: 'Short sentences, dry.',
  };

  await page.evaluate(
    async ({ opening, description, card, essay, twin, deep, fillers }) => {
      const filler = (i: number) => fillers[i % fillers.length];
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('nexus-tavern-pro');
        q.onsuccess = () => r(q.result);
      });
      const put = (store: string, value: unknown) =>
        new Promise<void>((res, rej) => {
          const q = db.transaction(store, 'readwrite').objectStore(store).put(value);
          q.onsuccess = () => res();
          q.onerror = () => rej(q.error);
        });
      const get = (store: string, id: string) =>
        new Promise<any>((r) => {
          const q = db.transaction(store, 'readonly').objectStore(store).get(id);
          q.onsuccess = () => r(q.result);
        });
      const now = Date.now();

      // The story: a long brief, and the transcript as its scenario too.
      const story = await get('stories', 'forked-story');
      await put('stories', {
        ...story,
        description,
        scenario: opening,
        rules: 'Nobody leaves the inn while the storm holds.',
      });

      // The character being played, every field filled.
      const sera = await get('characters', 'sera');
      await put('characters', { ...sera, ...card });

      // The persona.
      const corin = await get('personas', 'corin');
      await put('personas', { ...corin, backstory: 'Corin carries a letter he has never opened.' });

      // The transcript as the opening message, then eight short turns.
      const message = (id: string, order: number, content: string) => ({
        id,
        chatId: 'chat-1',
        branchId: 'main',
        role: order % 2 === 0 ? 'user' : 'assistant',
        characterId: order % 2 === 0 ? null : 'sera',
        content,
        attachments: [],
        order,
        model: '',
        tokens: 0,
        favorite: false,
        activeAlternativeId: null,
        createdAt: now + order,
        updatedAt: now + order,
      });
      // Order 5 is an assistant turn, as an opening is.
      await put('messages', message('m-opening', 5, opening));
      for (let order = 6; order <= 13; order += 1) {
        await put('messages', message(`m-turn-${order}`, order, `TURN-${order}: the storm went on and the lamps held.`));
      }

      // Five lorebooks, 280 entries, in the shape an import leaves behind.
      const book = (id: string, name: string) => ({
        id,
        name,
        description: '',
        enabled: true,
        tags: [],
        global: true,
        scanDepth: 0,
        createdAt: now,
        updatedAt: now,
      });
      const entry = (
        id: string,
        lorebookId: string,
        name: string,
        keys: string[],
        content: string,
        extra: Record<string, unknown> = {},
      ) => ({
        id,
        lorebookId,
        name,
        content,
        primaryKeys: keys,
        secondaryKeys: [],
        aliases: [],
        enabled: true,
        priority: 100,
        position: 'before-character',
        depth: 4,
        scanDepth: 0,
        delay: 0,
        sticky: 0,
        cooldown: 0,
        matchMode: 'word-boundary',
        caseSensitive: false,
        activation: 'keyword',
        category: '',
        scope: 'any',
        comment: '',
        customFields: [],
        order: 0,
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
      for (let b = 1; b <= 5; b += 1) await put('lorebooks', book(`book-${b}`, `Imported book ${b}`));

      // One always-on essay of five thousand tokens, placed before the character.
      await put('loreEntries', entry('l-essay', 'book-1', 'Etiquette', ['zzz'], essay, { activation: 'always' }));
      // Ten more always-on rules, modest.
      for (let i = 0; i < 10; i += 1) {
        await put('loreEntries', entry(`l-always-${i}`, 'book-1', `Rule ${i}`, ['zzz'], `${filler(i)} Rule ${i}.`, { activation: 'always' }));
      }
      // The same entry three times over, ten times.
      for (let g = 0; g < 10; g += 1) {
        for (let c = 0; c < 3; c += 1) {
          await put('loreEntries', entry(`l-twin-${g}-${c}`, 'book-2', `The well ${g}`, ['storm', 'inn'], `${twin} (${g})`));
        }
      }
      // Twenty rules injected into the conversation.
      for (let i = 0; i < 20; i += 1) {
        await put('loreEntries', entry(`l-deep-${i}`, 'book-3', `Pacing ${i}`, ['storm', 'lamps', 'silence'], `${deep} (${i})`, { position: 'at-depth', depth: 4 }));
      }
      // Two hundred and nineteen ordinary entries keyed to everyday words, a
      // few dozen of which fire on any given turn.
      const words = ['storm', 'door', 'lamps', 'coins', 'stranger', 'fire', 'road', 'mud', 'night', 'corner', 'silence', 'inn'];
      for (let i = 0; i < 219; i += 1) {
        const key = i < 40 ? words[i % words.length] : `unlikely${i}`;
        await put('loreEntries', entry(`l-ordinary-${i}`, `book-${(i % 3) + 3}`, `Entry ${i}`, [key], `${filler(i)} Entry ${i}.`, { position: i % 4 === 0 ? 'after-character' : 'before-character' }));
      }
      db.close();
    },
    {
      opening,
      description,
      card,
      essay: `${prose(5000, 'Honorific')} ${ESSAY_MARK}`,
      twin: TWIN_MARK,
      deep: DEEP_MARK,
      // Built here: a function cannot cross into the page.
      fillers: Array.from({ length: 12 }, (_, i) => prose(150 + i * 40, `Filler${i}`)),
    },
  );

  await page.reload();
  await boot(page);
  await goto(page, '#/chat/chat-1');
}

/* ------------------------------------------------------------ the checks */

/** "18.7k" → 18700, "455" → 455. The inspector rounds; the check only needs the order. */
function tokensOf(text: string): number {
  const m = /^([\d.,]+)(k?)$/i.exec(text.trim());
  if (!m) return NaN;
  const n = Number(m[1].replace(',', '.'));
  return m[2] ? Math.round(n * 1000) : n;
}

async function inspect(page: Page) {
  await openContextInspector(page);
  const meter = await page.getByText(/^\S+ \/ \S+ tokens$/).first().innerText();
  const [used, budget] = meter.replace(/ tokens$/, '').split(' / ').map(tokensOf);
  const included = await page.locator('.ctx-part-head').allInnerTexts();
  await page.getByRole('tab', { name: /Excluded/ }).click();
  const excluded = await page.locator('.ctx-part').allInnerTexts();
  await page.getByRole('button', { name: 'Close context inspector' }).click();
  return { used, budget, included, excluded };
}

async function sendTurn(page: Page, ai: MockProvider) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable({ timeout: 20_000 });
  await composer.fill('TURN-14: I set the coins on the bar.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ai.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const messages = ai.requests.at(-1)!.body.messages as Array<{ role: string; content: string }>;
  return { messages, text: JSON.stringify(messages) };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** What must hold whatever the budget. */
async function assertInvariants(page: Page, ai: MockProvider) {
  const before = await inspect(page);
  const { messages, text } = await sendTurn(page, ai);

  // The person being played, and the person playing.
  expect(text).toContain(CARD_MARK);
  expect(text).toContain('Being owed money');
  expect(text).toContain(PERSONA_MARK);

  // The turn being answered and the exchange before it, verbatim.
  expect(text).toContain('TURN-14: I set the coins on the bar.');
  expect(text).toContain('TURN-13: the storm went on');
  expect(text).toContain('TURN-12: the storm went on');

  // Nothing sent twice: the scenario is the opening message, and each group
  // of three identical entries is one entry — ten groups, ten at most.
  expect(count(text, OPENING_TAIL)).toBeLessThanOrEqual(1);
  expect(count(text, TWIN_MARK)).toBeLessThanOrEqual(10);

  // Nothing the inspector said was left out is sent anyway. Every dropped
  // lore entry is named; its text carries its own name in the heading.
  for (const row of before.excluded) {
    const name = /^Lore — (.+?) \(/.exec(row)?.[1];
    if (name && /dropped: context budget exceeded/.test(row)) {
      expect(text).not.toContain(`## ${name}\n`);
    }
  }
  // The rules injected into the conversation are exactly the ones the
  // inspector lists as included: no more, no fewer.
  const injected = messages.filter((m) => m.role === 'system' && m.content.includes(DEEP_MARK));
  const includedDeep = before.included.filter((r) => /Lore — Pacing/.test(r)).length;
  expect(injected.length).toBe(includedDeep);

  // And the whole thing stays inside what was allowed. The inspector rounds
  // to the nearest hundred, so the check allows for that.
  expect(Number.isFinite(before.used) && Number.isFinite(before.budget)).toBe(true);
  expect(before.used).toBeLessThanOrEqual(before.budget + 100);

  return { before, text };
}

test('under the default budget, the character survives and the essay does not', async ({
  page,
}) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedRealisticStory(page, {});

  const { before, text } = await assertInvariants(page, ai);
  // The five-thousand-token essay placed before the character is what goes,
  // not the character.
  expect(text).not.toContain(ESSAY_MARK);
  expect(before.excluded.some((r) => /Lore — Etiquette/.test(r) && /dropped/.test(r))).toBe(true);
  // The opening was cut to its end rather than dropped or sent whole.
  expect(text).toContain(OPENING_TAIL);
  expect(text).toContain('earlier part of this message omitted');
});

test('with room for everything, everything is sent once', async ({ page }) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  // Room on every dial, the entry limit included.
  await seedRealisticStory(page, { contextBudget: 131072, maxPromptTokens: 98304, maxLoreEntries: 200 });

  const { text } = await assertInvariants(page, ai);
  // The always-on essay is there. It used to be cut by the entry limit on
  // every turn, whatever the budget: an entry that matched nothing sorted as
  // least relevant, and sixty keyword hits filled the limit ahead of it.
  expect(text).toContain(ESSAY_MARK);
  expect(count(text, '## Rule ')).toBe(10);
  expect(text).not.toContain('earlier part of this message omitted');
  expect(count(text, OPENING_TAIL)).toBe(1);
  // Thirty entries, ten different texts: ten sent.
  expect(count(text, TWIN_MARK)).toBe(10);
});
