/**
 * The 90-step acceptance workflow from the specification, executed against the
 * real UI and the real IndexedDB database. Every "verify it persisted" step
 * reloads the page so nothing can pass on in-memory state alone.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  PNG_BYTES,
  field,
  fieldIn,
  boot,
  captureDownload,
  confirmDialog,
  countStore,
  goto,
  makeCharacterCardPng,
  reloadApp,
  saveAndSettle,
  bubble,
  openMessageMenu,
  mockAI,
  readStore,
  resetDatabase,
  setupProvider,
  sheetAction,
} from './helpers';

/** Expands one of the character editor's collapsed sections. */
async function openSection(page: Page, title: string) {
  await page.locator('.disclosure > summary', { hasText: title }).first().click();
}

test.beforeEach(async ({ page }) => {
  await mockAI(page, [
    'The tavern door creaks open. "You made it," she says.',
    'A second, different response entirely.',
    'A third response, generated with an instruction.',
    '{"title":"Met at the tavern","category":"Event","content":"The traveller met her at the tavern door."}',
  ]);
  await page.goto('/');
  await resetDatabase(page);
  await page.reload();
  await boot(page);
});

/* ================================================================ CHARACTER */

test('steps 1-9: create a character with every field, an avatar, then edit it', async ({ page }) => {
  await goto(page, '#/character/new');

  // 2. The five fields a character actually needs are the ones on screen.
  await field(page, 'Name').fill('Seraphine Vale');
  await field(page, 'Description').fill('Warm, watchful, and impossible to lie to.');
  await field(page, 'Personality').fill('Wry, protective, quietly grieving.');
  await page.getByRole('button', { name: 'Add greeting' }).click();
  await field(page, 'Greeting 1 text').fill('*She looks up from the bar.* "Sit anywhere you like."');

  // 3. Upload an avatar from the device gallery.
  await page
    .locator('input[type=file][accept*="image"]')
    .first()
    .setInputFiles({ name: 'sera.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.image-picker-preview img')).toBeVisible();

  // Everything else is a tab away and folded until asked for. Nothing was
  // dropped in the simplification — every field is still here.
  await page.getByRole('tab', { name: 'Details' }).click();
  await openSection(page, 'Identity');
  await field(page, 'Display name').fill('Sera');
  await field(page, 'Age').fill('27');
  await field(page, 'Pronouns').fill('she/her');
  await field(page, 'Occupation').fill('Innkeeper');

  await openSection(page, 'Appearance and manner');
  await field(page, 'Short description').fill('The innkeeper of the Nexus Tavern.');

  await openSection(page, 'Background');
  await field(page, 'Backstory').fill('She inherited the tavern from her mother.');
  await field(page, 'Secrets').fill('The cellar door has not been opened in ten years.');

  await openSection(page, 'World and lorebooks');
  await field(page, 'Scenario').fill('A storm has trapped travellers inside the tavern.');

  // 4. Save.
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/Saved "Seraphine Vale"/).first()).toBeVisible();

  // 5-6. Refresh and verify everything survived, avatar included.
  await page.reload();
  await boot(page, '#/characters');
  await expect(page.getByText('Seraphine Vale').first()).toBeVisible();

  const characters = await readStore(page, 'characters');
  expect(characters).toHaveLength(1);
  expect(characters[0].name).toBe('Seraphine Vale');
  expect(characters[0].displayName).toBe('Sera');
  expect(characters[0].secrets).toContain('cellar door');
  expect(characters[0].greetings).toHaveLength(1);
  expect(characters[0].avatarMediaId).toBeTruthy();
  expect(await countStore(page, 'mediaBlobs')).toBe(1);

  // 7-9. Edit, save, verify.
  await page.getByText('Seraphine Vale').first().click();
  await page.getByRole('tab', { name: 'Details' }).click();
  await openSection(page, 'Identity');
  await field(page, 'Nickname').fill('Sera of the Vale');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/^Saved /).first()).toBeVisible();

  await page.reload();
  const after = await readStore(page, 'characters');
  expect(after[0].nickname).toBe('Sera of the Vale');
  expect(after[0].avatarMediaId).toBe(characters[0].avatarMediaId);
});

/* ================================================================== PERSONA */

