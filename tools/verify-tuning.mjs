// In-chat tuning and the story's opening message, driven through the real UI.
//
// Three things are checked against the wire rather than the source: that a
// story's own opening message becomes the first message of a new chat, that
// direction set from inside the chat reaches the model, and that a temperature
// set for one chat applies to that chat and not to its neighbour.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const LLM = process.env.LLM_BASE ?? 'http://127.0.0.1:8471/v1';
const SHOTS = process.env.AUDIT_SHOTS ?? '.audit-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const record = (step, ok, note = '') => {
  results.push({ step, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
})).newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

const sent = [];
page.on('request', (r) => {
  if (r.url().includes('/chat/completions')) {
    try { sent.push(r.postDataJSON()); } catch { /* ignore */ }
  }
});

const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(450); };
const boot = async () => { await page.waitForSelector('#main', { timeout: 20000 }); await page.waitForTimeout(450); };
const sheetBtn = (n) => page.locator('.sheet').last().getByRole('button', { name: n }).first();
const field = (n) => page.getByRole('textbox', { name: n, exact: true }).first();

const OPENING = 'Snow has sealed the pass. The tavern is the only light for miles.';

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await boot();

/* ------------------------------------------------------------- the cast */
await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(450);
await field('Name').fill('Sera');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(650);

/* ------------------------------------- 1. the story's opening message */
await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await field('Title').fill('The Long Winter');

const openingBox = field('Opening message');
record('the story editor has an Opening message field', (await openingBox.count()) > 0);
const hint = await page.locator('#main').innerText();
record('the field explains what happens if it is left empty',
  /Leave it empty/i.test(hint), (hint.match(/Leave it empty[^\n]*/) ?? [''])[0]);

await openingBox.fill(OPENING);
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(350);
await sheetBtn(/Sera/).click();
await page.waitForTimeout(350);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(800);

/* ---------------------------------------------------------- provider */
await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(450);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(LLM);
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(1800);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(700);

await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(1200);

const firstBubble = await page.locator('[data-testid="message-bubble"]').first().innerText();
record('a new chat opens with the story\'s own opening message',
  firstBubble.includes('Snow has sealed the pass'),
  `first message: "${firstBubble.slice(0, 60)}…"`);
await page.screenshot({ path: `${SHOTS}/tuning-opening.png` });

/* ------------------------------------------ 2. direction, set in-chat */
const send = async (text) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(400);
};
const openMenu = async () => {
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.waitForTimeout(400);
};

await send('We shake off the snow and find a seat.');
const beforeDirection = JSON.stringify(sent[sent.length - 1] ?? {});
record('no direction is sent before any is set',
  !/Favour spoken dialogue/.test(beforeDirection));

await openMenu();
const menuText = await page.locator('.sheet').last().innerText();
record('the chat menu offers Response settings without leaving the chat',
  /Response settings/.test(menuText));
record('the menu row shows the temperature actually in force',
  /[Tt]emperature \d/.test(menuText),
  (menuText.match(/Temperature[^\n]*/) ?? [''])[0]);

await sheetBtn(/Response settings/).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${SHOTS}/tuning-sheet.png` });

const sheet = page.locator('.sheet').last();
record('the sheet offers one-tap nudges',
  (await sheet.getByRole('button', { name: 'More dialogue' }).count()) > 0);

await sheet.getByRole('button', { name: 'More dialogue' }).click();
await page.waitForTimeout(250);
const boxText = await sheet.getByRole('textbox', { name: /Direction sent to the AI/ }).inputValue();
record('a nudge writes the exact sentence the model will be given',
  boxText.includes('Favour spoken dialogue over narration.'),
  `box now reads: "${boxText}"`);

// A second nudge must add to the first, not replace it.
await sheet.getByRole('button', { name: 'Slower pace' }).click();
await page.waitForTimeout(250);
const twoText = await sheet.getByRole('textbox', { name: /Direction sent to the AI/ }).inputValue();
record('nudges accumulate rather than replacing each other',
  twoText.includes('Favour spoken dialogue') && twoText.includes('breathe'));

// Toggling the same nudge off must remove only its own line.
await sheet.getByRole('button', { name: 'Slower pace' }).click();
await page.waitForTimeout(250);
const oneText = await sheet.getByRole('textbox', { name: /Direction sent to the AI/ }).inputValue();
record('tapping a nudge again removes only that line',
  oneText.includes('Favour spoken dialogue') && !oneText.includes('breathe'));

await sheetBtn(/^Apply$/).click();
await page.waitForTimeout(800);

await send('What is she pouring tonight?');
const afterDirection = JSON.stringify(sent[sent.length - 1] ?? {});
record('direction set inside the chat reaches the model',
  /Favour spoken dialogue over narration/.test(afterDirection));

// And the inspector must show it as its own part, not hidden inside something else.
await openMenu();
await sheetBtn(/Context Inspector/).click();
await page.waitForTimeout(700);
await page.locator('.sheet').last().getByRole('tab', { name: /^Included/ }).click();
await page.waitForTimeout(400);
const inspector = await page.locator('.sheet').last().innerText();
record('the Context Inspector lists Direction as its own part',
  /Direction/.test(inspector));
await page.getByRole('button', { name: 'Close context inspector' }).click();
await page.waitForTimeout(400);

/* --------------------------------------- 3. temperature, per chat only */
await openMenu();
await sheetBtn(/Response settings/).click();
await page.waitForTimeout(700);

const tuning = page.locator('.sheet').last();
await tuning.getByRole('button', { name: 'Override' }).first().click();
await page.waitForTimeout(300);
const slider = tuning.getByRole('slider', { name: /Temperature/ }).first();
await slider.fill('0.15');
await page.waitForTimeout(250);
await sheetBtn(/^Apply$/).click();
await page.waitForTimeout(800);

await send('She sets down the bottle.');
const tuned = sent[sent.length - 1] ?? {};
record('a temperature set in the chat is used for that chat\'s requests',
  Math.abs((tuned.temperature ?? 9) - 0.15) < 0.001,
  `request carried temperature=${tuned.temperature}`);

// Survives a reload: this is stored, not just held in memory.
await page.reload();
await boot();
await page.waitForTimeout(800);
await openMenu();
const afterReload = await page.locator('.sheet').last().innerText();
record('the tuning survives a reload',
  /0\.15/.test(afterReload) && /1 direction/.test(afterReload),
  (afterReload.match(/Response settings[\s\S]{0,80}/) ?? [''])[0].replace(/\n/g, ' '));
await sheetBtn(/New chat in this story/).click();
await page.waitForTimeout(1800);

// A sibling chat in the same story must be untouched by the other chat's tuning.
await send('A different night, a different table.');
const sibling = sent[sent.length - 1] ?? {};
record('a second chat in the same story is NOT affected by the first chat\'s tuning',
  Math.abs((sibling.temperature ?? 0) - 0.15) > 0.001 &&
  !/Favour spoken dialogue/.test(JSON.stringify(sibling)),
  `sibling carried temperature=${sibling.temperature}`);
record('the second chat still opens with the story\'s opening message',
  (await page.locator('[data-testid="message-bubble"]').first().innerText())
    .includes('Snow has sealed the pass'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
