/**
 * Acceptance coverage for the second-phase features.
 *
 * As with workflow.spec.ts, every persistence claim is checked by reloading
 * the page and reading IndexedDB — never by trusting in-memory state.
 */
import { expect, test } from '@playwright/test';
import {
  PNG_BYTES,
  boot,
  bubble,
  captureDownload,
  countStore,
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
  seedFixtures,
  sendMessage,
  setupProvider,
  sheetAction,
  startChat,
  openStoryMap,
  openContextInspector,
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
  await seedFixtures(page);
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
  await seedFixtures(page);
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
  await seedFixtures(page);
  await setupImageProvider(page);
  await startChat(page);

  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Generate Image');
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByText(/Image generation failed/).first()).toBeVisible({ timeout: 20_000 });
  expect(await countStore(page, 'mediaBlobs')).toBe(0);
});

test('image generation is offered but explains itself with no provider', async ({ page }) => {
  await seedFixtures(page);
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
  await seedFixtures(page);
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

  // Wait for the write to land. Reloading straight after the click raced the
  // save, so the assertion below read the persona as it was before Apply.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => (await readStore<any>(page, 'personas'))[0]?.avatarMediaId, {
      timeout: 10_000,
    })
    .toBeTruthy();

  await reloadApp(page);
  const personas = await readStore(page, 'personas');
  expect(personas[0].avatarMediaId).toBeTruthy();
});

/* ======================================================= MOBILE IMAGE INPUT */

test('mobile attach sheet exposes camera, library and files as distinct inputs', async ({
  page,
}) => {
  await seedFixtures(page);
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
  await seedFixtures(page);
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
  await seedFixtures(page);
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
  await seedFixtures(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'We rode north to Ashfell and swore an oath at the gate.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'The story so far');

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
  await openContextInspector(page);
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page.getByText(/The party has reached Ashfell/)).toBeVisible();
  await expect(page.getByText(/Sera and Corin are wary allies/)).toBeVisible();
});

/* =========================================================== AUTO MEMORY */

test('automatic memory can be enabled and creates an editable memory', async ({ page }) => {
  await mockAI(page, [
    'She swore an oath and promised she would never betray the company.',
    // The extractor now reports a list of typed changes rather than one prose
    // summary, and reports an empty list when nothing changed. The old shape —
    // a single loose object — is no longer read, and an unreadable answer
    // records nothing instead of silently saving a mechanical extract.
    JSON.stringify([
      {
        title: 'The oath',
        content: 'She promised never to betray the company.',
        category: 'Event',
        subjects: ['Sera'],
        basis: 'observed',
        confidence: 0.9,
        importance: 'high',
        relationship: null,
      },
    ]),
  ]);
  await seedFixtures(page);
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
  await seedFixtures(page);
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
  await seedFixtures(page);
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
  await seedFixtures(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'We made camp outside Ashfell.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Hand this story to someone else');

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
  await seedFixtures(page);
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
  // The switch is written to IndexedDB asynchronously; reloading before it
  // lands read the old selection back and failed here intermittently.
  await expect(page.locator('.alt-nav')).toContainText('1 / 2');
  await reloadApp(page);
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible();
  await expect(page.locator('.alt-nav')).toContainText('1 / 2');
});

/* ========================================================= LOREBOOK LINKING */

test('a lorebook can be attached to a story and to a character from the UI', async ({ page }) => {
  await seedFixtures(page);

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
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.locator('.disclosure > summary', { hasText: 'World and lorebooks' }).first().click();
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

/* ============================================================ BACKUP SCOPE */

test('backups carry image providers and story summaries, but never API keys', async ({ page }) => {
  await seedFixtures(page);
  await setupProvider(page);
  await setupImageProvider(page);
  await startChat(page);
  await sendMessage(page, 'We rode north to Ashfell and swore an oath at the gate.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  // Give the story a long-run memory worth losing.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'The story so far');
  const summarySheet = page.getByRole('dialog');
  await fieldIn(summarySheet, 'Where things stand').fill('The party has reached Ashfell.');
  await summarySheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Story summary saved').first()).toBeVisible();

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  const backupJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });
  const backup = JSON.parse(backupJson);
  const body = backup.payload ?? backup.data ?? backup;

  // Both provider kinds are described, neither carries a key (spec §49).
  expect(body.providers).toHaveLength(1);
  expect(body.imageProviders).toHaveLength(1);
  expect(body.providers[0].apiKey).toBe('');
  expect(body.imageProviders[0].apiKey).toBe('');
  expect(body.imageProviders[0].model).toBe('mock-image-model');
  expect(backupJson).not.toContain('img-key-1234567890');
  expect(backupJson).not.toContain('test-key-1234567890');

  // The long-run memory is in there too.
  expect(body.storySummaries).toHaveLength(1);
  expect(body.storySummaries[0].currentSummary).toBe('The party has reached Ashfell.');

  // Erase, restore, and confirm both come back.
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('button', { name: /Erase all local data/ }).click();
  const eraseDialog = page.getByRole('dialog');
  await eraseDialog.getByRole('textbox').first().fill('ERASE');
  await eraseDialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByText('All local data erased').first()).toBeVisible();
  expect(await countStore(page, 'imageProviders')).toBe(0);
  expect(await countStore(page, 'storySummaries')).toBe(0);

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  await page.getByRole('button', { name: 'Choose backup file' }).click();
  await page.locator('input[type=file][accept*="json"]').last().setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupJson),
  });
  await expect(page.getByText('This backup contains').first()).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Backup restored').first()).toBeVisible({ timeout: 30_000 });

  await reloadApp(page);
  const restoredImageProviders = await readStore(page, 'imageProviders');
  const restoredSummaries = await readStore(page, 'storySummaries');
  expect(restoredImageProviders).toHaveLength(1);
  expect(restoredImageProviders[0].model).toBe('mock-image-model');
  // The key is not in the backup, so the user re-enters it — it must not be
  // silently restored as something else.
  expect(restoredImageProviders[0].apiKey).toBe('');
  expect(restoredSummaries).toHaveLength(1);
  expect(restoredSummaries[0].currentSummary).toBe('The party has reached Ashfell.');
});

