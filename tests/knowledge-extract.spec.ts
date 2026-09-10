/**
 * Noticing who came to know of what — and refusing to believe it.
 *
 * The extractor is handed a numbered list of things already in scope and one
 * exchange, and asked who gained access to which. Everything it returns is a
 * proposal: written down, shown in the inspector, and counted for nothing
 * until a person accepts it.
 *
 * What these tests can prove: the plumbing, the gates, the provenance, and
 * that a proposal is genuinely inert. What they cannot prove, and do not
 * claim to: that a model reads "Ryu hadn't been told" as a denial. The mock
 * answers whatever it is told to answer. Discrimination on those sentences is
 * the model's, and has to be judged against a real one.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  mockOllama,
  openContextInspector,
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

async function turn(page: Page, ollama: MockOllama, text: string) {
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  const before = ollama.requests.length;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 25_000 }).toBeGreaterThan(before);
}

function payloadOf(ollama: MockOllama): string {
  return JSON.stringify(ollama.requests.at(-1)?.body?.messages ?? []);
}

const edges = (page: Page) => readStore<any>(page, 'knowledgeEdges');
const ANNOTATE = { knowledgeMode: 'annotate' };
const SECRET = 'The cellar was sealed from the inside.';
/** The AI's reply — the sentence the attribution is read from. */
const TELLING = '"The cellar was sealed from the inside," Sera tells Corin, very quietly.';

function attribution(items: unknown[]): string {
  return JSON.stringify({ attributions: items });
}

const seed = {
  settings: ANNOTATE,
  memories: [{ id: 'mem-1', title: 'The cellar', content: SECRET }],
  relationships: [{ id: 'rel-1', betweenIds: ['sera', 'corin'] as [string, string], summary: 'Old friends.' }],
};

/* --------------------------------------------------------- what it asks */

test('the extractor is handed only what is in scope, and told what is not knowledge', async ({
  page,
}) => {
  const ollama = await mockOllama(page, [TELLING]);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, seed);

  await turn(page, ollama, 'Tell me.');
  await expect.poll(() => ollama.knowledge.length, { timeout: 20_000 }).toBe(1);

  const [request] = ollama.knowledge;
  const system: string = request.body.messages[0].content;
  const user: string = request.body.messages[1].content;

  // Subjects are numbered and offered — the model may point, never invent.
  expect(user).toContain('[M1] The cellar');
  expect(user).toContain('[R1] how Sera and Corin stand with each other');

  // And it is told, in so many words, which sentences are not attributions.
  // A model that ignores this is a model problem; a prompt that never said it
  // would be ours.
  for (const pattern of [
    "hadn't been told",
    'knew nothing about it',
    'lied to Ryu about the secret',
    'asked whether Sera knew',
    'already knew before this exchange',
  ]) {
    expect(system).toContain(pattern);
  }
});

test('tracking off never asks', async ({ page }) => {
  const ollama = await mockOllama(page, [TELLING]);
  await setupOllamaProvider(page);
  await seedBranchedStory(page, { ...seed, settings: {} });

  await turn(page, ollama, 'Tell me.');
  await page.waitForTimeout(700);
  expect(ollama.knowledge).toHaveLength(0);
  expect(await edges(page)).toHaveLength(0);
});

/* ----------------------------------------------------------- proposals */

