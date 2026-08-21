import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Chat, ID, Memory, Message } from '../types';
import { newMemory } from '../types/factories';
import {
  useActions,
  useAppState,
  useStore,
} from '../state/store';
import { useGeneration, chatDisplayTitle, speakerFor } from '../hooks/useGeneration';
import { MessageItem, type QuickAction } from '../components/chat/MessageItem';
import { ContextInspector } from '../components/chat/ContextInspector';
import { BranchPanel, CheckpointPanel } from '../components/chat/BranchPanel';
import { MemoryEditor } from './Memories';
import { Icon } from '../components/ui/Icon';
import { ActionSheet, Sheet } from '../components/ui/Sheet';
import { Banner, EmptyState, Spinner, copyText, useAutoResize } from '../components/ui/common';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { MediaImage, useMediaUrl } from '../components/media/MediaImage';
import { IMAGE_ACCEPT_ATTR, MediaError, saveMedia } from '../media/mediaStore';
import { generateMemoryDraft } from '../memory/summarizer';
import { formatTokens } from '../context/tokens';
import { downloadFile, exportChat, exportFilename, chatToTranscript } from '../exporters';
import { uid } from '../utils/uid';
import { truncate } from '../utils/text';
import type { RouteName } from '../state/router';

export function ChatPage({
  chatId,
  navigate,
}: {
  chatId: string | null;
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const { timeline, activeChat, activeBranch } = useStore();
  const gen = useGeneration();

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [instructFor, setInstructFor] = useState<Message | null>(null);
  const [instruction, setInstruction] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [chatMenu, setChatMenu] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
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
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');

  const textareaRef = useAutoResize(draft);

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
    // Jump to the end when a chat or branch is opened.
    const timer = setTimeout(() => scrollToBottom('auto'), 60);
    return () => clearTimeout(timer);
  }, [state.activeChatId, activeChat?.activeBranchId, scrollToBottom]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  };

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
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  /* ------------------------------------------------------------- send */

  const send = async () => {
    const text = draft.trim();
    if (!text && !pending.length) return;
    if (!activeChat) return;

    setDraft('');
    const attachments = pending;
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
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const shouldSend = state.settings.sendOnEnter ? !event.shiftKey : event.ctrlKey || event.metaKey;
    if (shouldSend) {
      event.preventDefault();
      void send();
    }
  };

  /* --------------------------------------------------- message actions */

  const alternativesFor = useCallback(
    (messageId: ID) => state.alternatives.filter((a) => a.messageId === messageId),
    [state.alternatives],
  );

  const quickAction = async (action: QuickAction, message: Message) => {
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
  };

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

  const rememberSelected = async () => {
    const chosen = timeline.filter((m) => selected.has(m.id));
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

  const compiled = gen.previewContext({
    pendingUserText: draft,
    pendingAttachments: pending,
  });
  const usedPct = Math.min(100, Math.round((compiled.totalTokens / Math.max(1, compiled.budget)) * 100));

  const branchCount = state.branches.length;
  const chatCheckpoints = state.checkpoints.filter((c) => c.chatId === activeChat.id);

  return (
    <div className="chat-screen">
      {gen.story?.backgroundMediaId && <ChatBackground mediaId={gen.story.backgroundMediaId} />}

      <header className="chat-header">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => navigate('stories')}
          aria-label="Back to stories"
        >
          <Icon name="chevronLeft" />
        </button>
        <div className="chat-title">
          <strong>{chatDisplayTitle(activeChat, gen.story)}</strong>
          <span>
            {gen.characters.length
              ? gen.characters.map((c) => c.name).join(', ')
              : 'No characters attached'}
            {branchCount > 1 && ` · ${activeBranch?.name ?? 'branch'}`}
          </span>
        </div>
        {state.settings.showTokenCounts && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowContext(true)}
            aria-label={`Context: ${compiled.totalTokens} of ${compiled.budget} tokens. Open inspector.`}
            title="Context inspector"
          >
            <span className={compiled.overBudget ? 'chip chip-danger' : usedPct > 80 ? 'chip chip-warn' : 'chip'}>
              {formatTokens(compiled.totalTokens)}
            </span>
          </button>
        )}
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
            timeline.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                characters={gen.characters}
                persona={gen.persona}
                story={gen.story}
                alternatives={alternativesFor(message.id)}
                content={gen.contentOf(message)}
                streaming={gen.streamingFor === message.id}
                streamingText={gen.streamingText}
                selecting={selecting}
                selected={selected.has(message.id)}
                onToggleSelect={(id) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onOpenMenu={setMenuFor}
                onQuickAction={quickAction}
                onSetAlternative={(messageId, alternativeId) =>
                  actions.setActiveAlternative(messageId, alternativeId)
                }
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
              onClick={rememberSelected}
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
                  chatToTranscript(chosen, (m) => speakerFor(m, gen.characters, gen.persona, gen.story).name),
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
            onClick={() => fileInput.current?.click()}
            aria-label="Attach images"
            disabled={uploading || gen.generating}
          >
            {uploading ? <span className="spinner" /> : <Icon name="image" />}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT_ATTR}
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => void addFiles(e.target.files)}
          />

          <textarea
            ref={textareaRef}
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={
              gen.provider
                ? state.settings.sendOnEnter
                  ? 'Message… (Enter to send, Shift+Enter for a new line)'
                  : 'Message…'
                : 'Set up an AI provider in Settings to generate replies'
            }
            rows={1}
            aria-label="Message"
          />

          {gen.generating ? (
            <button
              type="button"
              className="composer-btn composer-btn-stop"
              onClick={gen.stop}
              aria-label="Stop generating"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-btn composer-btn-send"
              onClick={send}
              disabled={!draft.trim() && !pending.length}
              aria-label="Send message"
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ overlays */}

      <ContextInspector compiled={compiled} open={showContext} onClose={() => setShowContext(false)} />

      <BranchPanel
        open={showBranches}
        onClose={() => setShowBranches(false)}
        chat={activeChat}
        branches={state.branches}
        messages={state.messages}
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
            key: 'context',
            label: 'Context Inspector',
            description: `${formatTokens(compiled.totalTokens)} / ${formatTokens(compiled.budget)} tokens`,
            icon: 'layers',
            onSelect: () => setShowContext(true),
          },
          {
            key: 'branches',
            label: 'Branches',
            description: `${branchCount} timeline${branchCount === 1 ? '' : 's'}`,
            icon: 'branch',
            onSelect: () => setShowBranches(true),
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
                chatToTranscript(timeline, (m) => speakerFor(m, gen.characters, gen.persona, gen.story).name),
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
        title={menuFor ? speakerFor(menuFor, gen.characters, gen.persona, gen.story).name : ''}
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
                    setTimeout(() => void rememberSelectedFor([menuFor.id]), 0);
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

  async function rememberSelectedFor(ids: ID[]) {
    setSelected(new Set(ids));
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
          sourceMessageIds: ids,
          sourceChatId: activeChat?.id ?? null,
          sourceStoryId: activeChat?.storyId ?? null,
        }),
      );
    } finally {
      setSummarising(false);
    }
  }
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