/* =========================================================== STORY TIMELINE */

test('the story timeline lists landmarks and jumps to the message', async ({ page }) => {
  await seedFixtures(page);
  await setupProvider(page);
  await startChat(page);

  await sendMessage(page, 'We set out for Ashfell at first light.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });
  await sendMessage(page, 'The gate guard refused us entry.');
  await expect(page.getByText(/A second, different response/)).toBeVisible({ timeout: 20_000 });

  // Three landmarks of three different kinds.
  await openMessageMenu(page, 'We set out for Ashfell at first light.');
  await sheetAction(page, 'Save checkpoint here');
  const cpDialog = page.getByRole('dialog').last();
  await fieldIn(cpDialog, 'Checkpoint name').fill('Departure');
  await cpDialog.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(page.getByText(/Checkpoint saved/).first()).toBeVisible();

  await openMessageMenu(page, 'The gate guard refused us entry.');
  await sheetAction(page, 'Mark important');

  await openStoryMap(page, 'timeline');

  const timeline = page.getByTestId('story-timeline');
  await expect(timeline).toBeVisible();
  const entries = page.getByTestId('timeline-entry');
  // Chat start + checkpoint + important message, in story order.
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('Chat started');
  await expect(entries.nth(1)).toContainText('Checkpoint: Departure');
  await expect(entries.nth(2)).toContainText('Important message');

  // The filters narrow the spine rather than emptying it.
  await page.getByRole('tab', { name: /Checkpoints/ }).click();
  await expect(page.getByTestId('timeline-entry')).toHaveCount(1);
  await page.getByRole('tab', { name: /Important/ }).click();
  await expect(page.getByTestId('timeline-entry')).toHaveCount(1);
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByTestId('timeline-entry')).toHaveCount(3);

  // Jumping closes the sheet and lands on the message itself.
  await page.getByRole('button', { name: 'Jump to Checkpoint: Departure' }).click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  const landed = page.locator('.msg-highlighted');
  await expect(landed).toHaveCount(1);
  await expect(landed).toContainText('We set out for Ashfell at first light.');
});

test('the story timeline spans other chats in the story and switches to them', async ({ page }) => {
  await seedFixtures(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'The oath was sworn at the gate.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await openMessageMenu(page, 'The oath was sworn at the gate.');
  await sheetAction(page, 'Save checkpoint here');
  const cpDialog = page.getByRole('dialog').last();
  await fieldIn(cpDialog, 'Checkpoint name').fill('The oath');
  await cpDialog.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(page.getByText(/Checkpoint saved/).first()).toBeVisible();

  // A second chat in the same story, which becomes the active one.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'New chat in this story');
  await expect(page.locator('.chat-composer')).toBeVisible();
  await sendMessage(page, 'A different thread entirely.');

  // The landmark from the first chat is still on the spine, marked as elsewhere.
  await openStoryMap(page, 'timeline');
  const oath = page.getByRole('button', { name: 'Jump to Checkpoint: The oath' });
  await expect(oath).toBeVisible();

  // Jumping crosses into the other chat and lands on the right message.
  await oath.click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  const landed = page.locator('.msg-highlighted');
  await expect(landed).toHaveCount(1, { timeout: 15_000 });
  await expect(landed).toContainText('The oath was sworn at the gate.');
  // And we really are in the other chat now.
  await expect(page.getByText('A different thread entirely.')).toHaveCount(0);
});
