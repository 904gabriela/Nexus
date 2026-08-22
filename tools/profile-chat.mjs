// Measures what typing and opening a chat actually cost, in a real browser.
//
// Seeds a long roleplay straight into IndexedDB, opens it, then types "hello"
// one character at a time and counts the work each keystroke provoked: React
// renders, context compilations, IndexedDB writes and main-thread long tasks.
//
// Run it before and after a change; the numbers, not the feel, decide.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4173';
const COUNT = Number(process.env.MESSAGE_COUNT ?? 300);
const LABEL = process.env.PROFILE_LABEL ?? 'run';
const SHOTS = process.env.AUDIT_SHOTS ?? '.audit-shots';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('!! PAGEERROR:', e.message));

// Count IndexedDB writes and long tasks from the very first frame.
await page.addInitScript(() => {
  const w = window;
  w.__idb = { puts: 0, gets: 0, getAlls: 0 };
  const store = IDBObjectStore.prototype;
  for (const [name, key] of [['put', 'puts'], ['get', 'gets'], ['getAll', 'getAlls']]) {
    const real = store[name];
    store[name] = function (...args) {
      w.__idb[key] += 1;
      return real.apply(this, args);
    };
  }
  w.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* not supported */ }
});

/* ------------------------------------------------------------- CPU brake */
// A phone is several times slower than this container. Without throttling, a
// bottleneck that ruins a real device can hide behind a fast CPU.
const cdp = await context.newCDPSession(page);
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 4);
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
await page.waitForTimeout(800);

/* ------------------------------------------------------------- the seed */
console.log(`\nseeding a ${COUNT}-message roleplay…`);
await page.evaluate(async (count) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('nexus-tavern-pro');
    r.onsuccess = () => res(r.result);
  });
  const put = (s, v) => new Promise((res, rej) => {
    const t = db.transaction(s, 'readwrite').objectStore(s).put(v);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
  const now = Date.now();

  await put('characters', {
    id: 'c1', name: 'Sera', displayName: '', nickname: '', age: '', gender: '', pronouns: '',
    species: '', role: '', tags: [], shortDescription: 'The innkeeper.',
    description: 'Warm and watchful, and never quite off duty.',
    appearance: '', physicalTraits: '', personality: 'Wry and protective.', temperament: '',
    traits: [], backstory: '', history: '', goals: '', motivations: '', fears: '', secrets: '',
    likes: '', dislikes: '', hobbies: '', values: '', beliefs: '', scenario: '',
    greetings: [], defaultGreetingId: null, speakingStyle: '', speechPatterns: '',
    exampleDialogue: '', systemPrompt: '', authorNote: '', relationships: '', friends: '',
    enemies: '', family: '', romantic: '', home: '', location: '', faction: '', world: '',
    lorebookIds: [], creator: '', creatorNotes: '', version: '1', customFields: [],
    metadata: {}, avatarMediaId: null, avatarUrl: '', favorite: false,
    createdAt: now, updatedAt: now,
  });

  // A lorebook with entries, so lore scanning has real work to do.
  await put('lorebooks', {
    id: 'lb1', name: 'World Lore', description: '', tags: [], enabled: true,
    scanDepth: 8, tokenBudget: 1200, recursive: false, favorite: false,
    createdAt: now, updatedAt: now,
  });
  for (let i = 0; i < 24; i += 1) {
    await put('loreEntries', {
      id: `le${i}`, lorebookId: 'lb1', name: `Entry ${i}`,
      content: `Lore body number ${i}, describing a place, a faction or a custom of the region.`,
      primaryKeys: [`keyword${i}`, `place${i}`], secondaryKeys: [], aliases: [`alias${i}`],
      logic: 'and-any', enabled: true, constant: false, selective: false, caseSensitive: false,
      matchWholeWords: true, priority: 10, insertionOrder: i, position: 'after-char',
      depth: 4, probability: 100, group: '', comment: '', createdAt: now, updatedAt: now,
    });
  }

  await put('stories', {
    id: 's1', title: 'The Long Winter', description: 'A seeded long roleplay.',
    scenario: 'Travellers wait out a long winter in the Nexus Tavern.',
    authorNote: '', openingMessage: '', tags: [],
    characters: [{ characterId: 'c1', primary: true, note: '', enabled: true }],
    personaId: null, lorebookIds: ['lb1'], memoryIds: [], coverMediaId: null,
    backgroundMediaId: null, defaultChatId: 'ch1', settings: {}, favorite: false,
    archived: false, createdAt: now, updatedAt: now,
  });
  await put('chats', {
    id: 'ch1', storyId: 's1', title: 'The Long Winter — chat', activeBranchId: 'b1',
    personaId: null, favorite: false, archived: false, settings: {}, direction: '',
    lorebookIds: [], orderCounter: count, createdAt: now, updatedAt: now,
  });
  await put('branches', {
    id: 'b1', chatId: 'ch1', parentBranchId: null, createdFromMessageId: null,
    forkOrder: 0, name: 'Main', createdAt: now, updatedAt: now,
  });

  // Memories, so memory ranking has real work too.
  for (let i = 0; i < 20; i += 1) {
    await put('memories', {
      id: `m${i}`, title: `Memory ${i}`, category: 'Event',
      content: `Something that happened earlier in the winter, number ${i}.`,
      keywords: [`keyword${i}`], importance: (i % 5) + 1, pinned: i < 3,
      storyId: 's1', chatId: null, sourceMessageIds: [], enabled: true,
      createdAt: now, updatedAt: now,
    });
  }

  const bodies = [
    'We keep to the fire and wait out the snow, saying little.',
    'Sera sets down another cup and studies the door for a long moment.',
    'I ask what she remembers about the pass before the rockfall closed it.',
    'The wind picks up outside the shutters and something upstairs creaks.',
    'I pour a measure, consider the road, and decide it can wait until morning.',
  ];
  for (let i = 0; i < count; i += 1) {
    await put('messages', {
      id: `msg${i}`, chatId: 'ch1', branchId: 'b1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      characterId: i % 2 === 0 ? null : 'c1',
      content: bodies[i % bodies.length] + ` (turn ${i})`,
      attachments: [], order: i, model: '', tokens: 0, favorite: false,
      activeAlternativeId: null, createdAt: now + i, updatedAt: now + i,
    });
  }
  db.close();
}, COUNT);

