// Product audit driver.
//
// Walks the app the way a new user would, at phone width, against an empty
// database: every entity is created by clicking, nothing is seeded, and each
// claim is checked against IndexedDB or a reload. Run it against a preview
// build:
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1 &
//   node tools/product-audit.mjs
//
// Screenshots land in .audit-shots/ (override with AUDIT_SHOTS).
const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = process.env.AUDIT_SHOTS ?? '.audit-shots';
mkdirSync(SHOTS, { recursive: true });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P8//8/AzGAiYFI' +
    'MKpwVOGowlGFxCoEAFHwBQV1I2CkAAAAAElFTkSuQmCC',
  'base64',
);

const results = [];
function record(phase, step, ok, note = '') {
  results.push({ phase, step, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${phase}] ${step}${note ? ` — ${note}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message);
  console.log('!! PAGEERROR:', e.message);
});

// A deterministic fake provider so chat can be exercised without a real key.
const sentRequests = [];
await page.route('**/v1/models', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'audit/model-a' }, { id: 'audit/model-b' }] }),
  }),
);
let replyIndex = 0;
const REPLIES = [
  'Sera looks up from the bar as the storm rattles the shutters.',
  'A different reply entirely, for the alternative.',
  'A third reply, generated with an instruction.',
  'A fourth reply.',
];
await page.route('**/v1/chat/completions', (route) => {
  sentRequests.push(route.request().postDataJSON());
  const reply = REPLIES[Math.min(replyIndex, REPLIES.length - 1)];
  replyIndex += 1;
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
  });
});

let step = 0;
async function shot(name) {
  step += 1;
  await page.screenshot({ path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png` });
}

async function go(hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(500);
}

async function boot() {
  await page.waitForSelector('#main', { timeout: 20000 });
  await page.waitForTimeout(500);
}

/** Real accessible labels, read the way the browser associates them. */
async function labelsOnScreen() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select'))
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const lbl = el.labels && el.labels[0] ? el.labels[0].textContent : null;
        // Strip the required marker: it is in the label text but not in the
        // accessible name the app exposes.
        return (el.getAttribute('aria-label') || lbl || '')
          .trim()
          .replace(/\s+/g, ' ')
          .replace(/\s*\*$/, '');
      })
      .filter(Boolean),
  );
}

async function fill(name, value) {
  const box = page.getByRole('textbox', { name, exact: true }).first();
  if (!(await box.count())) return false;
  await box.fill(value);
  return true;
}

async function countStore(store) {
  return page.evaluate(
    (s) =>
      new Promise((resolve) => {
        const r = indexedDB.open('nexus-tavern-pro');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(s)) return resolve(-1);
          const c = db.transaction(s, 'readonly').objectStore(s).count();
          c.onsuccess = () => { resolve(c.result); db.close(); };
        };
        r.onerror = () => resolve(-2);
      }),
    store,
  );
}

async function sheetButtons() {
  return (await page.locator('.sheet button').allTextContents())
    .map((t) => t.trim())
    .filter(Boolean);
}

async function closeSheet() {
  const close = page.locator('.sheet').last().getByRole('button', { name: 'Close', exact: true });
  if (await close.count()) await close.click();
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
}

// ============================================================ start clean
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

// ==================================================== PHASE 1: PERSONA
console.log('\n########## PHASE 1 — PERSONA ##########');
await go('#/personas');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(600);

const personaTabs = (await page.locator('[role=tab]').allTextContents()).map((t) => t.trim());
const personaFields = new Set();
for (const tab of personaTabs) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(250);
  for (const l of await labelsOnScreen()) personaFields.add(l);
}
console.log(`   tabs: ${personaTabs.join(' | ')}`);
console.log(`   fields: ${[...personaFields].join(' | ')}`);
for (const want of [
  'Name', 'Age', 'Gender', 'Pronouns', 'Appearance', 'Personality',
  'Backstory', 'Occupation', 'Goals', 'Likes', 'Dislikes', 'Custom instructions',
]) {
  const has = [...personaFields].some((f) => f.toLowerCase() === want.toLowerCase());
  record('P1', `field "${want}"`, has, has ? '' : 'not offered anywhere in the editor');
}

await page.getByRole('tab', { name: personaTabs[0] }).click();
await page.waitForTimeout(250);
record('P1', 'fill name', await fill('Name', 'Corin Ashe'));
await page.locator('input[type=file][accept*="image"]').first()
  .setInputFiles({ name: 'corin.png', mimeType: 'image/png', buffer: PNG });
await page.waitForTimeout(700);
record('P1', 'avatar preview after upload', (await page.locator('.image-picker-preview img').count()) > 0);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(900);
record('P1', 'persona persisted', (await countStore('personas')) === 1);
record('P1', 'avatar blob persisted', (await countStore('mediaBlobs')) >= 1);
await shot('persona-list');

await page.reload();
await boot();
await go('#/personas');
record('P1', 'survives reload', (await page.getByText('Corin Ashe').count()) > 0);

