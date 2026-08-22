import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AspectRatio,
  Attachment,
  Character,
  Chat,
  ID,
  MediaMeta,
  Message,
  Persona,
  Story,
} from '../types';
import {
  activeImageProvider,
  activeProvider,
  capabilitiesOf,
  charactersOf,
  effectiveGeneration,
  personaOf,
  storyOf,
  summaryOf,
  useActions,
  useAppState,
  useStore,
} from '../state/store';
import { maybeCreateAutoMemory } from '../memory/autoMemory';
import {
  applyDraft,
  generateStorySummary,
  shouldAutoSummarize,
} from '../memory/storySummary';
import { newStorySummary } from '../types/factories';
import { ProviderError, streamComplete } from '../ai/client';
import { compileContext, type CompileInput, type CompileResult } from '../context/compiler';
import { resolveTimeline } from '../services/timeline';
import { getMediaBlob, blobToDataUrl, saveMedia } from '../media/mediaStore';
import { ImageError, generateImage } from '../ai/imageClient';

export interface GenerationTarget {
  /** Which cast member replies; defaults to the primary character. */
  characterId?: ID | null;
  /** One-off steering instruction (regenerate with instruction). */
  instruction?: string;
  /** Replace this assistant message instead of appending a new one. */
  replaceMessageId?: ID;
  /** Store the result as an alternative rather than overwriting. */
  asAlternative?: boolean;
}

export interface GenerationState {
  generating: boolean;
  streamingText: string;
  streamingFor: ID | null;
  error: string | null;
}

/** Resolves attachment blobs to data URLs for vision-capable providers. */
async function buildImageMap(messages: Message[], pending: Attachment[]): Promise<Map<ID, string>> {
  const map = new Map<ID, string>();
  const attachments = [...messages.flatMap((m) => m.attachments ?? []), ...pending];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image' || !attachment.mediaId || map.has(attachment.mediaId)) continue;
    const blob = await getMediaBlob(attachment.mediaId);
    if (!blob) continue;
    try {
      map.set(attachment.mediaId, await blobToDataUrl(blob));
    } catch {
      /* a single unreadable image must not abort the whole generation */
    }
  }
  return map;
}