test('steps 10-16: create a persona with an avatar, verify persistence, edit', async ({ page }) => {
  await goto(page, '#/persona/new');
  await field(page, 'Name').fill('Corin Ashe');
  await page
    .locator('input[type=file][accept*="image"]')
    .first()
    .setInputFiles({ name: 'corin.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.image-picker-preview img')).toBeVisible();

  await page.getByRole('tab', { name: 'Profile' }).click();
  await field(page, 'Personality').fill('Curious, reckless, allergic to silence.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/Saved "Corin Ashe"/).first()).toBeVisible();

  await page.reload();
  await boot(page, '#/personas');
  await expect(page.getByText('Corin Ashe').first()).toBeVisible();

  const personas = await readStore(page, 'personas');
  expect(personas[0].avatarMediaId).toBeTruthy();
  expect(personas[0].personality).toContain('reckless');

  await page.getByText('Corin Ashe').first().click();
  await field(page, 'Nickname').fill('Cor');
  // Save is asynchronous; reloading on the next line read back the persona as
  // it was before the click.
  await saveAndSettle(page);
  await page.reload();
  expect((await readStore(page, 'personas'))[0].nickname).toBe('Cor');
});

/* ================================================================= LOREBOOK */

test('steps 17-28: full lorebook entry lifecycle', async ({ page }) => {
  await goto(page, '#/lorebooks');
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('tab', { name: /Entries/ })).toBeVisible();

  // 19. Add multiple entries.
  for (const [name, keys, content] of [
    ['Ashfell', 'Ashfell, the grey city', 'A grey city built on a dormant volcano.'],
    ['The Cellar', 'cellar, basement', 'Sealed for ten years. Something is down there.'],
    ['Storm Season', 'storm, rain', 'Storms roll in every autumn and last for weeks.'],
  ] as const) {
    await page.getByRole('button', { name: 'Add entry' }).click();
    const dialog = page.getByRole('dialog');
    await fieldIn(dialog, 'Name').fill(name);
    await fieldIn(dialog, 'Content').fill(content);
    await fieldIn(dialog, 'Primary keywords').fill(keys);
    await fieldIn(dialog, 'Primary keywords').press('Enter');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Entry saved').first()).toBeVisible();
  }
  expect(await countStore(page, 'loreEntries')).toBe(3);

  // 20-21. Edit an entry and add more keywords.
  await page.getByText('Ashfell', { exact: true }).first().click();
  const editor = page.getByRole('dialog');
  await fieldIn(editor, 'Content').fill('A grey city built on a dormant volcano. Ruled by the Ash Council.');
  await fieldIn(editor, 'Secondary keywords').fill('council');
  await fieldIn(editor, 'Secondary keywords').press('Enter');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Entry saved').first()).toBeVisible();

  // 22-23. Disable then re-enable.
  await page.getByRole('button', { name: /Actions for The Cellar/ }).click();
  await sheetAction(page, 'Disable entry');
  await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /Actions for The Cellar/ }).click();
  await sheetAction(page, 'Enable entry');
  await expect(page.getByText('Disabled', { exact: true })).toHaveCount(0);

  // 24. Duplicate.
  await page.getByRole('button', { name: /Actions for Storm Season/ }).click();
  await sheetAction(page, 'Duplicate');
  await expect(page.getByText('Storm Season (copy)').first()).toBeVisible();
  expect(await countStore(page, 'loreEntries')).toBe(4);

  // 25. Delete the duplicate.
  await page.getByRole('button', { name: /Actions for Storm Season \(copy\)/ }).click();
  await sheetAction(page, 'Delete');
  await confirmDialog(page, 'Delete');
  await expect(page.getByText('Entry deleted').first()).toBeVisible();
  expect(await countStore(page, 'loreEntries')).toBe(3);

  // 26-28. Refresh and verify.
  await page.reload();
  await boot(page);
  const entries = await readStore(page, 'loreEntries');
  expect(entries).toHaveLength(3);
  const ashfell = entries.find((e: any) => e.name === 'Ashfell');
  expect(ashfell.content).toContain('Ash Council');
  expect(ashfell.secondaryKeys).toContain('council');
  expect(entries.every((e: any) => e.enabled)).toBe(true);
});

test('lore entry validation refuses an entry with no content', async ({ page }) => {
  await goto(page, '#/lorebooks');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Add entry' }).click();
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Name').fill('Empty');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText(/needs content/)).toBeVisible();
  expect(await countStore(page, 'loreEntries')).toBe(0);
});

/* =================================================================== IMPORT */