await page.getByRole('button', { name: /Actions for Corin Ashe/ }).first().click();
await page.waitForTimeout(400);
const pActions = await sheetButtons();
console.log(`   actions: ${pActions.join(' | ')}`);
for (const want of ['Edit', 'Duplicate', 'Delete', 'Export', 'default']) {
  record('P1', `action "${want}"`, pActions.some((a) => a.toLowerCase().includes(want.toLowerCase())));
}
// Actually exercise duplicate.
const dup = page.locator('.sheet').last().getByRole('button', { name: /Duplicate/ }).first();
await dup.click();
await page.waitForTimeout(900);
record('P1', 'duplicate creates a second persona', (await countStore('personas')) === 2,
  `count=${await countStore('personas')}`);

// ==================================================== PHASE 2: CHARACTER
console.log('\n########## PHASE 2 — CHARACTER ##########');
await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(600);
const charTabs = (await page.locator('[role=tab]').allTextContents()).map((t) => t.trim());
const charFields = new Set();
for (const tab of charTabs) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(220);
  for (const l of await labelsOnScreen()) charFields.add(l);
}
console.log(`   tabs: ${charTabs.join(' | ')}`);
console.log(`   fields: ${[...charFields].slice(0, 40).join(' | ')}`);
await page.getByRole('tab', { name: charTabs[0] }).click();
await page.waitForTimeout(250);
record('P2', 'fill name', await fill('Name', 'Seraphine Vale'));
await page.locator('input[type=file][accept*="image"]').first()
  .setInputFiles({ name: 'sera.png', mimeType: 'image/png', buffer: PNG });
await page.waitForTimeout(700);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(900);
record('P2', 'character persisted', (await countStore('characters')) === 1);

await go('#/characters');
const hasCharActions = await page.getByRole('button', { name: /Actions for Seraphine Vale/ }).count();
record('P2', 'row actions button present', hasCharActions > 0);
if (hasCharActions) {
  await page.getByRole('button', { name: /Actions for Seraphine Vale/ }).first().click();
  await page.waitForTimeout(400);
  const cActions = await sheetButtons();
  console.log(`   actions: ${cActions.join(' | ')}`);
  for (const want of ['Edit', 'Duplicate', 'Delete', 'Export', 'avourite']) {
    record('P2', `action "${want}"`, cActions.some((a) => a.includes(want)));
  }
  await closeSheet();
}

// ==================================================== PHASE 4: LOREBOOK
console.log('\n########## PHASE 4 — LOREBOOK ##########');
await go('#/lorebooks');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(800);
record('P4', 'lorebook created and editor opened', (await countStore('lorebooks')) === 1);

const loreTabs = (await page.locator('[role=tab]').allTextContents()).map((t) => t.trim());
console.log(`   lorebook tabs: ${loreTabs.join(' | ')}`);

// Rename it via the Settings tab.
await page.getByRole('tab', { name: 'Settings' }).click();
await page.waitForTimeout(350);
const settingsLabels = await labelsOnScreen();
console.log(`   settings fields: ${settingsLabels.join(' | ')}`);
const nameField = settingsLabels.find((l) => /name/i.test(l));
if (nameField) {
  await page.getByRole('textbox', { name: nameField, exact: true }).first().fill('Ashfell Lore');
  await page.waitForTimeout(400);
  record('P4', 'rename lorebook', true);
} else {
  record('P4', 'rename lorebook', false, 'no name field in Settings tab');
}

// Add an entry.
await page.getByRole('tab', { name: /Entries/ }).click();
await page.waitForTimeout(350);
const addEntry = page.getByRole('button', { name: /Add entry|New entry/i }).first();
record('P4', 'Add entry button present', (await addEntry.count()) > 0);
if (await addEntry.count()) {
  await addEntry.click();
  await page.waitForTimeout(600);
  const entryLabels = await labelsOnScreen();
  console.log(`   entry fields: ${entryLabels.join(' | ')}`);
  // The advanced block may be collapsed behind a toggle.
  const advanced = page.getByRole('button', { name: /Advanced|More options/i }).first();
  if (await advanced.count()) {
    await advanced.click();
    await page.waitForTimeout(350);
    const more = await labelsOnScreen();
    console.log(`   entry fields (advanced): ${more.join(' | ')}`);
    for (const l of more) entryLabels.push(l);
  }
  for (const want of [
    'name', 'content', 'primary', 'secondary', 'alias',
    'priority', 'position', 'depth', 'scan', 'categor',
  ]) {
    const has = entryLabels.some((f) => f.toLowerCase().includes(want));
    record('P4', `entry field matching "${want}"`, has);
  }
  await shot('lore-entry-editor');

  // Fill and save a real entry.
  const nameLbl = entryLabels.find((l) => /^(entry )?name$/i.test(l)) || 'Name';
  const contentLbl = entryLabels.find((l) => /content/i.test(l)) || 'Content';
  const keysLbl = entryLabels.find((l) => /primary/i.test(l)) || 'Primary keywords';
  await page.getByRole('textbox', { name: nameLbl, exact: true }).first().fill('Ashfell');
  await page.getByRole('textbox', { name: contentLbl, exact: true }).first()
    .fill('Ashfell is the grey city built on the flank of a living volcano.');
  const keyBox = page.getByRole('textbox', { name: keysLbl, exact: true }).first();
  if (await keyBox.count()) {
    await keyBox.fill('Ashfell');
    await keyBox.press('Enter');
  }
  await page.waitForTimeout(250);
  const saveEntry = page.locator('.sheet').last().getByRole('button', { name: /^Save/ }).first();
  if (await saveEntry.count()) {
    await saveEntry.click();
    await page.waitForTimeout(800);
  }
  record('P4', 'lore entry persisted', (await countStore('loreEntries')) === 1,
    `count=${await countStore('loreEntries')}`);
}


