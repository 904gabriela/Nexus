import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Chat, ID, Memory, Message, MessageAlternative } from '../types';
import { newMemory } from '../types/factories';
import { effectiveGeneration, useActions, useAppState, useStore } from '../state/store';
import { useGeneration, chatDisplayTitle, speakerFor } from '../hooks/useGeneration';
import { MessageItem, type QuickAction } from '../components/chat/MessageItem';
import { ContextInspector } from '../components/chat/ContextInspector';
import { CheckpointPanel } from '../components/chat/BranchPanel';
import { ImageGenPanel } from '../components/chat/ImageGenPanel';
import { AiSummarySheet } from '../components/chat/AiSummarySheet';
import { StorySummarySheet } from '../components/chat/StorySummarySheet';
import { type JumpTarget } from '../components/chat/StoryTimeline';
import { StoryMap } from '../components/chat/StoryMap';
import { ResponseSettingsSheet } from '../components/chat/ResponseSettingsSheet';
import { QuickSettings } from '../components/chat/QuickSettings';
import { resolveScene } from '../context/scene';
import { MemoryEditor } from './Memories';
import { Icon } from '../components/ui/Icon';
import { ActionSheet, Sheet } from '../components/ui/Sheet';
import { Banner, EmptyState, Spinner, copyText, useAutoResize } from '../components/ui/common';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { MediaImage, useMediaUrl } from '../components/media/MediaImage';
import { IMAGE_ACCEPT_ATTR, MediaError, saveMedia } from '../media/mediaStore';
import { generateMemoryDraft } from '../memory/summarizer';
import { estimateTokens, formatTokens } from '../context/tokens';
import type { CompileResult } from '../context/compiler';
import { onIdle } from '../utils/idle';
import { downloadFile, exportChat, exportFilename, chatToTranscript } from '../exporters';
import { uid } from '../utils/uid';
import { truncate } from '../utils/text';
import { renderStats } from '../utils/perf';
import { clearDraft, getDraft, setDraft, useDraft } from '../state/composerDraft';
import type { RouteName } from '../state/router';

/** Shared empty list, so a message with no alternatives keeps a stable prop. */
const NO_ALTERNATIVES: MessageAlternative[] = [];

/** How many messages are mounted at once, and how many more each step adds. */
const WINDOW_STEP = 60;

/**
 * The token chip, which is the only part of the header that cares about the
 * draft. It subscribes to the draft itself and adds the draft's own estimate to
 * an already-compiled total, so the number stays live without the chat screen
 * — and therefore the message list — rerendering on every keystroke.
 */
const TokenChip = memo(function TokenChip({
  baseTokens,
  budget,
  overBudget,
  onOpen,
}: {
  baseTokens: number;
  budget: number;
  overBudget: boolean;
  onOpen: () => void;
}) {
  const draft = useDraft();
  const total = baseTokens + (draft ? estimateTokens(draft) : 0);
  const pct = Math.min(100, Math.round((total / Math.max(1, budget)) * 100));
  const over = overBudget || total > budget;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={onOpen}
      aria-label={`Context: ${total} of ${budget} tokens. Open inspector.`}
      title="Context inspector"
    >
      <span className={over ? 'chip chip-danger' : pct > 80 ? 'chip chip-warn' : 'chip'}>
        {formatTokens(total)}
      </span>
    </button>
  );
});

/**
 * The composer, which owns the text being typed.
 *
 * Everything this needs is either its own state or a stable prop, so a
 * keystroke rerenders this component and nothing else. It deliberately does not
 * receive the chat, the timeline or the compiled context — taking any of them
 * would put the message list back in the keystroke path.
 */
const ComposerInput = memo(function ComposerInput({
  placeholder,
  sendOnEnter,
  generating,
  hasAttachments,
  onSend,
  onStop,
}: {
  placeholder: string;
  sendOnEnter: boolean;
  generating: boolean;
  hasAttachments: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  renderStats.composer += 1;
  const draft = useDraft();
  const textareaRef = useAutoResize(draft);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const shouldSend = sendOnEnter ? !event.shiftKey : event.ctrlKey || event.metaKey;
    if (shouldSend) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <>
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
        aria-label="Message"
      />
      {generating ? (
        <button
          type="button"
          className="composer-btn composer-btn-stop"
          onClick={onStop}
          aria-label="Stop generating"
        >
          <Icon name="stop" />
        </button>
      ) : (
        <button
          type="button"
          className="composer-btn composer-btn-send"
          onClick={onSend}
          disabled={!draft.trim() && !hasAttachments}
          aria-label="Send message"
        >
          <Icon name="send" />
        </button>
      )}
    </>
  );
});

