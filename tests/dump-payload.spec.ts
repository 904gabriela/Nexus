/**
 * Not a regression test: dumps the real provider requests for review.
 *
 * This is the same diagnostic the Context Inspector shows, driven from a
 * script so a whole matrix of scenarios can be captured in one run and read
 * side by side. It asserts almost nothing — its job is to answer "what does
 * Nexus actually send?" for each shape of turn, so the answer comes from the
 * intercepted request rather than from reading the compiler.
 *
 * Opt in with DUMP_PATH; it writes <path>/<scenario>.json plus a summary.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, goto, mockOllama, resetDatabase, setupOllamaProvider, type MockOllama } from './helpers';
import { seedHospitalScene, type SceneSeed } from './scene-fixture';

test.skip(!process.env.DUMP_PATH, 'set DUMP_PATH to dump the payloads');

interface Scenario {
  name: string;
  note: string;
  seed?: SceneSeed;
  /** Applied to the seeded story/chat before the turn is sent. */
  prepare?: (page: Page) => Promise<void>;
  turn: string;
}

/** Selects narration presets on the seeded story. */
function withPresets(ids: string[]) {
  return async (page: Page) => {
    await page.evaluate(async (presetIds) => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('nexus-tavern-pro');
        q.onsuccess = () => r(q.result);
      });
      const story: any = await new Promise((r) => {
        const q = db.transaction('stories', 'readonly').objectStore('stories').get('mha-story');
        q.onsuccess = () => r(q.result);
      });
      story.narrationPresetIds = presetIds;
      await new Promise<void>((r) => {
        const q = db.transaction('stories', 'readwrite').objectStore('stories').put(story);
        q.onsuccess = () => r();
      });
      db.close();
    }, ids);
    await page.reload();
    await boot(page);
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'A-benchmark-short-dialogue',
    note: 'The benchmark turn: a short expression plus a short line that is a question.',
    turn: 'my face lits up mischievously\n\n"oh? is that so?"',
  },
  {
    name: 'B-physical-action',
    note: 'An action with no dialogue at all.',
    turn: '*Reiko crossed her arms and stared at him.*',
  },
  {
    name: 'C-long-emotional-dialogue',
    note: 'A multi-sentence emotional statement.',
    turn:
      '"You scared me, you know. I sat in that corridor for six hours and nobody would tell me ' +
      'anything, and the whole time I kept thinking about what I would have said if you had not ' +
      'woken up. So do not lie there and act like it was nothing."',
  },
  {
    name: 'D-scene-changing-action',
    note: 'An action that moves the scene.',
    turn: '*Reiko walked toward the window and pushed the blind aside.*',
  },
  {
    name: 'E-two-npcs-present',
    note: 'Two AI-controlled characters present; attribution should be switched on.',
    seed: { castKirishima: true, presentCharacterIds: ['bakugo', 'kirishima'] },
    turn: '"Both of you. Sit down."',
  },
  {
    name: 'F-quiet-emotional-beat',
    note: 'A quiet moment where the right answer may be slow.',
    turn: '*Reiko sat down in the chair by the bed and did not say anything.*',
  },
  {
    name: 'G-presence-pressure',
    note: 'Kirishima in the cast but absent, and the transcript names him ten times over.',
    seed: { castKirishima: true, transcriptRepeats: 10 },
    turn: '"Quiet in here."',
  },
  {
    name: 'H-preset-default',
    note: 'No narration presets selected.',
    prepare: withPresets([]),
    turn: 'my face lits up mischievously\n\n"oh? is that so?"',
  },
  {
    name: 'I-preset-detailed',
    note: 'Detailed alone.',
    prepare: withPresets(['preset-detailed']),
    turn: 'my face lits up mischievously\n\n"oh? is that so?"',
  },
  {
    name: 'J-preset-slowburn-detailed',
    note: 'Slow Burn + Detailed, combined.',
    prepare: withPresets(['preset-slow-burn', 'preset-detailed']),
    turn: 'my face lits up mischievously\n\n"oh? is that so?"',
  },
  {
    name: 'K-preset-cinematic-detailed',
    note: 'Cinematic + Detailed, combined.',
    prepare: withPresets(['preset-cinematic', 'preset-detailed']),
    turn: 'my face lits up mischievously\n\n"oh? is that so?"',
  },
];

const summary: Array<Record<string, unknown>> = [];

for (const scenario of SCENARIOS) {
  test(`dump ${scenario.name}`, async ({ page }) => {
    await page.goto('/');
    await resetDatabase(page);
    await page.reload();
    await boot(page);

    const ollama: MockOllama = await mockOllama(page, ['(mocked)'], 131072);
    await setupOllamaProvider(page);
    await seedHospitalScene(page, scenario.seed ?? {});
    if (scenario.prepare) await scenario.prepare(page);

    await goto(page, '#/chat/hospital-chat');
    await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeEditable();
    await composer.fill(scenario.turn);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => ollama.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const body = ollama.requests.at(-1)!.body;
    const dir = process.env.DUMP_PATH!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${scenario.name}.json`), JSON.stringify(body, null, 2));

    const system = body.messages.find((m: any) => m.role === 'system')?.content ?? '';
    const last = body.messages.at(-1);
    const chars = body.messages.reduce(
      (n: number, m: any) => n + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    summary.push({
      scenario: scenario.name,
      note: scenario.note,
      messages: body.messages.length,
      roles: body.messages.map((m: any) => m.role).join(','),
      approxPromptTokens: Math.round(chars / 3.8),
      options: body.options,
      presentLine: /Present: (.*)/.exec(system)?.[1] ?? '(none)',
      hasNarratorBrief: system.includes('## You are the narrator'),
      hasStyleBlock: system.includes('## Narration style'),
      // Scoped to the style block: the scene block also uses `- Name:` lines
      // for per-character state, and counting those as presets is misleading.
      styleLines: (
        (/## Narration style\n([\s\S]*?)(?:\n\n---|\n## |$)/.exec(system)?.[1] ?? '').match(
          /^- [^:]+:/gm,
        ) ?? []
      ).map((s: string) => s.trim()),
      lastMessageIsDirective:
        last?.role === 'system' && String(last.content).includes('## This turn'),
      attributedTurns: body.messages
        .filter((m: any) => m.role === 'assistant' && /^[A-Z][\w' -]{1,30}: /.test(m.content))
        .map((m: any) => String(m.content).split(':')[0]),
    });
    writeFileSync(join(dir, '_summary.json'), JSON.stringify(summary, null, 2));
  });
}
