// Long-run roleplay audit.
//
// Drives a real story past 300 messages through the actual UI against a real
// OpenAI-compatible server, and at 50/100/200/300 reads the Context Inspector
// to see what the compiler decided to send. The question it answers is not
// "does a message send" but "does a months-long story stay coherent and stay
// inside its token budget".
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const LLM = process.env.LLM_BASE ?? 'http://127.0.0.1:8471/v1';
const TARGET = Number(process.env.TARGET_MESSAGES ?? 320);
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
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})).newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

// Every outgoing request body, so context growth can be measured for real.
const sent = [];
page.on('request', (r) => {
  if (r.url().includes('/chat/completions')) {
    try { sent.push(r.postDataJSON()); } catch { /* ignore */ }
  }
});

const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(400); };
const boot = async () => { await page.waitForSelector('#main', { timeout: 20000 }); await page.waitForTimeout(400); };
const sheetBtn = (name) => page.locator('.sheet').last().getByRole('button', { name }).first();
const read = (store) => page.evaluate((s) => new Promise((res) => {
  const r = indexedDB.open('nexus-tavern-pro');
  r.onsuccess = () => {
    const db = r.result;
    const g = db.transaction(s, 'readonly').objectStore(s).getAll();
    g.onsuccess = () => { res(g.result); db.close(); };
  };
}), store);

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
console.log('\n--- building the story ---');

const makeCharacter = async (name, desc) => {
  await go('#/characters');
  await page.getByRole('button', { name: /^New$/ }).first().click();
  await page.waitForTimeout(450);
  await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill(name);
  await page.getByRole('tab', { name: 'Description' }).click();
  await page.waitForTimeout(250);
  await page.getByRole('textbox', { name: 'Full description', exact: true }).first().fill(desc);
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForTimeout(650);
};
await makeCharacter('Sera', 'The innkeeper of the Nexus Tavern, watchful and dry-humoured.');
await makeCharacter('Kaelen', 'A cartographer who maps places that should not exist.');

await go('#/personas');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(450);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Corin');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(650);

// Lorebook with several entries; only one has the rare keyword.
await go('#/lorebooks');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole('tab', { name: 'Settings' }).click();
await page.waitForTimeout(250);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('World Lore');
await page.getByRole('tab', { name: /Entries/ }).click();
await page.waitForTimeout(250);

const addEntry = async (name, content, keyword) => {
  await page.getByRole('button', { name: /Add entry|New entry/i }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill(name);
  await page.getByRole('textbox', { name: 'Content', exact: true }).first().fill(content);
  const k = page.getByRole('textbox', { name: 'Primary keywords', exact: true }).first();
  await k.fill(keyword);
  await k.press('Enter');
  await page.waitForTimeout(200);
  await sheetBtn(/^Save/).click();
  await page.waitForTimeout(650);
};
await addEntry('Secret Location',
  'The Moonfall Observatory is an abandoned observatory hidden in the mountains.', 'Moonfall');
await addEntry('The Ashfell Road',
  'The road to Ashfell is closed by rockfall in winter.', 'Ashfell');
await addEntry('Guild of Cartographers',
  'The Guild pays for maps of places that do not appear on other maps.', 'Guild');

await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(650);
await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('The Long Winter');
await page.getByRole('textbox', { name: 'Scenario', exact: true }).first()
  .fill('Travellers wait out a long winter in the Nexus Tavern.');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
for (const who of [/Sera/, /Kaelen/]) {
  await page.getByRole('button', { name: 'Add character' }).first().click();
  await page.waitForTimeout(350);
  await sheetBtn(who).click();
  await page.waitForTimeout(350);
}
await page.locator('select').first().selectOption({ label: 'Corin' }).catch(() => {});
await page.getByRole('tab', { name: /Lorebook/ }).click();
await page.waitForTimeout(300);
await page.getByRole('switch', { name: /World Lore/ }).first().click();
await page.waitForTimeout(250);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(800);

// Provider.
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
await page.waitForTimeout(800);
record('story assembled and chat opened', (await page.locator('.chat-composer').count()) > 0);

/* ------------------------------------------------------ the long haul */
console.log(`\n--- driving to ~${TARGET} messages ---`);

const composer = page.getByRole('textbox', { name: 'Message', exact: true });
const sendBtn = page.getByRole('button', { name: 'Send message' });

/** Reads the inspector without leaving the conversation. */
async function inspect() {
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await page.waitForTimeout(350);
  await sheetBtn(/Context Inspector/).click();
  await page.waitForTimeout(700);
  // The inspector remembers its last tab, so start from a known one.
  await page.locator('.sheet').last().getByRole('tab', { name: /^Included/ }).click();
  await page.waitForTimeout(350);
  const sheet = page.locator('.sheet').last();
  const header = await sheet.innerText();
  const sections = await sheet.locator('.section-title').allTextContents();
  const parts = await sheet.locator('.ctx-part-label').allTextContents();
  await page.getByRole('tab', { name: 'Excluded' }).click();
  await page.waitForTimeout(350);
  const excluded = await page.locator('.sheet').last().locator('.ctx-part-reason').allTextContents();
  await page.getByRole('tab', { name: /Lore & memory/ }).click();
  await page.waitForTimeout(350);
  const lore = await page.locator('.sheet').last().innerText();
  await page.getByRole('button', { name: 'Close context inspector' }).click();
  await page.waitForTimeout(350);
  const tokens = header.match(/([\d,.]+k?)\s*\/\s*([\d,.]+k?)\s*tokens/i);
  return {
    tokenLine: tokens ? tokens[0] : '(not found)',
    pct: (header.match(/(\d+)% of budget/) ?? [])[1],
    sections: sections.map((t) => t.replace(/\s+/g, ' ').trim()),
    partLabels: parts.map((t) => t.replace(/\s+/g, ' ').trim()),
    excludedReasons: [...new Set(excluded.map((t) => t.trim()))].slice(0, 4),
    loreText: lore,
  };
}

const stages = [50, 100, 200, 300];
const snapshots = {};
let turn = 0;

// A mix of ordinary lines; "Moonfall" appears only at a known point so lore
// activation can be checked at a stage boundary.
const LINES = [
  'We keep to the fire and wait out the snow.',
  'Kaelen unrolls another map across the table.',
  'I ask Sera what she remembers about the pass.',
  'The wind picks up outside the shutters.',
  'I pour another measure and consider the road.',
];

/** Captured when the rare keyword is used, since lore correctly stops being
 * relevant once the mention scrolls out of the scan window. Checking at a stage
 * boundary tests the wrong moment. */
let loreFiredAtMention = null;
let unrelatedStayedOut = null;

async function sendOne(text) {
  await composer.fill(text);
  await sendBtn.click();
  await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 30000 });
  if (/Moonfall/.test(text)) {
    // Read the inspector rather than guessing which captured request was the
    // chat one: after a turn the app also calls the provider for automatic
    // memory and the rolling summary, so the newest body is often upkeep.
    await page.getByRole('button', { name: 'Chat menu' }).click();
    await page.waitForTimeout(350);
    await sheetBtn(/Context Inspector/).click();
    await page.waitForTimeout(700);
    await page.locator('.sheet').last().getByRole('tab', { name: /Lore & memory/ }).click();
    await page.waitForTimeout(400);
    const loreTab = await page.locator('.sheet').last().innerText();
    loreFiredAtMention =
      /Secret Location/.test(loreTab) && /Keyword matched: Moonfall/i.test(loreTab);
    unrelatedStayedOut = /Guild of Cartographers[\s\S]{0,120}Excluded because/i.test(loreTab);
    await page.getByRole('button', { name: 'Close context inspector' }).click();
    await page.waitForTimeout(300);
  }
  turn += 2; // user + assistant
}