test('steps 29-36: import character, persona and lorebook JSON with preview', async ({ page }) => {
  await goto(page, '#/transfer');
  const input = page.locator('input[type=file]').first();

  // 29-32. Character card (SillyTavern v2 shape).
  await input.setInputFiles({
    name: 'kaelen.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'Kaelen',
          description: 'A wandering cartographer.',
          personality: 'Precise, distant, secretly sentimental.',
          scenario: 'The road to Ashfell.',
          first_mes: 'He does not look up from the map. "You are late."',
          alternate_greetings: ['"Another traveller. Wonderful."'],
          mes_example: '{{char}}: North is that way.',
          tags: ['cartographer', 'aloof'],
          unknown_custom_field: 'preserved value',
        },
      }),
    ),
  });

  await expect(page.getByText('Import preview — Character')).toBeVisible();
  await expect(page.getByText('Kaelen').first()).toBeVisible();
  await expect(page.getByText('2 greetings').first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Kaelen/).first()).toBeVisible();

  const characters = await readStore(page, 'characters');
  expect(characters).toHaveLength(1);
  expect(characters[0].greetings).toHaveLength(2);
  expect(characters[0].exampleDialogue).toContain('North is that way');
  expect(characters[0].customFields.some((f: any) => f.key === 'unknown_custom_field')).toBe(true);

  // 33-34. Persona.
  await input.setInputFiles({
    name: 'persona.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name: 'Wren',
        description: 'A courier with a bad map and worse luck.',
        speech_style: 'Clipped, sardonic.',
        customInstructions: 'Never speak for Wren.',
      }),
    ),
  });
  await expect(page.getByText('Import preview — Persona')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Wren/).first()).toBeVisible();
  const personas = await readStore(page, 'personas');
  expect(personas[0].name).toBe('Wren');
  expect(personas[0].speechStyle).toContain('sardonic');

  // 35-36. Lorebook with multiple entries (SillyTavern world-info shape).
  await input.setInputFiles({
    name: 'world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name: 'Ashfell World Info',
        entries: {
          '0': { keys: ['Ashfell'], content: 'The grey city.', comment: 'City', constant: false },
          '1': { keys: ['Ash Council'], keysecondary: ['politics'], content: 'Seven masked rulers.' },
          '2': { key: ['volcano'], content: 'Dormant, but not dead.', disable: true },
        },
      }),
    ),
  });
  await expect(page.getByText('Import preview — Lorebook')).toBeVisible();
  await expect(page.getByText('3 entries').first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Ashfell World Info/).first()).toBeVisible();

  const entries = await readStore(page, 'loreEntries');
  expect(entries).toHaveLength(3);
  expect(entries.find((e: any) => e.primaryKeys.includes('Ash Council')).secondaryKeys).toContain('politics');
  expect(entries.find((e: any) => e.primaryKeys.includes('volcano')).enabled).toBe(false);
});

test('steps 37-40: TXT import lets the user choose the target type', async ({ page }) => {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('The Drowned Library\n\nSunk beneath the harbour, its books still dry.'),
  });

  await expect(page.getByText(/What should this file become\?/)).toBeVisible();
  // Default guess is Character; switch to a lorebook entry and re-preview.
  await page.getByRole('button', { name: 'Lorebook Entry' }).click();
  await expect(page.getByText('Import preview — Lorebook Entry')).toBeVisible();
  await expect(page.getByText(/The Drowned Library/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported The Drowned Library/).first()).toBeVisible();

  const entries = await readStore(page, 'loreEntries');
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe('The Drowned Library');
  expect(entries[0].content).toContain('still dry');
  expect(await countStore(page, 'lorebooks')).toBe(1);
});

test('PNG character cards are read, and plain images fall back with a reason', async ({ page }) => {
  await goto(page, '#/transfer');
  const input = page.locator('input[type=file]').first();

  await input.setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: makeCharacterCardPng({ name: 'Ilse', description: 'Embedded in a PNG.' }),
  });
  await expect(page.getByText(/PNG character card/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Ilse/).first()).toBeVisible();
  const chars = await readStore(page, 'characters');
  expect(chars[0].name).toBe('Ilse');
  expect(chars[0].avatarMediaId).toBeTruthy();

  await input.setInputFiles({ name: 'plain.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.getByText(/no text metadata chunks|no character card chunk/).first()).toBeVisible();
});

test('import conflicts offer a choice and never silently overwrite', async ({ page }) => {
  const file = {
    name: 'dup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ name: 'Twin', description: 'First version.' })),
  };
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(/Imported Twin/).first()).toBeVisible();

  await page.locator('input[type=file]').first().setInputFiles({
    ...file,
    buffer: Buffer.from(JSON.stringify({ name: 'Twin', description: 'Second version.' })),
  });
  await expect(page.getByText(/Some items already exist/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const characters = await readStore(page, 'characters');
  expect(characters).toHaveLength(2); // "create a copy" is the default
  expect(characters.map((c: any) => c.description).sort()).toEqual(['First version.', 'Second version.']);
});

test('a malformed JSON file reports a clear error and imports nothing', async ({ page }) => {
  await goto(page, '#/transfer');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"name": "Broken", '),
  });
  await expect(page.getByText(/is not valid JSON/).first()).toBeVisible();
  expect(await countStore(page, 'characters')).toBe(0);
});

/* ==================================================================== STORY */

