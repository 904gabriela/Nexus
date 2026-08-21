// Two acceptance gaps, verified against the running app.
//
// 1. A REAL provider. No Playwright route interception anywhere in this file:
//    the browser makes genuine cross-origin HTTP requests to an OpenAI-
//    compatible server on another port (tools/fake-llm-server.mjs), exercising
//    CORS preflight and a real SSE stream. The replies are canned, so this
//    proves the transport and persistence path, not model quality.
// 2. Story cover and background images: assign, reload, render, replace,
//    remove, with a reload after each step.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const LLM = process.env.LLM_BASE ?? 'http://127.0.0.1:8471/v1';
const SHOTS = process.env.AUDIT_SHOTS ?? '.audit-shots';
mkdirSync(SHOTS, { recursive: true });

// Two visually distinct 1x1 PNGs so "replaced" is provable, not assumed.
const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

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

// Record what actually crossed the network, to prove nothing was intercepted.
const wire = [];
page.on('request', (r) => {
  if (r.url().includes(':8471')) wire.push(`${r.method()} ${r.url()}`);
});
page.on('response', (r) => {
  if (r.url().includes(':8471')) wire.push(`  <- ${r.status()} ${r.url()}`);
});

const go = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(500);
};
const boot = async () => {
  await page.waitForSelector('#main', { timeout: 20000 });
  await page.waitForTimeout(500);
};
const shot = (n) => page.screenshot({ path: `${SHOTS}/live-${n}.png` });
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

/* ============================================ 1. REAL PROVIDER, REAL WIRE */
console.log('\n########## LIVE PROVIDER (real HTTP, real SSE, real CORS) ##########');

await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(500);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Sera');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(700);

await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(700);
await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('Storm Night');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(400);
await sheetBtn(/Sera/).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(900);

// Configure the provider through the real Settings UI.
await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(LLM);
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(2500);
const loaded = await dlg.getByText(/Loaded 2 models/).count();
record('model discovery over a real cross-origin request', loaded > 0);
await shot('01-models');
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(900);

await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(900);

await page.getByRole('textbox', { name: 'Message', exact: true })
  .fill('We rode through the storm to reach Ashfell.');
await page.getByRole('button', { name: 'Send message' }).click();

// Streaming: the reply should appear progressively, not all at once.
await page.waitForTimeout(120);
const midStream = await page.locator('[data-testid="message-bubble"][data-role="assistant"]')
  .last().innerText().catch(() => '');
await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 30000 });
const finalText = await page.locator('[data-testid="message-bubble"][data-role="assistant"]')
  .last().innerText();

record('a real streamed reply arrived', finalText.length > 40, `${finalText.length} chars`);
record('the reply streamed in rather than landing at once',
  midStream.length > 0 && midStream.length < finalText.length,
  `${midStream.length} -> ${finalText.length} chars`);
record('the request really crossed the network', wire.some((w) => w.includes('chat/completions')),
  `${wire.length} wire events`);
await shot('02-reply');

// Persisted, and still there after a reload.
const stored = (await read('messages')).find((m) => m.role === 'assistant' && m.content);
record('the reply was persisted', !!stored && stored.content === finalText);
await page.reload();
await boot();
const afterReload = await page.locator('[data-testid="message-bubble"][data-role="assistant"]')
  .last().innerText();
record('the reply survives a reload', afterReload === finalText);

// Regenerate as an alternative, over the real wire.
await page.locator('.msg').filter({
  has: page.locator('[data-testid="message-bubble"][data-role="assistant"]'),
}).last().getByRole('button', { name: 'More message actions' }).click();
await page.waitForTimeout(400);
await sheetBtn(/Generate an alternative/).click();
await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 30000 });
await page.waitForTimeout(600);
const altNav = await page.locator('.alt-nav').first().innerText();
record('regeneration over the real provider kept the original',
  /2\s*\/\s*2/.test(altNav.replace(/\n/g, ' ')), altNav.replace(/\n/g, ' '));
record('the alternative was stored', (await read('messageAlternatives')).length === 1);
await page.reload();
await boot();
const altAfter = await page.locator('.alt-nav').first().innerText();
record('alternatives survive a reload', /2\s*\/\s*2/.test(altAfter.replace(/\n/g, ' ')));
await shot('03-alternatives');

console.log(`\n   wire trace (first 6):\n${wire.slice(0, 6).map((w) => `     ${w}`).join('\n')}`);

/* ================================== 2. STORY COVER AND BACKGROUND IMAGES */
console.log('\n########## STORY COVER & BACKGROUND ##########');

const openStoryMedia = async () => {
  await go('#/stories');
  await page.getByRole('button', { name: /Actions for Storm Night/ }).first().click();
  await page.waitForTimeout(400);
  await sheetBtn(/^Edit/).click();
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: /Media/ }).click();
  await page.waitForTimeout(400);
};

await openStoryMedia();
const mediaLabels = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button, input[type=file]'))
    .map((e) => e.getAttribute('aria-label') || (e.textContent || '').trim())
    .filter(Boolean).slice(0, 30));
