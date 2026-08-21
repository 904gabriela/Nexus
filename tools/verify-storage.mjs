// Storage durability, checked in the browser rather than from the source.
import { chromium } from '@playwright/test';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const results = [];
const record = (s, ok, note = '') => {
  results.push({ s, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

// Did the app actually call persist()? Observe it rather than trust the code.
await page.addInitScript(() => {
  window.__persistCalls = 0;
  if (navigator.storage?.persist) {
    const real = navigator.storage.persist.bind(navigator.storage);
    navigator.storage.persist = () => { window.__persistCalls += 1; return real(); };
  }
});

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await page.waitForSelector('#main', { timeout: 20000 });
await page.waitForTimeout(1500);

const calls = await page.evaluate(() => window.__persistCalls);
record('the app asks the browser to keep this data on startup', calls >= 1, `persist() called ${calls}x`);

const persisted = await page.evaluate(() => navigator.storage.persisted());
console.log(`   browser answer: persisted=${persisted}`);

// Settings must report the browser's real answer, not a hopeful one.
await page.evaluate(() => { location.hash = '#/settings'; });
await page.waitForTimeout(600);
await page.getByRole('tab', { name: 'Data' }).click();
await page.waitForTimeout(800);
const panel = await page.locator('#main').innerText();
record('Settings shows a storage-durability section', /Storage durability/i.test(panel));
const claimsPersistent = /Persistent/.test(panel) && !/Best effort/.test(panel);
record('the reported state matches what the browser actually said',
  claimsPersistent === persisted,
  `panel says ${claimsPersistent ? 'Persistent' : 'Best effort/Unknown'}, browser says ${persisted}`);
record('the section explains the risk in plain terms',
  /backup/i.test(panel) && /(evict|clear|discard)/i.test(panel));
await page.screenshot({ path: `${process.env.AUDIT_SHOTS ?? '.audit-shots'}/storage.png` });

// The backup recommendation must be earned, not constant.
await page.evaluate(() => { location.hash = '#/dashboard'; });
await page.waitForTimeout(700);
const emptyHome = await page.locator('#main').innerText();
record('no backup nag on an empty library', !/Worth backing up/i.test(emptyHome));

// Seed a library big enough to be worth protecting.
await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('nexus-tavern-pro'); r.onsuccess = () => res(r.result);
  });
  const put = (s, v) => new Promise((res) => {
    const t = db.transaction(s, 'readwrite').objectStore(s).put(v); t.onsuccess = () => res();
  });
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) {
    await put('stories', {
      id: `s${i}`, title: `Story ${i}`, description: '', scenario: '', authorNote: '',
      tags: [], characters: [], personaId: null, lorebookIds: [], memoryIds: [],
      coverMediaId: null, backgroundMediaId: null, defaultChatId: null, settings: {},
      favorite: false, archived: false, createdAt: now, updatedAt: now,
    });
    await put('chats', {
      id: `c${i}`, storyId: `s${i}`, title: `Chat ${i}`, activeBranchId: `b${i}`,
      personaId: null, favorite: false, archived: false, orderCounter: 80,
      createdAt: now, updatedAt: now,
    });
  }
  db.close();
});
await page.reload();
await page.waitForSelector('#main', { timeout: 20000 });
await page.waitForTimeout(1200);
const fullHome = await page.locator('#main').innerText();
record('a substantial library does get a backup recommendation',
  /Worth backing up/i.test(fullHome));
record('the recommendation says why', /messages|backup/i.test(fullHome));
console.log(`   banner: ${(fullHome.match(/Worth backing up[\s\S]{0,160}/) ?? [''])[0].replace(/\n/g, ' ')}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
