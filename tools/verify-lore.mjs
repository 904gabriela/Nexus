// Lorebook activation, checked against the real outgoing request and the
// Context Inspector: primary keyword, alias, secondary keyword, and a disabled
// entry that must never fire.
import { chromium } from '@playwright/test';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const LLM = process.env.LLM_BASE ?? 'http://127.0.0.1:8471/v1';

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
    try { sent.push(JSON.stringify(r.postDataJSON())); } catch { /* ignore */ }
  }
});

const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(450); };
const boot = async () => { await page.waitForSelector('#main', { timeout: 20000 }); await page.waitForTimeout(450); };
const sheetBtn = (n) => page.locator('.sheet').last().getByRole('button', { name: n }).first();
const field = (n) => page.getByRole('textbox', { name: n, exact: true }).first();

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await boot();

await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(450);
await field('Name').fill('Sera');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(650);

/* ------------------------------------------------------------ lorebook */
await go('#/lorebooks');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(750);
await page.getByRole('tab', { name: 'Settings' }).click();
await page.waitForTimeout(250);
await field('Name').fill('World Lore');
await page.getByRole('tab', { name: /Entries/ }).click();
await page.waitForTimeout(250);

/** Adds an entry; `extra` runs inside the open sheet before saving. */
async function addEntry(name, content, keyword, extra) {
  await page.getByRole('button', { name: /Add entry|New entry/i }).first().click();
  await page.waitForTimeout(550);
  await field('Name').fill(name);
  await field('Content').fill(content);
  const k = field('Primary keywords');
  await k.fill(keyword);
  await k.press('Enter');
  await page.waitForTimeout(200);
  if (extra) await extra();
  await sheetBtn(/^Save/).click();
  await page.waitForTimeout(700);
}

await addEntry('Secret Location',
  'The Moonfall Observatory is an abandoned observatory hidden in the mountains.',
  'Moonfall',
  async () => {
    // An alias should activate the entry exactly like the primary keyword.
    const aliases = field('Aliases');
    await aliases.fill('the old glass house');
    await aliases.press('Enter');
    await page.waitForTimeout(150);
  });

await addEntry('The Cartographers Guild',
  'The Guild pays handsomely for maps of places that appear on no other map.',
  'Guild');

await addEntry('Forbidden Vault',
  'The vault under the tavern has not been opened in ninety years.',
  'Vault',
  async () => {
    // Disabled: this must never reach the model, keyword or not.
    const toggle = page.locator('.sheet').last().getByRole('switch').first();
    if (await toggle.count()) await toggle.click();
    await page.waitForTimeout(200);
  });

const entries = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('nexus-tavern-pro');
  r.onsuccess = () => {
    const db = r.result;
    const g = db.transaction('loreEntries', 'readonly').objectStore('loreEntries').getAll();
    g.onsuccess = () => { res(g.result); db.close(); };
  };
}));
console.log(`   entries: ${entries.map((e) => `${e.name}[${e.enabled ? 'on' : 'off'}] keys=${JSON.stringify(e.primaryKeys)} aliases=${JSON.stringify(e.aliases)}`).join(' | ')}`);
record('three entries stored', entries.length === 3);
const disabled = entries.find((e) => e.name === 'Forbidden Vault');
record('the third entry really is disabled', disabled && disabled.enabled === false,
  `enabled=${disabled?.enabled}`);

/* --------------------------------------------------------------- story */
await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await field('Title').fill('Lore Test');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(350);
await sheetBtn(/Sera/).click();
await page.waitForTimeout(350);
await page.getByRole('tab', { name: /Lorebook/ }).click();
await page.waitForTimeout(300);
await page.getByRole('switch', { name: /World Lore/ }).first().click();
await page.waitForTimeout(250);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(800);

await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(450);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(LLM);
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(1800);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(700);

const startChat = async () => {
  await go('#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await page.waitForTimeout(900);
};
const send = async (text) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(300);
};
const newChat = async () => {
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.waitForTimeout(350);
  await sheetBtn(/New chat in this story/).click();
  await page.waitForTimeout(1600);
};
const last = () => sent[sent.length - 1] ?? '';

await startChat();

/* ------------------------------------------------ 1. primary keyword */
await send('We walk down the road, saying nothing in particular.');
record('lore stays out before its keyword is used', !last().includes('abandoned observatory'));

await send('We should look for the Moonfall Observatory.');
record('primary keyword activates the entry', last().includes('abandoned observatory'));
record('an unmentioned entry stays out', !last().includes('pays handsomely'));

// The inspector must agree with what was actually sent, and say why.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(350);
await sheetBtn(/Context Inspector/).click();
await page.waitForTimeout(700);
await page.locator('.sheet').last().getByRole('tab', { name: /Lore & memory/ }).click();
await page.waitForTimeout(400);
const loreText = await page.locator('.sheet').last().innerText();
record('inspector lists the entry as triggered', /Secret Location/.test(loreText));
record('inspector gives a reason for the trigger', /Triggered because/i.test(loreText));
const reason = (loreText.match(/Triggered because:[^\n]*/) ?? ['(none)'])[0];
console.log(`   ${reason}`);
record('inspector shows the untriggered entries too', /not included/i.test(loreText));
await page.getByRole('button', { name: 'Close context inspector' }).click();
await page.waitForTimeout(400);

/* --------------------------------------------------------- 2. alias */
await newChat();
await send('Take me to the old glass house on the ridge.');
record('an alias activates the entry', last().includes('abandoned observatory'),
  'alias "the old glass house"');

/* ---------------------------------------------- 3. disabled entry */
await newChat();
await send('Open the Vault beneath us.');
record('a DISABLED entry never activates, even on an exact keyword',
  !last().includes('ninety years'));

/* ------------------------------------------ 4. several entries at once */
await newChat();
await send('The Guild wants a map of Moonfall.');
record('two matching entries both activate',
  last().includes('abandoned observatory') && last().includes('pays handsomely'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