test('what it notices is a proposal: written, shown, and counted for nothing', async ({
  page,
}) => {
  const ollama = await mockOllama(page, [TELLING, 'Sera nods.']);
  ollama.knowledgeReplies = [
    attribution([
      {
        who: 'Corin',
        subject: 'M1',
        basis: 'told',
        toldBy: 'Sera',
        confidence: 0.92,
        evidence: TELLING,
      },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, seed);

  await turn(page, ollama, 'Tell me.');
  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(1);

  const [row] = await edges(page);
  expect(row).toMatchObject({
    knowerId: 'corin',
    subject: { kind: 'memory', id: 'mem-1' },
    basis: 'told',
    toldById: 'sera',
    status: 'proposed',
    branchId: 'main',
  });
  // Provenance is the turn that carries the sentence, not the whole exchange.
  const messages = await readStore<any>(page, 'messages');
  const reply = messages.find((m: any) => m.content === TELLING);
  expect(row.sourceMessageIds).toEqual([reply.id]);

  // Shown for review, and not yet knowledge.
  await openContextInspector(page);
  await page.getByRole('tab', { name: 'Knowledge' }).click();
  await expect(page.getByText('Waiting for you')).toBeVisible();
  await expect(page.getByText(/Corin.*now knows of.*The cellar/)).toBeVisible();
  await expect(page.getByText(/Not tracked/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close context inspector' }).click();

  // And the next prompt says nothing about any of it.
  await turn(page, ollama, 'Go on.');
  expect(payloadOf(ollama)).not.toContain('knows of');
  expect(payloadOf(ollama)).not.toContain('told by');
});

test('accepting makes it knowledge; dismissing makes it nothing', async ({ page }) => {
  const ollama = await mockOllama(page, [TELLING]);
  ollama.knowledgeReplies = [
    attribution([
      { who: 'Corin', subject: 'M1', basis: 'told', toldBy: 'Sera', confidence: 0.9, evidence: TELLING },
      { who: 'Sera', subject: 'R1', basis: 'witnessed', toldBy: null, confidence: 0.8, evidence: TELLING },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, seed);

  await turn(page, ollama, 'Tell me.');
  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(2);

  await openContextInspector(page);
  await page.getByRole('tab', { name: 'Knowledge' }).click();
  await page.getByRole('button', { name: 'Accept: Corin knows of The cellar' }).click();
  await page
    .getByRole('button', { name: /Dismiss: Sera knows of how Sera and Corin stand/ })
    .click();

  await expect.poll(async () => (await edges(page)).length, { timeout: 20_000 }).toBe(1);
  expect((await edges(page))[0]).toMatchObject({ knowerId: 'corin', status: 'applied' });
  // Accepted, it is now on file — with the sentence the inspector shows for it.
  await expect(page.getByText(/told by Sera/)).toBeVisible();
  await expect(page.getByText('Waiting for you')).toHaveCount(0);
});

/* --------------------------------------------------------------- gates */

test('everything the model cannot back up is refused', async ({ page }) => {
  const ollama = await mockOllama(page, [TELLING]);
  ollama.knowledgeReplies = [
    attribution([
      // Kept: everything checks out.
      { who: 'Corin', subject: 'M1', basis: 'told', toldBy: 'Sera', confidence: 0.9, evidence: TELLING },
      // A person the story does not have.
      { who: 'Halda', subject: 'M1', basis: 'witnessed', toldBy: null, confidence: 0.9, evidence: TELLING },
      // A thing that was never offered: the model may not conjure a subject.
      { who: 'Corin', subject: 'M7', basis: 'witnessed', toldBy: null, confidence: 0.9, evidence: TELLING },
      // Bases that are never the model's to give.
      { who: 'Corin', subject: 'M1', basis: 'stated', toldBy: null, confidence: 0.9, evidence: TELLING },
      { who: 'Corin', subject: 'M1', basis: 'authored', toldBy: null, confidence: 0.9, evidence: TELLING },
      // A quotation that appears nowhere in the exchange.
      { who: 'Corin', subject: 'M1', basis: 'witnessed', toldBy: null, confidence: 0.9, evidence: 'Corin read it in the ledger.' },
      // Told by yourself is not being told.
      { who: 'Corin', subject: 'M1', basis: 'told', toldBy: 'Corin', confidence: 0.9, evidence: TELLING },
    ]),
  ];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, seed);

  await turn(page, ollama, 'Tell me.');
  await page.waitForTimeout(1200);
  const rows = await edges(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ knowerId: 'corin', basis: 'told', toldById: 'sera' });
});

test('a model that finds nothing writes nothing', async ({ page }) => {
  const ollama = await mockOllama(page, ['Sera says nothing at all.']);
  ollama.knowledgeReplies = [attribution([])];
  await setupOllamaProvider(page);
  await seedBranchedStory(page, seed);

  await turn(page, ollama, 'Well?');
  await expect.poll(() => ollama.knowledge.length, { timeout: 20_000 }).toBe(1);
  await page.waitForTimeout(500);
  expect(await edges(page)).toHaveLength(0);
});