test('steps 41-48: build a story with a cast, persona, lorebook and media', async ({ page }) => {
  await seedLibrary(page);

  await goto(page, '#/story/new');
  await field(page, 'Title').fill('The Long Storm');
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, 'Scenario').fill('Travellers wait out a storm in the Nexus Tavern.');

  // 42. Multiple characters.
  await page.getByRole('tab', { name: /Cast/ }).click();
  await page.getByRole('button', { name: 'Add character' }).first().click();
  await sheetAction(page, 'Seraphine');
  await page.getByRole('button', { name: 'Add character' }).first().click();
  await sheetAction(page, 'Kaelen');
  await expect(page.getByText('Primary', { exact: true })).toHaveCount(1);

  // 43. Persona.
  await page.locator('select').first().selectOption({ label: 'Corin Ashe' });

  // 44. Lorebook.
  await page.getByRole('tab', { name: /Lorebooks/ }).click();
  await page.getByRole('switch', { name: /Ashfell/ }).click();

  // 45-46. Cover (Overview, where the story's identity lives) and the chat
  // background (Media).
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page
    .locator('input[type=file][accept*="image"]')
    .nth(0)
    .setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await page.waitForTimeout(300);
  await page.getByRole('tab', { name: 'Media' }).click();
  await page
    .locator('input[type=file][accept*="image"]')
    .nth(0)
    .setInputFiles({ name: 'bg.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await page.waitForTimeout(300);

  // 47-48. Save and refresh.
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/Saved "The Long Storm"/).first()).toBeVisible();
  await page.reload();
  await boot(page);

  const stories = await readStore(page, 'stories');
  expect(stories).toHaveLength(1);
  expect(stories[0].characters).toHaveLength(2);
  expect(stories[0].characters.filter((c: any) => c.primary)).toHaveLength(1);
  expect(stories[0].personaId).toBeTruthy();
  expect(stories[0].lorebookIds).toHaveLength(1);
  expect(stories[0].coverMediaId).toBeTruthy();
  expect(stories[0].backgroundMediaId).toBeTruthy();
});

test('an existing story can be edited without recreating it', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await field(page, 'Title').fill('The Long Storm — Revised');
  await page.getByRole('tab', { name: 'World' }).click();
  await field(page, "Author's note").fill('Keep the pacing slow and the tavern warm.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  // Wait for the write to land. Reloading straight after the click raced the
  // save and passed only because there was nothing else on screen to render.
  await expect(page.getByText(/^Saved /).first()).toBeVisible();
  await page.reload();

  const stories = await readStore(page, 'stories');
  expect(stories).toHaveLength(1);
  expect(stories[0].title).toBe('The Long Storm — Revised');
  expect(stories[0].authorNote).toContain('pacing slow');
});

/* ===================================================================== CHAT */

test('steps 49-54: send a message with an image attachment and verify it persists', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);

  await goto(page, '#/stories');
  await page.getByRole('button', { name: /Start chat|Continue/ }).first().click();
  await expect(page.locator('.chat-composer')).toBeVisible();

  // 51. Attach two images to prove multi-attachment support.
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Photo Library');
  const attachInput = page.getByTestId('attach-library');
  await attachInput.setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: PNG_BYTES },
    { name: 'two.png', mimeType: 'image/png', buffer: PNG_BYTES },
  ]);
  await expect(page.locator('.attachment-preview')).toHaveCount(2);

  await field(page, 'Message').fill('Look what I found in the cellar.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Look what I found in the cellar.')).toBeVisible();
  await expect(page.getByText(/The tavern door creaks open/)).toBeVisible({ timeout: 20_000 });

  // 53-54. Refresh; both attachments must render again.
  await reloadApp(page);
  await expect(page.getByText('Look what I found in the cellar.')).toBeVisible();
  await expect(page.locator('.msg-attachments img')).toHaveCount(2);

  const messages = await readStore(page, 'messages');
  const userMessage = messages.find((m: any) => m.role === 'user');
  expect(userMessage.attachments).toHaveLength(2);
});