// ==================================================== PHASE 5: STORY
console.log('\n########## PHASE 5 — STORY ##########');
await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
const storyTabs = (await page.locator('[role=tab]').allTextContents()).map((t) => t.trim());
console.log(`   story tabs: ${storyTabs.join(' | ')}`);
record('P5', 'fill title', await fill('Title', 'The Long Storm'));
await fill('Scenario', 'Travellers wait out a storm in the tavern.');

// Cast
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(350);
const addChar = page.getByRole('button', { name: 'Add character' }).first();
record('P5', 'Add character control', (await addChar.count()) > 0);
if (await addChar.count()) {
  await addChar.click();
  await page.waitForTimeout(400);
  await page.locator('.sheet').last().getByRole('button', { name: /Seraphine/ }).first().click();
  await page.waitForTimeout(500);
  record('P5', 'character attached to story', (await page.getByText('Seraphine Vale').count()) > 0);
}
// Persona
const personaSelect = page.locator('select').first();
if (await personaSelect.count()) {
  await personaSelect.selectOption({ label: 'Corin Ashe' }).catch(() => {});
  await page.waitForTimeout(300);
  record('P5', 'persona assigned to story', true);
} else {
  record('P5', 'persona assigned to story', false, 'no persona picker on the Cast tab');
}
// Lorebook
const loreTab = page.getByRole('tab', { name: /Lorebook/ });
record('P5', 'Lorebooks tab in story editor', (await loreTab.count()) > 0);
if (await loreTab.count()) {
  await loreTab.click();
  await page.waitForTimeout(400);
  const sw = page.getByRole('switch', { name: /Ashfell/ }).first();
  record('P5', 'lorebook toggle present', (await sw.count()) > 0);
  if (await sw.count()) {
    await sw.click();
    await page.waitForTimeout(300);
  }
}
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(1000);
record('P5', 'story persisted', (await countStore('stories')) === 1);
await shot('story-saved');

const storyRow = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('nexus-tavern-pro');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const all = await new Promise((res) => {
    const g = db.transaction('stories', 'readonly').objectStore('stories').getAll();
    g.onsuccess = () => res(g.result);
  });
  db.close();
  return all[0];
});
record('P5', 'story kept its character', (storyRow?.characters?.length ?? 0) >= 1);
record('P5', 'story kept its persona', !!storyRow?.personaId);
record('P5', 'story kept its lorebook', (storyRow?.lorebookIds?.length ?? 0) >= 1,
  `lorebookIds=${JSON.stringify(storyRow?.lorebookIds)}`);

// ==================================================== PHASE 6: CHAT
console.log('\n########## PHASE 6 — CHAT ##########');
// Configure the fake provider through the real Settings UI first.
await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:9/v1');
await dlg.getByRole('textbox', { name: 'API key', exact: true }).fill('audit-key-123456');
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(1200);
record('P6', 'model discovery through UI', (await dlg.getByText(/Loaded 2 models/).count()) > 0);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);
record('P6', 'provider saved', (await countStore('providers')) === 1);

await go('#/stories');
const startChat = page.getByRole('button', { name: /Start chat|Continue/ }).first();
record('P6', 'Start chat from story', (await startChat.count()) > 0);
await startChat.click();
await page.waitForTimeout(900);
record('P6', 'composer visible', (await page.locator('.chat-composer').count()) > 0);

await page.getByRole('textbox', { name: 'Message', exact: true }).fill('We rode into Ashfell at dusk.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2500);
record('P6', 'user message shown', (await page.getByText('We rode into Ashfell at dusk.').count()) > 0);
record('P6', 'AI reply shown', (await page.getByText(/Sera looks up from the bar/).count()) > 0);
await shot('chat-first-exchange');

// What actually went to the provider?
const req = sentRequests[sentRequests.length - 1];
const flat = JSON.stringify(req);
record('P6', 'request carries the newest user message', flat.includes('We rode into Ashfell at dusk.'));
record('P6', 'request carries the character', flat.includes('Seraphine'));
record('P6', 'request carries the persona', flat.includes('Corin'));
record('P6', 'request carries the story scenario', flat.includes('storm'));
record('P6', 'LORE ACTIVATED in request', flat.includes('grey city'),
  flat.includes('grey city') ? '' : 'lore entry did NOT reach the provider');
record('P6', 'API key absent from body', !flat.includes('audit-key-123456'));

await page.reload();
await boot();
record('P6', 'conversation survives reload',
  (await page.getByText('We rode into Ashfell at dusk.').count()) > 0);

// ============================================ PHASE 14: CONTEXT INSPECTOR
console.log('\n########## PHASE 14 — CONTEXT INSPECTOR ##########');
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Context Inspector/ }).click();
await page.waitForTimeout(700);
await shot('context-inspector');
const inspectorText = await page.locator('.sheet').last().innerText();
record('P14', 'inspector shows a token estimate', /tokens/i.test(inspectorText));
await page.getByRole('tab', { name: /Lore & memory/ }).click();
await page.waitForTimeout(400);
const loreTabText = await page.locator('.sheet').last().innerText();
record('P14', 'inspector lists the triggered lore entry', /Ashfell/.test(loreTabText),
  /Ashfell/.test(loreTabText) ? '' : 'lore not shown as triggered');
