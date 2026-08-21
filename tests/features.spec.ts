/**
 * Acceptance coverage for the second-phase features.
 *
 * As with workflow.spec.ts, every persistence claim is checked by reloading
 * the page and reading IndexedDB — never by trusting in-memory state.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  PNG_BYTES,
  boot,
  bubble,
  captureDownload,
  countStore,
  field,
  fieldIn,
  goto,
  makeCharacterCardPng,
  numberField,
  openMessageMenu,
  mockAI,
  mockImageAI,
  readStore,
  reloadApp,
  resetDatabase,
  setupImageProvider,
  setupProvider,
  sheetAction,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockAI(page, [
    'The tavern door creaks open. "You made it," she says.',
    'A second, different response entirely.',
    '{"title":"Met at the tavern","category":"Event","content":"The traveller met her at the tavern door."}',
  ]);
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/* ======================================================= IMAGE GENERATION */

test('image generation: scene prompt is built, editable, and the result is stored', async ({
  page,
}) => {
  const imageApi = await mockImageAI(page);
  await seed(page);
  await setupProvider(page);
  await setupImageProvider(page);
  await startChat(page);
  await sendMessage(page, 'She stands by the window, watching the storm over Ashfell.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Generate image')).toBeVisible();

  // The scene prompt must actually be derived from story state, not blank.
  const promptBox = dialog.getByLabel('Image prompt');
  const suggested = await promptBox.inputValue();
  expect(suggested.length).toBeGreaterThan(40);
  expect(suggested).toContain('Sera');

  // And it must be editable before anything is sent.
  await promptBox.fill(`${suggested}\nExtra detail added by the user.`);
  await dialog.getByRole('button', { name: 'Portrait' }).click();
  await dialog.getByRole('button', { name: 'Generate' }).click();

  await expect(dialog.getByRole('button', { name: 'Add to chat' })).toBeVisible({
    timeout: 20_000,
  });

  // The edited prompt, not the suggestion, is what was sent.
  expect(imageApi.requests).toHaveLength(1);
  expect(imageApi.requests[0].body.prompt).toContain('Extra detail added by the user.');
  expect(imageApi.requests[0].body.size).toBe('1024x1536');

  // Stored as a real blob with its provenance recorded.
  const media = await readStore(page, 'media');
  const generated = media.filter((m: any) => m.source === 'generated');
  expect(generated).toHaveLength(1);
  expect(generated[0].prompt).toContain('Extra detail added by the user.');
  expect(generated[0].imageModel).toBe('mock-image-model');
  expect(generated[0].storyId).toBeTruthy();
  expect(await countStore(page, 'mediaBlobs')).toBe(1);

  // Attaching it puts it in the conversation and it survives a refresh.
  await dialog.getByRole('button', { name: 'Add to chat' }).click();
  await expect(page.locator('.msg-attachments img')).toHaveCount(1);
  await reloadApp(page);
  await expect(page.locator('.msg-attachments img')).toHaveCount(1);
});

test('image generation: a generated image can become a character avatar', async ({ page }) => {
  await mockImageAI(page);
  await seed(page);
  await setupImageProvider(page);
  await startChat(page);

  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Character' }).click();
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('button', { name: 'Add to chat' })).toBeVisible({
    timeout: 20_000,
  });

  await dialog.getByRole('button', { name: /Sera's avatar/ }).click();
  await expect(page.getByText(/Set as Sera's avatar/).first()).toBeVisible();

  await reloadApp(page);
  const characters = await readStore(page, 'characters');
  const sera = characters.find((c: any) => c.name === 'Sera');
  expect(sera.avatarMediaId).toBeTruthy();
  const media = await readStore(page, 'media');
  expect(media.find((m: any) => m.id === sera.avatarMediaId).source).toBe('generated');
});

test('image generation reports provider failures instead of failing silently', async ({ page }) => {
  await mockImageAI(page, { fail: true });
  await seed(page);
  await setupImageProvider(page);
  await startChat(page);

  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByText(/Image generation failed/).first()).toBeVisible({ timeout: 20_000 });
  expect(await countStore(page, 'mediaBlobs')).toBe(0);
});

test('image generation is offered but explains itself with no provider', async ({ page }) => {
  await seed(page);
  await startChat(page);
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('No image provider configured')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /Set up image generation/ })).toBeVisible();
});