test('steps 55-62: edit, delete, regenerate, alternatives and branching', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  await sendMessage(page, 'Hello there.');
  await expect(page.getByText(/The tavern door creaks open/)).toBeVisible({ timeout: 20_000 });

  // 55. Edit a message and confirm it persists.
  await page
    .locator('.msg')
    .filter({ has: page.getByTestId('message-bubble').filter({ hasText: 'Hello there.' }) })
    .first()
    .getByRole('button', { name: 'Edit message' })
    .click();
  const editDialog = page.getByRole('dialog');
  await fieldIn(editDialog, 'Message text').fill('Hello there. (edited)');
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(bubble(page, 'Hello there. (edited)').first()).toBeVisible();
  await reloadApp(page);
  await expect(bubble(page, 'Hello there. (edited)').first()).toBeVisible();

  // 57-58. Generate an alternative — the original must survive.
  const aiMessage = page.locator('.msg').last();
  await aiMessage.getByRole('button', { name: 'More message actions' }).click();
  await sheetAction(page, 'Generate an alternative');
  await expect(page.getByText(/A second, different response/)).toBeVisible({ timeout: 20_000 });
  expect(await countStore(page, 'messageAlternatives')).toBe(1);

  // 59. Switch back to the original.
  await expect(page.locator('.alt-nav')).toBeVisible();
  await page.getByRole('button', { name: 'Previous response' }).click();
  await expect(page.getByText(/The tavern door creaks open/)).toBeVisible();
  await page.getByRole('button', { name: 'Next response' }).click();
  await expect(page.getByText(/A second, different response/)).toBeVisible();

  // 60. Branch from the AI message.
  await page.locator('.msg').last().getByRole('button', { name: 'More message actions' }).click();
  await sheetAction(page, 'Branch from here');
  const branchDialog = page.getByRole('dialog');
  await fieldIn(branchDialog, 'Branch name').fill('What if she refuses');
  await branchDialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.getByText(/Switched to "What if she refuses"/).first()).toBeVisible();
  expect(await countStore(page, 'branches')).toBe(2);

  // Write on the branch; the original timeline must stay untouched.
  await sendMessage(page, 'This only exists on the branch.');

  // 61-62. Rename and switch back to the main timeline.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Branches');
  await expect(page.getByText('What if she refuses').first()).toBeVisible();
  await page.getByRole('button', { name: 'Rename branch What if she refuses' }).click();
  const renameDialog = page.getByRole('dialog').last();
  await fieldIn(renameDialog, 'Branch name').fill('Refusal path');
  await renameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Refusal path').first()).toBeVisible();

  await page.getByRole('button', { name: 'Switch to branch Main' }).click();
  await expect(bubble(page, 'This only exists on the branch.')).toHaveCount(0);
  await expect(bubble(page, 'Hello there. (edited)').first()).toBeVisible();

  // Switch back to the branch: its message returns.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Branches');
  await page.getByRole('button', { name: 'Switch to branch Refusal path' }).click();
  await expect(bubble(page, 'This only exists on the branch.').first()).toBeVisible();
});

test('deleting a message removes it from storage', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'Delete me please.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  const before = await countStore(page, 'messages');
  await openMessageMenu(page, 'Delete me please.');
  await sheetAction(page, 'Delete message');
  await confirmDialog(page, 'Delete');
  await expect(bubble(page, 'Delete me please.')).toHaveCount(0);
  expect(await countStore(page, 'messages')).toBe(before - 1);
});

/* =============================================================== CHECKPOINT */

test('steps 63-66: save a checkpoint, continue, then start a chat from it', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  await sendMessage(page, 'First beat of the scene.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  // 63. Save a checkpoint at the AI reply.
  await page.locator('.msg').last().getByRole('button', { name: 'More message actions' }).click();
  await sheetAction(page, 'Save checkpoint here');
  const dialog = page.getByRole('dialog');
  await fieldIn(dialog, 'Checkpoint name').fill('Before the cellar');
  await dialog.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(page.getByText('Checkpoint saved').first()).toBeVisible();

  // 64. Continue the conversation past the checkpoint.
  await sendMessage(page, 'Later developments after the checkpoint.');

  // 65-66. Start a new chat from the checkpoint; the later text must be absent.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Checkpoints');
  await page.getByRole('button', { name: 'New chat from here' }).click();
  await expect(page.getByText(/^Started /).first()).toBeVisible();

  await expect(bubble(page, 'First beat of the scene.').first()).toBeVisible();
  await expect(bubble(page, 'Later developments after the checkpoint.')).toHaveCount(0);
  expect(await countStore(page, 'chats')).toBe(2);
});

test('restoring a checkpoint forks a branch and leaves the original intact', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  await sendMessage(page, 'Anchor message.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });
  await page.locator('.msg').last().getByRole('button', { name: 'More message actions' }).click();
  await sheetAction(page, 'Save checkpoint here');
  await page.getByRole('dialog').getByRole('button', { name: 'Save checkpoint' }).click();

  await sendMessage(page, 'Written after the checkpoint.');

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Checkpoints');
  await page.getByRole('button', { name: 'Restore here' }).click();
  await expect(page.getByText(/Forked a new branch/).first()).toBeVisible();

  await expect(bubble(page, 'Written after the checkpoint.')).toHaveCount(0);
  await expect(bubble(page, 'Anchor message.').first()).toBeVisible();
  expect(await countStore(page, 'branches')).toBe(2);
  // The original message still exists — it was not deleted, only hidden.
  const messages = await readStore(page, 'messages');
  expect(messages.some((m: any) => m.content === 'Written after the checkpoint.')).toBe(true);
});

/* =================================================================== MEMORY */

