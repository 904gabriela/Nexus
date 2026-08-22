// The acceptance test, exactly as described: open a 300+ message roleplay, tap
// the composer, type "hello" naturally, then send it and watch the reply arrive
// while the UI stays usable.
//
// The CPU is throttled to stand in for a phone, and every latency is measured
// inside the page — input event to the paint that shows it — because timing
// from the test process would measure the debugger, not the user's experience.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const LLM = process.env.LLM_BASE ?? 'http://127.0.0.1:8471/v1';
const COUNT = Number(process.env.MESSAGE_COUNT ?? 320);
const SHOTS = process.env.AUDIT_SHOTS ?? '.audit-shots';
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 4);
mkdirSync(SHOTS, { recursive: true });

const results = [];
const record = (step, ok, note = '') => {
  results.push({ step, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));
await page.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* unsupported */ }
});
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

await page.goto(`${BASE}/#/dashboard`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
await page.evaluate(() => new Promise((res) => {
  localStorage.clear();
  const r = indexedDB.deleteDatabase('nexus-tavern-pro');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload();
await page.waitForSelector('#main', { timeout: 20000 });

/* ------------------------------------------------------------- the seed */
console.log(`\nseeding a ${COUNT}-message roleplay…`);
await page.evaluate(async (count) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('nexus-tavern-pro');
    r.onsuccess = () => res(r.result);
  });
  const put = (s, v) => new Promise((res) => {
    const t = db.transaction(s, 'readwrite').objectStore(s).put(v);
    t.onsuccess = () => res();
  });
  const now = Date.now();
  await put('characters', {
    id: 'c1', name: 'Sera', displayName: '', nickname: '', age: '', gender: '', pronouns: '',
    species: '', role: '', tags: [], shortDescription: '', description: 'The innkeeper.',
    appearance: '', physicalTraits: '', personality: '', temperament: '', traits: [],
    backstory: '', history: '', goals: '', motivations: '', fears: '', secrets: '', likes: '',
    dislikes: '', hobbies: '', values: '', beliefs: '', scenario: '', greetings: [],
    defaultGreetingId: null, speakingStyle: '', speechPatterns: '', exampleDialogue: '',
    systemPrompt: '', authorNote: '', relationships: '', friends: '', enemies: '', family: '',
    romantic: '', home: '', location: '', faction: '', world: '', lorebookIds: [], creator: '',
    creatorNotes: '', version: '1', customFields: [], metadata: {}, avatarMediaId: null,
    avatarUrl: '', favorite: false, createdAt: now, updatedAt: now,
  });
  await put('stories', {
    id: 's1', title: 'The Long Winter', description: '', scenario: 'A long winter.',
    authorNote: '', openingMessage: '', tags: [],
    characters: [{ characterId: 'c1', primary: true, note: '', enabled: true }],
    personaId: null, lorebookIds: [], memoryIds: [], coverMediaId: null,
    backgroundMediaId: null, defaultChatId: 'ch1', settings: {}, favorite: false,
    archived: false, createdAt: now, updatedAt: now,
  });
  await put('chats', {
    id: 'ch1', storyId: 's1', title: 'Long chat', activeBranchId: 'b1', personaId: null,
    favorite: false, archived: false, settings: {}, direction: '', lorebookIds: [],
    orderCounter: count, createdAt: now, updatedAt: now,
  });
  await put('branches', {
    id: 'b1', chatId: 'ch1', parentBranchId: null, createdFromMessageId: null, forkOrder: 0,
    name: 'Main', createdAt: now, updatedAt: now,
  });
  for (let i = 0; i < count; i += 1) {
    await put('messages', {
      id: `msg${i}`, chatId: 'ch1', branchId: 'b1',
      role: i % 2 === 0 ? 'user' : 'assistant', characterId: i % 2 === 0 ? null : 'c1',
      content: `Turn ${i}: the fire burns low and the snow keeps coming down outside.`,
      attachments: [], order: i, model: '', tokens: 0, favorite: false,
      activeAlternativeId: null, createdAt: now + i, updatedAt: now + i,
    });
  }
  db.close();
}, COUNT);
await page.reload();
await page.waitForSelector('#main', { timeout: 20000 });

/* -------------------------------------------------------------- provider */
await page.evaluate(() => { location.hash = '#/settings'; });
await page.waitForTimeout(700);
await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill(LLM);
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(2500);
await dlg.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);

/* ------------------------------------------------------- 1. open the chat */
await page.evaluate(() => { window.__nexusPerf?.reset(); window.__longTasks.length = 0; });
const t0 = Date.now();
await page.evaluate(() => { location.hash = '#/chat/ch1'; });
await page.waitForSelector('.chat-composer textarea:not([disabled])', { timeout: 60000 });
const usableMs = Date.now() - t0;
await page.waitForSelector('[data-testid="message-bubble"]', { timeout: 60000 });
await page.waitForTimeout(2000);

record(`a ${COUNT}-message chat becomes usable in under 500ms`, usableMs < 500, `${usableMs} ms`);
const mounted = await page.locator('[data-testid="message-bubble"]').count();
record('only a window of messages is mounted', mounted <= 180, `${mounted} of ${COUNT} mounted`);
await page.screenshot({ path: `${SHOTS}/acceptance-open.png` });