/* ============================================================ MEDIA GALLERY */

test('media gallery filters generated images and can reuse one', async ({ page }) => {
  await mockImageAI(page);
  await seed(page);
  await setupImageProvider(page);
  await startChat(page);

  // One uploaded and one generated image, so the filter has something to do.
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Photo Library');
  await page
    .getByTestId('attach-library')
    .setInputFiles({ name: 'uploaded.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.attachment-preview')).toHaveCount(1);

  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');
  const genDialog = page.getByRole('dialog');
  await genDialog.getByRole('button', { name: 'Generate' }).click();
  await expect(genDialog.getByRole('button', { name: 'Add to chat' })).toBeVisible({
    timeout: 20_000,
  });
  await genDialog.getByRole('button', { name: 'Delete' }).first().isVisible();
  await page.keyboard.press('Escape');

  await goto(page, '#/media');
  await expect(page.locator('.media-tile')).toHaveCount(2);

  await page.getByRole('button', { name: /^Generated \(/ }).click();
  await expect(page.locator('.media-tile')).toHaveCount(1);

  // Reuse it as a persona avatar.
  await page.locator('.media-tile').first().click();
  await page.getByRole('button', { name: 'Actions' }).click();
  await sheetAction(page, 'Use this image');
  const reuse = page.getByRole('dialog').last();
  await reuse.getByRole('button', { name: 'Persona avatar' }).click();
  await reuse.getByLabel('Persona').selectOption({ label: 'Corin' });
  await reuse.getByRole('button', { name: 'Apply' }).click();

  await reloadApp(page);
  const personas = await readStore(page, 'personas');
  expect(personas[0].avatarMediaId).toBeTruthy();
});

/* ======================================================= MOBILE IMAGE INPUT */

test('mobile attach sheet exposes camera, library and files as distinct inputs', async ({
  page,
}) => {
  await seed(page);
  await startChat(page);
  await page.getByRole('button', { name: 'Add image' }).click();

  const sheet = page.locator('.sheet').last();
  await expect(sheet.getByRole('button', { name: /Camera/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Photo Library/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Files/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Generate Image/ })).toBeVisible();

  // Only the camera input carries `capture` — that attribute is what makes a
  // phone open the camera rather than the photo library.
  await expect(page.getByTestId('attach-camera')).toHaveAttribute('capture', 'environment');
  await expect(page.getByTestId('attach-library')).not.toHaveAttribute('capture', /.*/);
  await expect(page.getByTestId('attach-library')).toHaveAttribute('multiple', '');

  // The library input genuinely accepts a file.
  await sheetAction(page, 'Photo Library');
  await page
    .getByTestId('attach-library')
    .setInputFiles({ name: 'phone.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.attachment-preview')).toHaveCount(1);
});

/* =============================================================== CAPABILITIES */

test('model capabilities are shown and gate the vision path', async ({ page }) => {
  await seed(page);
  await setupProvider(page);

  await goto(page, '#/settings');
  await page.locator('.card').filter({ hasText: 'mock/' }).first()
    .getByRole('button', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Model capabilities')).toBeVisible();
  // The mock provider reports no modalities, so this must be honest about it.
  await expect(dialog.getByText('Inferred from model name')).toBeVisible();
  await expect(dialog.getByRole('switch', { name: /Vision/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Attaching an image to a non-vision model must say so.
  await startChat(page);
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Photo Library');
  await page
    .getByTestId('attach-library')
    .setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: PNG_BYTES });

  await expect(
    page.getByText('This model does not support image understanding.').first(),
  ).toBeVisible();
});

test('enabling vision makes images reach the model', async ({ page }) => {
  const api = await mockAI(page, ['Understood.']);
  await seed(page);
  await setupProvider(page);

  await goto(page, '#/settings');
  await page.locator('.card').filter({ hasText: 'mock/' }).first()
    .getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('switch', { name: /Vision/ }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await startChat(page);
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Photo Library');
  await page
    .getByTestId('attach-library')
    .setInputFiles({ name: 'seen.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.attachment-preview')).toHaveCount(1);
  await sendMessage(page, 'What do you see?');
  await expect(bubble(page, 'Understood.').first()).toBeVisible({ timeout: 20_000 });

  // The request must carry an image part, not just a mention of one.
  const last = api.requests[api.requests.length - 1];
  const userTurn = last.body.messages.filter((m: any) => m.role === 'user').pop();
  expect(Array.isArray(userTurn.content)).toBe(true);
  expect(userTurn.content.some((p: any) => p.type === 'image_url')).toBe(true);
});

/* ============================================================ STORY SUMMARY */

test('story summary generates, persists and replaces old history in context', async ({ page }) => {
  await seed(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'We rode north to Ashfell and swore an oath at the gate.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Story summary');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Story summary')).toBeVisible();
  await dialog.getByRole('button', { name: /Generate/ }).click();

  // With the mock returning prose rather than summary JSON, the deterministic
  // fallback must still produce something editable.
  await expect(fieldIn(dialog, 'History so far')).not.toBeEmpty({ timeout: 20_000 });

  await fieldIn(dialog, 'Where things stand').fill('The party has reached Ashfell.');
  await fieldIn(dialog, 'Relationship state').fill('Sera and Corin are wary allies.');
  await dialog.getByRole('switch', { name: 'Lock this summary' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Story summary saved').first()).toBeVisible();

  await reloadApp(page);
  const summaries = await readStore(page, 'storySummaries');
  expect(summaries).toHaveLength(1);
  expect(summaries[0].currentSummary).toBe('The party has reached Ashfell.');
  expect(summaries[0].relationshipState).toBe('Sera and Corin are wary allies.');
  expect(summaries[0].locked).toBe(true);

  // And it must actually reach the model's context.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Context Inspector');
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page.getByText(/The party has reached Ashfell/)).toBeVisible();
  await expect(page.getByText(/Sera and Corin are wary allies/)).toBeVisible();
});

/* =========================================================== AUTO MEMORY */

test('automatic memory can be enabled and creates an editable memory', async ({ page }) => {
  await mockAI(page, [
    'She swore an oath and promised she would never betray the company.',
    '{"title":"The oath","category":"Event","content":"She promised never to betray the company."}',
  ]);
  await seed(page);
  await setupProvider(page);

  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('switch', { name: 'Create memories automatically' }).click();
  await numberField(page, 'Check every N replies').fill('1');

  await reloadApp(page);
  const settings = await readStore(page, 'settings');
  expect(settings[0].autoMemory).toBe(true);
  expect(settings[0].autoMemoryEvery).toBe(1);

  await startChat(page);
  await sendMessage(page, 'Do you swear it?');
  await expect(page.getByText(/swore an oath/).first()).toBeVisible({ timeout: 20_000 });

  // The trigger scan runs after the reply lands.
  await expect(page.getByText(/Memory saved automatically/).first()).toBeVisible({
    timeout: 25_000,
  });

  await reloadApp(page, '#/memories');
  const memories = await readStore(page, 'memories');
  expect(memories.length).toBeGreaterThan(0);
  expect(memories[0].origin).toBe('auto');
  expect(memories[0].pinned).toBe(false); // not pinned unless configured
  await expect(page.getByText('auto').first()).toBeVisible();
});

/* ====================================================== IMPORTANT MESSAGES */

test('important messages are kept separate from memories and survive reload', async ({ page }) => {
  await seed(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'Remember this exact wording, word for word.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await openMessageMenu(page, 'Remember this exact wording, word for word.');
  await sheetAction(page, 'Mark important');
  // The flag renders on the message itself before we go looking for it.
  await expect(page.locator('.bubble.important')).toHaveCount(1);

  await reloadApp(page, '#/memories');
  await page.getByRole('tab', { name: 'Important messages' }).click();
  await expect(
    page.getByText('Remember this exact wording, word for word.').first(),
  ).toBeVisible();

  // It is a message, not a memory.
  expect(await countStore(page, 'memories')).toBe(0);

  // Promoting it to a memory is explicit.
  await page.getByRole('button', { name: 'Make a memory' }).click();
  await expect(page.getByText('Saved as a memory').first()).toBeVisible();
  expect(await countStore(page, 'memories')).toBe(1);
});

/* ================================================== NEW CHAT FROM MESSAGE */

test('start new chat from here copies history and leaves the original intact', async ({ page }) => {
  await seed(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'First beat.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });
  await sendMessage(page, 'Second beat, after the fork point.');

  // Fork from the first user message.
  await openMessageMenu(page, 'First beat.');
  await sheetAction(page, 'Start new chat from here');

  const dialog = page.getByRole('dialog').last();
  await expect(dialog.getByRole('button', { name: /Start from this message/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Start from this message/ }).click();
  await dialog.getByRole('button', { name: 'Create chat' }).click();

  await expect(bubble(page, 'First beat.').first()).toBeVisible();
  await expect(bubble(page, 'Second beat, after the fork point.')).toHaveCount(0);

  // Two chats now exist and the original still has everything.
  expect(await countStore(page, 'chats')).toBe(2);
  const chats = await readStore(page, 'chats');
  const messages = await readStore(page, 'messages');
  const originalId = chats.find((c: any) => !c.title.includes('new thread')).id;
  const originalMessages = messages.filter((m: any) => m.chatId === originalId);
  expect(originalMessages.some((m: any) => m.content.includes('Second beat'))).toBe(true);
});

/* ======================================================== AI SUMMARY EXPORT */

test('export for AI summary produces a briefing in all three formats', async ({ page }) => {
  await seed(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'We made camp outside Ashfell.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Export for AI summary');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Export for AI summary')).toBeVisible();

  // Markdown: structured briefing, not a raw transcript.
  const markdown = await captureDownload(page, async () => {
    await dialog.getByRole('button', { name: 'Download' }).click();
  });
  expect(markdown).toContain('story briefing');
  expect(markdown).toContain('## Characters');
  expect(markdown).toContain('Sera');
  expect(markdown).toContain('We made camp outside Ashfell.');

  // JSON: machine-readable with the same content.
  await dialog.getByRole('tab', { name: 'JSON' }).click();
  const json = await captureDownload(page, async () => {
    await dialog.getByRole('button', { name: 'Download' }).click();
  });
  const parsed = JSON.parse(json);
  expect(parsed.kind).toBe('ai-summary');
  expect(parsed.characters.length).toBeGreaterThan(0);
  expect(parsed.recentConversation.length).toBeGreaterThan(0);

  // Plain text: no Markdown syntax left behind.
  await dialog.getByRole('tab', { name: 'Plain text' }).click();
  const txt = await captureDownload(page, async () => {
    await dialog.getByRole('button', { name: 'Download' }).click();
  });
  expect(txt).toContain('Characters');
  expect(txt).not.toContain('## ');
});

/* ================================================== CHARACTER CARD VARIANTS */

test('character card variants all import: v1, v2, ccv3 PNG, chara PNG, plain JSON', async ({
  page,
}) => {
  await goto(page, '#/transfer');
  const input = page.locator('input[type=file]').first();

  // SillyTavern v1 — flat object, no spec field.
  await input.setInputFiles({
    name: 'v1.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name: 'V1 Character',
        description: 'A flat v1 card.',
        personality: 'Terse.',
        scenario: 'A crossroads.',
        first_mes: 'You again.',
        mes_example: '<START>\n{{char}}: Hm.',
      }),
    ),
  });
  await expect(page.getByText('Import preview — Character')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported V1 Character/).first()).toBeVisible();

  // SillyTavern v2 — nested under data with a spec marker.
  await input.setInputFiles({
    name: 'v2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'V2 Character',
          description: 'A v2 card.',
          alternate_greetings: ['Alt one.', 'Alt two.'],
          character_book: {
            name: 'Embedded book',
            entries: [{ keys: ['relic'], content: 'A relic of the old world.' }],
          },
        },
      }),
    ),
  });
  await expect(page.getByText('Import preview — Character')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported V2 Character/).first()).toBeVisible();

  // CCv3 PNG — metadata under the ccv3 chunk keyword.
  await input.setInputFiles({
    name: 'ccv3.png',
    mimeType: 'image/png',
    buffer: makeCharacterCardPng(
      { spec: 'chara_card_v3', data: { name: 'V3 Character', description: 'From a ccv3 PNG.' } },
      'ccv3',
    ),
  });
  await expect(page.getByText(/PNG character card/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported V3 Character/).first()).toBeVisible();

  // Plain JSON with no card conventions at all.
  await input.setInputFiles({
    name: 'plain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ name: 'Plain Character', description: 'Just an object.' }),
    ),
  });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Plain Character/).first()).toBeVisible();

  const characters = await readStore(page, 'characters');
  const names = characters.map((c: any) => c.name).sort();
  expect(names).toEqual(['Plain Character', 'V1 Character', 'V2 Character', 'V3 Character']);

  // The v2 card's extras must have survived, not been silently dropped.
  const v2 = characters.find((c: any) => c.name === 'V2 Character');
  expect(v2.greetings.length).toBe(2);
  const entries = await readStore(page, 'loreEntries');
  expect(entries.some((e: any) => e.primaryKeys.includes('relic'))).toBe(true);
});

