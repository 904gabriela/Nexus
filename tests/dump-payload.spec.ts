/** Not a regression test: dumps the real Reiko/Bakugo payload for review. */
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { boot, goto, mockOllama, resetDatabase, setupOllamaProvider } from './helpers';
import { seedHospitalScene } from './scene-fixture';

// Opt-in: this writes a file for human review rather than asserting anything,
// so it stays out of the regression suite unless a path is given.
test.skip(!process.env.DUMP_PATH, 'set DUMP_PATH to dump the payload');

test('dump', async ({ page }) => {
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
  const ollama = await mockOllama(page, ['Bakugo scowls.'], 8192);
  await setupOllamaProvider(page);
  await seedHospitalScene(page, { castKirishima: true });

  await goto(page, '#/chat/hospital-chat');
  await expect(page.locator('.chat-composer')).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  // The benchmark turn verbatim: a short expression plus a short line, which
  // is the shape that used to draw a one-sentence conversational answer.
  await composer.fill('my face lits up mischievously\n\n"oh? is that so?"');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => ollama.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

  const body = ollama.requests.at(-1)!.body;
  const out = process.env.DUMP_PATH!;
  writeFileSync(out, JSON.stringify(body, null, 2));
  writeFileSync(
    out.replace('.json', '.system.txt'),
    body.messages.find((m: any) => m.role === 'system')?.content ?? '',
  );
});