await page.reload();
await page.waitForSelector('#main', { timeout: 20000 });
await page.waitForTimeout(1000);

/* --------------------------------------------------- opening the chat */
console.log('opening the chat…');
await page.evaluate(() => {
  window.__nexusPerf?.reset();
  window.__idb.puts = 0; window.__idb.gets = 0; window.__idb.getAlls = 0;
  window.__longTasks.length = 0;
});

const openStart = Date.now();
await page.evaluate(() => { location.hash = '#/chat/ch1'; });
// "Usable" means the composer can actually be typed into.
await page.waitForSelector('.chat-composer textarea:not([disabled])', { timeout: 60000 });
const openMs = Date.now() - openStart;
await page.waitForSelector('[data-testid="message-bubble"]', { timeout: 60000 });
const firstPaintMs = Date.now() - openStart;
await page.waitForTimeout(2500); // let any deferred work settle

const afterOpen = await page.evaluate(() => ({
  mounted: document.querySelectorAll('[data-testid="message-bubble"]').length,
  compiles: window.__nexusPerf?.compileStats.calls ?? -1,
  compileMs: Math.round(window.__nexusPerf?.compileStats.totalMs ?? -1),
  renders: { ...(window.__nexusPerf?.renderStats ?? {}) },
  idb: { ...window.__idb },
  longTasks: [...window.__longTasks],
}));

/* ------------------------------------------------------------- typing */
console.log('typing "hello" one character at a time…');
const composer = page.getByRole('textbox', { name: 'Message', exact: true });
await composer.click();
await page.waitForTimeout(600);

await page.evaluate(() => {
  window.__nexusPerf?.reset();
  window.__idb.puts = 0; window.__idb.gets = 0; window.__idb.getAlls = 0;
  window.__longTasks.length = 0;
});

