// Data-integrity checks for the parts of the model that are easy to corrupt:
// alternatives, branching from a specific alternative, checkpoints, and
// whether messages leak between chats of the same story.
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
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})).newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

let reply = 0;
const REPLIES = ['Response one.', 'Response two.', 'Response three.', 'Response four.'];
await page.route('**/v1/models', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'audit/model-a' }] }) }));
await page.route('**/v1/chat/completions', (r) =>
  r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: REPLIES[Math.min(reply++, 3)] } }],
    }),
  }));

const go = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(500);
};
const boot = async () => {
  await page.waitForSelector('#main', { timeout: 20000 });
  await page.waitForTimeout(500);
};
const read = (store) => page.evaluate((s) => new Promise((res) => {
  const r = indexedDB.open('nexus-tavern-pro');
  r.onsuccess = () => {
    const db = r.result;
    const g = db.transaction(s, 'readonly').objectStore(s).getAll();
    g.onsuccess = () => { res(g.result); db.close(); };
  };
}), store);
const send = async (text) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(2200);
};
const menuFor = async (text) => {
  await page.locator('.msg').filter({
    has: page.locator('[data-testid="message-bubble"]').filter({ hasText: text }),
  }).first().getByRole('button', { name: 'More message actions' }).click();
  await page.waitForTimeout(400);
};
const sheetBtn = (name) =>
  page.locator('.sheet').last().getByRole('button', { name }).first();

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await boot();

// Minimal library through the UI.
await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(500);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Sera');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(700);

await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('Integrity');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(400);
await sheetBtn(/Sera/).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(900);

await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:9/v1');
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(1200);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);

await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(900);
const chatA = await page.evaluate(() => location.hash);

/* ===================================================== H. ALTERNATIVES */
console.log('\n--- alternatives ---');
await send('Message A.');   // -> Response one.
await menuFor('Response one.');
await sheetBtn(/Generate an alternative/).click();
await page.waitForTimeout(2600);
await menuFor('Response two.');
await sheetBtn(/Generate an alternative/).click();
await page.waitForTimeout(2600);

const navText = await page.locator('.alt-nav').first().innerText();
record('three responses are navigable', /3\s*\/\s*3/.test(navText.replace(/\n/g, ' ')),
  navText.replace(/\n/g, ' '));
record('two alternatives stored', (await read('messageAlternatives')).length === 2);

// Step back to response 2 and confirm the selection persists.
await page.getByRole('button', { name: 'Previous response' }).first().click();
await page.waitForTimeout(700);
const midText = await page.locator('.alt-nav').first().innerText();
record('can step back to 2 / 3', /2\s*\/\s*3/.test(midText.replace(/\n/g, ' ')));
await page.reload();
await boot();
const afterReload = await page.locator('.alt-nav').first().innerText();
record('the selected alternative survives reload', /2\s*\/\s*3/.test(afterReload.replace(/\n/g, ' ')),
  afterReload.replace(/\n/g, ' '));

// Branch from the message while alternative 2 is showing.
const shownBefore = await page.locator('[data-testid="message-bubble"][data-role="assistant"]')
  .last().innerText();
await menuFor(shownBefore.slice(0, 20));
await sheetBtn(/Branch from here/).click();
await page.waitForTimeout(500);
const bDlg = page.getByRole('dialog').last();
const bName = bDlg.getByRole('textbox').first();
if (await bName.count()) await bName.fill('From alt 2');
await bDlg.getByRole('button', { name: /Create branch|Branch|Save/ }).first().click();
await page.waitForTimeout(1400);
const shownAfter = await page.locator('[data-testid="message-bubble"][data-role="assistant"]')
  .last().innerText();
record('branching keeps the alternative that was showing', shownAfter === shownBefore,
  `${shownBefore.slice(0, 24)} -> ${shownAfter.slice(0, 24)}`);

/* ====================================================== J. CHECKPOINTS */
console.log('\n--- checkpoints ---');
await go(chatA.replace(/^#/, ''));
await page.waitForTimeout(900);
// Return to the main timeline so the checkpoint work is unambiguous.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await sheetBtn(/^Branches/).click();
await page.waitForTimeout(700);
await page.locator('[data-testid="branch-row"]').first().click();
await page.waitForTimeout(900);

await send('Message C.');
await menuFor('Message C.');
await sheetBtn(/Save checkpoint here/).click();
await page.waitForTimeout(500);
const cpDlg = page.getByRole('dialog').last();
await cpDlg.getByRole('textbox').first().fill('At C');
await cpDlg.getByRole('button', { name: /Save checkpoint/ }).click();
await page.waitForTimeout(900);

await send('Message D.');
await send('Message E.');
const originalCount = (await read('messages')).length;

await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await sheetBtn(/^Checkpoints/).click();
await page.waitForTimeout(700);
await page.getByRole('button', { name: /New chat from here/ }).first().click();
await page.waitForTimeout(1800);

const newChatText = await page.locator('.chat-messages').innerText();
record('new chat contains history up to the checkpoint', newChatText.includes('Message C.'));
record('new chat excludes messages after the checkpoint',
  !newChatText.includes('Message D.') && !newChatText.includes('Message E.'),
  'D and E must not appear');

await go(chatA.replace(/^#/, ''));
await page.waitForTimeout(1000);
const originalText = await page.locator('.chat-messages').innerText();
record('original chat still has everything',
  originalText.includes('Message C.') && originalText.includes('Message D.') &&
  originalText.includes('Message E.'));
record('original messages were not moved', (await read('messages')).length >= originalCount);

/* ================================================ G. CHAT ISOLATION */
console.log('\n--- chat isolation ---');
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await sheetBtn(/New chat in this story/).click();
await page.waitForTimeout(1600);
await send('Only in chat two.');

const chatTwoText = await page.locator('.chat-messages').innerText();
record('second chat does not show the first chat messages',
  !chatTwoText.includes('Message C.') && !chatTwoText.includes('Message D.'));

await go(chatA.replace(/^#/, ''));
await page.waitForTimeout(1000);
const chatOneText = await page.locator('.chat-messages').innerText();
record('first chat does not show the second chat messages',
  !chatOneText.includes('Only in chat two.'));

await page.reload();
await boot();
const afterReloadText = await page.locator('.chat-messages').innerText();
record('isolation survives reload',
  afterReloadText.includes('Message D.') && !afterReloadText.includes('Only in chat two.'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