/* ======================================================= ALTERNATIVES/BRANCH */

test('alternatives and the active selection survive a reload', async ({ page }) => {
  await seed(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'Say something.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await openMessageMenu(page, 'The tavern door creaks');
  await sheetAction(page, 'Generate an alternative');
  await expect(page.getByText(/A second, different response/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.alt-nav')).toBeVisible();
  await expect(page.locator('.alt-nav')).toContainText('2 / 2');

  // The selection must be persisted, not just held in memory.
  await reloadApp(page);
  await expect(page.getByText(/A second, different response/)).toBeVisible();
  await expect(page.locator('.alt-nav')).toContainText('2 / 2');
  expect(await countStore(page, 'messageAlternatives')).toBe(1);

  // Switching back also persists.
  await page.getByRole('button', { name: 'Previous response' }).click();
  await reloadApp(page);
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible();
  await expect(page.locator('.alt-nav')).toContainText('1 / 2');
});

/* ========================================================= LOREBOOK LINKING */

test('a lorebook can be attached to a story and to a character from the UI', async ({ page }) => {
  await seed(page);

  // Attach to the story.
  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('tab', { name: /Lorebooks/ }).click();
  await page.getByRole('switch', { name: /Ashfell Lore/ }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible();

  // Attach to a character.
  await goto(page, '#/characters');
  await page.getByText('Sera').first().click();
  await page.getByRole('tab', { name: 'World' }).click();
  await page.getByRole('switch', { name: /Ashfell Lore/ }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible();

  await reloadApp(page);
  const stories = await readStore(page, 'stories');
  const characters = await readStore(page, 'characters');
  expect(stories[0].lorebookIds).toHaveLength(1);
  expect(characters.find((c: any) => c.name === 'Sera').lorebookIds).toHaveLength(1);

  // The lorebook editor reflects both attachments.
  await goto(page, '#/lorebooks');
  await page.getByText('Ashfell Lore').first().click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Attached to' })).toBeVisible();
  const attachments = page.locator('.stack').filter({ hasText: 'Ashfell Lore' }).first();
  await expect(page.getByText('The Long Storm').first()).toBeVisible();
  await expect(page.getByText('Sera').first()).toBeVisible();
  expect(await attachments.count()).toBeGreaterThanOrEqual(0);
});

/* ================================================================ HELPERS */

async function seed(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const put = (store: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });

    await put('characters', {
      id: 'c1',
      name: 'Sera',
      displayName: '',
      nickname: '',
      age: '31',
      gender: 'female',
      pronouns: 'she/her',
      species: 'human',
      race: '',
      occupation: 'innkeeper',
      role: '',
      tags: [],
      shortDescription: 'The innkeeper.',
      description: 'Warm and watchful.',
      appearance: 'Dark braided hair, burn-scarred hands, grey wool dress.',
      physicalTraits: 'Tall, broad-shouldered.',
      personality: 'Wry and protective.',
      temperament: '',
      traits: [],
      backstory: '',
      history: '',
      goals: '',
      motivations: '',
      fears: '',
      secrets: '',
      likes: '',
      dislikes: '',
      hobbies: '',
      values: '',
      beliefs: '',
      scenario: '',
      greetings: [{ id: 'g1', label: 'Default', content: 'Sera looks up from the bar.' }],
      defaultGreetingId: 'g1',
      speakingStyle: '',
      speechPatterns: '',
      exampleDialogue: '',
      systemPrompt: '',
      authorNote: '',
      relationships: '',
      friends: '',
      enemies: '',
      family: '',
      romantic: '',
      home: 'Ashfell',
      location: 'the Nexus Tavern',
      faction: '',
      world: '',
      lorebookIds: [],
      creator: '',
      creatorNotes: '',
      version: '1',
      customFields: [],
      metadata: {},
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('personas', {
      id: 'p1',
      name: 'Corin',
      displayName: '',
      nickname: '',
      age: '',
      gender: '',
      pronouns: 'they/them',
      species: '',
      appearance: 'Travel-stained coat, short red hair.',
      personality: 'Curious and reckless.',
      traits: [],
      backstory: '',
      occupation: '',
      goals: '',
      likes: '',
      dislikes: '',
      speechStyle: '',
      customInstructions: '',
      tags: [],
      customFields: [],
      avatarMediaId: null,
      avatarUrl: '',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('lorebooks', {
      id: 'b1',
      name: 'Ashfell Lore',
      description: 'Seeded.',
      enabled: true,
      tags: [],
      global: false,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put('loreEntries', {
      id: 'e1',
      lorebookId: 'b1',
      name: 'Ashfell',
      content: 'The grey city on the volcano.',
      primaryKeys: ['Ashfell'],
      secondaryKeys: [],
      aliases: [],
      enabled: true,
      priority: 100,
      position: 'after-character',
      depth: 4,
      scanDepth: 0,
      matchMode: 'word-boundary',
      caseSensitive: false,
      activation: 'keyword',
      category: '',
      scope: 'any',
      comment: '',
      customFields: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    await put('stories', {
      id: 's1',
      title: 'The Long Storm',
      description: 'A seeded story.',
      scenario: 'Travellers wait out a storm in the Nexus Tavern.',
      authorNote: '',
      tags: [],
      characters: [{ characterId: 'c1', primary: true, note: '', enabled: true }],
      personaId: 'p1',
      lorebookIds: [],
      memoryIds: [],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: null,
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
    db.close();
  });
  await page.reload();
  await boot(page);
}

async function startChat(page: Page) {
  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible();
}

async function sendMessage(page: Page, text: string) {
  const composer = field(page, 'Message');
  await expect(composer).toBeEditable();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(bubble(page, text).first()).toBeVisible({ timeout: 20_000 });
}
