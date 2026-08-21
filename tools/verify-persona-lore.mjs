// Two focused checks the main audit does not cover:
//   1. Switching persona mid-story must not relabel messages already sent.
//   2. Lore must stay out of the request when its keyword is absent.
import { chromium } from '@playwright/test';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const results = [];
const record = (step, ok, note = '') => {
  results.push({ step, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

const sent = [];
await page.route('**/v1/models', (r) =>
  r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'audit/model-a' }] }),
  }),
);
await page.route('**/v1/chat/completions', (r) => {
  sent.push(r.request().postDataJSON());
  return r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Understood.' } }] }),
  });
});

const go = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(500);
};
const boot = async () => {
  await page.waitForSelector('#main', { timeout: 20000 });
  await page.waitForTimeout(500);
};

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(
  () => new Promise((resolve) => {
    localStorage.clear();
    const r = indexedDB.deleteDatabase('nexus-tavern-pro');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  }),
);
await page.reload();
await boot();

// Two personas, one character, one lorebook entry with a distinctive keyword.
async function makePersona(name) {
  await go('#/personas');
  await page.getByRole('button', { name: /^New$/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill(name);
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForTimeout(700);
}
await makePersona('Corin Ashe');
await makePersona('Wren Solace');

await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(500);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Seraphine');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(700);

await go('#/lorebooks');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(800);
await page.getByRole('tab', { name: 'Settings' }).click();
await page.waitForTimeout(300);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Ashfell Lore');
await page.getByRole('tab', { name: /Entries/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Add entry|New entry/i }).first().click();
await page.waitForTimeout(600);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Ashfell');
await page.getByRole('textbox', { name: 'Content', exact: true }).first()
  .fill('Ashfell is the grey city on a living volcano.');
const keys = page.getByRole('textbox', { name: 'Primary keywords', exact: true }).first();
await keys.fill('Ashfell');
await keys.press('Enter');
await page.waitForTimeout(200);
await page.locator('.sheet').last().getByRole('button', { name: /^Save/ }).first().click();
await page.waitForTimeout(800);

// Story with the first persona and the lorebook.
await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('The Long Storm');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Seraphine/ }).first().click();
await page.waitForTimeout(400);
await page.locator('select').first().selectOption({ label: 'Corin Ashe' }).catch(() => {});
await page.getByRole('tab', { name: /Lorebook/ }).click();
await page.waitForTimeout(300);
await page.getByRole('switch', { name: /Ashfell/ }).first().click();
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(900);

// Provider.
await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:9/v1');
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(1200);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);

// ---------------------------------------------------------------- chat
await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(900);

const firstChatHash = await page.evaluate(() => location.hash);
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('We ride for Ashfell.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2500);

// 1. Lore activates when its keyword is present.
const withKeyword = JSON.stringify(sent[sent.length - 1]);
record('lore reaches the request when its keyword is used',
  withKeyword.includes('grey city on a living volcano'));

// 2. And stays out of a conversation that never mentions it. This needs a
// fresh chat: the scanner reads recent history, so an earlier mention in the
// same conversation legitimately keeps the entry live.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /New chat in this story/ }).click();
await page.waitForTimeout(1600);
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('The weather is calm today.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2500);
const withoutKeyword = JSON.stringify(sent[sent.length - 1]);
record('lore is NOT injected into a chat that never mentions it',
  !withoutKeyword.includes('grey city on a living volcano'),
  'irrelevant lore must not be sent every turn');

// Back to the first conversation for the persona checks.
await go(firstChatHash.replace(/^#/, ''));
await page.waitForTimeout(1200);

// The message the first persona wrote, as displayed now.
const authorBefore = await page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'We ride for Ashfell.' }),
}).first().getAttribute('aria-label');
record('user message is attributed to the persona who wrote it',
  /Corin Ashe/.test(authorBefore ?? ''), authorBefore ?? '');

// 3. Switch persona from inside the chat, then re-check the old message.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
const changePersona = page.locator('.sheet').last()
  .getByRole('button', { name: /Change your persona/ }).first();
record('chat offers a persona switch', (await changePersona.count()) > 0);
await changePersona.click();
await page.waitForTimeout(500);
await page.locator('.sheet').last().getByRole('button', { name: /Wren Solace/ }).first().click();
await page.waitForTimeout(1200);

const authorAfter = await page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'We ride for Ashfell.' }),
}).first().getAttribute('aria-label');
record('switching persona does NOT relabel the older message',
  /Corin Ashe/.test(authorAfter ?? ''), authorAfter ?? '');

// A new message should use the new persona.
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A new voice speaks.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2500);
const newAuthor = await page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'A new voice speaks.' }),
}).first().getAttribute('aria-label');
record('a new message uses the newly selected persona',
  /Wren Solace/.test(newAuthor ?? ''), newAuthor ?? '');

// And it survives a reload.
await page.reload();
await boot();
const afterReload = await page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'We ride for Ashfell.' }),
}).first().getAttribute('aria-label');
record('attribution survives a reload', /Corin Ashe/.test(afterReload ?? ''), afterReload ?? '');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