export function ChatPage({
  chatId,
  navigate,
  jumpToMessageId,
}: {
  chatId: string | null;
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
  /** Set by "View source" on a memory: scroll to this message once loaded. */
  jumpToMessageId?: string | null;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const { timeline, activeChat, activeBranch } = useStore();
  const gen = useGeneration();

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  /** True once the opening scroll has landed and the view is the reader's. */
  const settledRef = useRef(false);
  /** Mirrors pendingJump for effects that must not re-run when it changes. */
  const pendingJumpRef = useRef<JumpTarget | null>(null);

  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // send() is a stable callback, so it reads the attachments through a ref
  // rather than closing over a value that changes identity every render.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [instructFor, setInstructFor] = useState<Message | null>(null);
  const [instruction, setInstruction] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [chatMenu, setChatMenu] = useState(false);
  const [responseSettings, setResponseSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [storyMapTab, setStoryMapTab] = useState<'branches' | 'timeline'>('branches');
  const [showStoryMap, setShowStoryMap] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [checkpointFor, setCheckpointFor] = useState<Message | null>(null);
  const [checkpointName, setCheckpointName] = useState('');
  const [branchFor, setBranchFor] = useState<Message | null>(null);
  const [branchName, setBranchName] = useState('');
  const [memoryDraft, setMemoryDraft] = useState<Memory | null>(null);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [speakerPicker, setSpeakerPicker] = useState(false);
  const [personaPicker, setPersonaPicker] = useState(false);
  const [storyPicker, setStoryPicker] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [attachSheet, setAttachSheet] = useState(false);
  const [imageGen, setImageGen] = useState(false);
  const [aiSummary, setAiSummary] = useState(false);
  const [storySummary, setStorySummary] = useState(false);
  const [newChatFrom, setNewChatFrom] = useState<Message | null>(null);

  const [quickSettings, setQuickSettings] = useState(false);
  const [pendingJump, setPendingJump] = useState<JumpTarget | null>(null);
  const [highlighted, setHighlighted] = useState<ID | null>(null);


  useEffect(() => {
    if (chatId && chatId !== state.activeChatId) void actions.openChat(chatId);
    if (!chatId && state.activeChatId) void actions.openChat(null);
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------------------- scrolling */

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(gen.generating ? 'auto' : 'smooth');
  }, [timeline.length, gen.streamingText, scrollToBottom, gen.generating]);

  useEffect(() => {
    // Jump to the end when a chat or branch is opened — unless a timeline jump
    // is steering the scroll, in which case it owns where we land.
    if (pendingJumpRef.current) return;
    settledRef.current = false;
    const timer = setTimeout(() => {
      scrollToBottom('auto');
      // Two frames: one for the scroll, one for the layout it causes.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        settledRef.current = true;
      }));
    }, 60);
    return () => clearTimeout(timer);
  }, [state.activeChatId, activeChat?.activeBranchId, scrollToBottom]);

  /*
   * The compiled context, built off the critical path.
   *
   * It is only ever *displayed* — the token chip and the inspector — while
   * generation compiles its own from the live store. Opening a chat should not
   * wait for a lore scan and a token estimate of the whole history, so this
   * happens once the thread is free, and never from the text being typed: the
   * draft's own tokens are added where the number is shown.
   */
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const previewRef = useRef(gen.previewContext);
  previewRef.current = gen.previewContext;

  useEffect(() => {
    if (state.chatLoading) return;
    // Nothing displays the number unless the chip is on or the inspector is
    // open, and compiling for a reader who is not there is pure cost.
    if (!state.settings.showTokenCounts) return;
    // While the inspector is open it owns the compiled value — it built one
    // that includes the unsent draft, and this pass would quietly replace it
    // with one that does not.
    if (showContext) return;
    return onIdle(() => setCompiled(previewRef.current({ pendingAttachments: pendingRef.current })));
  }, [state.chatLoading, state.settings.showTokenCounts, showContext, timeline, pending, gen.previewContext]);

  // Opening the inspector is an explicit request for the number, so it is worth
  // compiling right then if the idle pass has not run yet.
  const toggleSelected = useCallback((id: ID) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAlternative = useCallback(
    (messageId: ID, alternativeId: ID | null) =>
      void actions.setActiveAlternative(messageId, alternativeId),
    [actions],
  );

  /*
   * Opening the inspector is an explicit request to see what would be sent, so
   * it always recompiles and — unlike the background pass — includes the text
   * currently in the composer, since an unsent draft can trigger lore of its
   * own. Doing this here rather than on every keystroke is the whole point:
   * the scan happens once, when someone asks to see it.
   */
  const openContextInspector = useCallback(() => {
    setCompiled(
      previewRef.current({
        pendingUserText: getDraft(),
        pendingAttachments: pendingRef.current,
      }),
    );
    setShowContext(true);
  }, []);


  /*
   * Only a recent window of the conversation is mounted.
   *
   * A chat is read from the bottom, so the newest messages are the ones that
   * must be there instantly; older ones are mounted as they are scrolled
   * towards. This is what keeps opening a 5,000-message roleplay the same cost
   * as opening a short one. The timeline itself is untouched, so branches,
   * alternatives and checkpoints all still see the whole history.
   */
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const growthRef = useRef<number | null>(null);

  useEffect(() => {
    setWindowSize(WINDOW_STEP);
  }, [activeChat?.id, activeChat?.activeBranchId]);

  const visible = useMemo(
    () => (timeline.length > windowSize ? timeline.slice(timeline.length - windowSize) : timeline),
    [timeline, windowSize],
  );
  const hiddenCount = timeline.length - visible.length;

  const showEarlier = useCallback(() => {
    const node = scrollRef.current;
    // Remember the height so the view can be pinned to the same message once
    // the older ones are inserted above it.
    growthRef.current = node ? node.scrollHeight - node.scrollTop : null;
    setWindowSize((size) => size + WINDOW_STEP);
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || growthRef.current == null) return;
    node.scrollTop = node.scrollHeight - growthRef.current;
    growthRef.current = null;
  }, [visible.length]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    // Reaching towards the top mounts the previous chunk before it is needed,
    // so scrolling back through a long story stays continuous. Armed only once
    // the opening scroll has settled, or opening would immediately mount a
    // second chunk nobody asked for.
    if (!settledRef.current) return;
    if (node.scrollTop < 600 && hiddenCount > 0 && growthRef.current == null) showEarlier();
  };

  /* ------------------------------------------------- jumping to a message */

  /**
   * A timeline landmark may live in another chat or on another branch, so the
   * jump runs in stages: navigate, switch branch, then scroll. Each stage
   * re-runs this effect once the store catches up.
   */
  useEffect(() => {
    if (!pendingJump || !activeChat) return;
    if (activeChat.id !== pendingJump.chatId) return; // navigation still in flight
    if (activeChat.activeBranchId !== pendingJump.branchId) {
      void actions.switchBranch(pendingJump.branchId);
      return;
    }
    // The target may be older than the mounted window, in which case it must be
    // mounted before it can be scrolled to.
    const index = timeline.findIndex((m) => m.id === pendingJump.messageId);
    if (index >= 0 && timeline.length - index > windowSize) {
      setWindowSize(timeline.length - index + WINDOW_STEP);
      return;
    }

    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${pendingJump.messageId}"]`,
    );
    if (!target) {
      // The chat and branch are already correct, so a message that is not in
      // this timeline at all has been deleted since the sheet was opened. Give
      // up rather than leaving the jump armed forever — an armed jump keeps
      // suppressing the scroll-to-bottom on every chat you open afterwards.
      if (timeline.length && !timeline.some((m) => m.id === pendingJump.messageId)) {
        pendingJumpRef.current = null;
        setPendingJump(null);
      }
      return; // otherwise it simply has not rendered yet
    }

    atBottomRef.current = false;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlighted(pendingJump.messageId);
    pendingJumpRef.current = null;
    setPendingJump(null);
  }, [pendingJump, activeChat, timeline, actions, windowSize]);

  // Owned by its own effect: clearing pendingJump above re-runs that one, and a
  // fade-out timer living there would cancel itself in the cleanup.
  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), 2600);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  /**
   * The timeline spans the whole story when there is one; a chat with no story
   * is its own timeline. Declared here, above the `!activeChat` early return,
   * because hooks may not sit behind a conditional.
   */
  const storyChats = useMemo(() => {
    if (!activeChat) return [];
    return activeChat.storyId
      ? state.chats.filter((c) => c.storyId === activeChat.storyId)
      : [activeChat];
  }, [state.chats, activeChat]);

  /**
   * A jump requested from outside the chat (currently "View source" on a
   * memory). Waits for the chat's messages to load so the message's branch can
   * be resolved, then hands over to the same staged jump as the timeline.
   */
  const armedExternalJump = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToMessageId || !activeChat) return;
    if (armedExternalJump.current === jumpToMessageId) return;
    const message = state.messages.find((m) => m.id === jumpToMessageId);
    if (!message) return; // still loading this chat's working set
    armedExternalJump.current = jumpToMessageId;
    const target = {
      chatId: activeChat.id,
      branchId: message.branchId,
      messageId: message.id,
    };
    pendingJumpRef.current = target;
    setPendingJump(target);
  }, [jumpToMessageId, activeChat, state.messages]);

  const jumpToMessage = useCallback(
    (target: JumpTarget) => {
      setShowStoryMap(false);
      pendingJumpRef.current = target;
      setPendingJump(target);
      if (target.chatId !== state.activeChatId) navigate('chat', target.chatId);
    },
    [state.activeChatId, navigate],
  );

  /* ------------------------------------------------------- attachments */

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      try {
        const meta = await saveMedia(file, { ownerType: 'message', ownerId: state.activeChatId });
        added.push({
          id: uid(),
          kind: 'image',
          mediaId: meta.id,
          filename: meta.filename,
          mimeType: meta.mimeType,
          size: meta.size,
        });
      } catch (err) {
        actions.toast({
          kind: 'error',
          title: `Could not attach "${file.name}"`,
          detail: err instanceof MediaError ? err.message : (err as Error).message,
        });
      }
    }
    if (added.length) {
      setPending((current) => [...current, ...added]);
      await actions.refreshMedia();
      // Be explicit rather than letting the user believe the model saw it.
      if (gen.provider && !gen.capabilities.vision) {
        actions.toast({
          kind: 'warn',
          title: 'This model does not support image understanding.',
          detail: `${gen.provider.model || 'The selected model'} cannot read images. It will be told an image was attached, but not shown it. Pick a vision model, or enable vision for this provider in Settings if you know it supports images.`,
        });
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  /* ------------------------------------------------------------- send */

  const send = useCallback(async () => {
    const text = getDraft().trim();
    if (!text && !pendingRef.current.length) return;
    if (!activeChat) return;

    clearDraft();
    const attachments = pendingRef.current;
    setPending([]);
    atBottomRef.current = true;

    await actions.appendMessage({
      role: 'user',
      content: text,
      attachments,
      personaId: gen.persona?.id ?? null,
    });

    // Auto-title a fresh chat from its first user message.
    if (activeChat.title === 'New Chat' && text) {
      await actions.saveChat({ ...activeChat, title: truncate(text, 40) });
    }

    await gen.generate({});
  }, [activeChat, actions, gen]);

  /* --------------------------------------------------- message actions */

  const alternativesByMessage = useMemo(() => {
    const map = new Map<ID, MessageAlternative[]>();
    for (const alt of state.alternatives) {
      const list = map.get(alt.messageId);
      if (list) list.push(alt);
      else map.set(alt.messageId, [alt]);
    }
    return map;
  }, [state.alternatives]);

  const alternativesFor = useCallback(
    (messageId: ID) => alternativesByMessage.get(messageId) ?? NO_ALTERNATIVES,
    [alternativesByMessage],
  );

  const quickAction = useCallback(async (action: QuickAction, message: Message) => {
    switch (action) {
      case 'copy': {
        const ok = await copyText(gen.contentOf(message));
        actions.toast({
          kind: ok ? 'success' : 'error',
          title: ok ? 'Copied to clipboard' : 'Could not copy',
        });
        break;
      }
      case 'edit':
        setEditing(message);
        setEditText(gen.contentOf(message));
        break;
      case 'regenerate':
        await regenerate(message, false);
        break;
      case 'important':
        await actions.updateMessage({ ...message, important: !message.important });
        break;
      case 'delete':
        await removeMessage(message);
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, gen, confirm, state.settings]);

  const regenerate = async (message: Message, asAlternative: boolean, instructionText = '') => {
    atBottomRef.current = true;
    await gen.generate({
      replaceMessageId: message.id,
      asAlternative,
      instruction: instructionText || undefined,
      characterId: message.characterId,
    });
  };

  const removeMessage = async (message: Message) => {
    const ok = await confirm({
      title: 'Delete this message?',
      message: (
        <p style={{ margin: 0 }} className="small">
          “{truncate(gen.contentOf(message), 120)}”
        </p>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await actions.deleteMessage(message.id);
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (editing.activeAlternativeId) {
      // Editing an alternative rewrites that alternative, not the original.
      const alternative = state.alternatives.find((a) => a.id === editing.activeAlternativeId);
      if (alternative) {
        const repo = await import('../storage/repositories');
        await repo.alternatives.save({ ...alternative, content: editText });
        await actions.openChat(editing.chatId);
        setEditing(null);
        actions.toast({ kind: 'success', title: 'Alternative updated' });
        return;
      }
    }
    await actions.updateMessage({ ...editing, content: editText });
    setEditing(null);
    actions.toast({ kind: 'success', title: 'Message updated' });
  };

  /* ------------------------------------------------------------ memory */

  /**
   * Summarises the chosen messages into an editable memory draft. Nothing is
   * saved here — the user reviews and confirms in the memory editor.
   */
  const rememberMessages = async (ids: ID[]) => {
    const chosen = timeline.filter((m) => ids.includes(m.id));
    if (!chosen.length) return;
    setSummarising(true);
    try {
      const result = await generateMemoryDraft({
        messages: chosen.map((m) => ({ ...m, content: gen.contentOf(m) })),
        characters: gen.characters,
        persona: gen.persona,
        provider: gen.provider,
      });
      setMemoryNote(result.note ?? null);
      setMemoryDraft(
        newMemory({
          title: result.title,
          content: result.content,
          category: result.category,
          sourceMessageIds: chosen.map((m) => m.id),
          sourceChatId: activeChat?.id ?? null,
          sourceStoryId: activeChat?.storyId ?? null,
          characterIds: Array.from(
            new Set(chosen.map((m) => m.characterId).filter(Boolean) as string[]),
          ),
        }),
      );
    } finally {
      setSummarising(false);
    }
  };

  /*
   * Pure and small — the cast plus whatever the chat has declared. Not the
   * compiler, so keeping it current costs nothing, but it is memoised anyway
   * so the header does not churn while someone is typing.
   *
   * It has to sit above the early returns below: a hook after a conditional
   * return changes the hook count between renders, which React answers by
   * unmounting the whole tree.
   */
  const scene = useMemo(
    // The scene as it stands, so the header and the presence chips agree with
    // the prompt rather than with the base nobody has edited since the story
    // moved on.
    () => resolveScene({ scene: gen.scene, cast: gen.characters }),
    [gen.scene, gen.characters],
  );

  /* ------------------------------------------------------------ render */

  if (!chatId || !activeChat) {
    return <ChatPicker navigate={navigate} />;
  }

  if (state.chatLoading) {
    return (
      <div className="chat-screen">
        <Spinner label="Opening chat…" />
      </div>
    );
  }

  renderStats.screen += 1;

  const branchCount = state.branches.length;
  const chatCheckpoints = state.checkpoints.filter((c) => c.chatId === activeChat.id);

  // What tuning is already in force, so it is visible without opening the
  // sheet. This used to describe the chat menu's Response settings row; the
  // row moved to Quick Settings and the summary moved with it.
  const generation = effectiveGeneration(activeChat, gen.story, gen.provider);
  const directionLines = (activeChat.direction ?? '')
    .split('\n')
    .filter((l) => l.trim()).length;
  const responseSummary = directionLines
    ? `${directionLines} direction${directionLines === 1 ? '' : 's'} · temperature ${generation.temperature}`
    : `Temperature ${generation.temperature} · no direction set`;

  const sceneArtMediaId =
    gen.story?.backgroundMediaId ??
    gen.story?.coverMediaId ??
    scene.primary?.avatarMediaId ??
    null;

  const sceneDescriptor = [
    scene.location ||
      scene.situation ||
      (scene.present.length
        ? scene.present.map((c) => c.name).join(', ')
        : 'No characters attached'),
    // Which timeline you are on is not scene-setting, but forgetting it while
    // playing on a fork is worse than the extra word.
    branchCount > 1 ? (activeBranch?.name ?? 'branch') : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="chat-screen">
      <header className="chat-header">
        {/*
          Whatever artwork the story already has, in order of how deliberate it
          is: a background was chosen to be one, a cover was chosen to
          represent the story, an avatar is at least the right face.

          It lives inside the header rather than behind the whole screen. As a
          full-bleed backdrop it ran 380px down the page and the first two
          replies were rendered over hard-edged blocks of it — the fade was
          measured against the image's own height, not against where the prose
          starts. Bounding it to the header makes the overlap impossible rather
          than merely unlikely, and the scrim underneath means the title's
          contrast never depends on which image it is.
        */}
        {sceneArtMediaId && <ChatBackground mediaId={sceneArtMediaId} />}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => navigate('stories')}
          aria-label="Back to stories"
        >
          <Icon name="chevronLeft" />
        </button>
        <div className="chat-title">
          {/*
            The story leads, not the chat's auto-generated name: what someone
            is in the middle of is "The Long Storm", not "The Long Storm —
            chat". The line under it says where they are, falling back to who
            is here when the scene has not been placed.
          */}
          <strong>{gen.story?.title || chatDisplayTitle(activeChat, gen.story)}</strong>
          <span>{sceneDescriptor}</span>
        </div>
        {/*
          The token count is a number about the request, not about the story,
          and in the header it competed with the title for the same few
          hundred pixels. It moved to Quick Settings, beside the inspector it
          belongs to — still one tap away, and only when it is over budget does
          it come back out here where it cannot be missed.
        */}
        {state.settings.showTokenCounts && compiled?.overBudget && (
          <TokenChip
            baseTokens={compiled?.totalTokens ?? 0}
            budget={compiled?.budget ?? 0}
            overBudget
            onOpen={openContextInspector}
          />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => {
            setStoryMapTab('branches');
            setShowStoryMap(true);
          }}
          aria-label="Story map"
          title="Story map"
        >
          <Icon name="branch" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => setQuickSettings(true)}
          aria-label="Quick settings"
          title="Quick settings"
        >
          <Icon name="settings" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => setChatMenu(true)}
          aria-label="Chat menu"
        >
          <Icon name="more" />
        </button>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-messages">
          {hiddenCount > 0 && (
            <button type="button" className="btn btn-sm btn-block" onClick={showEarlier}>
              <Icon name="clock" />
              Show earlier messages ({hiddenCount})
            </button>
          )}
          {!timeline.length ? (
            <EmptyState
              icon="chat"
              title="No messages yet"
              message={
                gen.characters.length
                  ? 'Say something to begin. Characters with a greeting open the scene automatically in new chats.'
                  : 'This chat has no characters attached. Edit the story to add one.'
              }
            />
          ) : (
            visible.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                characters={gen.characters}
                persona={gen.persona}
                personas={state.personas}
                story={gen.story}
                alternatives={alternativesFor(message.id)}
                content={gen.contentOf(message)}
                streaming={gen.streamingFor === message.id}
                streamingText={gen.streamingFor === message.id ? gen.streamingText : ''}
                selecting={selecting}
                selected={selected.has(message.id)}
                highlighted={highlighted === message.id}
                onToggleSelect={toggleSelected}
                onOpenMenu={setMenuFor}
                onQuickAction={quickAction}
                onSetAlternative={setAlternative}
                onViewImage={setLightbox}
                showTimestamps={false}
              />
            ))
          )}
          {gen.generating && gen.streamingFor === 'new' && (
            <div className="msg">
              <div className="msg-body">
                <div className="bubble">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-composer">
        {selecting && (
          <div className="selection-bar">
            <strong>{selected.size} selected</strong>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!selected.size || summarising}
              onClick={() => rememberMessages([...selected])}
            >
              {summarising ? <span className="spinner" /> : <Icon name="brain" />}
              Remember
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!selected.size}
              onClick={async () => {
                const chosen = timeline.filter((m) => selected.has(m.id));
                const ok = await copyText(
                  chatToTranscript(chosen, (m) => speakerFor(m, gen.characters, gen.persona, gen.story, state.personas).name),
                );
                actions.toast({ kind: ok ? 'success' : 'error', title: ok ? 'Copied' : 'Copy failed' });
              }}
            >
              <Icon name="copy" />
              Copy
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={!selected.size}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${selected.size} message${selected.size === 1 ? '' : 's'}?`,
                  confirmLabel: 'Delete',
                  destructive: true,
                });
                if (!ok) return;
                for (const id of selected) await actions.deleteMessage(id);
                setSelected(new Set());
                setSelecting(false);
              }}
            >
              <Icon name="trash" />
              Delete
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setSelecting(false);
                setSelected(new Set());
              }}
            >
              Done
            </button>
          </div>
        )}

        {!!pending.length && (
          <div className="composer-attachments">
            {pending.map((attachment) => (
              <PendingAttachment
                key={attachment.id}
                attachment={attachment}
                onRemove={() => setPending((current) => current.filter((a) => a.id !== attachment.id))}
              />
            ))}
          </div>
        )}

        <div className="composer-row">
          <button
            type="button"
            className="composer-btn"
            onClick={() => setAttachSheet(true)}
            aria-label="Add image"
            disabled={uploading || gen.generating}
          >
            {uploading ? <span className="spinner" /> : <Icon name="plus" />}
          </button>
          {/*
            Three distinct inputs, because the attribute combination is what
            tells a phone which picker to open. `capture` opens the camera;
            omitting it opens the photo library; `accept="*"` opens Files.
          */}
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT_ATTR}
            multiple
            className="sr-only"
            tabIndex={-1}
            data-testid="attach-library"
            onChange={(e) => void addFiles(e.target.files)}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            data-testid="attach-camera"
            onChange={(e) => void addFiles(e.target.files)}
          />
          <input
            ref={filesInput}
            type="file"
            accept="image/*,.png,.jpg,.jpeg,.webp,.gif"
            multiple
            className="sr-only"
            tabIndex={-1}
            data-testid="attach-files"
            onChange={(e) => void addFiles(e.target.files)}
          />

          <ComposerInput
            placeholder={
              gen.provider
                ? state.settings.sendOnEnter
                  ? 'Message… (Enter to send, Shift+Enter for a new line)'
                  : 'Message…'
                : 'Set up an AI provider in Settings to generate replies'
            }
            sendOnEnter={state.settings.sendOnEnter}
            generating={gen.generating}
            hasAttachments={pending.length > 0}
            onSend={send}
            onStop={gen.stop}
          />
        </div>
      </div>

      {/* ------------------------------------------------------ overlays */}

      {compiled && (
        <ContextInspector
          compiled={compiled}
          open={showContext}
          onClose={() => setShowContext(false)}
        />
      )}

      <ImageGenPanel
        open={imageGen}
        onClose={() => setImageGen(false)}
        gen={gen}
        onOpenSettings={() => {
          setImageGen(false);
          navigate('settings');
        }}
      />

      <QuickSettings
        open={quickSettings}
        onClose={() => setQuickSettings(false)}
        chat={activeChat}
        storyPresetIds={gen.story?.narrationPresetIds ?? []}
        cast={gen.characters}
        scene={scene}
        sceneNow={gen.scene ?? activeChat.scene}
        sceneDerived={gen.sceneDerived}
        relationships={gen.relationships}
        relationshipsDerived={gen.relationshipsDerived}
        settings={state.settings}
        persona={gen.persona}
        personaName={gen.persona ? gen.persona.displayName || gen.persona.name : null}
        onPatchChat={(patch) => actions.saveChat({ ...activeChat, ...patch })}
        onCommitScene={gen.commitScene}
        onCommitCharacterState={gen.commitCharacterState}
        onUndoSceneChange={gen.reverseSceneDelta}
        onUndoRelationshipChange={gen.reverseRelationshipDelta}
        onPatchSettings={(patch) => actions.saveSettings(patch)}
        responseSummary={responseSummary}
        contextSummary={
          state.settings.showTokenCounts && compiled
            ? `${formatTokens(compiled.totalTokens)} / ${formatTokens(compiled.budget)} tokens`
            : null
        }
        onOpenInspector={openContextInspector}
        onOpenPersona={() => setPersonaPicker(true)}
        onOpenResponseSettings={() => setResponseSettings(true)}
        onOpenMemories={() => navigate('memories')}
        onOpenAdvanced={() => navigate('settings')}
      />

      <ResponseSettingsSheet
        open={responseSettings}
        onClose={() => setResponseSettings(false)}
        chat={activeChat}
        story={gen.story}
        provider={gen.provider}
        onSave={(patch) => actions.saveChat({ ...activeChat, ...patch })}
      />

      <AiSummarySheet open={aiSummary} onClose={() => setAiSummary(false)} gen={gen} />

      <StorySummarySheet open={storySummary} onClose={() => setStorySummary(false)} gen={gen} />

      {/*
        Mobile-first image entry. Separate inputs are what make a phone offer
        the camera vs the photo library vs Files — one picker cannot do all three.
      */}
      <ActionSheet
        open={attachSheet}
        onClose={() => setAttachSheet(false)}
        title="Add an image"
        actions={[
          {
            key: 'camera',
            label: 'Camera',
            description: 'Take a new photo.',
            icon: 'camera',
            onSelect: () => cameraInput.current?.click(),
          },
          {
            key: 'library',
            label: 'Photo Library',
            description: 'Choose existing pictures.',
            icon: 'image',
            onSelect: () => fileInput.current?.click(),
          },
          {
            key: 'files',
            label: 'Files',
            description: 'Browse your device storage.',
            icon: 'file',
            onSelect: () => filesInput.current?.click(),
          },
          {
            key: 'generate',
            label: 'Generate Image',
            description: gen.imageProvider
              ? `Create art with ${gen.imageProvider.name}.`
              : 'Set up an image provider first.',
            icon: 'sparkle',
            separatorBefore: true,
            onSelect: () => setImageGen(true),
          },
          {
            key: 'gallery',
            label: 'Media Library',
            description: 'Reuse an image you already have.',
            icon: 'grid',
            onSelect: () => navigate('media'),
          },
        ]}
      />

      {newChatFrom && (
        <NewChatFromSheet
          message={newChatFrom}
          onClose={() => setNewChatFrom(null)}
          timeline={timeline}
          onCreated={(id) => {
            setNewChatFrom(null);
            navigate('chat', id);
          }}
        />
      )}

      {/*
        One surface for both views. The ⋯ menu's Branches and Story timeline
        entries open it on the tab they name, so nothing that used to be
        reachable stopped being reachable.
      */}
      <StoryMap
        initialTab={storyMapTab}
        open={showStoryMap}
        onClose={() => setShowStoryMap(false)}
        chat={activeChat}
        branches={state.branches}
        messages={state.messages}
        story={gen.story}
        chats={storyChats}
        summary={gen.summary ?? null}
        activeChatId={state.activeChatId}
        onJump={jumpToMessage}
      />

      <CheckpointPanel
        open={showCheckpoints}
        onClose={() => setShowCheckpoints(false)}
        chat={activeChat}
        checkpoints={state.checkpoints}
        messages={state.messages}
        onOpenChat={(id) => navigate('chat', id)}
      />

      <ActionSheet
        open={chatMenu}
        onClose={() => setChatMenu(false)}
        title={chatDisplayTitle(activeChat, gen.story)}
        actions={[
          {
            /*
             * Response settings, the Context Inspector and the persona picker
             * all live in Quick Settings now, and Branches and Story timeline
             * are two names for one sheet. Leaving them here as well made the
             * menu answer questions it had already answered — this is the
             * long tail: export, rename, archive, delete, and the things you
             * do to a chat rather than to a scene.
             */
            key: 'story-map',
            label: 'Story map',
            description: `${branchCount} timeline${branchCount === 1 ? '' : 's'} · every landmark in this story`,
            icon: 'branch',
            onSelect: () => {
              setStoryMapTab('branches');
              setShowStoryMap(true);
            },
          },
          {
            key: 'checkpoints',
            label: 'Checkpoints',
            description: `${chatCheckpoints.length} saved`,
            icon: 'bookmark',
            onSelect: () => setShowCheckpoints(true),
          },
          {
            key: 'select',
            label: 'Select messages',
            description: 'Remember, copy or delete several at once.',
            icon: 'check',
            onSelect: () => setSelecting(true),
          },
          {
            key: 'speaker',
            label: 'Ask another character to reply',
            icon: 'users',
            disabled: gen.characters.length < 2,
            description:
              gen.characters.length < 2
                ? 'Add more characters to the story first.'
                : `${gen.characters.length} characters in this scene`,
            onSelect: () => setSpeakerPicker(true),
            separatorBefore: true,
          },
          {
            key: 'story-summary',
            label: 'The story so far',
            description: gen.summary?.rollingSummary
              ? 'What has happened, kept short enough to carry forward.'
              : 'Not written yet — a long story needs one to keep its past.',
            icon: 'brain',
            disabled: !activeChat.storyId,
            onSelect: () => setStorySummary(true),
          },
          {
            key: 'ai-summary',
            label: 'Hand this story to someone else',
            description: 'A briefing pack: who everyone is, what has happened, where it stands.',
            icon: 'file',
            onSelect: () => setAiSummary(true),
          },
          {
            key: 'generate-image',
            label: 'Generate image',
            description: gen.imageProvider
              ? `Using ${gen.imageProvider.name}`
              : 'No image provider configured yet.',
            icon: 'sparkle',
            onSelect: () => setImageGen(true),
          },
          {
            key: 'newchat',
            label: 'New chat in this story',
            icon: 'plus',
            disabled: !activeChat.storyId,
            onSelect: async () => {
              const chat = await actions.createChat({ storyId: activeChat.storyId });
              navigate('chat', chat.id);
            },
          },
          {
            key: 'rename',
            label: 'Rename chat',
            icon: 'edit',
            onSelect: () => {
              setRenameText(activeChat.title);
              setRenaming(true);
            },
          },
          {
            key: 'favorite',
            label: activeChat.favorite ? 'Remove from favourites' : 'Add to favourites',
            icon: 'star',
            onSelect: () => actions.saveChat({ ...activeChat, favorite: !activeChat.favorite }),
          },
          {
            key: 'archive',
            label: activeChat.archived ? 'Unarchive chat' : 'Archive chat',
            icon: 'archive',
            onSelect: () => actions.saveChat({ ...activeChat, archived: !activeChat.archived }),
          },
          {
            key: 'duplicate',
            label: 'Duplicate chat',
            icon: 'copy',
            onSelect: async () => {
              const copy = await actions.duplicateChat(activeChat.id);
              if (copy) {
                actions.toast({ kind: 'success', title: `Duplicated as "${copy.title}"` });
                navigate('chat', copy.id);
              }
            },
          },
          {
            key: 'export',
            label: 'Export chat',
            icon: 'download',
            onSelect: async () => {
              const json = await exportChat(activeChat.id, true);
              downloadFile(exportFilename('chat', activeChat.title), json);
              actions.toast({ kind: 'success', title: 'Chat exported' });
            },
          },
          {
            key: 'transcript',
            label: 'Export transcript (.txt)',
            icon: 'file',
            onSelect: () => {
              downloadFile(
                `transcript-${activeChat.title || 'chat'}.txt`,
                chatToTranscript(timeline, (m) => speakerFor(m, gen.characters, gen.persona, gen.story, state.personas).name),
                'text/plain',
              );
            },
          },
          {
            key: 'story',
            label: 'Edit story',
            icon: 'book',
            disabled: !activeChat.storyId,
            onSelect: () => navigate('story', activeChat.storyId),
          },
          {
            key: 'move-story',
            label: activeChat.storyId ? 'Move to another story…' : 'Move to story…',
            description: activeChat.storyId
              ? 'Swap which story supplies the cast and lorebooks.'
              : 'This chat has no story, so the model has no cast to describe.',
            icon: 'book',
            disabled: state.stories.filter((s) => !s.archived).length === 0,
            onSelect: () => setStoryPicker(true),
          },
          {
            key: 'delete',
            label: 'Delete chat',
            icon: 'trash',
            destructive: true,
            separatorBefore: true,
            onSelect: async () => {
              const ok = await confirm(deleteConfirm('chat', activeChat.title));
              if (!ok) return;
              await actions.deleteChat(activeChat.id);
              navigate('stories');
            },
          },
        ]}
      />

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor ? speakerFor(menuFor, gen.characters, gen.persona, gen.story, state.personas).name : ''}
        actions={
          menuFor
            ? [
                { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => quickAction('edit', menuFor) },
                { key: 'copy', label: 'Copy', icon: 'copy', onSelect: () => quickAction('copy', menuFor) },
                ...(menuFor.role === 'assistant'
                  ? [
                      {
                        key: 'regen',
                        label: 'Regenerate',
                        description: 'Replaces this response.',
                        icon: 'refresh',
                        onSelect: () => regenerate(menuFor, false),
                      },
                      {
                        key: 'regen-alt',
                        label: 'Generate an alternative',
                        description: 'Keeps this response and adds another you can switch between.',
                        icon: 'layers',
                        onSelect: () => regenerate(menuFor, true),
                      },
                      {
                        key: 'regen-instruct',
                        label: 'Regenerate with instruction',
                        icon: 'sparkle',
                        onSelect: () => {
                          setInstructFor(menuFor);
                          setInstruction('');
                        },
                      },
                      ...(alternativesFor(menuFor.id).length && menuFor.activeAlternativeId
                        ? [
                            {
                              key: 'keep',
                              label: 'Keep this response',
                              description: 'Makes the shown alternative the main text.',
                              icon: 'check',
                              onSelect: () =>
                                actions.promoteAlternative(menuFor.id, menuFor.activeAlternativeId!),
                            },
                            {
                              key: 'del-alt',
                              label: 'Delete this alternative',
                              icon: 'trash',
                              onSelect: () => actions.deleteAlternative(menuFor.activeAlternativeId!),
                            },
                          ]
                        : []),
                    ]
                  : []),
                {
                  key: 'remember',
                  label: 'Remember',
                  description: 'Turn this message into a long-term memory.',
                  icon: 'brain',
                  separatorBefore: true,
                  onSelect: () => {
                    setSelected(new Set([menuFor.id]));
                    setSelecting(true);
                    void rememberMessages([menuFor.id]);
                  },
                },
                {
                  key: 'important',
                  label: menuFor.important ? 'Unmark important' : 'Mark important',
                  icon: 'flag',
                  onSelect: () => quickAction('important', menuFor),
                },
                {
                  key: 'branch',
                  label: 'Branch from here',
                  description: 'Fork a new timeline; the original stays untouched.',
                  icon: 'branch',
                  onSelect: () => {
                    setBranchFor(menuFor);
                    setBranchName('');
                  },
                },
                {
                  key: 'newchat-here',
                  label: 'Start new chat from here',
                  description: 'Copies the story setup and history up to this point.',
                  icon: 'chat',
                  onSelect: () => setNewChatFrom(menuFor),
                },
                {
                  key: 'checkpoint',
                  label: 'Save checkpoint here',
                  icon: 'bookmark',
                  onSelect: () => {
                    setCheckpointFor(menuFor);
                    setCheckpointName(truncate(gen.contentOf(menuFor), 32));
                  },
                },
                {
                  key: 'select',
                  label: 'Select messages',
                  icon: 'check',
                  onSelect: () => {
                    setSelecting(true);
                    setSelected(new Set([menuFor.id]));
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete message',
                  icon: 'trash',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => removeMessage(menuFor),
                },
              ]
            : []
        }
      />

      {/*
        Changing the persona rewrites the chat's personaId only. Messages keep
        the personaId stamped when they were sent, so switching mid-story does
        not retroactively re-attribute anything you already wrote.
      */}
      <ActionSheet
        open={personaPicker}
        onClose={() => setPersonaPicker(false)}
        title="Write as…"
        actions={state.personas.map((persona) => ({
          key: persona.id,
          label: persona.name || 'Unnamed',
          description:
            gen.persona?.id === persona.id
              ? 'Currently writing as this persona.'
              : truncate(persona.personality || persona.appearance, 70),
          icon: 'user',
          disabled: gen.persona?.id === persona.id,
          onSelect: () => {
            void (async () => {
              await actions.saveChat({ ...activeChat, personaId: persona.id });
              actions.toast({
                kind: 'success',
                title: `Now writing as ${persona.name}`,
                detail: 'Messages you already sent keep their original persona.',
              });
            })();
          },
        }))}
      />

      {/*
        Imported chats arrive with no story, so the compiler has no cast to
        describe and the model writes blind. `storyId` used to be settable only
        at creation, which left those chats permanently orphaned — this is the
        way back. Only the chat row changes: messages, branches and their
        stamped characterIds are untouched, so the move is reversible.
      */}
      <ActionSheet
        open={storyPicker}
        onClose={() => setStoryPicker(false)}
        title="Move to story…"
        actions={state.stories
          .filter((s) => !s.archived)
          .map((story) => ({
            key: story.id,
            label: story.title || 'Untitled story',
            description:
              activeChat.storyId === story.id
                ? 'This chat already belongs to this story.'
                : `${story.characters.filter((c) => c.enabled).length} character(s) in the cast.`,
            icon: 'book' as const,
            disabled: activeChat.storyId === story.id,
            onSelect: () => {
              void (async () => {
                await actions.saveChat({
                  ...activeChat,
                  storyId: story.id,
                  // A chat with no persona of its own adopts the story's, so
                  // the persona-protection rule has a name to protect.
                  personaId: activeChat.personaId ?? story.personaId ?? null,
                });
                actions.toast({
                  kind: 'success',
                  title: `Moved to "${story.title || 'Untitled story'}"`,
                  detail: 'The story\'s cast, lorebooks and memories now apply to this chat.',
                });
              })();
            },
          }))}
      />

      <ActionSheet
        open={speakerPicker}
        onClose={() => setSpeakerPicker(false)}
        title="Who replies next?"
        actions={gen.characters.map((character) => ({
          key: character.id,
          label: character.name || 'Unnamed',
          description: truncate(character.shortDescription || character.personality, 70),
          icon: 'user',
          onSelect: () => {
            atBottomRef.current = true;
            void gen.generate({ characterId: character.id });
          },
        }))}
      />

      {editing && (
        <Sheet
          open
          onClose={() => setEditing(null)}
          title="Edit message"
          large
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={saveEdit}>
                <Icon name="save" />
                Save
              </button>
            </>
          }
        >
          {editing.activeAlternativeId && (
            <Banner kind="info" title="Editing an alternative">
              You are viewing an alternative response, so your edit updates that alternative.
            </Banner>
          )}
          <textarea
            className="textarea textarea-lg"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            aria-label="Message text"
            data-autofocus
          />
        </Sheet>
      )}

      {instructFor && (
        <Sheet
          open
          onClose={() => setInstructFor(null)}
          title="Regenerate with instruction"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setInstructFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!instruction.trim()}
                onClick={() => {
                  const target = instructFor;
                  const text = instruction;
                  setInstructFor(null);
                  void regenerate(target, true, text);
                }}
              >
                <Icon name="sparkle" />
                Generate
              </button>
            </>
          }
        >
          <p className="small muted">
            The instruction applies to this generation only, and the result is stored as an
            alternative so the current response is kept.
          </p>
          <textarea
            className="textarea"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Make it shorter and darker. End on a question."
            aria-label="Instruction"
            data-autofocus
          />
        </Sheet>
      )}

      {branchFor && (
        <Sheet
          open
          onClose={() => setBranchFor(null)}
          title="Create a branch"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBranchFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  const branch = await actions.createBranch(branchFor.id, branchName);
                  setBranchFor(null);
                  if (branch) {
                    actions.toast({
                      kind: 'success',
                      title: `Switched to "${branch.name}"`,
                      detail: 'The original timeline is unchanged — switch back any time.',
                    });
                  }
                }}
              >
                <Icon name="branch" />
                Create branch
              </button>
            </>
          }
        >
          <p className="small muted">
            History up to and including this message is inherited. Anything you write afterwards
            belongs to the new branch only.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="branch-new-name">
              Branch name
            </label>
            <input
              id="branch-new-name"
              className="input"
              value={branchName}
              placeholder="What if she refuses?"
              onChange={(e) => setBranchName(e.target.value)}
              data-autofocus
            />
          </div>
        </Sheet>
      )}

      {checkpointFor && (
        <Sheet
          open
          onClose={() => setCheckpointFor(null)}
          title="Save checkpoint"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCheckpointFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await actions.createCheckpoint(checkpointFor.id, checkpointName);
                  setCheckpointFor(null);
                  actions.toast({ kind: 'success', title: 'Checkpoint saved' });
                }}
              >
                <Icon name="bookmark" />
                Save checkpoint
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="cp-new-name">
              Checkpoint name
            </label>
            <input
              id="cp-new-name"
              className="input"
              value={checkpointName}
              onChange={(e) => setCheckpointName(e.target.value)}
              data-autofocus
            />
          </div>
        </Sheet>
      )}

      {memoryDraft && (
        <MemoryEditor
          memory={memoryDraft}
          onClose={() => {
            setMemoryDraft(null);
            setMemoryNote(null);
          }}
          extraHeader={
            memoryNote ? (
              <Banner kind="info" title="Draft summary">
                {memoryNote}
              </Banner>
            ) : (
              <Banner kind="success" title="AI summary">
                Review and edit before saving — nothing is stored until you press Save.
              </Banner>
            )
          }
          onSave={async (memory) => {
            await actions.saveMemory(memory);
            setMemoryDraft(null);
            setMemoryNote(null);
            setSelecting(false);
            setSelected(new Set());
            actions.toast({ kind: 'success', title: 'Memory saved' });
          }}
        />
      )}

      {renaming && (
        <Sheet
          open
          onClose={() => setRenaming(false)}
          title="Rename chat"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRenaming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await actions.saveChat({ ...activeChat, title: renameText.trim() || activeChat.title });
                  setRenaming(false);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="chat-name">
              Chat name
            </label>
            <input
              id="chat-name"
              className="input"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              data-autofocus
            />
          </div>
        </Sheet>
      )}

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightbox(null)}
        >
          <MediaImage mediaId={lightbox} alt="Attachment" />
          <button type="button" aria-label="Close preview" onClick={() => setLightbox(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Start a new chat seeded from an existing conversation.
 *
 * The source chat is never modified — history is copied, so branching and the
 * original timeline both stay intact.
 */
function NewChatFromSheet({
  message,
  timeline,
  onClose,
  onCreated,
}: {
  message: Message;
  timeline: Message[];
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const { activeChat } = useStore();
  const [mode, setMode] = useState<'beginning' | 'here' | 'checkpoint'>('here');
  const [checkpointId, setCheckpointId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const chatCheckpoints = state.checkpoints.filter((c) => c.chatId === activeChat?.id);
  const indexHere = timeline.findIndex((m) => m.id === message.id);
  const countHere = indexHere >= 0 ? indexHere + 1 : timeline.length;

  const create = async () => {
    if (!activeChat) return;
    setBusy(true);
    try {
      if (mode === 'checkpoint') {
        const chat = await actions.chatFromCheckpoint(checkpointId);
        if (chat) onCreated(chat.id);
        return;
      }
      const upTo = mode === 'beginning' ? 0 : countHere;
      const chat = await actions.chatFromMessages(activeChat.id, upTo, message.id);
      if (chat) onCreated(chat.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Start new chat from here"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={create}
            disabled={busy || (mode === 'checkpoint' && !checkpointId)}
          >
            {busy ? <span className="spinner" /> : <Icon name="chat" />}
            Create chat
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        The new chat keeps this story's characters, persona, lorebooks, memories and summary. The
        original conversation is left exactly as it is.
      </p>

      <div className="stack">
        {(
          [
            {
              id: 'beginning' as const,
              label: 'Start from the beginning',
              detail: 'A fresh chat with the same setup and no messages.',
            },
            {
              id: 'here' as const,
              label: 'Start from this message',
              detail: `Copies the first ${countHere} message(s), ending here.`,
            },
            {
              id: 'checkpoint' as const,
              label: 'Start from a checkpoint',
              detail: chatCheckpoints.length
                ? `${chatCheckpoints.length} checkpoint(s) available.`
                : 'No checkpoints saved in this chat yet.',
              disabled: !chatCheckpoints.length,
            },
          ]
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            className="card card-button"
            aria-pressed={mode === option.id}
            disabled={'disabled' in option && option.disabled}
            style={
              mode === option.id
                ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                : undefined
            }
            onClick={() => setMode(option.id)}
          >
            <Icon name={mode === option.id ? 'check' : 'chevronRight'} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600 }}>{option.label}</span>
              <span className="small muted">{option.detail}</span>
            </span>
          </button>
        ))}
      </div>

      {mode === 'checkpoint' && !!chatCheckpoints.length && (
        <div className="field" style={{ marginTop: 14 }}>
          <label className="field-label" htmlFor="cp-pick">
            Checkpoint
          </label>
          <select
            id="cp-pick"
            className="select"
            value={checkpointId}
            onChange={(e) => setCheckpointId(e.target.value)}
          >
            <option value="">Choose a checkpoint…</option>
            {chatCheckpoints.map((cp) => (
              <option key={cp.id} value={cp.id}>
                {cp.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Sheet>
  );
}

function ChatBackground({ mediaId }: { mediaId: string }) {
  const { url } = useMediaUrl(mediaId);
  if (!url) return null;
  return <div className="chat-bg" style={{ backgroundImage: `url(${url})` }} aria-hidden="true" />;
}

function PendingAttachment({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const { url } = useMediaUrl(attachment.mediaId);
  return (
    <div className="attachment-preview">
      {url ? <img src={url} alt={attachment.filename} /> : <span className="spinner" />}
      <button type="button" onClick={onRemove} aria-label={`Remove ${attachment.filename}`}>
        <Icon name="x" width={14} height={14} />
      </button>
    </div>
  );
}

/** Chat list shown when no chat is selected. */
function ChatPicker({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<Chat | null>(null);

  const chats = useMemo(
    () =>
      state.chats
        .filter((c) => (showArchived ? true : !c.archived))
        .sort((a, b) => {
          if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        }),
    [state.chats, showArchived],
  );

  return (
    <>
      <div className="page-header">
        <h1>
          Chats
          <span className="subtitle">{state.chats.length} conversations</span>
        </h1>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={async () => {
            const story = state.stories.filter((s) => !s.archived)[0];
            if (!story) {
              actions.toast({
                kind: 'warn',
                title: 'Create a story first',
                detail: 'Chats belong to a story, which holds the characters and lorebooks.',
              });
              navigate('stories');
              return;
            }
            const chat = await actions.createChat({ storyId: story.id });
            navigate('chat', chat.id);
          }}
        >
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        {state.chats.some((c) => c.archived) && (
          <label className="switch-row" style={{ marginBottom: 8 }}>
            <span className="switch-label">Show archived</span>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
          </label>
        )}

        {!chats.length ? (
          <EmptyState
            icon="chat"
            title="No chats yet"
            message="Chats live inside stories. Create a story with at least one character, then start chatting."
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('stories')}>
                <Icon name="book" />
                Go to stories
              </button>
            }
          />
        ) : (
          <div className="list">
            {chats.map((chat) => {
              const story = state.stories.find((s) => s.id === chat.storyId) ?? null;
              return (
                <div className="card card-button" key={chat.id}>
                  <button
                    type="button"
                    onClick={() => navigate('chat', chat.id)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: 'none',
                      border: 0,
                      color: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      <strong className="truncate">{chat.title}</strong>
                      {chat.favorite && (
                        <Icon name="star" width={13} height={13} style={{ color: 'var(--warn)' }} />
                      )}
                      {chat.archived && <span className="chip">Archived</span>}
                    </div>
                    <div className="small muted">{story?.title ?? 'No story'}</div>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Actions for ${chat.title}`}
                    onClick={() => setMenuFor(chat)}
                  >
                    <Icon name="more" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? ''}
        actions={
          menuFor
            ? [
                { key: 'open', label: 'Open', icon: 'chat', onSelect: () => navigate('chat', menuFor.id) },
                {
                  key: 'favorite',
                  label: menuFor.favorite ? 'Remove from favourites' : 'Add to favourites',
                  icon: 'star',
                  onSelect: () => actions.saveChat({ ...menuFor, favorite: !menuFor.favorite }),
                },
                {
                  key: 'archive',
                  label: menuFor.archived ? 'Unarchive' : 'Archive',
                  icon: 'archive',
                  onSelect: () => actions.saveChat({ ...menuFor, archived: !menuFor.archived }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicateChat(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export',
                  icon: 'download',
                  onSelect: async () => {
                    downloadFile(
                      exportFilename('chat', menuFor.title),
                      await exportChat(menuFor.id, true),
                    );
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: 'trash',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: async () => {
                    const ok = await confirm(deleteConfirm('chat', menuFor.title));
                    if (ok) await actions.deleteChat(menuFor.id);
                  },
                },
              ]
            : []
        }
      />
    </>
  );
}
