import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AspectRatio,
  Attachment,
  Character,
  Chat,
  ID,
  MediaMeta,
  Memory,
  Message,
  Persona,
  Provider,
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
  acceptMemory,
  applyDiscoveries,
  applyRelationshipImpacts,
  memoryStatus,
} from '../memory/matrix';
import {
  applyDraft,
  generateStorySummary,
  shouldAutoSummarize,
} from '../memory/storySummary';
import { newStorySummary } from '../types/factories';
import { ProviderError, isOllama, streamComplete } from '../ai/client';
import { compileContext, type CompileInput, type CompileResult } from '../context/compiler';
import {
  ASSUMED_CONTEXT,
  DEFAULT_PRACTICAL_INPUT,
  fetchOllamaContextWindow,
  resolveUsableBudget,
  type UsableBudget,
} from '../ai/contextWindow';
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

/**
 * What may actually be spent on this generation.
 *
 * Ollama can be asked what the loaded model holds, so it is asked. Everything
 * else keeps the configured number, because a remote provider rejects an
 * oversized request loudly instead of truncating it in silence.
 */
async function resolveGenerationBudget(
  provider: Provider,
  generation: { contextSize?: number; maxTokens?: number },
  settings: { contextBudget?: number; maxPromptTokens?: number },
): Promise<UsableBudget> {
  // The per-chat override wins, then the global Context size, then the default.
  // The client used to fall back to its own constant here while the compiler
  // read the global setting, so the two could disagree about how big the prompt
  // was allowed to be.
  const requested = generation.contextSize ?? settings.contextBudget ?? ASSUMED_CONTEXT;
  const reserve = generation.maxTokens ?? 0;
  const practicalMax = settings.maxPromptTokens || DEFAULT_PRACTICAL_INPUT;

  if (!isOllama(provider)) {
    return resolveUsableBudget({
      requested,
      modelLimit: requested,
      reserveForResponse: reserve,
      practicalMax,
    });
  }
  const window = await fetchOllamaContextWindow(provider, provider.model);
  return resolveUsableBudget({
    requested,
    modelLimit: window.limit,
    reserveForResponse: reserve,
    practicalMax,
    reported: window.reported,
  });
}

