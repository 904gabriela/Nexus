/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Attachment,
  Branch,
  Chat,
  Character,
  Checkpoint,
  ID,
  LoreEntry,
  Lorebook,
  MediaMeta,
  Memory,
  Message,
  MessageAlternative,
  Persona,
  Provider,
  ImageProvider,
  ModelCapabilities,
  Settings,
  Story,
  StorySummary,
  ToastMessage,
} from '../types';
import { defaultCapabilities } from '../types';
import {
  DEFAULT_GENERATION,
  defaultSettings,
  inferCapabilities,
  newBranch,
  newChat,
  newCheckpoint,
  newMessage,
} from '../types/factories';
import * as repo from '../storage/repositories';
import { listMedia } from '../media/mediaStore';
import { scanV2, type V2Scan } from '../storage/migration';
import { resolveTimeline, descendantBranchIds, ownedMessageIds } from '../services/timeline';
import { uid } from '../utils/uid';

/* ---------------------------------------------------------------- state */

export interface AppState {
  ready: boolean;
  loadError: string | null;
  settings: Settings;
  characters: Character[];
  personas: Persona[];
  stories: Story[];
  chats: Chat[];
  lorebooks: Lorebook[];
  loreEntries: LoreEntry[];
  memories: Memory[];
  providers: Provider[];
  imageProviders: ImageProvider[];
  storySummaries: StorySummary[];
  media: MediaMeta[];
  checkpoints: Checkpoint[];
  /** Working set for the currently open chat. */
  activeChatId: ID | null;
  messages: Message[];
  branches: Branch[];
  alternatives: MessageAlternative[];
  chatLoading: boolean;
  v2Scan: V2Scan | null;
}

type Action =
  | { type: 'ready'; payload: Partial<AppState> }
  | { type: 'error'; error: string }
  | { type: 'set'; payload: Partial<AppState> };

const initialState: AppState = {
  ready: false,
  loadError: null,
  settings: defaultSettings(),
  characters: [],
  personas: [],
  stories: [],
  chats: [],
  lorebooks: [],
  loreEntries: [],
  memories: [],
  providers: [],
  imageProviders: [],
  storySummaries: [],
  media: [],
  checkpoints: [],
  activeChatId: null,
  messages: [],
  branches: [],
  alternatives: [],
  chatLoading: false,
  v2Scan: null,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ready':
      return { ...state, ...action.payload, ready: true, loadError: null };
    case 'error':
      return { ...state, ready: true, loadError: action.error };
    case 'set':
      return { ...state, ...action.payload };
    default:
      return state;
  }
}

function upsert<T extends { id: ID }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  const copy = list.slice();
  copy[index] = item;
  return copy;
}

function upsertMany<T extends { id: ID }>(list: T[], items: T[]): T[] {
  let out = list;
  for (const item of items) out = upsert(out, item);
  return out;
}

/* -------------------------------------------------------------- context */

export interface AppActions {
  reload: () => Promise<void>;
  toast: (toast: Omit<ToastMessage, 'id'>) => void;

  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;

  saveCharacter: (character: Character) => Promise<Character>;
  deleteCharacter: (id: ID) => Promise<void>;
  duplicateCharacter: (id: ID) => Promise<Character | null>;

  savePersona: (persona: Persona) => Promise<Persona>;
  deletePersona: (id: ID) => Promise<void>;
  duplicatePersona: (id: ID) => Promise<Persona | null>;

  saveStory: (story: Story) => Promise<Story>;
  deleteStory: (id: ID) => Promise<void>;
  duplicateStory: (id: ID) => Promise<Story | null>;

  saveLorebook: (lorebook: Lorebook) => Promise<Lorebook>;
  deleteLorebook: (id: ID) => Promise<void>;
  duplicateLorebook: (id: ID) => Promise<Lorebook | null>;
  saveLoreEntry: (entry: LoreEntry) => Promise<LoreEntry>;
  saveLoreEntries: (entries: LoreEntry[]) => Promise<void>;
  deleteLoreEntry: (id: ID) => Promise<void>;
  duplicateLoreEntry: (id: ID) => Promise<LoreEntry | null>;

  saveMemory: (memory: Memory) => Promise<Memory>;
  deleteMemory: (id: ID) => Promise<void>;

  saveProvider: (provider: Provider) => Promise<Provider>;
  deleteProvider: (id: ID) => Promise<void>;

  saveImageProvider: (provider: ImageProvider) => Promise<ImageProvider>;
  deleteImageProvider: (id: ID) => Promise<void>;

  saveStorySummary: (summary: StorySummary) => Promise<StorySummary>;

  refreshMedia: () => Promise<MediaMeta[]>;
  removeMedia: (id: ID) => Promise<void>;

  /* chat */
  openChat: (chatId: ID | null) => Promise<void>;
  createChat: (options: { storyId?: ID | null; title?: string; seedGreeting?: boolean }) => Promise<Chat>;
  saveChat: (chat: Chat) => Promise<Chat>;
  deleteChat: (id: ID) => Promise<void>;
  duplicateChat: (id: ID) => Promise<Chat | null>;

  appendMessage: (partial: Partial<Message> & { role: Message['role'] }) => Promise<Message>;
  updateMessage: (message: Message) => Promise<Message>;
  deleteMessage: (id: ID) => Promise<void>;
  setActiveAlternative: (messageId: ID, alternativeId: ID | null) => Promise<void>;
  addAlternative: (messageId: ID, content: string, instruction: string, model: string) => Promise<MessageAlternative>;
  deleteAlternative: (alternativeId: ID) => Promise<void>;
  promoteAlternative: (messageId: ID, alternativeId: ID) => Promise<void>;