export function useGeneration() {
  const state = useAppState();
  const actions = useActions();
  const { timeline, activeChat, getState } = useStore();
  const abortRef = useRef<AbortController | null>(null);
  /** Latest streamed text, readable from the catch block after an abort. */
  const streamingTextRef = useRef('');

  const [generating, setGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  /** Pending frame for coalesced streaming updates; null when none is queued. */
  const streamFrameRef = useRef<number | null>(null);

  /** Drops any queued frame so a finished stream cannot paint over the result. */
  const flushStreamFrame = () => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
  };
  const [streamingFor, setStreamingFor] = useState<ID | null>(null);
  const [error, setError] = useState<string | null>(null);

  const story = useMemo(() => storyOf(state, activeChat), [state, activeChat]);
  const characters = useMemo(() => charactersOf(state, story), [state, story]);
  const persona = useMemo(() => personaOf(state, activeChat, story), [state, activeChat, story]);
  const provider = useMemo(() => activeProvider(state), [state]);
  const imageProvider = useMemo(() => activeImageProvider(state), [state]);
  const capabilities = useMemo(() => capabilitiesOf(provider), [provider]);
  const summary = useMemo(() => summaryOf(state, story), [state, story]);

  /** Alternative-aware content for a message. */
  const contentOf = useCallback(
    (message: Message): string => {
      if (!message.activeAlternativeId) return message.content;
      const alternative = state.alternatives.find((a) => a.id === message.activeAlternativeId);
      return alternative?.content ?? message.content;
    },
    [state.alternatives],
  );

  const memoriesForContext = useMemo(() => {
    if (!story) return state.memories;
    // Story-attached memories first, then unattached global ones.
    const attached = state.memories.filter(
      (m) => story.memoryIds.includes(m.id) || m.sourceStoryId === story.id,
    );
    const global = state.memories.filter(
      (m) => !m.sourceStoryId && !story.memoryIds.includes(m.id),
    );
    return [...attached, ...global];
  }, [state.memories, story]);

  const buildCompileInput = useCallback(
    (
      history: Message[],
      options: {
        pendingUserText?: string;
        pendingAttachments?: Attachment[];
        instruction?: string;
        respondingCharacterId?: ID | null;
        imageMap?: Map<ID, string>;
        /**
         * The chat and story as they are at call time. generate() resolves
         * these from the live store, because the values this callback closed
         * over can be a render behind — sending immediately after switching
         * chats would otherwise compile with the previous chat's direction and
         * context size.
         */
        chat?: Chat | null;
        story?: Story | null;
      } = {},
    ): CompileInput => ({
      settings: state.settings,
      story: options.story !== undefined ? options.story : story,
      chat: options.chat !== undefined ? options.chat : activeChat,
      characters,
      persona,
      memories: memoriesForContext,
      lorebooks: state.lorebooks,
      loreEntries: state.loreEntries,
      history: history.map((message) => ({ ...message, content: contentOf(message) })),
      summary,
      pendingUserText: options.pendingUserText,
      pendingAttachments: options.pendingAttachments,
      instruction: options.instruction,
      respondingCharacterId: options.respondingCharacterId,
      visionEnabled: capabilities.vision,
      imageResolver: options.imageMap
        ? (attachment) => (attachment.mediaId ? options.imageMap!.get(attachment.mediaId) : undefined)
        : undefined,
    }),
    [
      state.settings,
      state.lorebooks,
      state.loreEntries,
      story,
      activeChat,
      characters,
      persona,
      memoriesForContext,
      contentOf,
      capabilities.vision,
      summary,
    ],
  );

  /** Synchronous preview used by the Context Inspector and the token meter. */
  const previewContext = useCallback(
    (options: {
      pendingUserText?: string;
      pendingAttachments?: Attachment[];
      respondingCharacterId?: ID | null;
    } = {}): CompileResult => compileContext(buildCompileInput(timeline, options)),
    [buildCompileInput, timeline],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * Keeps long-run memory current after a turn: folds older history into the
   * rolling summary, and proposes an automatic memory when a trigger fires.
   * Runs detached so neither can delay or break the reply.
   */
  const runPostTurnUpkeep = useCallback(async () => {
    const current = getState();
    const chat = current.chats.find((c) => c.id === current.activeChatId) ?? null;
    if (!chat) return;
    const currentStory = storyOf(current, chat);
    const currentCharacters = charactersOf(current, currentStory);
    const currentPersona = personaOf(current, chat, currentStory);
    const currentProvider = activeProvider(current);
    const line = resolveTimeline(current.messages, current.branches, chat.activeBranchId);

    // 1. Rolling story summary.
    if (currentStory && current.settings.useStorySummary) {
      const existing = summaryOf(current, currentStory);
      if (
        shouldAutoSummarize(
          existing,
          line,
          current.settings.summaryWindow,
          current.settings.autoSummaryEvery,
        )
      ) {
        try {
          const draft = await generateStorySummary({
            story: currentStory,
            existing,
            characters: currentCharacters,
            persona: currentPersona,
            timeline: line,
            window: current.settings.summaryWindow,
            provider: currentProvider,
          });
          await actions.saveStorySummary(
            applyDraft(existing ?? newStorySummary(currentStory.id), draft),
          );
        } catch {
          // A failed summary just means the next turn tries again.
        }
      }
    }

    // 2. Automatic memory.
    if (current.settings.autoMemory && current.settings.autoMemoryEvery > 0) {
      const assistantCount = line.filter((m) => m.role === 'assistant').length;
      if (assistantCount > 0 && assistantCount % current.settings.autoMemoryEvery === 0) {
        try {
          const exchange = line.slice(-2);
          const result = await maybeCreateAutoMemory({
            messages: exchange.map((m) => ({ ...m, content: contentOf(m) })),
            characters: currentCharacters,
            persona: currentPersona,
            provider: currentProvider,
            settings: current.settings,
            chatId: chat.id,
            storyId: chat.storyId,
            existing: current.memories,
          });
          if (result) {
            await actions.saveMemory(result.memory);
            actions.toast({
              kind: 'info',
              title: 'Memory saved automatically',
              detail: `${result.memory.title} — triggered by: ${result.hit.trigger}. Edit or delete it from Memories.`,
            });
          }
        } catch {
          // Automatic memory is an assist, never a hard requirement.
        }
      }
    }
  }, [actions, contentOf, getState]);

  const generate = useCallback(
    async (target: GenerationTarget = {}): Promise<void> => {
      if (!activeChat) return;
      if (!provider) {
        setError('No AI provider is configured.');
        actions.toast({
          kind: 'error',
          title: 'No AI provider configured',
          detail: 'Add one in Settings → AI Providers before generating a reply.',
        });
        return;
      }
      if (!provider.model) {
        setError('No model selected.');
        actions.toast({
          kind: 'error',
          title: 'No model selected',
          detail: `Choose a model for "${provider.name}" in Settings.`,
        });
        return;
      }

      const respondingId =
        target.characterId ??
        story?.characters.find((c) => c.primary && c.enabled)?.characterId ??
        characters[0]?.id ??
        null;

      // Resolve the timeline at call time rather than trusting the value this
      // callback closed over. send() appends the user's message and calls
      // generate() in the same tick, so the closed-over timeline is one message
      // stale — using it silently drops the newest turn from the request.
      const live = getState();
      const liveChat = live.chats.find((c) => c.id === live.activeChatId) ?? activeChat;
      const liveStory = storyOf(live, liveChat);
      const currentTimeline = resolveTimeline(
        live.messages,
        live.branches,
        liveChat.activeBranchId,
      );

      // History excludes the message being replaced so it is not fed back in.
      const replaceIndex = target.replaceMessageId
        ? currentTimeline.findIndex((m) => m.id === target.replaceMessageId)
        : -1;
      const history =
        replaceIndex >= 0 ? currentTimeline.slice(0, replaceIndex) : currentTimeline;

      const controller = new AbortController();
      abortRef.current = controller;
      setGenerating(true);
      flushStreamFrame();
      setStreamingText('');
      streamingTextRef.current = '';
      setError(null);
      setStreamingFor(target.replaceMessageId ?? 'new');

      let placeholder: Message | null = null;
      try {
        const imageMap = capabilities.vision
          ? await buildImageMap(history, [])
          : undefined;

        const compiled = compileContext(
          buildCompileInput(history, {
            instruction: target.instruction,
            respondingCharacterId: respondingId,
            imageMap,
            chat: liveChat,
            story: liveStory,
          }),
        );

        if (compiled.overBudget) {
          actions.toast({
            kind: 'warn',
            title: 'Context is over budget',
            detail: `${compiled.totalTokens} estimated tokens vs a ${compiled.budget} budget. Older messages and low-priority items were trimmed.`,
          });
        }

        const generation = effectiveGeneration(liveChat, liveStory, provider);

        // Append a live placeholder so streaming text has somewhere to land.
        if (!target.replaceMessageId && !target.asAlternative) {
          placeholder = await actions.appendMessage({
            role: 'assistant',
            characterId: respondingId,
            content: '',
            model: provider.model,
          });
          setStreamingFor(placeholder.id);
        }

        const text = await streamComplete({
          provider,
          messages: compiled.messages,
          settings: generation,
          signal: controller.signal,
          onToken: (_chunk, full) => {
            streamingTextRef.current = full;
            // A fast local model can emit tokens far quicker than the screen
            // refreshes. Painting each one costs a render nobody can see, and
            // on a phone that is what makes the rest of the UI stop
            // responding mid-reply, so updates are coalesced to one a frame.
            if (streamFrameRef.current !== null) return;
            streamFrameRef.current = requestAnimationFrame(() => {
              streamFrameRef.current = null;
              setStreamingText(streamingTextRef.current);
            });
          },
        });

        flushStreamFrame();
        const finalText = text.trim();
        if (!finalText) throw new ProviderError('The model returned an empty response.');

        if (target.asAlternative && target.replaceMessageId) {
          const alternative = await actions.addAlternative(
            target.replaceMessageId,
            finalText,
            target.instruction ?? '',
            provider.model,
          );
          // Show the new alternative straight away.
          await actions.setActiveAlternative(target.replaceMessageId, alternative.id);
        } else if (target.replaceMessageId) {
          const message = getState().messages.find((m) => m.id === target.replaceMessageId);
          if (message) {
            await actions.updateMessage({
              ...message,
              content: finalText,
              model: provider.model,
              error: undefined,
            });
          }
        } else if (placeholder) {
          await actions.updateMessage({
            ...placeholder,
            content: finalText,
            model: provider.model,
          });
        }
      } catch (err) {
        const aborted = (err as Error)?.name === 'AbortError';
        const partial = streamingTextRef.current;
        if (aborted) {
          // Keep whatever streamed before the stop.
          if (placeholder) {
            if (partial.trim()) {
              await actions.updateMessage({ ...placeholder, content: partial.trim() });
            } else {
              await actions.deleteMessage(placeholder.id);
            }
          }
          actions.toast({ kind: 'info', title: 'Generation stopped' });
        } else {
          const message =
            err instanceof ProviderError
              ? err.message
              : `Generation failed: ${(err as Error).message}`;
          const detail = err instanceof ProviderError ? err.detail : undefined;
          setError(message);
          actions.toast({ kind: 'error', title: 'Generation failed', detail: detail ?? message });
          if (placeholder) {
            if (partial.trim()) {
              await actions.updateMessage({
                ...placeholder,
                content: partial.trim(),
                error: message,
              });
            } else {
              await actions.deleteMessage(placeholder.id);
            }
          }
        }
      } finally {
        abortRef.current = null;
        flushStreamFrame();
        setGenerating(false);
        setStreamingText('');
        setStreamingFor(null);
      }

      // Background upkeep. These are best-effort: a failure here must never
      // surface as a failed reply, so each is caught independently.
      void runPostTurnUpkeep();
    },
    [
      activeChat,
      provider,
      story,
      characters,
      timeline,
      buildCompileInput,
      actions,
      getState,
      capabilities.vision,
      runPostTurnUpkeep,
    ],
  );

  /* ---------------------------------------------------------- image gen */

  const [generatingImage, setGeneratingImage] = useState(false);
  const imageAbortRef = useRef<AbortController | null>(null);

  const stopImage = useCallback(() => {
    imageAbortRef.current?.abort();
    imageAbortRef.current = null;
  }, []);

  /**
   * Generates an image and stores it as blob-backed media, tagged with where
   * it came from so the gallery can group it and it can be regenerated later.
   */
  const createImage = useCallback(
    async (options: {
      prompt: string;
      aspect?: AspectRatio;
      messageId?: ID | null;
      characterId?: ID | null;
      personaId?: ID | null;
    }): Promise<MediaMeta | null> => {
      if (!imageProvider) {
        actions.toast({
          kind: 'error',
          title: 'No image provider configured',
          detail: 'Add one in Settings → Image Generation before generating art.',
        });
        return null;
      }

      const controller = new AbortController();
      imageAbortRef.current = controller;
      setGeneratingImage(true);
      try {
        const result = await generateImage({
          provider: imageProvider,
          prompt: options.prompt,
          aspect: options.aspect ?? imageProvider.defaultAspect,
          signal: controller.signal,
        });

        const extension = result.mimeType.includes('jpeg') ? 'jpg' : 'png';
        const file =
          typeof File !== 'undefined'
            ? new File([result.blob], `generated-${Date.now()}.${extension}`, {
                type: result.mimeType,
              })
            : result.blob;

        const meta = await saveMedia(file, {
          ownerType: 'generated',
          source: 'generated',
          prompt: result.prompt,
          imageProviderId: imageProvider.id,
          imageModel: result.model,
          storyId: story?.id ?? null,
          chatId: activeChat?.id ?? null,
          messageId: options.messageId ?? null,
          characterId: options.characterId ?? null,
          personaId: options.personaId ?? null,
          // Preserve the model's exact output rather than re-encoding it.
          preserveOriginal: true,
        });
        await actions.refreshMedia();
        return meta;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          actions.toast({ kind: 'info', title: 'Image generation stopped' });
          return null;
        }
        const detail =
          err instanceof ImageError ? (err.detail ?? err.message) : (err as Error).message;
        actions.toast({
          kind: 'error',
          title: 'Image generation failed',
          detail,
        });
        return null;
      } finally {
        imageAbortRef.current = null;
        setGeneratingImage(false);
      }
    },
    [imageProvider, actions, story, activeChat],
  );

  return {
    generating,
    streamingText,
    streamingFor,
    error,
    generate,
    stop,
    previewContext,
    contentOf,
    provider,
    imageProvider,
    capabilities,
    summary,
    story,
    characters,
    persona,
    /** Trailing slice of the active branch, for image prompt building. */
    recentTimeline: timeline.slice(-8),
    generatingImage,
    createImage,
    stopImage,
  };
}