/** Token cost per section, so an oversized prompt can be attributed. */
function summariseTokens(compiled: CompileResult): Array<{ label: string; tokens: number }> {
  const byKind = new Map<string, number>();
  for (const part of compiled.parts) {
    byKind.set(part.kind, (byKind.get(part.kind) ?? 0) + part.tokens);
  }
  return [...byKind.entries()]
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
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
  const characters = useMemo(
    () => charactersOf(state, story, activeChat),
    [state, story, activeChat],
  );
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

  /**
   * Memories that the branch being played can actually have witnessed.
   *
   * Branching never copies messages, so a memory extracted from a turn that
   * only exists on a sibling branch stayed in context after forking away from
   * it — the alternative timeline remembered a conversation it never had.
   * Provenance already answers this: an automatic memory is a claim about
   * specific messages, and a branch that cannot see any of them cannot have
   * seen the thing they say happened.
   *
   * Only `origin: 'auto'` is judged. A memory the author wrote or imported is
   * theirs, deliberate, and belongs wherever they put it. `pinned` is not
   * consulted either way: it raises a memory's priority and protects it from
   * trimming, but it is not a claim about which timeline the memory happened
   * in, and pinning something must not resurrect it on a branch that never saw
   * it.
   */
  const visibleMessageIds = useMemo(() => new Set(timeline.map((m) => m.id)), [timeline]);
  const onBranch = useCallback(
    (memory: Memory): boolean => {
      if (memory.origin !== 'auto') return true;
      // Nothing to judge: no provenance means no evidence it is off-branch.
      if (!memory.sourceMessageIds.length) return true;
      // Another chat's branch structure says nothing about this one's.
      if (memory.sourceChatId && memory.sourceChatId !== activeChat?.id) return true;
      return memory.sourceMessageIds.some((id) => visibleMessageIds.has(id));
    },
    [visibleMessageIds, activeChat?.id],
  );

  const memoriesForContext = useMemo(() => {
    const inScope = state.memories.filter(onBranch);
    if (!story) return inScope;
    // Story-attached memories first, then unattached global ones.
    const attached = inScope.filter(
      (m) => story.memoryIds.includes(m.id) || m.sourceStoryId === story.id,
    );
    const global = inScope.filter((m) => !m.sourceStoryId && !story.memoryIds.includes(m.id));
    return [...attached, ...global];
  }, [state.memories, story, onBranch]);

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
        /** The real window, once negotiated with the provider. */
        budgetOverride?: number;
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
      // Presence comes from the chat being generated for, not the one this
      // callback closed over — the same staleness that used to drop the newest
      // turn would otherwise compile the previous chat's scene.
      scene: (options.chat !== undefined ? options.chat : activeChat)?.scene ?? null,
      budgetOverride: options.budgetOverride,
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
    const currentCharacters = charactersOf(current, currentStory, chat);
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
          const { results, discovered, readable } = await maybeCreateAutoMemory({
            messages: exchange.map((m) => ({ ...m, content: contentOf(m) })),
            characters: currentCharacters,
            persona: currentPersona,
            provider: currentProvider,
            settings: current.settings,
            chatId: chat.id,
            storyId: chat.storyId,
            existing: current.memories,
          });

          for (const result of results) {
            // Accepting is what makes a supersession real, so a memory that
            // commits on its own must go through the same path as one accepted
            // by hand rather than being written straight in.
            const writes =
              memoryStatus(result.memory) === 'active'
                ? acceptMemory(result.memory, current.memories)
                : [result.memory];
            for (const write of writes) await actions.saveMemory(write);
          }

          // Nothing recorded because the model's answer could not be read is a
          // different thing from nothing worth recording, and it must not look
          // the same — otherwise a model that cannot produce JSON leaves
          // automatic memory quietly doing nothing forever.
          if (!readable) {
            actions.toast({
              kind: 'warn',
              title: 'Could not read the memory extraction',
              detail:
                'The model did not answer with the JSON that was asked for, so nothing was recorded. Smaller models often need a larger one for this — or turn automatic memory off and use Remember in a chat instead.',
            });
          }

          const committed = results.filter((r) => memoryStatus(r.memory) === 'active');
          const proposed = results.filter((r) => memoryStatus(r.memory) !== 'active');

          if (committed.length) {
            actions.toast({
              kind: 'info',
              title:
                committed.length === 1
                  ? 'Memory saved automatically'
                  : `${committed.length} memories saved automatically`,
              detail: `${committed.map((r) => r.memory.title).join(' · ')} — edit or delete them from Memories.`,
            });
          }
          if (proposed.length) {
            actions.toast({
              kind: 'info',
              title:
                proposed.length === 1
                  ? 'A memory is waiting for you'
                  : `${proposed.length} memories are waiting for you`,
              detail:
                'Not confident enough to save on its own, so it is not being used yet. Review it in Memories.',
            });
          }

          // A beat that moved two people is also a change to where they stand,
          // and a name the story invented is someone the cast may want. Both
          // land on the story, so they are folded in one write.
          if (currentStory) {
            const withRelationships =
              applyRelationshipImpacts(
                currentStory,
                results.map((r) => r.memory),
              ) ?? currentStory;
            const withDiscoveries = applyDiscoveries(
              withRelationships,
              discovered,
              current.characters,
            );
            const updated = withDiscoveries ?? withRelationships;
            if (updated !== currentStory) await actions.saveStory(updated);

            const added = (withDiscoveries?.discovered?.length ?? 0) -
              (currentStory.discovered?.length ?? 0);
            if (added > 0) {
              actions.toast({
                kind: 'info',
                title: added === 1 ? 'Someone new was named' : `${added} new people were named`,
                detail:
                  'They are not in the cast — the story just mentioned them. Add or dismiss them under the story’s Cast tab.',
              });
            }
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

      /*
       * Who is being asked to reply, strongest claim first.
       *
       * The scene's own lead used to be skipped entirely, so a chat re-cast
       * around Halda still generated for whoever the *story* was built around.
       * resolveScene treats the id handed to it as an explicit request, which
       * outranks the scene's declaration and puts that character back in the
       * room — so a stale story-level flag quietly re-seated a character the
       * user had removed, and, since the responder now gates secrets and
       * character-only lore, brought their private material with them.
       *
       * The story-level `primary` stays exactly what it was: the default for a
       * scene that has not named a lead of its own. It is read from the live
       * story rather than the closed-over one for the same reason as above.
       */
      const respondingId =
        target.characterId ??
        liveChat.scene?.primaryCharacterId ??
        liveStory?.characters.find((c) => c.primary && c.enabled)?.characterId ??
        characters[0]?.id ??
        null;

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

        const configured = effectiveGeneration(liveChat, liveStory, provider);
        // A reply allowance has to be held inside the context window, so an
        // enormous one is paid for on every message whether or not the model
        // ever writes that much. Cap it to what a roleplay turn can actually
        // use; the setting still lowers it, it just cannot inflate the window.
        const outputCeiling = state.settings.maxResponseTokens || 2048;
        const generation = {
          ...configured,
          maxTokens: Math.min(configured.maxTokens ?? outputCeiling, outputCeiling),
        };

        // Find out what the model can actually hold before building anything.
        // Compiling to the configured number and letting the server sort it out
        // is what silently deleted the system prompt — Ollama truncates from the
        // head, so the persona and the scene were the first things to go.
        const usable = await resolveGenerationBudget(provider, generation, state.settings);

        const compiled = compileContext(
          buildCompileInput(history, {
            instruction: target.instruction,
            respondingCharacterId: respondingId,
            imageMap,
            chat: liveChat,
            story: liveStory,
            budgetOverride: usable.promptBudget,
          }),
        );

        if ((configured.maxTokens ?? 0) > generation.maxTokens) {
          actions.toast({
            kind: 'warn',
            title: `Reply limit set to ${generation.maxTokens.toLocaleString()} tokens`,
            detail:
              `This chat asks for ${configured.maxTokens!.toLocaleString()}. A reply allowance is ` +
              `held open inside the context window on every message, so a large one is paid for ` +
              `on every turn whether or not it is used. Change "Longest reply" in Settings to ` +
              `raise the cap.`,
          });
        }
        if (usable.clamped || usable.capped) {
          actions.toast({
            kind: 'warn',
            title: `Prompt built to ${usable.promptBudget.toLocaleString()} tokens`,
            detail: usable.clamped
              ? `This chat is configured for ${usable.requested.toLocaleString()} tokens of ` +
                `prompt; ${provider.model} can hold ${usable.modelLimit.toLocaleString()} in ` +
                `total, shared with the reply. The prompt is built to fit rather than being ` +
                `truncated by the server.`
              : `${provider.model} could hold ${usable.modelLimit.toLocaleString()}, but a ` +
                `roleplay turn does not need it: the scene, the cast and recent turns fit in ` +
                `${usable.promptBudget.toLocaleString()}. A larger prompt costs latency on every ` +
                `message. Change "Prompt budget" in Settings to raise it.`,
          });
        } else if (compiled.overBudget) {
          actions.toast({
            kind: 'warn',
            title: 'Context is over budget',
            detail: `${compiled.totalTokens} estimated tokens vs a ${compiled.budget} budget. Older messages and low-priority items were trimmed.`,
          });
        }

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
          promptTokens: compiled.totalTokens,
          breakdown: summariseTokens(compiled),
          pipeline: compiled.pipeline,
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
      // `story` is gone from this list because generate() now reads the live
      // story for responder selection, exactly as it already did for the chat
      // and the timeline. Keeping it would only re-create the callback when a
      // value it no longer reads changes.
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