test('steps 67-75: create a memory from selected messages, then manage it', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  await sendMessage(page, 'She told me her name was Seraphine.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  // 67-69. Select messages and Remember.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Select messages');
  await page.locator('.bubble').first().click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Remember' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 25_000 });
  // 70. Edit the draft before saving.
  await fieldIn(dialog, 'Title').fill('Her name is Seraphine');
  await fieldIn(dialog, 'Content').fill('The innkeeper introduced herself as Seraphine.');
  await dialog.getByRole('switch', { name: 'Pinned' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Memory saved').first()).toBeVisible();

  // 72-73. Verify it persisted, pinned, and is searchable.
  await page.reload();
  await boot(page, '#/memories');
  await expect(page.getByText('Her name is Seraphine').first()).toBeVisible();
  const memories = await readStore(page, 'memories');
  expect(memories[0].pinned).toBe(true);
  expect(memories[0].sourceMessageIds.length).toBeGreaterThan(0);

  await page.getByRole('searchbox').first().fill('Seraphine');
  await expect(page.getByText('Her name is Seraphine').first()).toBeVisible();
  await page.getByRole('searchbox').first().fill('nothing matches this');
  await expect(page.getByText('Her name is Seraphine')).toHaveCount(0);
  await page.getByRole('searchbox').first().fill('');

  // 74. Edit.
  await page.getByText('Her name is Seraphine').first().click();
  await fieldIn(page.getByRole('dialog'), 'Content').fill('Updated memory content.');
  await saveAndSettle(page.getByRole('dialog'), page);
  await page.reload();
  expect((await readStore(page, 'memories'))[0].content).toBe('Updated memory content.');

  // 75. Delete.
  await boot(page, '#/memories');
  await page.getByRole('button', { name: /Actions for/ }).first().click();
  await sheetAction(page, 'Delete');
  await confirmDialog(page, 'Delete');
  expect(await countStore(page, 'memories')).toBe(0);
});

test('memory generation falls back to a local summary with no provider', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  // Deliberately no provider configured.
  await startChat(page);

  await field(page, 'Message').fill('The Ash Council sealed the cellar ten years ago.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/No AI provider configured/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Select messages');
  await page.locator('.bubble').first().click();
  await page.getByRole('button', { name: 'Remember' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/summarised locally/i)).toBeVisible();
  await expect(fieldIn(dialog, 'Content')).not.toBeEmpty();
});

/* ===================================================================== LORE */

test('steps 76-79: a lore keyword triggers, is visible in the inspector and the tester', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  // 76. Mention a keyword from the seeded lorebook.
  await field(page, 'Message').fill('Tell me about Ashfell.');

  // 77-78. The inspector must show the entry and why it triggered.
  // Open the Context Inspector via the chat menu — the small chip button
  // is not always reachable on mobile viewports.
  await page.getByRole('button', { name: 'Chat menu' }).click();
  await sheetAction(page, 'Context Inspector');
  await expect(page.getByText('Context Inspector').first()).toBeVisible();
  await page.getByRole('tab', { name: /Lore & memory/ }).click();
  await expect(page.getByText('Ashfell').first()).toBeVisible();
  await expect(page.getByText(/Triggered because: Keyword matched: Ashfell/)).toBeVisible();

  // The compiled system prompt must actually contain the lore text.
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page.getByText(/The grey city on the volcano/)).toBeVisible();
  await page.getByRole('button', { name: 'Close context inspector' }).click();

  // 79. The tester agrees, using the same retrieval code.
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Tools' }).click();
  await field(page, 'Test text').fill('We ride for Ashfell at dawn.');
  await expect(page.getByText(/Keyword matched: Ashfell/)).toBeVisible();

  await field(page, 'Test text').fill('Nothing relevant here at all.');
  await expect(page.getByText(/No keyword matched/).first()).toBeVisible();
});

test('lore keyword matching respects word boundaries', async ({ page }) => {
  await seedLibrary(page);
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Tools' }).click();

  // "Ashfell" must not match inside an unrelated longer word.
  await field(page, 'Test text').fill('The ashfelling process is unrelated.');
  await expect(page.getByText(/No keyword matched/).first()).toBeVisible();

  await field(page, 'Test text').fill('ASHFELL, at last.');
  await expect(page.getByText(/Keyword matched/).first()).toBeVisible();
});

/* =================================================================== EXPORT */

