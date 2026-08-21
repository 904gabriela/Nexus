/**
 * Mobile UX audit.
 *
 * Every control a finger can reach must be at least MIN_TOUCH px on its
 * smaller side, and no surface may scroll horizontally. Both are measured from
 * the rendered layout at the two viewports the specification calls out — 390px
 * (iPhone 12–15) and 412px (Pixel and most Android) — rather than eyeballed.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  field,
  goto,
  mockAI,
  openMessageMenu,
  resetDatabase,
  seedFixtures,
  sendMessage,
  setupProvider,
  sheetAction,
  startChat,
} from './helpers';

const MIN_TOUCH = 44;
const VIEWPORTS = [
  { name: '390px iPhone', width: 390, height: 844 },
  { name: '412px Pixel', width: 412, height: 915 },
];

interface Violation {
  surface: string;
  kind: string;
  detail: string;
}

/**
 * Controls that are legitimately not finger targets: file inputs hidden behind
 * a visible button, and anything explicitly hidden from assistive tech.
 */
const EXEMPT = ['input[type=file]', '[aria-hidden="true"]', '.sr-only'];

async function auditSurface(page: Page, surface: string): Promise<Violation[]> {
  return page.evaluate(
    ({ surfaceName, min, exempt }) => {
      const found: Violation[] = [];

      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 1) {
        found.push({
          surface: surfaceName,
          kind: 'horizontal-overflow',
          detail: `${doc.scrollWidth}px of content in a ${doc.clientWidth}px viewport`,
        });
      }

      const selector =
        'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"]';
      const seen = new Set<string>();

      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (exempt.some((ex) => el.matches(ex) || el.closest(ex))) continue;

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const box = el.getBoundingClientRect();
        // Not laid out (collapsed section, closed sheet) — nothing to tap.
        if (box.width === 0 || box.height === 0) continue;

        // Text entry stretches to the form column, so only its height matters.
        const isTextEntry =
          el.tagName === 'TEXTAREA' ||
          (el.tagName === 'INPUT' &&
            !['checkbox', 'radio', 'file'].includes((el as HTMLInputElement).type));

        const smallest = isTextEntry ? box.height : Math.min(box.width, box.height);
        if (smallest >= min - 0.5) continue;

        const label =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          (el.textContent || '').trim().slice(0, 40) ||
          `${el.tagName.toLowerCase()}.${el.className}`;
        const key = `${label}|${Math.round(box.width)}x${Math.round(box.height)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        found.push({
          surface: surfaceName,
          kind: 'touch-target',
          detail: `"${label}" is ${Math.round(box.width)}×${Math.round(box.height)}px, needs ${min}px`,
        });
      }

      return found;
    },
    { surfaceName: surface, min: MIN_TOUCH, exempt: EXEMPT },
  ) as Promise<Violation[]>;
}

/** Dismisses the topmost sheet the way a thumb does — via its Close button. */
async function closeSheet(page: Page) {
  await page.locator('.sheet').last().getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.sheet')).toHaveCount(0);
}

function report(surface: string, violations: Violation[]): string {
  if (!violations.length) return '';
  return `\n${surface}:\n${violations.map((v) => `  ${v.kind}: ${v.detail}`).join('\n')}`;
}

for (const viewport of VIEWPORTS) {
  test.describe(`mobile UX at ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAI(page, ['The tavern door creaks open. "You made it," she says.']);
      await page.goto('/');
      await resetDatabase(page);
      await page.reload();
      await boot(page);
    });

    test('navigation, list pages and editors are reachable by thumb', async ({ page }) => {
      const violations: Violation[] = [];
      let detail = '';

      const collect = async (surface: string) => {
        const found = await auditSurface(page, surface);
        violations.push(...found);
        detail += report(surface, found);
      };

      await collect('dashboard + bottom nav');

      for (const route of [
        'stories',
        'characters',
        'personas',
        'lorebooks',
        'memories',
        'media',
        'transfer',
        'search',
        'settings',
      ]) {
        await goto(page, `#/${route}`);
        await collect(`${route} page`);
      }

      // Editors are full-screen routes with the densest control layout.
      for (const [route, surface] of [
        ['#/character/new', 'character editor'],
        ['#/persona/new', 'persona editor'],
        ['#/lorebook/new', 'lorebook editor'],
        ['#/story/new', 'story editor'],
      ]) {
        await goto(page, route);
        await collect(surface);
      }

      expect(violations, `Mobile UX violations at ${viewport.name}:${detail}`).toEqual([]);
    });

    test('chat, composer, sheets and inspector are reachable by thumb', async ({ page }) => {
      await seedFixtures(page);
      await setupProvider(page);
      await startChat(page);

      const violations: Violation[] = [];
      let detail = '';
      const collect = async (surface: string) => {
        const found = await auditSurface(page, surface);
        violations.push(...found);
        detail += report(surface, found);
      };

      await collect('empty chat + composer');

      // The composer must stay inside the viewport, not scroll off the bottom.
      const composer = page.locator('.chat-composer');
      const box = await composer.boundingBox();
      expect(box, 'the composer has a layout box').not.toBeNull();
      expect(
        Math.round(box!.y + box!.height),
        'the composer sits inside the viewport',
      ).toBeLessThanOrEqual(viewport.height);

      // Attachment sheet: camera / library / files / generate. Sheets are
      // dismissed the way a thumb does it — the Close button, not Escape.
      await page.getByRole('button', { name: 'Add image' }).click();
      await expect(page.locator('.sheet').last()).toBeVisible();
      await collect('attachment sheet');
      await closeSheet(page);

      await sendMessage(page, 'Hello there.');
      await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });
      await collect('chat with messages');

      // Message action bottom sheet.
      await openMessageMenu(page, 'Hello there.');
      await collect('message action sheet');
      await closeSheet(page);

      // Chat menu → branches.
      await page.getByRole('button', { name: 'Chat menu' }).click();
      await expect(page.locator('.sheet').last()).toBeVisible();
      await collect('chat menu sheet');
      await sheetAction(page, /Branches/);
      await expect(page.locator('.sheet').last()).toBeVisible();
      await collect('branch panel');
      await closeSheet(page);

      // Context inspector.
      await page.getByRole('button', { name: /Context: .* Open inspector/ }).click();
      await expect(page.getByRole('button', { name: 'Close context inspector' })).toBeVisible();
      await collect('context inspector');
      await page.getByRole('button', { name: 'Close context inspector' }).click();

      expect(violations, `Mobile UX violations at ${viewport.name}:${detail}`).toEqual([]);
    });

    test('the on-screen keyboard does not bury the composer', async ({ page }) => {
      await seedFixtures(page);
      await setupProvider(page);
      await startChat(page);

      // A focused composer with several lines of text must keep its send button
      // on screen; this is what breaks when a layout uses 100vh on mobile.
      const input = field(page, 'Message');
      await input.click();
      await input.fill('One\nTwo\nThree\nFour\nFive\nSix');

      const send = page.getByRole('button', { name: 'Send message' });
      const sendBox = await send.boundingBox();
      expect(sendBox, 'the send button is laid out').not.toBeNull();
      expect(Math.round(sendBox!.y + sendBox!.height)).toBeLessThanOrEqual(viewport.height);
      expect(Math.min(sendBox!.width, sendBox!.height)).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5);

      // The message list must still scroll independently, not push the page.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'no horizontal overflow with the composer expanded').toBeLessThanOrEqual(1);
    });
  });
}
