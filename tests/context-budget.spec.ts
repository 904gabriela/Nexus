/**
 * What the prompt is allowed to cost, and what Nexus says about it.
 *
 * Three numbers decide the budget: the configured context size, the model's
 * own window (known only when Ollama reports it), and a practical ceiling on
 * prompt size. These tests pin down that the warning about them says only
 * what is known, and that the ceiling can be raised for the one case that
 * needs it — a story that begins with a long pasted transcript.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  bubble,
  goto,
  mockAI,
  mockOllama,
  numberField,
  openContextInspector,
  resetDatabase,
  setupOllamaProvider,
  setupProvider,
} from './helpers';
import { seedBranchedStory } from './branch-summary-fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

async function send(page: Page, text: string) {
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

/* ------------------------------------------------------------- warnings */

test('a remote provider is not warned every turn about a window nobody measured', async ({
  page,
}) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page);

  await send(page, 'Go on.');
  await expect(bubble(page, 'A reply.')).toBeVisible({ timeout: 20_000 });
  // The default context size and a remote model whose window Nexus never
  // measured. This used to warn on every message that the model "can hold
  // 8,192" — a figure Nexus had simply been told, echoed back as a fact.
  await expect(page.getByText(/Prompt built to/)).toHaveCount(0);
});

test('a window the model did report is named as reported', async ({ page }) => {
  await mockOllama(page, ['Sera nods.'], 8192);
  await setupOllamaProvider(page);
  // Asked for four times what the model says it holds.
  await seedBranchedStory(page, { settings: { contextBudget: 32768 } });

  await send(page, 'Go on.');
  await expect(page.getByText(/Prompt built to/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/reports it can hold 8,192/)).toBeVisible();
});

/* -------------------------------------------------------- prompt budget */

/**
 * One enormous assistant turn, as a story continued from a pasted transcript
 * arrives — and, when asked, the one-line reply the player then sends.
 */
async function seedLongOpening(page: Page, options: { answered: boolean }) {
  await page.evaluate(async (answered) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('nexus-tavern-pro');
      q.onsuccess = () => r(q.result);
    });
    const paragraph =
      'The evening drew on and the lamps were lit one by one, and Sera counted the ' +
      'coins on the bar twice before she was satisfied that the night had paid for itself.\n\n';
    // Roughly twenty thousand tokens: past the practical ceiling, well inside
    // a large context size.
    const content = paragraph.repeat(420);
    const now = Date.now();
    const put = (value: unknown) =>
      new Promise<void>((r) => {
        const q = db.transaction('messages', 'readwrite').objectStore('messages').put(value);
        q.onsuccess = () => r();
      });
    const base = {
      chatId: 'chat-1',
      branchId: 'main',
      attachments: [],
      model: '',
      tokens: 0,
      favorite: false,
      activeAlternativeId: null,
    };
    await put({
      ...base,
      id: 'm-long',
      role: 'assistant',
      characterId: 'sera',
      content,
      order: 4,
      createdAt: now + 4,
      updatedAt: now + 4,
    });
    if (answered) {
      await put({
        ...base,
        id: 'm-answer',
        role: 'user',
        characterId: null,
        content: 'Go on.',
        order: 5,
        createdAt: now + 5,
        updatedAt: now + 5,
      });
    }
    db.close();
  }, options.answered);
  await page.reload();
  await boot(page);
  await goto(page, '#/chat/chat-1');
}

const CUT = 'Only the end of this message fitted the context budget.';
const OMITTED = 'earlier part of this message omitted';

test('the global Context size governs the turn itself, not only the preview', async ({ page }) => {
  const ai = await mockAI(page, ['A reply.']);
  await setupProvider(page);
  // Room for the whole transcript, on both dials.
  await seedBranchedStory(page, { settings: { contextBudget: 65536, maxPromptTokens: 65536 } });
  await seedLongOpening(page, { answered: false });

  await send(page, 'Go on.');
  await expect.poll(() => ai.requests.length, { timeout: 25_000 }).toBeGreaterThan(0);
  // The turn used to be built to a default of 8,192 whatever Settings said,
  // because the merged generation settings always carried that default and
  // it was read before the global figure. The preview honoured the setting;
  // the prompt actually sent did not.
  const payload = JSON.stringify(ai.requests.at(-1)?.body?.messages ?? []);
  expect(payload).not.toContain(OMITTED);
  expect(payload).toContain('paid for itself');
});

test('a transcript with nothing after it yet is cut to its end, not sent over budget', async ({
  page,
}) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  await seedBranchedStory(page, { settings: { contextBudget: 65536 } });
  await seedLongOpening(page, { answered: false });

  // The newest message used to be kept whole whatever it cost, so this chat
  // opened with a prompt half again the size of its budget.
  await openContextInspector(page);
  await page.getByRole('tab', { name: /Excluded/ }).click();
  await expect(page.getByText(CUT)).toBeVisible();
  await expect(page.getByText(/Context is over budget/)).toHaveCount(0);
});

test('a long opening is cut to its end under the practical ceiling, and fits whole once it is raised', async ({
  page,
}) => {
  await mockAI(page, ['A reply.']);
  await setupProvider(page);
  // A context size that would hold the whole thing. The ceiling is what cuts it.
  await seedBranchedStory(page, { settings: { contextBudget: 65536 } });
  await seedLongOpening(page, { answered: true });

  await openContextInspector(page);
  await page.getByRole('tab', { name: /Excluded/ }).click();
  await expect(page.getByText(CUT)).toBeVisible();
  await page.getByRole('button', { name: 'Close context inspector' }).click();

  // The ceiling is a setting, so a story that needs more can have it. This
  // field did not exist: the warning told people to change "Prompt budget"
  // in Settings, and there was nothing there to change.
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Context' }).click();
  await numberField(page, 'Prompt budget (tokens)').fill('65536');
  await expect
    .poll(async () => {
      const rows = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((r) => {
          const q = indexedDB.open('nexus-tavern-pro');
          q.onsuccess = () => r(q.result);
        });
        const value = await new Promise<any>((r) => {
          const q = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
          q.onsuccess = () => r(q.result);
        });
        db.close();
        return value;
      });
      return rows.maxPromptTokens;
    })
    .toBe(65536);

  await goto(page, '#/chat/chat-1');
  await openContextInspector(page);
  await page.getByRole('tab', { name: /Excluded/ }).click();
  await expect(page.getByText(CUT)).toHaveCount(0);
});