test('steps 80-85: every export produces readable JSON', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);

  // Attach an image so the "media is bundled" assertion below is meaningful
  // rather than trivially true against an empty library.
  await page.getByRole('button', { name: 'Add image' }).click();
  await sheetAction(page, 'Photo Library');
  await page
    .getByTestId('attach-library')
    .setInputFiles({ name: 'export.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(page.locator('.attachment-preview')).toHaveCount(1);

  await sendMessage(page, 'A line worth exporting.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Export' }).click();

  const characterJson = await captureDownload(page, async () => {
    await page.getByTestId('export-row-character').first().getByRole('button').click();
  });
  // Everything Nexus writes is a Nexus document: flat collections under one
  // envelope, the same shape whatever the kind.
  const parsedCharacter = JSON.parse(characterJson);
  expect(parsedCharacter.format).toBe('nexus');
  expect(parsedCharacter.schema).toBe(1);
  expect(parsedCharacter.kind).toBe('character');
  expect(parsedCharacter.characters).toHaveLength(1);
  expect(parsedCharacter.characters[0].name).toBeTruthy();
  // The subject is identified, so a reader can tell it from its dependencies.
  expect(parsedCharacter.primaryId).toBe(parsedCharacter.characters[0].id);
  expect(characterJson).toContain('\n  '); // human-readable indentation

  // The export button carries its kind and item name, so this cannot pick up
  // a chat that happens to be named after the story.
  const storyJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: 'Export story: The Long Storm' }).click();
  });
  const parsedStory = JSON.parse(storyJson);
  expect(parsedStory.format).toBe('nexus');
  expect(parsedStory.kind).toBe('story');
  expect(parsedStory.characters.length).toBeGreaterThan(0);
  expect(parsedStory.lorebooks.length).toBeGreaterThan(0);
  expect(parsedStory.chats.length).toBeGreaterThan(0);
  // Chats used to nest their own branches and messages; they are collections
  // of the document now, like everything else.
  expect(parsedStory.messages.length).toBeGreaterThan(0);
  expect(parsedStory.branches.length).toBeGreaterThan(0);

  // 85. Full backup, with the API key stripped.
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  const backupJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });
  const backup = JSON.parse(backupJson);
  expect(backup.format).toBe('nexus');
  expect(backup.kind).toBe('backup');
  expect(backup.characters.length).toBeGreaterThan(0);
  expect(backup.messages.length).toBeGreaterThan(0);
  expect(backup.providers.every((p: any) => p.apiKey === '')).toBe(true);
  expect(backupJson).not.toContain('test-key-1234567890');
  expect(Object.keys(backup.media ?? {}).length).toBeGreaterThan(0);
});

/* ================================================================== RESTORE */

test('steps 86-88: delete everything, then restore it from a backup', async ({ page }) => {
  await seedLibrary(page);
  await seedStory(page);
  await setupProvider(page);
  await startChat(page);
  await sendMessage(page, 'This must come back after the restore.');
  await expect(page.getByText(/The tavern door creaks/)).toBeVisible({ timeout: 20_000 });

  const before = {
    characters: await countStore(page, 'characters'),
    stories: await countStore(page, 'stories'),
    messages: await countStore(page, 'messages'),
    loreEntries: await countStore(page, 'loreEntries'),
    media: await countStore(page, 'media'),
  };
  expect(before.characters).toBeGreaterThan(0);

  await goto(page, '#/transfer');
  await page.getByRole('tab', { name: 'Backup & Restore' }).click();
  const backupJson = await captureDownload(page, async () => {
    await page.getByRole('button', { name: /Download full backup/ }).click();
  });

  // 86. Wipe the library through the real UI.
  await goto(page, '#/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByRole('button', { name: /Erase all local data/ }).click();
  const eraseDialog = page.getByRole('dialog');
  await eraseDialog.getByRole('textbox').first().fill('ERASE');
  await eraseDialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page.getByText('All local data erased').first()).toBeVisible();
  expect(await countStore(page, 'characters')).toBe(0);
  expect(await countStore(page, 'messages')).toBe(0);

  // 87. Restore.
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

  // 88. Everything is back, including blobs and message text.
  expect(await countStore(page, 'characters')).toBe(before.characters);
  expect(await countStore(page, 'stories')).toBe(before.stories);
  expect(await countStore(page, 'messages')).toBe(before.messages);
  expect(await countStore(page, 'loreEntries')).toBe(before.loreEntries);
  expect(await countStore(page, 'media')).toBe(before.media);
  expect(await countStore(page, 'mediaBlobs')).toBe(before.media);

  await page.reload();
  await boot(page, '#/stories');
  await expect(page.getByText('The Long Storm').first()).toBeVisible();
  const messages = await readStore(page, 'messages');
  expect(messages.some((m: any) => m.content === 'This must come back after the restore.')).toBe(true);
});

/* ================================================================ MIGRATION */