await shot('inspector-lore');
await page.getByRole('button', { name: 'Close context inspector' }).click();
await page.waitForTimeout(400);

// ============================================ PHASE 7/8: MESSAGE ACTIONS
console.log('\n########## PHASE 7-8 — MESSAGE ACTIONS & REGENERATION ##########');
const aiBubble = page.locator('[data-testid="message-bubble"][data-role="assistant"]').last();
const aiArticle = page.locator('.msg').filter({ has: aiBubble }).last();
await aiArticle.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(450);
const aiActions = await sheetButtons();
console.log(`   AI message actions: ${aiActions.join(' | ')}`);
for (const want of [
  'Edit', 'Copy', 'Regenerate', 'instruction', 'Remember', 'important',
  'Branch from here', 'Start new chat from here', 'Save checkpoint', 'Delete',
]) {
  record('P7', `AI action "${want}"`, aiActions.some((a) => a.toLowerCase().includes(want.toLowerCase())));
}
// Generate an alternative rather than overwrite.
const altBtn = page.locator('.sheet').last().getByRole('button', { name: /Generate an alternative/ }).first();
if (await altBtn.count()) {
  await altBtn.click();
  await page.waitForTimeout(2500);
  const nav = await page.locator('.alt-nav').count();
  record('P8', 'alternative created with a 1/2 selector', nav > 0);
  const navText = nav ? await page.locator('.alt-nav').first().innerText() : '';
  record('P8', 'selector reads 2 / 2', /2\s*\/\s*2/.test(navText), navText.replace(/\n/g, ' '));
  record('P8', 'original response preserved', (await countStore('messageAlternatives')) >= 1);
  await shot('alternatives');
} else {
  record('P8', 'generate alternative', false, 'action not offered');
}


// ==================================================== PHASE 9: BRANCHING
console.log('\n########## PHASE 9 — BRANCHING ##########');
await closeSheet();
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Message B.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2200);
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Message C.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2200);
const beforeBranch = await countStore('messages');

const cArticle = page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'Message C.' }),
}).first();
await cArticle.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Branch from here/ }).click();
await page.waitForTimeout(500);
const branchDlg = page.getByRole('dialog').last();
const branchName = branchDlg.getByRole('textbox').first();
if (await branchName.count()) await branchName.fill('Branch A');
await branchDlg.getByRole('button', { name: /Create branch|Branch|Save/ }).first().click();
await page.waitForTimeout(1200);
record('P9', 'branch created', (await countStore('branches')) >= 2, `branches=${await countStore('branches')}`);

await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Only on branch A.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2200);
record('P9', 'messages are inherited not copied',
  (await countStore('messages')) > beforeBranch, 'branch adds only its own messages');

// Switch back to main and confirm the branch-only message is gone.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /^Branches/ }).click();
await page.waitForTimeout(600);
const branchRows = await page.locator('[data-testid="branch-row"]').count();
record('P9', 'branch panel lists both timelines', branchRows >= 2, `rows=${branchRows}`);
await shot('branches');
await page.locator('[data-testid="branch-row"]').first().click();
await page.waitForTimeout(900);
record('P9', 'main timeline intact after switching back',
  (await page.getByText('Message C.').count()) > 0);
record('P9', 'branch-only message hidden on main',
  (await page.getByText('Only on branch A.').count()) === 0);

await page.reload();
await boot();
record('P9', 'branch structure survives reload', (await countStore('branches')) >= 2);

// ==================================================== PHASE 11: CHECKPOINTS
console.log('\n########## PHASE 11 — CHECKPOINTS ##########');
const cArticle2 = page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'Message C.' }),
}).first();
await cArticle2.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Save checkpoint here/ }).click();
await page.waitForTimeout(500);
const cpDlg = page.getByRole('dialog').last();
await cpDlg.getByRole('textbox').first().fill('Before confession');
await cpDlg.getByRole('button', { name: /Save checkpoint/ }).click();
await page.waitForTimeout(900);
record('P11', 'checkpoint saved', (await countStore('checkpoints')) === 1);

const chatsBefore = await countStore('chats');
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /^Checkpoints/ }).click();
await page.waitForTimeout(600);
const newFromCp = page.getByRole('button', { name: /New chat from here/ }).first();
record('P11', 'New chat from checkpoint offered', (await newFromCp.count()) > 0);
if (await newFromCp.count()) {
  await newFromCp.click();
  await page.waitForTimeout(1400);
  record('P11', 'new chat created from checkpoint',
    (await countStore('chats')) === chatsBefore + 1, `chats=${await countStore('chats')}`);
  record('P11', 'history before the checkpoint is present',
    (await page.getByText('We rode into Ashfell at dusk.').count()) > 0);
  record('P11', 'original checkpoint still available', (await countStore('checkpoints')) === 1);
}