export type UseGeneration = ReturnType<typeof useGeneration>;

/**
 * Who said this message.
 *
 * A user message is attributed to the persona that wrote it, not the one
 * selected now — switching persona mid-story must not retroactively relabel
 * everything you already said. `personas` lets an older message resolve its own
 * author; the active persona is only the fallback for messages saved before
 * personaId existed.
 */
export function speakerFor(
  message: Message,
  characters: Character[],
  persona: Persona | null,
  story: Story | null,
  personas: Persona[] = [],
): { name: string; character: Character | null; persona: Persona | null } {
  if (message.role === 'user') {
    const author =
      (message.personaId ? personas.find((p) => p.id === message.personaId) : null) ?? persona;
    return {
      name: author?.displayName || author?.name || 'You',
      character: null,
      persona: author ?? null,
    };
  }
  if (message.role === 'system') return { name: 'System', character: null, persona: null };
  const character =
    characters.find((c) => c.id === message.characterId) ??
    characters.find((c) => c.id === story?.characters.find((l) => l.primary)?.characterId) ??
    characters[0] ??
    null;
  return {
    name: character?.displayName || character?.name || 'Assistant',
    character,
    persona: null,
  };
}

export function chatDisplayTitle(chat: Chat | null, story: Story | null): string {
  if (!chat) return 'Chat';
  if (chat.title && chat.title !== 'New Chat') return chat.title;
  return story?.title || chat.title || 'Chat';
}