  createBranch: (fromMessageId: ID, name?: string) => Promise<Branch | null>;
  renameBranch: (branchId: ID, name: string) => Promise<void>;
  switchBranch: (branchId: ID) => Promise<void>;
  deleteBranch: (branchId: ID) => Promise<void>;

  createCheckpoint: (messageId: ID, name: string, description?: string) => Promise<Checkpoint | null>;
  renameCheckpoint: (checkpointId: ID, name: string, description?: string) => Promise<void>;
  deleteCheckpoint: (checkpointId: ID) => Promise<void>;
  restoreCheckpoint: (checkpointId: ID) => Promise<Branch | null>;
  chatFromCheckpoint: (checkpointId: ID) => Promise<Chat | null>;
  /** Fork a brand-new chat seeded from the first `count` messages. */
  chatFromMessages: (chatId: ID, count: number, upToMessageId?: ID) => Promise<Chat | null>;
}

interface StoreValue {
  state: AppState;
  actions: AppActions;
  toasts: ToastMessage[];
  dismissToast: (id: ID) => void;
  /** Timeline for the active branch. */
  timeline: Message[];
  activeChat: Chat | null;
  activeBranch: Branch | null;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <AppStoreProvider>.');
  return value;
}

export function useAppState(): AppState {
  return useStore().state;
}

export function useActions(): AppActions {
  return useStore().actions;
}