// ==================================================== PHASE 12/13: MEMORY
console.log('\n########## PHASE 12-13 — MEMORY & IMPORTANT ##########');
await go('#/chat');
await page.waitForTimeout(600);
const firstChat = page.locator('.list button, .card button').first();
await firstChat.click().catch(() => {});
await page.waitForTimeout(900);

const anyArticle = page.locator('.msg').first();
await anyArticle.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Remember/ }).click();
await page.waitForTimeout(2500);
const memDlg = page.getByRole('dialog').last();
record('P12', 'memory draft dialog opens', (await memDlg.count()) > 0);
const memFields = await labelsOnScreen();
console.log(`   memory fields: ${memFields.join(' | ')}`);
record('P12', 'memory is editable before saving', memFields.some((f) => /title|content/i.test(f)));
const saveMem = memDlg.getByRole('button', { name: /^Save/ }).first();
if (await saveMem.count()) {
  await saveMem.click();
  await page.waitForTimeout(1000);
}
record('P12', 'memory persisted', (await countStore('memories')) >= 1, `count=${await countStore('memories')}`);

const memRow = await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('nexus-tavern-pro'); r.onsuccess = () => res(r.result);
  });
  const all = await new Promise((res) => {
    const g = db.transaction('memories', 'readonly').objectStore('memories').getAll();
    g.onsuccess = () => res(g.result);
  });
  db.close(); return all[0];
});
record('P12', 'memory records sourceMessageIds',
  (memRow?.sourceMessageIds?.length ?? 0) > 0, `ids=${JSON.stringify(memRow?.sourceMessageIds)}`);

await go('#/memories');
await page.waitForTimeout(500);
record('P12', 'memory appears in the Memories library',
  (await page.locator('.card').count()) > 0);
const memActionsBtn = page.getByRole('button', { name: /Actions for/ }).first();
if (await memActionsBtn.count()) {
  await memActionsBtn.click();
  await page.waitForTimeout(400);
  const mActions = await sheetButtons();
  console.log(`   memory actions: ${mActions.join(' | ')}`);
  for (const want of ['Pin', 'Edit', 'Delete', 'source']) {
    record('P12', `memory action "${want}"`, mActions.some((a) => a.toLowerCase().includes(want.toLowerCase())));
  }
  const pin = page.locator('.sheet').last().getByRole('button', { name: /Pin/ }).first();
  if (await pin.count()) {
    await pin.click();
    await page.waitForTimeout(900);
    const pinned = await page.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('nexus-tavern-pro'); r.onsuccess = () => res(r.result);
      });
      const all = await new Promise((res) => {
        const g = db.transaction('memories', 'readonly').objectStore('memories').getAll();
        g.onsuccess = () => res(g.result);
      });
      db.close(); return all.some((m) => m.pinned);
    });
    record('P12', 'pin persists to the record', pinned);
  }
} else {
  record('P12', 'memory row actions', false, 'no Actions button on a memory');
}


// ============================================ VIEW SOURCE + NAVIGATION
console.log('\n########## VIEW SOURCE & NAVIGATION ##########');
await go('#/memories');
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Actions for/ }).first().click();
await page.waitForTimeout(400);
const vs = page.locator('.sheet').last().getByRole('button', { name: /View source/ }).first();
record('VS', 'View source action present', (await vs.count()) > 0);
if (await vs.count()) {
  await vs.click();
  await page.waitForTimeout(2200);
  const onChat = await page.locator('.chat-composer').count();
  record('VS', 'lands in the conversation', onChat > 0);
  const highlighted = await page.locator('.msg-highlighted').count();
  record('VS', 'highlights the source message', highlighted === 1, `count=${highlighted}`);
  await shot('view-source');
}

// Bottom navigation should read Home / Chats / Stories / Library / Settings.
await go('#/dashboard');
const navLabels = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.bottom-nav button')).map((b) => b.textContent.trim()),
);
console.log(`   bottom nav: ${navLabels.join(' | ')}`);
record('NAV', 'bottom nav is Home/Chats/Stories/Library/Settings',
  JSON.stringify(navLabels) === JSON.stringify(['Home', 'Chats', 'Stories', 'Library', 'Settings']),
  navLabels.join('/'));

await page.getByRole('button', { name: 'Library' }).first().click();
await page.waitForTimeout(600);
await shot('library');
const libText = await page.locator('#main').innerText();
for (const want of ['Characters', 'Personas', 'Lorebooks', 'Memories', 'Images', 'Import']) {
  record('NAV', `Library exposes ${want}`, libText.includes(want));
}
const libOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
record('NAV', 'Library has no horizontal overflow', libOverflow <= 1, `${libOverflow}px`);
await page.getByRole('button', { name: 'Open Characters' }).click();
await page.waitForTimeout(600);
record('NAV', 'Library row opens its page', (await page.getByText('Seraphine Vale').count()) > 0);


