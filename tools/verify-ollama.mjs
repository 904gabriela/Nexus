// Ollama support and connection diagnosis, driven through the real UI.
//
// The page is served from a LAN address and the model server from a different
// port on that address, so every request the app makes is genuinely
// cross-origin — the same relationship a phone has with a PC. Both cases are
// exercised against a real HTTP server: one that withholds CORS headers (a
// default Ollama install) and one that sends them.
//
// AUDIT_BASE must NOT be loopback, or the CORS case cannot be reproduced.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://192.0.2.2:4173';
const OLLAMA = process.env.OLLAMA_BASE ?? 'http://192.0.2.2:11434';
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
  if (/:(11434|11436)\b/.test(r.url())) sent.push(`${r.method()} ${r.url()}`);
});

const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(450); };
const boot = async () => { await page.waitForSelector('#main', { timeout: 20000 }); await page.waitForTimeout(450); };

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await boot();

console.log(`\n   page origin: ${BASE}`);
console.log(`   ollama:      ${OLLAMA}  (cross-origin: ${new URL(BASE).port !== new URL(OLLAMA).port})\n`);

/* ------------------------------------------------------ open the editor */
await go('#/settings');
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');

// Choosing Ollama should offer its default port and need no model typed.
const kindSelect = dlg.locator('select').first();
await kindSelect.selectOption({ label: 'Ollama' }).catch(() => {});
await page.waitForTimeout(400);
record('Ollama is offered as its own provider kind',
  (await kindSelect.inputValue()) === 'ollama',
  `selected "${await kindSelect.inputValue()}"`);
const presetUrl = await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).inputValue();
record('choosing Ollama fills in its usual port', /11434/.test(presetUrl), presetUrl);

await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(OLLAMA);

/* ============================================ 1. CORS-blocked (default) */
console.log('--- against a server that sends no CORS headers ---');
await dlg.getByRole('button', { name: 'Test connection' }).click();
await page.waitForTimeout(4000);
const blocked = await dlg.innerText();
await page.screenshot({ path: `${SHOTS}/ollama-cors-blocked.png` });

record('a CORS-blocked server is NOT reported as unreachable',
  !/Nothing answered at that address/i.test(blocked));
record('it is named as a browser block rather than a network fault',
  /blocked it|cross-origin|CORS/i.test(blocked),
  (blocked.match(/Reachable, but[^\n]*/) ?? [''])[0]);
record('the diagnosis says the server did answer',
  /Server responds[\s\S]{0,40}/.test(blocked) && /reachable and answered/i.test(blocked));
record('it names the exact remedy, with the origin to allow',
  /OLLAMA_ORIGINS/.test(blocked) && blocked.includes(new URL(BASE).origin),
  (blocked.match(/OLLAMA_ORIGINS[^\n.]*/) ?? [''])[0]);
record('it says the app cannot bypass it, rather than implying a retry will help',
  /no setting in this app can bypass/i.test(blocked));

/* ================================================= 2. CORS allowed */
console.log('\n--- after the server is told to allow this origin ---');
// A second instance of the same server, differing only in that it sends the
// Access-Control-Allow-Origin header a configured Ollama would.
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(
  process.env.OLLAMA_OK ?? OLLAMA.replace(/:11434/, ':11436'),
);
await dlg.getByRole('button', { name: 'Test connection' }).click();
await page.waitForTimeout(4000);
const okText = await dlg.innerText();
await page.screenshot({ path: `${SHOTS}/ollama-reachable.png` });

record('a reachable Ollama is detected as Ollama',
  /Ollama detected/i.test(okText), (okText.match(/Ollama detected/) ?? [''])[0]);
record('the model list is discovered without one being typed first',
  /1 model available/i.test(okText), (okText.match(/\d+ models? available/) ?? [''])[0]);
record('test connection does NOT demand a model be chosen first',
  !/No model is selected/i.test(okText) && !/Connection failed/i.test(okText));
record('a single model is selected automatically',
  /llama3\.1:latest/.test(okText), (okText.match(/llama3\.1:latest/) ?? [''])[0]);
record('model discovery used Ollama\'s own endpoint',
  sent.some((s) => s.includes('/api/tags')),
  sent.filter((s) => s.includes('/api/')).slice(0, 2).join(' | '));

// The picker must actually be populated, not just the banner text.
const modelValue = await dlg.locator('select').last().inputValue().catch(() => '');
record('the model picker is populated and pre-selected',
  modelValue.includes('llama3.1'), `picker = "${modelValue}"`);

await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(900);

/* ------------------------------------------- 3. survives a reload */
await page.reload();
await boot();
await go('#/settings');
const afterReload = await page.locator('#main').innerText();
record('the provider is still configured after a reload',
  /llama3\.1:latest/.test(afterReload));

/* --------------------------------------- 4. a real streamed generation */
await go('#/characters');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(450);
await page.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Sera');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(650);

await go('#/stories');
await page.getByRole('button', { name: /^New$/ }).first().click();
await page.waitForTimeout(650);
await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('Ollama Test');
await page.getByRole('tab', { name: /Cast/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Add character' }).first().click();
await page.waitForTimeout(350);
await page.locator('.sheet').last().getByRole('button', { name: /Sera/ }).first().click();
await page.waitForTimeout(350);
await page.getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(800);

await go('#/stories');
await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
await page.waitForTimeout(900);
await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Good evening.');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForSelector('[aria-label="Generating"]', { state: 'detached', timeout: 40000 });
await page.waitForTimeout(500);

const bubbles = await page.locator('[data-testid="message-bubble"]').allInnerTexts();
const reply = bubbles[bubbles.length - 1] ?? '';
record('a real reply comes back from the Ollama endpoint',
  reply.includes('fire has burned low'), `"${reply.slice(0, 54)}…"`);
record('generation used Ollama\'s native /api/chat, not the OpenAI shim',
  sent.some((s) => s.includes('/api/chat')),
  sent.filter((s) => s.includes('/api/chat')).slice(0, 1).join('') || '(none)');
await page.screenshot({ path: `${SHOTS}/ollama-reply.png` });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
console.log(`\nrequests to the model server — ${sent.length}`);
for (const s of [...new Set(sent)].slice(0, 8)) console.log(`  ${s}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
