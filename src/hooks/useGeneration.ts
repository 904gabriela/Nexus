import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  Attachment,
  Character,
  Chat,
  ID,
  Message,
  Persona,
  Story,
} from '../types';
import {
  activeProvider,
  charactersOf,
  effectiveGeneration,
  personaOf,
  storyOf,
  useActions,
  useAppState,
  useStore,
} from '../state/store';
import { ProviderError, streamComplete } from '../ai/client';
import { compileContext, type CompileInput, type CompileResult } from '../context/compiler';
import { getMediaBlob, blobToDataUrl } from '../media/mediaStore';

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
  const { timeline, activeChat } = useStore();
  const abortRef = useRef<AbortController | null>(null);
  /** Latest streamed text, readable from the catch block after an abort. */
  const streamingTextRef = useRef('');

  const [generating, setGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingFor, setStreamingFor] = useState<ID | null>(null);
  const [error, setError] = useState<string | null>(null);

  const story = useMemo(() => storyOf(state, activeChat), [state, activeChat]);
  const characters = useMemo(() => charactersOf(state, story), [state, story]);
  const persona = useMemo(() => personaOf(state, activeChat, story), [state, activeChat, story]);
  const provider = useMemo(() => activeProvider(state), [state]);

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
      } = {},
    ): CompileInput => ({
      settings: state.settings,
      story,
      chat: activeChat,
      characters,
      persona,
      memories: memoriesForContext,
      lorebooks: state.lorebooks,
      loreEntries: state.loreEntries,
      history: history.map((message) => ({ ...message, content: contentOf(message) })),
      pendingUserText: options.pendingUserText,
      pendingAttachments: options.pendingAttachments,
      instruction: options.instruction,
      respondingCharacterId: options.respondingCharacterId,
      visionEnabled: !!provider?.visionSupport,
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
      provider,
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

      // History excludes the message being replaced so it is not fed back in.
      const history = target.replaceMessageId
        ? timeline.slice(
            0,
            timeline.findIndex((m) => m.id === target.replaceMessageId),
          )
        : timeline;

      const controller = new AbortController();
      abortRef.current = controller;
      setGenerating(true);
      setStreamingText('');
      streamingTextRef.current = '';
      setError(null);
      setStreamingFor(target.replaceMessageId ?? 'new');

      let placeholder: Message | null = null;
      try {
        const imageMap = provider.visionSupport
          ? await buildImageMap(history, [])
          : undefined;

        const compiled = compileContext(
          buildCompileInput(history, {
            instruction: target.instruction,
            respondingCharacterId: respondingId,
            imageMap,
          }),
        );

        if (compiled.overBudget) {
          actions.toast({
            kind: 'warn',
            title: 'Context is over budget',
            detail: `${compiled.totalTokens} estimated tokens vs a ${compiled.budget} budget. Older messages and low-priority items were trimmed.`,
          });
        }

        const generation = effectiveGeneration(activeChat, story, provider);

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
            setStreamingText(full);
          },
        });

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
          const message = state.messages.find((m) => m.id === target.replaceMessageId);
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
        setGenerating(false);
        setStreamingText('');
        setStreamingFor(null);
      }
    },
    [
      activeChat,
      provider,
      story,
      characters,
      timeline,
      buildCompileInput,
      actions,
      state.messages,
    ],
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
    story,
    characters,
    persona,
  };
}

export type UseGeneration = ReturnType<typeof useGeneration>;

export function speakerFor(
  message: Message,
  characters: Character[],
  persona: Persona | null,
  story: Story | null,
): { name: string; character: Character | null } {
  if (message.role === 'user') {
    return { name: persona?.displayName || persona?.name || 'You', character: null };
  }
  if (message.role === 'system') return { name: 'System', character: null };
  const character =
    characters.find((c) => c.id === message.characterId) ??
    characters.find((c) => c.id === story?.characters.find((l) => l.primary)?.characterId) ??
    characters[0] ??
    null;
  return { name: character?.displayName || character?.name || 'Assistant', character };
}

export function chatDisplayTitle(chat: Chat | null, story: Story | null): string {
  if (!chat) return 'Chat';
  if (chat.title && chat.title !== 'New Chat') return chat.title;
  return story?.title || chat.title || 'Chat';
}