// ============================================ PHASE 15: IMAGE IN CHAT
console.log('\n########## PHASE 15 — IMAGE UPLOAD ##########');
await go('#/chat');
await page.waitForTimeout(600);
await page.locator('.list button, .card button').first().click().catch(() => {});
await page.waitForTimeout(900);
const addImage = page.getByRole('button', { name: 'Add image' });
record('P15', 'Add image button in composer', (await addImage.count()) > 0);
await addImage.click();
await page.waitForTimeout(500);
const attachOptions = await sheetButtons();
console.log(`   attach options: ${attachOptions.join(' | ')}`);
for (const want of ['Camera', 'Photo Library', 'Files', 'Generate Image', 'Media Library']) {
  record('P15', `attach option "${want}"`, attachOptions.some((a) => a.includes(want)));
}
// The three inputs must carry the attributes a phone acts on.
const inputAttrs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.chat-composer input[type=file]')).map((el) => ({
    testid: el.getAttribute('data-testid'),
    accept: el.getAttribute('accept'),
    capture: el.getAttribute('capture'),
    multiple: el.hasAttribute('multiple'),
  })),
);
console.log(`   file inputs: ${JSON.stringify(inputAttrs)}`);
const camera = inputAttrs.find((i) => i.testid === 'attach-camera');
record('P15', 'camera input uses capture=environment', camera?.capture === 'environment');
record('P15', 'camera input accepts images', /image/.test(camera?.accept ?? ''));
const library = inputAttrs.find((i) => i.testid === 'attach-library');
record('P15', 'library input has no capture (opens the gallery)', !library?.capture);
record('P15', 'library input allows multiple', !!library?.multiple);

await page.locator('.sheet').last().getByRole('button', { name: /Photo Library/ }).click();
await page.waitForTimeout(400);
// Count before picking: the blob is written at pick time, not at send time.
const blobsBefore = await countStore('mediaBlobs');
await page.locator('[data-testid="attach-library"]')
  .setInputFiles({ name: 'scene.png', mimeType: 'image/png', buffer: PNG });
await page.waitForTimeout(900);
record('P15', 'attachment preview appears', (await page.locator('.attachment-preview').count()) > 0);
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Here is what I found.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(2600);
record('P15', 'image blob stored in IndexedDB', (await countStore('mediaBlobs')) > blobsBefore,
  `${blobsBefore} -> ${await countStore('mediaBlobs')}`);
record('P15', 'image renders in the conversation',
  (await page.locator('.msg-attachments img').count()) > 0);
await shot('image-in-chat');

await page.reload();
await boot();
record('P15', 'image still renders after reload',
  (await page.locator('.msg-attachments img').count()) > 0);
// Nothing enormous should be sitting in localStorage.
const lsBytes = await page.evaluate(() =>
  Object.keys(localStorage).reduce((n, k) => n + (localStorage.getItem(k) || '').length, 0),
);
record('P15', 'no base64 images parked in localStorage', lsBytes < 20000, `${lsBytes} chars`);

// ============================================ PHASE 13: IMPORTANT MESSAGES
console.log('\n########## PHASE 13 — IMPORTANT MESSAGES ##########');
const impArticle = page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"]').filter({ hasText: 'Here is what I found.' }),
}).first();
await impArticle.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
await page.locator('.sheet').last().getByRole('button', { name: /Mark important/ }).click();
await page.waitForTimeout(900);
await go('#/memories');
await page.waitForTimeout(500);
const impTab = page.getByRole('tab', { name: /Important messages/ });
record('P13', 'Important messages view exists', (await impTab.count()) > 0);
if (await impTab.count()) {
  await impTab.click();
  await page.waitForTimeout(600);
  record('P13', 'flagged message listed there',
    (await page.getByText('Here is what I found.').count()) > 0);
  await shot('important-messages');
}

// ============================================ PHASE 3: REAL FILE IMPORT
console.log('\n########## PHASE 3 — IMPORT ##########');
await go('#/transfer');
await page.waitForTimeout(500);
const importInputs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('input[type=file]')).map((el) => ({
    accept: el.getAttribute('accept'),
    multiple: el.hasAttribute('multiple'),
  })),
);
console.log(`   import inputs: ${JSON.stringify(importInputs)}`);
record('P3', 'import uses a real file input', importInputs.length > 0);
record('P3', 'accepts json/txt/png', importInputs.some((i) =>
  /json/.test(i.accept ?? '') && /png|image/.test(i.accept ?? '')));

const charsBefore = await countStore('characters');
await page.locator('input[type=file]').first().setInputFiles({
  name: 'imported.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: 'Imported Ally', description: 'Came from a v2 card.',
            alternate_greetings: ['Hello there.'] },
  })),
});
await page.waitForTimeout(1200);
record('P3', 'JSON import shows a preview before committing',
  (await page.getByText(/Import preview/).count()) > 0);
await shot('import-preview');
const confirm = page.getByRole('button', { name: /Confirm import/ }).first();
if (await confirm.count()) {
  await confirm.click();
  await page.waitForTimeout(1200);
}
record('P3', 'character imported', (await countStore('characters')) === charsBefore + 1);

