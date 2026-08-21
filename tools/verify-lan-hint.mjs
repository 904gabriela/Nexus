// The phone-pointing-at-itself mistake, reproduced rather than reasoned about.
//
// The page is loaded over a real LAN address, exactly as a phone would load it,
// and then given the loopback base URL that works on the PC. The app must name
// the mistake instead of reporting a generic connection failure.
import { chromium } from '@playwright/test';

const BASE = process.env.LAN_BASE; // must be a LAN address, not 127.0.0.1
if (!BASE || /(^|\/\/)(localhost|127\.|\[::1\])/.test(BASE)) {
  console.error('LAN_BASE must be a non-loopback address, e.g. http://192.0.2.2:4173');
  process.exit(2);
}

const results = [];
const record = (s, ok, note = '') => {
  results.push({ s, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
})).newPage();

await page.goto(`${BASE}/#/settings`);
await page.waitForSelector('.app-shell', { timeout: 20000 });
console.log(`   page origin: ${await page.evaluate(() => location.origin)}`);

await page.getByRole('button', { name: /Add provider|Add another provider/ }).first().click();
await page.waitForTimeout(500);
const dlg = page.getByRole('dialog');
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:11434/v1');
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(2500);

const text = await dlg.innerText();
record('the loopback mistake is named, not reported as a generic failure',
  /means "this device"/i.test(text));
record('it says what to use instead', /address on your network/i.test(text));
record('it does not blame CORS or the firewall for this case',
  !/CORS/i.test(text.split('means "this device"')[1] ?? ''));
console.log(`\n   message: ${(text.match(/[^\n]*means "this device"[^\n]*(\n[^\n]*)?/) ?? [""])[0]}`);

// A correct LAN URL must NOT be blocked by the same check.
await dlg.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://192.0.2.9:11434/v1');
await dlg.getByRole('button', { name: 'Fetch models' }).click();
await page.waitForTimeout(2500);
const lanText = await dlg.innerText();
record('a genuine LAN address is not rejected by the loopback check',
  !/means "this device"/i.test(lanText),
  'it fails to connect, but for the real reason');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