// Measured inside the page: from the keystroke's input event to the paint that
// shows it. Timing this from the test process instead would measure the
// debugger round trip, which is not something the user can feel.
await page.evaluate(() => {
  const w = window;
  w.__keyLatency = [];
  const el = document.querySelector('.chat-composer textarea');
  el.addEventListener('input', () => {
    const start = performance.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => w.__keyLatency.push(Math.round(performance.now() - start)));
    });
  });
});

let typed = 0;
for (const ch of 'hello') {
  await composer.press(ch);
  typed += 1;
  await page.waitForFunction(
    (expected) => document.querySelector('.chat-composer textarea')?.value.length === expected,
    typed,
    { timeout: 30000 },
  );
}
await page.waitForTimeout(1200);
const latencies = await page.evaluate(() => window.__keyLatency);

const afterTyping = await page.evaluate(() => ({
  compiles: window.__nexusPerf?.compileStats.calls ?? -1,
  compileMs: Math.round(window.__nexusPerf?.compileStats.totalMs ?? -1),
  renders: { ...(window.__nexusPerf?.renderStats ?? {}) },
  idb: { ...window.__idb },
  longTasks: [...window.__longTasks],
  value: document.querySelector('.chat-composer textarea')?.value,
}));

await page.screenshot({ path: `${SHOTS}/profile-${LABEL}.png` });

/* ------------------------------------------------------------- report */
const report = {
  label: LABEL,
  messages: COUNT,
  cpuThrottle: `${THROTTLE}x`,
  open: {
    composerUsableMs: openMs,
    firstMessageMs: firstPaintMs,
    mountedMessages: afterOpen.mounted,
    contextCompiles: afterOpen.compiles,
    contextCompileMs: afterOpen.compileMs,
    messageRenders: afterOpen.renders.message,
    idbGetAlls: afterOpen.idb.getAlls,
    longTasks: afterOpen.longTasks,
  },
  typingHello: {
    perKeystrokeMs: latencies,
    worstMs: Math.max(...latencies),
    medianMs: [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    contextCompiles: afterTyping.compiles,
    contextCompileMs: afterTyping.compileMs,
    messageRenders: afterTyping.renders.message,
    screenRenders: afterTyping.renders.screen,
    idbPuts: afterTyping.idb.puts,
    idbGetAlls: afterTyping.idb.getAlls,
    longTasks: afterTyping.longTasks,
    finalValue: afterTyping.value,
  },
};

console.log(`\n================ ${LABEL} · ${COUNT} messages · CPU ${THROTTLE}x ================`);
console.log('OPEN CHAT');
console.log(`  composer usable        ${report.open.composerUsableMs} ms`);
console.log(`  first message painted  ${report.open.firstMessageMs} ms`);
console.log(`  mounted message nodes  ${report.open.mountedMessages}`);
console.log(`  context compiles       ${report.open.contextCompiles}  (${report.open.contextCompileMs} ms total)`);
console.log(`  message renders        ${report.open.messageRenders}`);
console.log(`  long tasks             ${report.open.longTasks.join(', ') || 'none'}`);
console.log('\nTYPING "hello" (5 keystrokes)');
console.log(`  per-keystroke latency  ${report.typingHello.perKeystrokeMs.join(' / ')} ms`);
console.log(`  worst / median         ${report.typingHello.worstMs} / ${report.typingHello.medianMs} ms`);
console.log(`  context compiles       ${report.typingHello.contextCompiles}  (${report.typingHello.contextCompileMs} ms total)`);
console.log(`  message renders        ${report.typingHello.messageRenders}`);
console.log(`  chat screen renders    ${report.typingHello.screenRenders}`);
console.log(`  IndexedDB writes       ${report.typingHello.idbPuts}`);
console.log(`  IndexedDB getAll       ${report.typingHello.idbGetAlls}`);
console.log(`  long tasks             ${report.typingHello.longTasks.join(', ') || 'none'}`);
console.log(`  composer contains      "${report.typingHello.finalValue}"`);
console.log('='.repeat(60));

writeFileSync(`${SHOTS}/profile-${LABEL}.json`, JSON.stringify(report, null, 2));
await browser.close();