test('steps 89-90: V2 localStorage data migrates without being destroyed', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'nexus_v2_chars',
      JSON.stringify([
        {
          id: 'v2-char-1',
          name: 'Old Friend',
          description: 'Carried over from V2.',
          personality: 'Nostalgic.',
          first_mes: 'You came back.',
          avatar:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P8//8/AzGAiYFIMKpwVOGowlGFxCoEAFHwBQV1I2CkAAAAAElFTkSuQmCC',
        },
      ]),
    );
    localStorage.setItem(
      'nexus_v2_personas',
      JSON.stringify([{ id: 'v2-persona-1', name: 'Old Me', description: 'A V2 persona.' }]),
    );
    localStorage.setItem(
      'nexus_v2_stories',
      JSON.stringify([
        {
          id: 'v2-story-1',
          title: 'Legacy Story',
          scenario: 'Carried forward.',
          activeCharacters: ['v2-char-1'],
          personaId: 'v2-persona-1',
        },
      ]),
    );
    localStorage.setItem(
      'nexus_v2_lore',
      JSON.stringify([
        { id: 'v2-lore-1', name: 'Old Lore', keys: ['relic'], content: 'A relic of the old world.' },
      ]),
    );
    localStorage.setItem(
      'nexus_v2_chats',
      JSON.stringify([
        {
          id: 'v2-chat-1',
          storyId: 'v2-story-1',
          title: 'Legacy Chat',
          messages: [
            { role: 'user', content: 'Are you still there?' },
            { role: 'assistant', content: 'Always.', characterId: 'v2-char-1' },
          ],
        },
      ]),
    );
    localStorage.setItem('nexus_v2_settings', JSON.stringify({ systemPrompt: 'Be evocative.', temperature: 1.1 }));
  });

  await page.reload();
  await boot(page);

  await expect(page.getByText(/Existing Nexus Tavern V2 data found/).first()).toBeVisible();
  await page.getByRole('button', { name: /Migrate existing V2 data/ }).click();
  await expect(page.getByText('V2 data migrated').first()).toBeVisible({ timeout: 30_000 });

  // 90. Everything came across, and the old keys are untouched.
  const characters = await readStore(page, 'characters');
  expect(characters).toHaveLength(1);
  expect(characters[0].name).toBe('Old Friend');
  expect(characters[0].greetings[0].content).toBe('You came back.');
  expect(characters[0].avatarMediaId).toBeTruthy();
  expect(await countStore(page, 'mediaBlobs')).toBe(1);

  const stories = await readStore(page, 'stories');
  expect(stories[0].title).toBe('Legacy Story');
  expect(stories[0].characters).toHaveLength(1);
  expect(stories[0].personaId).toBeTruthy();

  const entries = await readStore(page, 'loreEntries');
  expect(entries).toHaveLength(1);
  expect(entries[0].primaryKeys).toContain('relic');

  const messages = await readStore(page, 'messages');
  expect(messages).toHaveLength(2);

  const settings = await readStore(page, 'settings');
  expect(settings[0].globalSystemPrompt).toBe('Be evocative.');

  // The original V2 data is deliberately left in place.
  const stillThere = await page.evaluate(() => localStorage.getItem('nexus_v2_chars'));
  expect(stillThere).toContain('Old Friend');

  await page.reload();
  await boot(page, '#/characters');
  await expect(page.getByText('Old Friend').first()).toBeVisible();
  await expect(page.getByText(/Existing Nexus Tavern V2 data found/)).toHaveCount(0);
});

/* ============================================================== HELPERS ==== */

/** Seeds a character, a second character, a persona and a lorebook via the UI-free path. */
async function seedLibrary(page: Page) {
  await page.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('nexus-tavern-pro');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await open();
    const put = (store: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });

    const now = Date.now();
    const character = (id: string, name: string) => ({
      id,
      name,
      displayName: '',
      nickname: '',
      age: '',
      gender: '',
      pronouns: '',
      species: '',
      race: '',
      occupation: '',
      role: '',
      tags: [],
      shortDescription: `${name} test fixture`,
      description: `${name} is a seeded test character.`,
      appearance: '',
      physicalTraits: '',
      personality: 'Seeded.',
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
      greetings: [{ id: `${id}-g`, label: 'Default', content: `${name} nods in greeting.` }],
      defaultGreetingId: `${id}-g`,
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
      home: '',
      location: '',
      faction: '',
      world: '',
      lorebookIds: [],
      creator: '',
      creatorNotes: '',
      version: '1.0',
      customFields: [],
      metadata: {},
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('characters', character('seed-char-1', 'Seraphine'));
    await put('characters', character('seed-char-2', 'Kaelen'));

    await put('personas', {
      id: 'seed-persona-1',
      name: 'Corin Ashe',
      displayName: '',
      nickname: '',
      age: '',
      gender: '',
      pronouns: '',
      species: '',
      appearance: '',
      personality: 'A seeded persona.',
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
      id: 'seed-book-1',
      name: 'Ashfell Lore',
      description: 'Seeded lorebook.',
      enabled: true,
      tags: [],
      global: false,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    await put('loreEntries', {
      id: 'seed-entry-1',
      lorebookId: 'seed-book-1',
      name: 'Ashfell',
      content: 'The grey city on the volcano, ruled by the Ash Council.',
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
    db.close();
  });
  await page.reload();
  await boot(page);
}

async function seedStory(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('stories', 'readwrite');
      const r = tx.objectStore('stories').put({
        id: 'seed-story-1',
        title: 'The Long Storm',
        description: 'A seeded story.',
        scenario: 'Travellers wait out a storm.',
        authorNote: '',
        tags: [],
        characters: [
          { characterId: 'seed-char-1', primary: true, note: '', enabled: true },
          { characterId: 'seed-char-2', primary: false, note: '', enabled: true },
        ],
        personaId: 'seed-persona-1',
        lorebookIds: ['seed-book-1'],
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
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
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
  // Scoped to a bubble: the chat title is derived from the first message, so a
  // bare text match would also hit the header.
  await expect(bubble(page, text).first()).toBeVisible({ timeout: 20_000 });
}