/* ------------------------------------------------------------- provider */

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const toast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    const entry: ToastMessage = { ...message, id: uid('toast_') };
    setToasts((current) => [...current.slice(-3), entry]);
    const ttl = message.kind === 'error' ? 9000 : 4200;
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== entry.id)), ttl);
  }, []);

  const dismissToast = useCallback((id: ID) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [
        settings,
        characters,
        personas,
        stories,
        chats,
        lorebooks,
        loreEntries,
        memories,
        providers,
        imageProviderList,
        summaries,
        media,
        checkpoints,
      ] = await Promise.all([
        repo.settingsRepo.load(),
        repo.characters.all(),
        repo.personas.all(),
        repo.stories.all(),
        repo.chats.all(),
        repo.lorebooks.all(),
        repo.loreEntries.all(),
        repo.memories.all(),
        repo.providers.all(),
        repo.imageProviders.all(),
        repo.storySummaries.all(),
        listMedia(),
        repo.checkpoints.all(),
      ]);
      dispatch({
        type: 'ready',
        payload: {
          settings,
          characters,
          personas,
          stories,
          chats,
          lorebooks,
          loreEntries,
          memories,
          providers,
          imageProviders: imageProviderList,
          storySummaries: summaries,
          media,
          checkpoints,
          v2Scan: settings.migratedV2 ? null : scanV2(),
        },
      });
    } catch (err) {
      dispatch({
        type: 'error',
        error:
          (err as Error)?.message ??
          'The local database could not be opened. Your data is safe, but the app cannot start.',
      });
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Theme + font scale are applied at the document level.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = state.settings.theme;
    document.documentElement.style.setProperty('--font-scale', String(state.settings.fontScale));
  }, [state.settings.theme, state.settings.fontScale]);

  const set = useCallback((payload: Partial<AppState>) => {
    // Keep the ref in sync SYNCHRONOUSLY so a second action in the same
    // microtask sees the update from the first one. Without this, back-to-back
    // dispatches (e.g. appendMessage → generate → appendMessage) race and the
    // later one clobbers the earlier's changes with stale state.
    stateRef.current = { ...stateRef.current, ...payload };
    dispatch({ type: 'set', payload });
  }, []);

  /* ----------------------------------------------------------- actions */

  const actions = useMemo<AppActions>(() => {
    const guard = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        toast({
          kind: 'error',
          title: `${label} failed`,
          detail: (err as Error)?.message ?? 'Unknown error.',
        });
        throw err;
      }
    };

    const loadChatWorkingSet = async (chatId: ID) => {
      const [messages, branches, alternatives, checkpoints] = await Promise.all([
        repo.messages.byChat(chatId),
        repo.branches.byChat(chatId),
        repo.alternatives.byChat(chatId),
        repo.checkpoints.byChat(chatId),
      ]);
      return { messages, branches, alternatives, checkpoints };
    };

    return {
      reload: loadAll,
      toast,

      async saveSettings(patch) {
        return guard('Saving settings', async () => {
          const next: Settings = { ...stateRef.current.settings, ...patch, id: 'settings' };
          await repo.settingsRepo.save(next);
          set({ settings: next });
          return next;
        });
      },

      /* --------------------------------------------------- characters */

      async saveCharacter(character) {
        return guard('Saving the character', async () => {
          const saved = await repo.characters.save(character);
          set({ characters: upsert(stateRef.current.characters, saved) });
          return saved;
        });
      },
      async deleteCharacter(id) {
        return guard('Deleting the character', async () => {
          await repo.deleteCharacterCascade(id);
          const stories = await repo.stories.all();
          set({
            characters: stateRef.current.characters.filter((c) => c.id !== id),
            stories,
          });
        });
      },
      async duplicateCharacter(id) {
        return guard('Duplicating the character', async () => {
          const original = stateRef.current.characters.find((c) => c.id === id);
          if (!original) return null;
          const copy: Character = {
            ...structuredCloneSafe(original),
            id: uid(),
            name: `${original.name} (copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = await repo.characters.save(copy);
          set({ characters: upsert(stateRef.current.characters, saved) });
          return saved;
        });
      },

      /* ------------------------------------------------------ personas */

      async savePersona(persona) {
        return guard('Saving the persona', async () => {
          let list = stateRef.current.personas;
          if (persona.isDefault) {
            const others = list.filter((p) => p.id !== persona.id && p.isDefault);
            for (const other of others) {
              const cleared = await repo.personas.save({ ...other, isDefault: false });
              list = upsert(list, cleared);
            }
          }
          const saved = await repo.personas.save(persona);
          list = upsert(list, saved);
          set({ personas: list });
          if (persona.isDefault) {
            await this.saveSettings({ defaultPersonaId: persona.id });
          } else if (stateRef.current.settings.defaultPersonaId === persona.id) {
            await this.saveSettings({ defaultPersonaId: null });
          }
          return saved;
        });
      },
      async deletePersona(id) {
        return guard('Deleting the persona', async () => {
          await repo.deletePersonaCascade(id);
          const [stories, chats] = await Promise.all([repo.stories.all(), repo.chats.all()]);
          set({
            personas: stateRef.current.personas.filter((p) => p.id !== id),
            stories,
            chats,
          });
          if (stateRef.current.settings.defaultPersonaId === id) {
            await this.saveSettings({ defaultPersonaId: null });
          }
        });
      },
      async duplicatePersona(id) {
        return guard('Duplicating the persona', async () => {
          const original = stateRef.current.personas.find((p) => p.id === id);
          if (!original) return null;
          const copy: Persona = {
            ...structuredCloneSafe(original),
            id: uid(),
            name: `${original.name} (copy)`,
            isDefault: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = await repo.personas.save(copy);
          set({ personas: upsert(stateRef.current.personas, saved) });
          return saved;
        });
      },

      /* ------------------------------------------------------- stories */

      async saveStory(story) {
        return guard('Saving the story', async () => {
          const saved = await repo.stories.save(story);
          set({ stories: upsert(stateRef.current.stories, saved) });
          return saved;
        });
      },
      async deleteStory(id) {
        return guard('Deleting the story', async () => {
          await repo.deleteStoryCascade(id);
          const chats = await repo.chats.all();
          const clearActive = stateRef.current.activeChatId
            ? !chats.some((c) => c.id === stateRef.current.activeChatId)
            : false;
          set({
            stories: stateRef.current.stories.filter((s) => s.id !== id),
            chats,
            ...(clearActive ? { activeChatId: null, messages: [], branches: [], alternatives: [] } : {}),
          });
        });
      },
      async duplicateStory(id) {
        return guard('Duplicating the story', async () => {
          const original = stateRef.current.stories.find((s) => s.id === id);
          if (!original) return null;
          const copy: Story = {
            ...structuredCloneSafe(original),
            id: uid(),
            title: `${original.title} (copy)`,
            defaultChatId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = await repo.stories.save(copy);
          set({ stories: upsert(stateRef.current.stories, saved) });
          return saved;
        });
      },

      /* ----------------------------------------------------- lorebooks */

      async saveLorebook(lorebook) {
        return guard('Saving the lorebook', async () => {
          const saved = await repo.lorebooks.save(lorebook);
          set({ lorebooks: upsert(stateRef.current.lorebooks, saved) });
          return saved;
        });
      },
      async deleteLorebook(id) {
        return guard('Deleting the lorebook', async () => {
          await repo.deleteLorebookCascade(id);
          const [stories, characters, chats] = await Promise.all([
            repo.stories.all(),
            repo.characters.all(),
            repo.chats.all(),
          ]);
          set({
            lorebooks: stateRef.current.lorebooks.filter((b) => b.id !== id),
            loreEntries: stateRef.current.loreEntries.filter((e) => e.lorebookId !== id),
            stories,
            characters,
            chats,
          });
        });
      },
      async duplicateLorebook(id) {
        return guard('Duplicating the lorebook', async () => {
          const original = stateRef.current.lorebooks.find((b) => b.id === id);
          if (!original) return null;
          const copy: Lorebook = {
            ...structuredCloneSafe(original),
            id: uid(),
            name: `${original.name} (copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const entries = stateRef.current.loreEntries
            .filter((e) => e.lorebookId === id)
            .map((entry) => ({ ...structuredCloneSafe(entry), id: uid(), lorebookId: copy.id }));
          const saved = await repo.lorebooks.save(copy);
          await repo.loreEntries.saveMany(entries);
          set({
            lorebooks: upsert(stateRef.current.lorebooks, saved),
            loreEntries: [...stateRef.current.loreEntries, ...entries],
          });
          return saved;
        });
      },
      async saveLoreEntry(entry) {
        return guard('Saving the lore entry', async () => {
          const saved = await repo.loreEntries.save(entry);
          set({ loreEntries: upsert(stateRef.current.loreEntries, saved) });
          return saved;
        });
      },
      async saveLoreEntries(entries) {
        return guard('Saving lore entries', async () => {
          await repo.loreEntries.saveMany(entries);
          set({ loreEntries: upsertMany(stateRef.current.loreEntries, entries) });
        });
      },
      async deleteLoreEntry(id) {
        return guard('Deleting the lore entry', async () => {
          await repo.loreEntries.remove(id);
          set({ loreEntries: stateRef.current.loreEntries.filter((e) => e.id !== id) });
        });
      },
      async duplicateLoreEntry(id) {
        return guard('Duplicating the lore entry', async () => {
          const original = stateRef.current.loreEntries.find((e) => e.id === id);
          if (!original) return null;
          const copy: LoreEntry = {
            ...structuredCloneSafe(original),
            id: uid(),
            name: `${original.name} (copy)`,
            order: original.order + 0.5,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const saved = await repo.loreEntries.save(copy);
          set({ loreEntries: upsert(stateRef.current.loreEntries, saved) });
          return saved;
        });
      },

      /* ------------------------------------------------------ memories */

      async saveMemory(memory) {
        return guard('Saving the memory', async () => {
          const saved = await repo.memories.save(memory);
          set({ memories: upsert(stateRef.current.memories, saved) });
          return saved;
        });
      },
      async deleteMemory(id) {
        return guard('Deleting the memory', async () => {
          await repo.memories.remove(id);
          set({ memories: stateRef.current.memories.filter((m) => m.id !== id) });
        });
      },

      /* ----------------------------------------------------- providers */

      async saveProvider(provider) {
        return guard('Saving the provider', async () => {
          const saved = await repo.providers.save(provider);
          set({ providers: upsert(stateRef.current.providers, saved) });
          if (!stateRef.current.settings.activeProviderId) {
            await this.saveSettings({ activeProviderId: saved.id });
          }
          return saved;
        });
      },
      async deleteProvider(id) {
        return guard('Deleting the provider', async () => {
          await repo.providers.remove(id);
          const remaining = stateRef.current.providers.filter((p) => p.id !== id);
          set({ providers: remaining });
          if (stateRef.current.settings.activeProviderId === id) {
            await this.saveSettings({ activeProviderId: remaining[0]?.id ?? null });
          }
        });
      },

      async saveImageProvider(provider) {
        return guard('Saving the image provider', async () => {
          const saved = await repo.imageProviders.save(provider);
          set({ imageProviders: upsert(stateRef.current.imageProviders, saved) });
          if (!stateRef.current.settings.activeImageProviderId) {
            await this.saveSettings({ activeImageProviderId: saved.id });
          }
          return saved;
        });
      },
      async deleteImageProvider(id) {
        return guard('Deleting the image provider', async () => {
          await repo.imageProviders.remove(id);
          const remaining = stateRef.current.imageProviders.filter((p) => p.id !== id);
          set({ imageProviders: remaining });
          if (stateRef.current.settings.activeImageProviderId === id) {
            await this.saveSettings({ activeImageProviderId: remaining[0]?.id ?? null });
          }
        });
      },

      async saveStorySummary(summary) {
        return guard('Saving the story summary', async () => {
          const saved = await repo.storySummaries.save(summary);
          set({ storySummaries: upsert(stateRef.current.storySummaries, saved) });
          return saved;
        });
      },

      /* --------------------------------------------------------- media */

      async refreshMedia() {
        const media = await listMedia();
        set({ media });
        return media;
      },
      async removeMedia(id) {
        return guard('Deleting the image', async () => {
          const { deleteMedia } = await import('../media/mediaStore');
          await deleteMedia(id);

          // Detach it from anything that pointed at it.
          const chars = stateRef.current.characters.filter((c) => c.avatarMediaId === id);
          const people = stateRef.current.personas.filter((p) => p.avatarMediaId === id);
          const storyList = stateRef.current.stories.filter(
            (s) => s.coverMediaId === id || s.backgroundMediaId === id,
          );
          await Promise.all([
            repo.characters.saveMany(chars.map((c) => ({ ...c, avatarMediaId: null }))),
            repo.personas.saveMany(people.map((p) => ({ ...p, avatarMediaId: null }))),
            repo.stories.saveMany(
              storyList.map((s) => ({
                ...s,
                coverMediaId: s.coverMediaId === id ? null : s.coverMediaId,
                backgroundMediaId: s.backgroundMediaId === id ? null : s.backgroundMediaId,
              })),
            ),
          ]);

          const [characters, personas, stories, media] = await Promise.all([
            repo.characters.all(),
            repo.personas.all(),
            repo.stories.all(),
            listMedia(),
          ]);
          set({ characters, personas, stories, media });
        });
      },

      /* ---------------------------------------------------------- chat */

      async openChat(chatId) {
        if (!chatId) {
          set({ activeChatId: null, messages: [], branches: [], alternatives: [] });
          return;
        }
        set({ chatLoading: true });
        try {
          const chat = await repo.chats.get(chatId);
          if (!chat) {
            set({ chatLoading: false, activeChatId: null, messages: [], branches: [] });
            toast({ kind: 'error', title: 'That chat no longer exists.' });
            return;
          }
          const working = await loadChatWorkingSet(chatId);
          // Self-heal a chat whose branch row went missing.
          let branches = working.branches;
          let activeBranchId = chat.activeBranchId;
          if (!branches.length) {
            const branch = newBranch(chatId, { name: 'Main' });
            await repo.branches.save(branch);
            branches = [branch];
            activeBranchId = branch.id;
            await repo.chats.save({ ...chat, activeBranchId });
          } else if (!branches.some((b) => b.id === activeBranchId)) {
            activeBranchId = branches[0].id;
            await repo.chats.save({ ...chat, activeBranchId });
          }
          const nextChat = { ...chat, activeBranchId };
          set({
            activeChatId: chatId,
            messages: working.messages,
            branches,
            alternatives: working.alternatives,
            chats: upsert(stateRef.current.chats, nextChat),
            checkpoints: upsertMany(stateRef.current.checkpoints, working.checkpoints),
            chatLoading: false,
          });
        } catch (err) {
          set({ chatLoading: false });
          toast({
            kind: 'error',
            title: 'Could not open that chat',
            detail: (err as Error).message,
          });
        }
      },

      async createChat({ storyId = null, title, seedGreeting = true }) {
        return guard('Creating the chat', async () => {
          const story = storyId ? stateRef.current.stories.find((s) => s.id === storyId) : null;
          const chat = newChat({
            storyId,
            title: title ?? (story ? `${story.title} — chat` : 'New Chat'),
            personaId: story?.personaId ?? stateRef.current.settings.defaultPersonaId ?? null,
          });
          const branch = newBranch(chat.id, { name: 'Main' });
          chat.activeBranchId = branch.id;

          const seeded: Message[] = [];
          if (seedGreeting && story) {
            const primaryLink =
              story.characters.find((c) => c.primary && c.enabled) ??
              story.characters.find((c) => c.enabled);
            const character = primaryLink
              ? stateRef.current.characters.find((c) => c.id === primaryLink.characterId)
              : undefined;
            const greeting =
              character?.greetings.find((g) => g.id === character.defaultGreetingId) ??
              character?.greetings[0];
            if (greeting?.content.trim()) {
              seeded.push(
                newMessage(chat.id, branch.id, {
                  role: 'assistant',
                  characterId: character!.id,
                  content: greeting.content,
                  order: 0,
                }),
              );
              chat.orderCounter = 1;
            }
          }

          await repo.chats.save(chat);
          await repo.branches.save(branch);
          if (seeded.length) await repo.messages.saveMany(seeded);

          if (story && !story.defaultChatId) {
            const updated = await repo.stories.save({ ...story, defaultChatId: chat.id });
            set({ stories: upsert(stateRef.current.stories, updated) });
          }

          set({
            chats: upsert(stateRef.current.chats, chat),
            activeChatId: chat.id,
            messages: seeded,
            branches: [branch],
            alternatives: [],
          });
          return chat;
        });
      },

      async saveChat(chat) {
        return guard('Saving the chat', async () => {
          const saved = await repo.chats.save(chat);
          set({ chats: upsert(stateRef.current.chats, saved) });
          return saved;
        });
      },

      async deleteChat(id) {
        return guard('Deleting the chat', async () => {
          await repo.deleteChatCascade(id);
          const wasActive = stateRef.current.activeChatId === id;
          set({
            chats: stateRef.current.chats.filter((c) => c.id !== id),
            checkpoints: stateRef.current.checkpoints.filter((c) => c.chatId !== id),
            ...(wasActive
              ? { activeChatId: null, messages: [], branches: [], alternatives: [] }
              : {}),
          });
          const stories = stateRef.current.stories.filter((s) => s.defaultChatId === id);
          if (stories.length) {
            await repo.stories.saveMany(stories.map((s) => ({ ...s, defaultChatId: null })));
            set({
              stories: upsertMany(
                stateRef.current.stories,
                stories.map((s) => ({ ...s, defaultChatId: null })),
              ),
            });
          }
        });
      },

      async duplicateChat(id) {
        return guard('Duplicating the chat', async () => {
          const original = await repo.chats.get(id);
          if (!original) return null;
          const [srcMessages, srcBranches, srcAlternatives] = await Promise.all([
            repo.messages.byChat(id),
            repo.branches.byChat(id),
            repo.alternatives.byChat(id),
          ]);

          const chat: Chat = {
            ...structuredCloneSafe(original),
            id: uid(),
            title: `${original.title} (copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const branchMap = new Map<ID, ID>();
          const branches = srcBranches.map((b) => {
            const fresh = uid();
            branchMap.set(b.id, fresh);
            return { ...b, id: fresh, chatId: chat.id };
          });
          for (const branch of branches) {
            if (branch.parentBranchId) {
              branch.parentBranchId = branchMap.get(branch.parentBranchId) ?? null;
            }
          }
          const messageMap = new Map<ID, ID>();
          const messages = srcMessages.map((m) => {
            const fresh = uid();
            messageMap.set(m.id, fresh);
            return { ...m, id: fresh, chatId: chat.id, branchId: branchMap.get(m.branchId) ?? m.branchId };
          });
          for (const branch of branches) {
            if (branch.createdFromMessageId) {
              branch.createdFromMessageId = messageMap.get(branch.createdFromMessageId) ?? null;
            }
          }
          const alternativeMap = new Map<ID, ID>();
          const alternatives = srcAlternatives.map((a) => {
            const fresh = uid();
            alternativeMap.set(a.id, fresh);
            return {
              ...a,
              id: fresh,
              chatId: chat.id,
              messageId: messageMap.get(a.messageId) ?? a.messageId,
            };
          });
          for (const message of messages) {
            if (message.activeAlternativeId) {
              message.activeAlternativeId = alternativeMap.get(message.activeAlternativeId) ?? null;
            }
          }
          chat.activeBranchId = branchMap.get(original.activeBranchId) ?? branches[0]?.id ?? '';

          await repo.chats.save(chat);
          await repo.branches.saveMany(branches);
          await repo.messages.saveMany(messages);
          await repo.alternatives.saveMany(alternatives);
          set({ chats: upsert(stateRef.current.chats, chat) });
          return chat;
        });
      },

      /* ------------------------------------------------------ messages */

      async appendMessage(partial) {
        return guard('Saving the message', async () => {
          const current = stateRef.current;
          const chat = current.chats.find((c) => c.id === current.activeChatId);
          if (!chat) throw new Error('No chat is open.');
          const order = chat.orderCounter;
          const message = newMessage(chat.id, chat.activeBranchId, { ...partial, order });
          const nextChat = { ...chat, orderCounter: order + 1 };
          await repo.messages.save(message);
          await repo.chats.save(nextChat);
          set({
            messages: [...current.messages, message],
            chats: upsert(current.chats, nextChat),
          });
          return message;
        });
      },

      async updateMessage(message) {
        return guard('Updating the message', async () => {
          const saved = await repo.messages.save(message);
          set({ messages: upsert(stateRef.current.messages, saved) });
          return saved;
        });
      },

      async deleteMessage(id) {
        return guard('Deleting the message', async () => {
          const current = stateRef.current;
          const alternativeIds = current.alternatives
            .filter((a) => a.messageId === id)
            .map((a) => a.id);
          // A branch forked from this message would be orphaned.
          const orphanBranches = current.branches.filter((b) => b.createdFromMessageId === id);
          await repo.messages.remove(id);
          if (alternativeIds.length) await repo.alternatives.removeMany(alternativeIds);
          if (orphanBranches.length) {
            const message = current.messages.find((m) => m.id === id);
            const patched = orphanBranches.map((b) => ({
              ...b,
              createdFromMessageId: null,
              forkOrder: message?.order ?? b.forkOrder,
            }));
            await repo.branches.saveMany(patched);
            set({ branches: upsertMany(current.branches, patched) });
          }
          set({
            messages: stateRef.current.messages.filter((m) => m.id !== id),
            alternatives: stateRef.current.alternatives.filter((a) => a.messageId !== id),
          });
        });
      },

      async setActiveAlternative(messageId, alternativeId) {
        return guard('Switching response', async () => {
          const message = stateRef.current.messages.find((m) => m.id === messageId);
          if (!message) return;
          const saved = await repo.messages.save({ ...message, activeAlternativeId: alternativeId });
          set({ messages: upsert(stateRef.current.messages, saved) });
        });
      },

      async addAlternative(messageId, content, instruction, model) {
        return guard('Saving the alternative', async () => {
          const current = stateRef.current;
          const alternative: MessageAlternative = {
            id: uid(),
            messageId,
            chatId: current.activeChatId ?? '',
            content,
            instruction,
            model,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await repo.alternatives.save(alternative);
          set({ alternatives: [...current.alternatives, alternative] });
          return alternative;
        });
      },

      async deleteAlternative(alternativeId) {
        return guard('Deleting the alternative', async () => {
          const current = stateRef.current;
          const alternative = current.alternatives.find((a) => a.id === alternativeId);
          await repo.alternatives.remove(alternativeId);
          const message = alternative
            ? current.messages.find((m) => m.id === alternative.messageId)
            : undefined;
          if (message?.activeAlternativeId === alternativeId) {
            const saved = await repo.messages.save({ ...message, activeAlternativeId: null });
            set({ messages: upsert(current.messages, saved) });
          }
          set({ alternatives: stateRef.current.alternatives.filter((a) => a.id !== alternativeId) });
        });
      },

      /** Makes an alternative the message's canonical content. */
      async promoteAlternative(messageId, alternativeId) {
        return guard('Keeping this response', async () => {
          const current = stateRef.current;
          const message = current.messages.find((m) => m.id === messageId);
          const alternative = current.alternatives.find((a) => a.id === alternativeId);
          if (!message || !alternative) return;
          // The previous canonical text is preserved as an alternative.
          const preserved: MessageAlternative = {
            id: uid(),
            messageId,
            chatId: message.chatId,
            content: message.content,
            instruction: '',
            model: message.model ?? '',
            createdAt: message.createdAt,
            updatedAt: Date.now(),
          };
          await repo.alternatives.save(preserved);
          await repo.alternatives.remove(alternativeId);
          const saved = await repo.messages.save({
            ...message,
            content: alternative.content,
            model: alternative.model || message.model,
            activeAlternativeId: null,
          });
          set({
            messages: upsert(current.messages, saved),
            alternatives: [
              ...current.alternatives.filter((a) => a.id !== alternativeId),
              preserved,
            ],
          });
        });
      },

      /* ------------------------------------------------------ branches */

      async createBranch(fromMessageId, name) {
        return guard('Creating the branch', async () => {
          const current = stateRef.current;
          const chat = current.chats.find((c) => c.id === current.activeChatId);
          const message = current.messages.find((m) => m.id === fromMessageId);
          if (!chat || !message) return null;
          const siblingCount = current.branches.filter(
            (b) => b.parentBranchId === chat.activeBranchId,
          ).length;
          const branch = newBranch(chat.id, {
            parentBranchId: chat.activeBranchId,
            createdFromMessageId: fromMessageId,
            forkOrder: message.order,
            name: name?.trim() || `Branch ${siblingCount + 2}`,
          });
          await repo.branches.save(branch);
          const nextChat = { ...chat, activeBranchId: branch.id };
          await repo.chats.save(nextChat);
          set({
            branches: [...current.branches, branch],
            chats: upsert(current.chats, nextChat),
          });
          return branch;
        });
      },

      async renameBranch(branchId, name) {
        return guard('Renaming the branch', async () => {
          const branch = stateRef.current.branches.find((b) => b.id === branchId);
          if (!branch) return;
          const saved = await repo.branches.save({ ...branch, name: name.trim() || branch.name });
          set({ branches: upsert(stateRef.current.branches, saved) });
        });
      },

      async switchBranch(branchId) {
        return guard('Switching branch', async () => {
          const current = stateRef.current;
          const chat = current.chats.find((c) => c.id === current.activeChatId);
          if (!chat || chat.activeBranchId === branchId) return;
          const nextChat = { ...chat, activeBranchId: branchId };
          await repo.chats.save(nextChat);
          set({ chats: upsert(current.chats, nextChat) });
        });
      },

      async deleteBranch(branchId) {
        return guard('Deleting the branch', async () => {
          const current = stateRef.current;
          const chat = current.chats.find((c) => c.id === current.activeChatId);
          const branch = current.branches.find((b) => b.id === branchId);
          if (!chat || !branch) return;
          if (!branch.parentBranchId && current.branches.length === 1) {
            throw new Error('The main timeline cannot be deleted. Delete the chat instead.');
          }
          const doomed = descendantBranchIds(current.branches, branchId);
          const messageIds = ownedMessageIds(current.messages, doomed);
          const alternativeIds = current.alternatives
            .filter((a) => messageIds.includes(a.messageId))
            .map((a) => a.id);
          const checkpointIds = current.checkpoints
            .filter((c) => doomed.includes(c.branchId))
            .map((c) => c.id);

          await Promise.all([
            repo.branches.removeMany(doomed),
            repo.messages.removeMany(messageIds),
            repo.alternatives.removeMany(alternativeIds),
            repo.checkpoints.removeMany(checkpointIds),
          ]);

          const remaining = current.branches.filter((b) => !doomed.includes(b.id));
          const nextActive =
            chat.activeBranchId && doomed.includes(chat.activeBranchId)
              ? (branch.parentBranchId ?? remaining[0]?.id ?? '')
              : chat.activeBranchId;
          const nextChat = { ...chat, activeBranchId: nextActive };
          await repo.chats.save(nextChat);

          set({
            branches: remaining,
            messages: current.messages.filter((m) => !messageIds.includes(m.id)),
            alternatives: current.alternatives.filter((a) => !alternativeIds.includes(a.id)),
            checkpoints: current.checkpoints.filter((c) => !checkpointIds.includes(c.id)),
            chats: upsert(current.chats, nextChat),
          });
        });
      },

      /* --------------------------------------------------- checkpoints */

      async createCheckpoint(messageId, name, description = '') {
        return guard('Saving the checkpoint', async () => {
          const current = stateRef.current;
          const chat = current.chats.find((c) => c.id === current.activeChatId);
          const message = current.messages.find((m) => m.id === messageId);
          if (!chat || !message) return null;
          const checkpoint = newCheckpoint({
            name: name.trim() || `Checkpoint ${current.checkpoints.length + 1}`,
            description,
            storyId: chat.storyId,
            chatId: chat.id,
            branchId: chat.activeBranchId,
            messageId,
            messageOrder: message.order,
          });
          await repo.checkpoints.save(checkpoint);
          set({ checkpoints: [...current.checkpoints, checkpoint] });
          return checkpoint;
        });
      },

      async renameCheckpoint(checkpointId, name, description) {
        return guard('Renaming the checkpoint', async () => {
          const checkpoint = stateRef.current.checkpoints.find((c) => c.id === checkpointId);
          if (!checkpoint) return;
          const saved = await repo.checkpoints.save({
            ...checkpoint,
            name: name.trim() || checkpoint.name,
            description: description ?? checkpoint.description,
          });
          set({ checkpoints: upsert(stateRef.current.checkpoints, saved) });
        });
      },

      async deleteCheckpoint(checkpointId) {
        return guard('Deleting the checkpoint', async () => {
          await repo.checkpoints.remove(checkpointId);
          set({ checkpoints: stateRef.current.checkpoints.filter((c) => c.id !== checkpointId) });
        });
      },

      /** Restores by forking a new branch at the checkpoint — nothing is lost. */
      async restoreCheckpoint(checkpointId) {
        return guard('Restoring the checkpoint', async () => {
          const current = stateRef.current;
          const checkpoint = current.checkpoints.find((c) => c.id === checkpointId);
          if (!checkpoint) return null;
          if (current.activeChatId !== checkpoint.chatId) {
            await this.openChat(checkpoint.chatId);
          }
          const chat = stateRef.current.chats.find((c) => c.id === checkpoint.chatId);
          if (!chat) return null;
          const branch = newBranch(chat.id, {
            parentBranchId: checkpoint.branchId,
            createdFromMessageId: checkpoint.messageId,
            forkOrder: checkpoint.messageOrder,
            name: `From "${checkpoint.name}"`,
          });
          await repo.branches.save(branch);
          const nextChat = { ...chat, activeBranchId: branch.id };
          await repo.chats.save(nextChat);
          set({
            branches: [...stateRef.current.branches, branch],
            chats: upsert(stateRef.current.chats, nextChat),
          });
          return branch;
        });
      },

      /**
       * Copies the leading `count` messages of a chat into a new one. The
       * source chat is never touched, so this is safe from any point.
       */
      async chatFromMessages(chatId, count, upToMessageId) {
        return guard('Starting a new chat', async () => {
          const current = stateRef.current;
          const [srcMessages, srcBranches, srcChat] = await Promise.all([
            repo.messages.byChat(chatId),
            repo.branches.byChat(chatId),
            repo.chats.get(chatId),
          ]);
          if (!srcChat) return null;

          const line = resolveTimeline(srcMessages, srcBranches, srcChat.activeBranchId);
          const cut = upToMessageId
            ? line.findIndex((m) => m.id === upToMessageId) + 1 || count
            : count;
          const slice = line.slice(0, Math.max(0, cut));

          const story = srcChat.storyId
            ? current.stories.find((s) => s.id === srcChat.storyId)
            : null;
          const chat = newChat({
            storyId: srcChat.storyId,
            title: story ? `${story.title} — new thread` : `${srcChat.title} — new thread`,
            personaId: srcChat.personaId,
            lorebookIds: srcChat.lorebookIds,
            settings: srcChat.settings,
          });
          const branch = newBranch(chat.id, { name: 'Main' });
          chat.activeBranchId = branch.id;

          const messages = slice.map((message, index) => ({
            ...structuredCloneSafe(message),
            id: uid(),
            chatId: chat.id,
            branchId: branch.id,
            order: index,
            activeAlternativeId: null,
          }));
          chat.orderCounter = messages.length;

          await repo.chats.save(chat);
          await repo.branches.save(branch);
          if (messages.length) await repo.messages.saveMany(messages);

          set({
            chats: upsert(stateRef.current.chats, chat),
            activeChatId: chat.id,
            messages,
            branches: [branch],
            alternatives: [],
          });
          return chat;
        });
      },

      /** Copies history up to the checkpoint into a brand-new chat. */
      async chatFromCheckpoint(checkpointId) {
        return guard('Starting a chat from the checkpoint', async () => {
          const current = stateRef.current;
          const checkpoint = current.checkpoints.find((c) => c.id === checkpointId);
          if (!checkpoint) return null;

          const [srcMessages, srcBranches, srcChat] = await Promise.all([
            repo.messages.byChat(checkpoint.chatId),
            repo.branches.byChat(checkpoint.chatId),
            repo.chats.get(checkpoint.chatId),
          ]);
          const timeline = resolveTimeline(srcMessages, srcBranches, checkpoint.branchId).filter(
            (m) => m.order <= checkpoint.messageOrder,
          );

          const chat = newChat({
            storyId: srcChat?.storyId ?? null,
            title: `${srcChat?.title ?? 'Chat'} — from "${checkpoint.name}"`,
            personaId: srcChat?.personaId ?? null,
            lorebookIds: srcChat?.lorebookIds ?? [],
            settings: srcChat?.settings ?? {},
          });
          const branch = newBranch(chat.id, { name: 'Main' });
          chat.activeBranchId = branch.id;
          const messages = timeline.map((message, index) => ({
            ...structuredCloneSafe(message),
            id: uid(),
            chatId: chat.id,
            branchId: branch.id,
            order: index,
            activeAlternativeId: null,
          }));
          chat.orderCounter = messages.length;

          await repo.chats.save(chat);
          await repo.branches.save(branch);
          await repo.messages.saveMany(messages);
          set({
            chats: upsert(stateRef.current.chats, chat),
            activeChatId: chat.id,
            messages,
            branches: [branch],
            alternatives: [],
          });
          return chat;
        });
      },
    };
  }, [loadAll, set, toast]);

  const activeChat = useMemo(
    () => state.chats.find((c) => c.id === state.activeChatId) ?? null,
    [state.chats, state.activeChatId],
  );

  const activeBranch = useMemo(
    () => state.branches.find((b) => b.id === activeChat?.activeBranchId) ?? null,
    [state.branches, activeChat?.activeBranchId],
  );

  const timeline = useMemo(() => {
    if (!activeChat) return [];
    return resolveTimeline(state.messages, state.branches, activeChat.activeBranchId);
  }, [state.messages, state.branches, activeChat]);

  const value = useMemo<StoreValue>(
    () => ({ state, actions, toasts, dismissToast, timeline, activeChat, activeBranch }),
    [state, actions, toasts, dismissToast, timeline, activeChat, activeBranch],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** structuredClone is missing on older Safari; JSON round-trip is fine here. */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------- helpers */

/** Effective generation settings for a chat: chat → story → provider. */
export function effectiveGeneration(
  chat: Chat | null,
  story: Story | null,
  provider: Provider | null,
) {
  return {
    ...DEFAULT_GENERATION,
    ...(provider
      ? {
          temperature: provider.temperature,
          maxTokens: provider.maxTokens,
          topP: provider.topP,
          frequencyPenalty: provider.frequencyPenalty,
          presencePenalty: provider.presencePenalty,
          streaming: provider.streaming,
        }
      : {}),
    ...(story?.settings ?? {}),
    ...(chat?.settings ?? {}),
  };
}

export function activeProvider(state: AppState): Provider | null {
  return state.providers.find((p) => p.id === state.settings.activeProviderId) ?? null;
}

export function storyOf(state: AppState, chat: Chat | null): Story | null {
  if (!chat?.storyId) return null;
  return state.stories.find((s) => s.id === chat.storyId) ?? null;
}

export function charactersOf(state: AppState, story: Story | null): Character[] {
  if (!story) return [];
  return story.characters
    .filter((link) => link.enabled)
    .map((link) => state.characters.find((c) => c.id === link.characterId))
    .filter(Boolean) as Character[];
}

export function personaOf(state: AppState, chat: Chat | null, story: Story | null): Persona | null {
  const id = chat?.personaId ?? story?.personaId ?? state.settings.defaultPersonaId;
  if (!id) return null;
  return state.personas.find((p) => p.id === id) ?? null;
}

export function attachmentsOf(message: Message): Attachment[] {
  return message.attachments ?? [];
}

export function activeImageProvider(state: AppState): ImageProvider | null {
  return (
    state.imageProviders.find((p) => p.id === state.settings.activeImageProviderId) ?? null
  );
}

export function summaryOf(state: AppState, story: Story | null): StorySummary | null {
  if (!story) return null;
  return state.storySummaries.find((s) => s.storyId === story.id) ?? null;
}

/**
 * What the selected model can do. Provider-reported capabilities win; the
 * user's manual overrides win over those; otherwise we infer from the id.
 * Never assume — the UI gates controls on this.
 */
export function capabilitiesOf(provider: Provider | null): ModelCapabilities {
  if (!provider) return defaultCapabilities({ text: false, streaming: false });
  const reported = provider.modelInfo?.[provider.model]?.capabilities;
  const base = reported ?? inferCapabilities(provider.model || '');
  return {
    ...base,
    // The legacy per-provider vision flag still acts as an explicit opt-in.
    vision: provider.capabilityOverrides?.vision ?? (provider.visionSupport || base.vision),
    streaming: provider.capabilityOverrides?.streaming ?? (provider.streaming && base.streaming),
    text: provider.capabilityOverrides?.text ?? base.text,
    imageGeneration: provider.capabilityOverrides?.imageGeneration ?? base.imageGeneration,
  };
}