console.log(`   media tab controls: ${[...new Set(mediaLabels)].join(' | ')}`);

// Each ImagePicker is a .field carrying its own label, and holds two file
// inputs (gallery, camera). Scope by the label so the right one is driven.
const picker = (label) =>
  page.locator('.field').filter({ has: page.locator('.field-label', { hasText: label }) });
const pickerInput = (label) => picker(label).locator('input[type=file]').first();

record('story Media tab exposes a cover picker', (await picker('Story cover').count()) === 1);
record('story Media tab exposes a background picker',
  (await picker('Chat background').count()) === 1);

const saveStory = async () => {
  await page.getByRole('button', { name: 'Save' }).first().click();
  await page.waitForTimeout(1000);
};
const storyRow = async () => (await read('stories'))[0];

// --- cover: assign
await pickerInput('Story cover')
  .setInputFiles({ name: 'cover-red.png', mimeType: 'image/png', buffer: RED });
await page.waitForTimeout(900);
await saveStory();
let row = await storyRow();
const coverId1 = row.coverMediaId;
record('cover assigned and saved', !!coverId1, `coverMediaId=${coverId1}`);

await page.reload();
await boot();
await openStoryMedia();
record('cover renders after reload',
  (await picker('Story cover').locator('.image-picker-preview img').count()) === 1);
record('cover image decoded after reload (blob URL rebuilt)',
  await picker('Story cover').locator('.image-picker-preview img').first()
    .evaluate((img) => img.complete && img.naturalWidth > 0));
await shot('04-cover');

// --- background: assign
await pickerInput('Chat background')
  .setInputFiles({ name: 'bg-blue.png', mimeType: 'image/png', buffer: BLUE });
await page.waitForTimeout(900);
await saveStory();
row = await storyRow();
record('background assigned and saved', !!row.backgroundMediaId,
  `backgroundMediaId=${row.backgroundMediaId}`);
record('assigning the background left the cover alone', row.coverMediaId === coverId1);

await page.reload();
await boot();
await openStoryMedia();
record('cover still renders after reload',
  (await picker('Story cover').locator('.image-picker-preview img').count()) === 1);
record('background renders after reload',
  (await picker('Chat background').locator('.image-picker-preview img').count()) === 1);
record('both images decoded after reload',
  await page.locator('.image-picker-preview img')
    .evaluateAll((imgs) => imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0)));
await shot('05-cover-and-background');

// The background must actually reach the conversation.
await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(1400);
record('story background renders behind the conversation',
  (await page.locator('.chat-bg').count()) === 1);
await shot('06-chat-background');

// --- replace the cover with a different picture
await openStoryMedia();
await pickerInput('Story cover')
  .setInputFiles({ name: 'cover-blue.png', mimeType: 'image/png', buffer: BLUE });
await page.waitForTimeout(900);
await saveStory();
row = await storyRow();
const coverId2 = row.coverMediaId;
// A per-field picker must mint a new image rather than overwrite the bytes of
// the old one, or choosing another cover would silently change every other
// place that picture is used.
record('choosing another cover stores a new image', !!coverId2 && coverId2 !== coverId1,
  `${coverId1} -> ${coverId2}`);
record('the previous cover image is left intact in the library',
  (await read('media')).some((m) => m.id === coverId1));
await page.reload();
await boot();
await openStoryMedia();
record('replaced cover renders after reload',
  (await picker('Story cover').locator('.image-picker-preview img').count()) === 1);
record('replacing the cover left the background alone',
  (await storyRow()).backgroundMediaId === row.backgroundMediaId);

// --- remove the cover (this asks for confirmation first)
await picker('Story cover').getByRole('button', { name: 'Remove' }).click();
await page.waitForTimeout(400);
await page.getByRole('dialog').last().getByRole('button', { name: 'Remove' }).click();
await page.waitForTimeout(700);
await saveStory();
row = await storyRow();
record('removing the cover clears it', !row.coverMediaId, `coverMediaId=${row.coverMediaId}`);
record('removing the cover left the background alone', !!row.backgroundMediaId);

await page.reload();
await boot();
await openStoryMedia();
row = await storyRow();
record('cover stays removed after reload', !row.coverMediaId);
record('background survives the cover removal', !!row.backgroundMediaId);
record('the removed image is still in the Media library',
  (await read('media')).some((m) => m.id === coverId2),
  'removal detaches, it does not delete');

// --- remove the background
await picker('Chat background').getByRole('button', { name: 'Remove' }).click();
await page.waitForTimeout(400);
await page.getByRole('dialog').last().getByRole('button', { name: 'Remove' }).click();
await page.waitForTimeout(700);
await saveStory();
record('removing the background clears it', !(await storyRow()).backgroundMediaId);

await page.reload();
await boot();
record('background stays removed after reload', !(await storyRow()).backgroundMediaId);
await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(1400);
record('chat no longer shows a background', (await page.locator('.chat-bg').count()) === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