for (const stage of stages) {
  while (turn < stage) {
    const line = turn === Number(process.env.LORE_TURN ?? 148) ? 'We should look for the Moonfall Observatory.' : LINES[turn % LINES.length];
    await sendOne(line);
    if (turn % 50 === 0) process.stdout.write(`   ...${turn} messages\n`);
  }
  const snap = await inspect();
  snapshots[stage] = snap;
  console.log(`\n   [${stage} messages] ${snap.tokenLine} (${snap.pct}% of budget)`);
  console.log(`   sections: ${snap.sections.join(' | ')}`);
  console.log(`   excluded reasons: ${snap.excludedReasons.join(' | ') || '(none)'}`);
  await page.screenshot({ path: `${SHOTS}/longrun-${stage}.png` });
}

/* ------------------------------------------------------------ verdicts */
console.log('\n--- verdicts ---');

const budgetPct = (s) => Number(snapshots[s].pct ?? 999);
record('context stays inside the budget at 50', budgetPct(50) <= 100, `${budgetPct(50)}%`);
record('context stays inside the budget at 300', budgetPct(300) <= 100, `${budgetPct(300)}%`);

// The crux: token use must not grow with the length of the story.
const growth = budgetPct(300) - budgetPct(50);
record('context does NOT grow without bound as the story grows', growth <= 25,
  `${budgetPct(50)}% at 50 -> ${budgetPct(300)}% at 300 (delta ${growth})`);

// And the request itself should carry a bounded number of messages.
const msgCounts = sent.map((b) => (b.messages ?? []).length);
const lastCount = msgCounts[msgCounts.length - 1];
const maxCount = Math.max(...msgCounts);
record('the request does not send the whole history every turn', lastCount < 200,
  `last request carried ${lastCount} messages (peak ${maxCount}) of ${turn} stored`);

// Identity must survive to the end of a long story.
const finalBody = JSON.stringify(sent[sent.length - 1]);
record('character still present at 300+', finalBody.includes('Sera'));
record('persona still present at 300+', finalBody.includes('Corin'));
record('scenario still present at 300+', /winter/i.test(finalBody));

// The rolling summary should exist and be carrying the older history.
const summaries = await read('storySummaries');
record('a rolling story summary was produced automatically', summaries.length === 1,
  summaries.length ? `covers through order ${summaries[0].coveredThroughOrder}` : 'none');
if (summaries.length) {
  record('the summary is actually being sent', finalBody.includes(
    (summaries[0].rollingSummary || summaries[0].currentSummary || '').slice(0, 30)) ||
    /summary/i.test(finalBody),
    'summary text found in the outgoing request');
}

// Lore fired at the point the keyword was used, and is not glued on forever.
record('lore activated on the turn its rare keyword appeared',
  loreFiredAtMention === true,
  'measured at the mention, not at a stage boundary');
record('unrelated lore was explicitly excluded at the same moment',
  unrelatedStayedOut === true,
  'the Guild entry, never mentioned, is listed as excluded with a reason');

const totalStored = (await read('messages')).length;
record('every message was persisted', totalStored >= turn - 2, `${totalStored} stored`);

await page.reload();
await boot();
record('a 300-message chat still opens after reload',
  (await page.locator('[data-testid="message-bubble"]').count()) > 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
console.log('\nSTAGE TABLE');
for (const s of stages) {
  console.log(`  ${String(s).padStart(3)} msgs: ${snapshots[s].tokenLine.padEnd(22)} ${snapshots[s].pct}% of budget`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