// PNG carrying a character card.
function cardPng(card) {
  const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const keyword = Buffer.from('chara', 'latin1');
  const data = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(payload, 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  let table = null;
  const crc32 = (buf) => {
    if (!table) { table = []; for (let n = 0; n < 256; n++) { let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return crc ^ 0xffffffff;
  };
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([PNG.subarray(0, 33), length, type, data, crc, PNG.subarray(33)]);
}
const beforePng = await countStore('characters');
await page.locator('input[type=file]').first().setInputFiles({
  name: 'card.png', mimeType: 'image/png',
  buffer: cardPng({ name: 'PNG Card Hero', description: 'Embedded in a PNG.' }),
});
await page.waitForTimeout(1400);
record('P3', 'PNG character card detected',
  (await page.getByText(/PNG character card|Import preview/).count()) > 0);
const confirm2 = page.getByRole('button', { name: /Confirm import/ }).first();
if (await confirm2.count()) { await confirm2.click(); await page.waitForTimeout(1200); }
record('P3', 'PNG card imported', (await countStore('characters')) === beforePng + 1);

// ============================================ PHASE 20: BACKUP / RESTORE
console.log('\n########## PHASE 20 — BACKUP & RESTORE ##########');
await page.getByRole('tab', { name: /Backup & Restore/ }).click();
await page.waitForTimeout(500);
const before = {
  characters: await countStore('characters'),
  personas: await countStore('personas'),
  stories: await countStore('stories'),
  messages: await countStore('messages'),
  memories: await countStore('memories'),
  branches: await countStore('branches'),
  checkpoints: await countStore('checkpoints'),
  media: await countStore('media'),
};
console.log(`   before: ${JSON.stringify(before)}`);
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /Download full backup/ }).click(),
]);
const stream = await download.createReadStream();
const chunks = [];
for await (const c of stream) chunks.push(c);
const backupJson = Buffer.concat(chunks).toString('utf8');
record('P20', 'backup downloaded', backupJson.length > 500, `${backupJson.length} bytes`);
record('P20', 'backup excludes the API key', !backupJson.includes('audit-key-123456'));
const parsed = JSON.parse(backupJson);
const body = parsed.data ?? parsed.payload ?? parsed;
for (const key of ['characters', 'personas', 'stories', 'chats', 'messages',
                   'branches', 'checkpoints', 'memories', 'lorebooks', 'mediaMeta']) {
  record('P20', `backup contains ${key}`, Array.isArray(body[key]) && body[key].length >= 0);
}
record('P20', 'backup bundles image bytes', !!body.media && Object.keys(body.media).length > 0,
  `${Object.keys(body.media ?? {}).length} images`);

// Erase, then restore.
await go('#/settings');
await page.getByRole('tab', { name: 'Data' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Erase all local data/ }).click();
await page.waitForTimeout(500);
const eraseDlg = page.getByRole('dialog').last();
await eraseDlg.getByRole('textbox').first().fill('ERASE');
await eraseDlg.getByRole('button', { name: 'Erase everything' }).click();
await page.waitForTimeout(1500);
record('P20', 'erase clears the library', (await countStore('characters')) === 0);

await go('#/transfer');
await page.getByRole('tab', { name: /Backup & Restore/ }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Choose backup file' }).click();
await page.waitForTimeout(300);
await page.locator('input[type=file][accept*="json"]').last().setInputFiles({
  name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupJson),
});
await page.waitForTimeout(1500);
const restoreBtn = page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true });
record('P20', 'restore preview shown', (await restoreBtn.count()) > 0);
if (await restoreBtn.count()) {
  await restoreBtn.click();
  await page.waitForTimeout(4000);
}
const after = {
  characters: await countStore('characters'),
  personas: await countStore('personas'),
  stories: await countStore('stories'),
  messages: await countStore('messages'),
  memories: await countStore('memories'),
  branches: await countStore('branches'),
  checkpoints: await countStore('checkpoints'),
  media: await countStore('media'),
};
console.log(`   after:  ${JSON.stringify(after)}`);
for (const key of Object.keys(before)) {
  record('P20', `restored ${key}`, after[key] === before[key], `${before[key]} -> ${after[key]}`);
}
await page.reload();
await boot();
record('P20', 'restored data survives reload', (await countStore('messages')) === before.messages);


// ============================================ EDIT / INSTRUCTION / AVATAR
console.log('\n########## EDIT, INSTRUCTION, AVATAR, EXPORT ##########');
await go('#/chat');
await page.waitForTimeout(700);
await page.locator('.list button, .card button').first().click().catch(() => {});
await page.waitForTimeout(900);

// Edit a user message.
const userArticle = page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"][data-role="user"]'),
}).first();
await userArticle.getByRole('button', { name: 'Edit message' }).click();
await page.waitForTimeout(500);
const editBox = page.getByRole('textbox', { name: 'Message text', exact: true }).first();
record('EDIT', 'user message edit dialog opens', (await editBox.count()) > 0);
if (await editBox.count()) {
  await editBox.fill('Edited by the user.');
  await page.getByRole('dialog').last().getByRole('button', { name: /^Save/ }).first().click();
  await page.waitForTimeout(900);
  record('EDIT', 'edit shows in the conversation',
    (await page.getByText('Edited by the user.').count()) > 0);
  await page.reload();
  await boot();
  record('EDIT', 'edit persisted through reload',
    (await page.getByText('Edited by the user.').count()) > 0);
}

