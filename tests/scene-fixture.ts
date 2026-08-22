/**
 * The hospital-room scenario, seeded exactly as the failure was reported.
 *
 * Reiko and Bakugo are alone in a room. Kirishima is in the cast but not in the
 * scene. Edgeshot exists only as a lorebook entry and as a name in a long
 * pasted transcript — which is precisely the shape that used to put him in the
 * room, speaking, addressing the user as Deku.
 */
import type { Page } from '@playwright/test';
import { boot } from './helpers';

/** A pasted transcript: one assistant turn, thick with names of absent people. */
export const HISTORICAL_TRANSCRIPT = [
  '*The hospital room was quiet.*',
  'Bakugo: "Tch."',
  'Reiko: "How are you feeling?"',
  '*She remembered Edgeshot weaving his heart back together, and how Midoriya had',
  'nearly died in the same battle. Kirishima, Sero, Kaminari and Mina were coming',
  'later. Ochako, Tsuyu and Todoroki were visiting Midoriya down the hall.*',
  'Bakugo: "Deku got out before me. Figures."',
  '*Edgeshot had said the surgery went well. Aizawa had signed the forms.*',
].join('\n');

export interface SceneSeed {
  /** Characters present in the scene. Defaults to Bakugo alone. */
  presentCharacterIds?: string[];
  /** Repeat the transcript to make absent names overwhelmingly frequent. */
  transcriptRepeats?: number;
  /** Add Kirishima to the cast. */
  castKirishima?: boolean;
  location?: string;
  situation?: string;
}

export async function seedHospitalScene(page: Page, seed: SceneSeed = {}) {
  await page.evaluate(async (options) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nexus-tavern-pro');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const put = (store: string, value: unknown) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    const now = Date.now();

    const character = (id: string, name: string, description: string) => ({
      id,
      name,
      displayName: '',
      nickname: '',
      age: '18',
      gender: '',
      pronouns: '',
      species: 'human',
      race: '',
      occupation: 'hero student',
      role: '',
      tags: [],
      shortDescription: description,
      description,
      appearance: '',
      physicalTraits: '',
      personality: 'Loud and proud.',
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
      greetings: [],
      defaultGreetingId: null,
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
      version: '1',
      customFields: [],
      metadata: {},
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
    });

    await put('characters', character('bakugo', 'Katsuki Bakugo', 'Explosive hero student.'));
    if (options.castKirishima) {
      await put('characters', character('kirishima', 'Eijiro Kirishima', 'Hardening hero student.'));
    }

    await put('personas', {
      id: 'reiko',
      name: 'Reiko Ryuusui',
      displayName: '',
      nickname: '',
      age: '18',
      gender: 'female',
      pronouns: 'she/her',
      species: 'human',
      occupation: 'hero student',
      appearance: 'Brown hair, freckles.',
      personality: 'Direct and possessive.',
      traits: [],
      backstory: '',
      goals: '',
      likes: '',
      dislikes: '',
      speechStyle: '',
      customFields: [],
      customInstructions: '',
      avatarMediaId: null,
      avatarUrl: '',
      favorite: false,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    // A world lorebook. Edgeshot exists in it, keyed to his own name.
    await put('lorebooks', {
      id: 'mha',
      name: 'MHA CANON',
      description: '',
      tags: [],
      enabled: true,
      global: false,
      scanDepth: 0,
      createdAt: now,
      updatedAt: now,
    });
    const entry = (id: string, name: string, keys: string[], content: string, extra = {}) => ({
      id,
      lorebookId: 'mha',
      name,
      content,
      primaryKeys: keys,
      secondaryKeys: [],
      aliases: [],
      enabled: true,
      priority: 50,
      position: 'after-character',
      depth: 4,
      scanDepth: 0,
      matchMode: 'word-boundary',
      caseSensitive: false,
      activation: 'normal',
      category: '',
      scope: '',
      comment: '',
      customFields: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    await put('loreEntries', entry('e-edge', 'Edgeshot', ['Edgeshot'], 'Ninja hero. Thin and fast.'));
    await put('loreEntries', entry('e-deku', 'Midoriya', ['Midoriya', 'Deku'], 'Green-haired hero student.'));
    await put('loreEntries', entry('e-ua', 'U.A. Hospital', ['hospital'], 'The U.A. recovery ward.'));
    await put(
      'loreEntries',
      entry('e-disabled', 'Stain', ['Stain'], 'The Hero Killer.', { enabled: false }),
    );

    const cast = [{ characterId: 'bakugo', primary: true, note: '', enabled: true }];
    if (options.castKirishima) {
      cast.push({ characterId: 'kirishima', primary: false, note: '', enabled: true });
    }

    await put('stories', {
      id: 'mha-story',
      title: 'MHA — Reiko Integration',
      description: 'A long-running MHA roleplay.',
      scenario: 'Recovery after the final battle.',
      authorNote: '',
      openingMessage: '',
      tags: [],
      characters: cast,
      personaId: 'reiko',
      lorebookIds: ['mha'],
      memoryIds: [],
      coverMediaId: null,
      backgroundMediaId: null,
      defaultChatId: 'hospital-chat',
      settings: {},
      favorite: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });

    const repeats = options.transcriptRepeats ?? 1;
    await put('chats', {
      id: 'hospital-chat',
      storyId: 'mha-story',
      title: 'Hospital room',
      activeBranchId: 'hospital-branch',
      personaId: 'reiko',
      favorite: false,
      archived: false,
      settings: {},
      direction: '',
      lorebookIds: [],
      orderCounter: repeats + 1,
      scene: {
        location: options.location ?? "Bakugo's hospital room",
        situation: options.situation ?? 'Reiko is visiting Bakugo during his recovery.',
        presentCharacterIds: options.presentCharacterIds ?? ['bakugo'],
        primaryCharacterId: 'bakugo',
        objective: '',
        characterStates: { bakugo: 'Recovering from broken ribs; his right arm is immobilised.' },
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
    await put('branches', {
      id: 'hospital-branch',
      chatId: 'hospital-chat',
      parentBranchId: null,
      createdFromMessageId: null,
      forkOrder: 0,
      name: 'Main',
      createdAt: now,
      updatedAt: now,
    });

    for (let i = 0; i < repeats; i += 1) {
      await put('messages', {
        id: `transcript-${i}`,
        chatId: 'hospital-chat',
        branchId: 'hospital-branch',
        role: 'assistant',
        characterId: 'bakugo',
        content: options.transcript,
        attachments: [],
        order: i,
        model: '',
        tokens: 0,
        favorite: false,
        activeAlternativeId: null,
        historical: true,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }

    db.close();
  }, { ...seed, transcript: HISTORICAL_TRANSCRIPT });

  await page.reload();
  await boot(page);
}