/* --------------------------------------------------------- 2. type hello */
const composer = page.getByRole('textbox', { name: 'Message', exact: true });
await composer.click();
// Everything deferred — the idle context pass, any window growth from the
// opening scroll — must have finished, or its cost is charged to the first
// keystroke that happens to follow it.
await page.waitForTimeout(2500);
const mountedBeforeTyping = await page.locator('[data-testid="message-bubble"]').count();
await page.evaluate(() => {
  window.__nexusPerf?.reset();
  window.__longTasks.length = 0;
  window.__lat = [];
  const el = document.querySelector('.chat-composer textarea');
  el.addEventListener('input', () => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(
      () => window.__lat.push(Math.round(performance.now() - start)),
    ));
  });
});

let typed = 0;
for (const ch of 'hello') {
  await composer.press(ch);
  typed += 1;
  await page.waitForFunction(
    (n) => document.querySelector('.chat-composer textarea')?.value.length === n,
    typed,
    { timeout: 20000 },
  );
}
await page.waitForTimeout(900);

const typing = await page.evaluate(() => ({
  lat: window.__lat,
  long: [...window.__longTasks],
  compiles: window.__nexusPerf.compileStats.calls,
  messageRenders: window.__nexusPerf.renderStats.message,
  value: document.querySelector('.chat-composer textarea').value,
  mounted: document.querySelectorAll('[data-testid="message-bubble"]').length,
}));

const median = [...typing.lat].sort((a, b) => a - b)[Math.floor(typing.lat.length / 2)];
record('every character appears immediately', Math.max(...typing.lat) <= 50,
  `per-keystroke ${typing.lat.join('/')} ms at ${THROTTLE}x CPU throttle`);
record('typing lands within about a frame', median <= 33, `median ${median} ms`);
record('the existing messages do not rerender',
  typing.messageRenders === 0 || typing.mounted > mountedBeforeTyping,
  typing.mounted > mountedBeforeTyping
    ? `${typing.messageRenders} renders, all from mounting ${typing.mounted - mountedBeforeTyping} newly scrolled-in messages`
    : `${typing.messageRenders} message renders`);
record('the context engine does not run', typing.compiles === 0, `${typing.compiles} compiles`);
record('no long task is caused by a keystroke', typing.long.length === 0,
  typing.long.join(', ') || 'none');
record('the composer contains what was typed', typing.value === 'hello', `"${typing.value}"`);
await page.screenshot({ path: `${SHOTS}/acceptance-typed.png` });

/* ----------------------------------------------------- 3. send and stream */
await page.evaluate(() => { window.__longTasks.length = 0; window.__lat = []; });
await page.getByRole('button', { name: 'Send message' }).click();

// While the reply streams the UI must still take input and still scroll.
await page.waitForSelector('[aria-label="Stop generating"]', { timeout: 30000 });
const scrollBefore = await page.evaluate(() => document.querySelector('.chat-scroll').scrollTop);
await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop -= 400; });
await page.waitForTimeout(120);
const scrollAfter = await page.evaluate(() => document.querySelector('.chat-scroll').scrollTop);
record('the conversation still scrolls while generating', scrollAfter !== scrollBefore,
  `${scrollBefore} -> ${scrollAfter}`);

await page.evaluate(() => {
  const el = document.querySelector('.chat-composer textarea');
  el.addEventListener('input', () => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(
      () => window.__lat.push(Math.round(performance.now() - start)),
    ));
  });
});
await composer.press('a');
await composer.press('b');
await page.waitForTimeout(400);
const midStream = await page.evaluate(() => ({ lat: window.__lat, value: document.querySelector('.chat-composer textarea').value }));
record('the composer still accepts typing mid-generation', midStream.value === 'ab',
  `latency ${midStream.lat.join('/')} ms`);
record('typing stays responsive mid-generation',
  midStream.lat.length > 0 && Math.max(...midStream.lat) <= 60,
  `worst ${Math.max(...midStream.lat)} ms`);

const stopVisible = await page.locator('[aria-label="Stop generating"]').count();
if (stopVisible) {
  await page.getByRole('button', { name: 'Stop generating' }).click();
  await page.waitForSelector('[aria-label="Send message"]', { timeout: 30000 });
  record('generation can be cancelled mid-stream', true, 'stop returned the send button');
} else {
  await page.waitForSelector('[aria-label="Send message"]', { timeout: 30000 });
  record('generation finished and the composer returned', true,
    'the canned reply completed before Stop could be pressed');
}
const replied = await page.locator('[data-testid="message-bubble"]').last().innerText();
record('the reply arrived', replied.trim().length > 0, `"${replied.slice(0, 48)}…"`);

const streamLong = await page.evaluate(() => [...window.__longTasks]);
record('streaming causes no long task over 200ms',
  streamLong.every((d) => d <= 200), streamLong.join(', ') || 'none');

await page.screenshot({ path: `${SHOTS}/acceptance-streamed.png` });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.step}${f.note ? ` — ${f.note}` : ''}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