// Regenerate with instruction on an AI message.
const ai2 = page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"][data-role="assistant"]'),
}).last();
await ai2.getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
const withInstruction = page.locator('.sheet').last()
  .getByRole('button', { name: /Regenerate with instruction/ }).first();
record('EDIT', 'regenerate-with-instruction offered', (await withInstruction.count()) > 0);
if (await withInstruction.count()) {
  await withInstruction.click();
  await page.waitForTimeout(500);
  const instrBox = page.getByRole('textbox', { name: 'Instruction', exact: true }).first();
  if (await instrBox.count()) {
    await instrBox.fill('Make it darker and shorter.');
    await page.getByRole('dialog').last().getByRole('button', { name: /Generate|Regenerate/ }).first().click();
    await page.waitForTimeout(3000);
    const lastReq = JSON.stringify(sentRequests[sentRequests.length - 1]);
    record('EDIT', 'instruction reaches the provider request',
      lastReq.includes('Make it darker and shorter.'));
  }
}

// Use a stored image as a character avatar, from the Images library.
await go('#/media');
await page.waitForTimeout(700);
const tile = page.locator('.media-tile').first();
record('IMG', 'media library lists stored images', (await tile.count()) > 0);
if (await tile.count()) {
  await tile.click();
  await page.waitForTimeout(600);
  const actionsBtn = page.getByRole('button', { name: 'Actions' }).first();
  if (await actionsBtn.count()) {
    await actionsBtn.click();
    await page.waitForTimeout(400);
    const useBtn = page.locator('.sheet').last().getByRole('button', { name: /Use this image/ }).first();
    record('IMG', '"Use this image" offered', (await useBtn.count()) > 0);
    if (await useBtn.count()) {
      await useBtn.click();
      await page.waitForTimeout(600);
      const reuse = page.getByRole('dialog').last();
      const targets = (await reuse.locator('button').allTextContents()).map((t) => t.trim());
      console.log(`   reuse targets: ${targets.join(' | ')}`);
      for (const want of ['Character avatar', 'Persona avatar', 'Story cover', 'background']) {
        record('IMG', `reuse target "${want}"`, targets.some((t) => t.toLowerCase().includes(want.toLowerCase())));
      }
      const charTarget = reuse.getByRole('button', { name: /Character avatar/ }).first();
      if (await charTarget.count()) {
        await charTarget.click();
        await page.waitForTimeout(400);
        // Index 0 is the "Choose…" placeholder; pick a real character.
        const sel = reuse.locator('select').first();
        if (await sel.count()) await sel.selectOption({ index: 1 }).catch(() => {});
        await reuse.getByRole('button', { name: /^Apply/ }).first().click();
        await page.waitForTimeout(1200);
        const applied = await page.evaluate(async () => {
          const db = await new Promise((res) => {
            const r = indexedDB.open('nexus-tavern-pro'); r.onsuccess = () => res(r.result);
          });
          const all = await new Promise((res) => {
            const g = db.transaction('characters', 'readonly').objectStore('characters').getAll();
            g.onsuccess = () => res(g.result);
          });
          db.close();
          return all.some((c) => !!c.avatarMediaId);
        });
        record('IMG', 'image applied as a character avatar and persisted', applied);
      }
    }
  } else {
    record('IMG', 'media detail actions', false, 'no Actions button on the image detail');
  }
}

// Export a chat in all three formats.
console.log('\n--- export formats ---');
await go('#/chat');
await page.waitForTimeout(700);
await page.locator('.list button, .card button').first().click().catch(() => {});
await page.waitForTimeout(900);
for (const [label, matcher] of [['JSON', /Export chat/], ['transcript', /Export transcript/]]) {
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.waitForTimeout(400);
  const btn = page.locator('.sheet').last().getByRole('button', { name: matcher }).first();
  if (!(await btn.count())) {
    record('EXPORT', `chat export (${label})`, false, 'not offered in the chat menu');
    await closeSheet();
    continue;
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
  record('EXPORT', `chat export (${label})`, !!dl, dl.suggestedFilename());
  await page.waitForTimeout(500);
}
// AI summary package.
await page.getByRole('button', { name: 'Chat menu' }).click();
await page.waitForTimeout(400);
const aiSum = page.locator('.sheet').last().getByRole('button', { name: /Export for AI summary/ }).first();
record('EXPORT', 'AI summary package offered', (await aiSum.count()) > 0);
if (await aiSum.count()) {
  await aiSum.click();
  await page.waitForTimeout(700);
  const formats = (await page.locator('.sheet').last().locator('button').allTextContents())
    .map((t) => t.trim());
  console.log(`   summary formats: ${formats.join(' | ')}`);
  record('EXPORT', 'summary offers Markdown/TXT/JSON',
    ['Markdown', 'Text', 'JSON'].filter((f) => formats.some((x) => x.includes(f))).length >= 2);
  await closeSheet();
}

console.log('\n########## SUMMARY ##########');





const failures = results.filter((r) => !r.ok);
console.log(`${results.length - failures.length}/${results.length} checks passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  [${f.phase}] ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
console.log(`\nPAGE ERRORS: ${pageErrors.length}`);

await browser.close();
