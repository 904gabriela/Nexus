import { useEffect, useMemo, useState } from 'react';
import type { Memory, MemoryCategory, MemoryImportance, Message } from '../types';
import { MEMORY_CATEGORIES, MEMORY_IMPORTANCE } from '../types';
import { newMemory } from '../types/factories';
import { useActions, useAppState } from '../state/store';
import { Icon } from '../components/ui/Icon';
import { Banner, EmptyState, SearchInput, Spinner, Tabs, copyText } from '../components/ui/common';
import { SelectField, TagField, TextArea, TextField, Toggle } from '../components/ui/Field';
import { ActionSheet, Sheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { downloadFile, exportFilename, exportMemories, exportMemory } from '../exporters';
import { relativeTime, truncate } from '../utils/text';
import {
  acceptMemory,
  memoryBasis,
  memoryStatus,
  memorySupersedes,
} from '../memory/matrix';
import type { RouteName } from '../state/router';

const IMPORTANCE_CHIP: Record<MemoryImportance, string> = {
  critical: 'chip-danger',
  high: 'chip-warn',
  normal: 'chip',
  low: 'chip',
};

export function MemoriesPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null, query?: Record<string, string>) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();

  /**
   * Opens the conversation a memory was distilled from and scrolls to the
   * message. The source may live in a chat that is not currently loaded, so the
   * message is looked up in the database rather than in state.
   */
  const openSource = async (memory: Memory) => {
    const [first] = memory.sourceMessageIds;
    if (!first) return;
    const repo = await import('../storage/repositories');
    const message = await repo.messages.get(first);
    if (!message) {
      actions.toast({
        kind: 'warn',
        title: 'That message no longer exists',
        detail: 'It was deleted after this memory was created. The memory itself is unaffected.',
      });
      return;
    }
    navigate('chat', message.chatId, { message: message.id });
  };

  const [view, setView] = useState<'memories' | 'important'>('memories');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | MemoryCategory>('all');
  const [sort, setSort] = useState<'updated' | 'importance' | 'title'>('updated');
  const [editing, setEditing] = useState<Memory | null>(null);
  const [menuFor, setMenuFor] = useState<Memory | null>(null);
  // Replaced memories are kept as a record but are noise in the list, so they
  // are somewhere to go and look rather than always in the way.
  const [shelf, setShelf] = useState<'current' | 'review' | 'replaced'>('current');

  const needsReview = useMemo(
    () => state.memories.filter((m) => memoryStatus(m) === 'proposed'),
    [state.memories],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rank: Record<MemoryImportance, number> = { critical: 4, high: 3, normal: 2, low: 1 };
    return state.memories
      .filter((memory) => {
        const status = memoryStatus(memory);
        if (shelf === 'review' && status !== 'proposed') return false;
        if (shelf === 'replaced' && status !== 'superseded') return false;
        if (shelf === 'current' && status === 'superseded') return false;
        if (category !== 'all' && memory.category !== category) return false;
        if (!needle) return true;
        return [memory.title, memory.content, memory.tags.join(' '), memory.category]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (sort === 'importance') return rank[b.importance] - rank[a.importance] || b.updatedAt - a.updatedAt;
        if (sort === 'title') return a.title.localeCompare(b.title);
        return b.updatedAt - a.updatedAt;
      });
  }, [state.memories, query, category, sort, shelf]);

  /**
   * How many chat/branch contexts have recorded knowledge about each memory.
   *
   * Counted in contexts rather than in people on purpose. This page is the
   * global library and has no timeline, so "2 characters" would read as one
   * settled fact about the story when the two could be on branches that
   * contradict each other. A context count claims only what it can back up;
   * who knows what, where, is the Context Inspector's job.
   */
  const knowledgeContexts = useMemo(() => {
    const byMemory = new Map<string, Set<string>>();
    for (const edge of state.knowledgeEdges) {
      if (edge.subject.kind !== 'memory') continue;
      const seen = byMemory.get(edge.subject.id) ?? new Set<string>();
      seen.add(`${edge.chatId}/${edge.branchId}`);
      byMemory.set(edge.subject.id, seen);
    }
    return byMemory;
  }, [state.knowledgeEdges]);

  /**
   * Accepting is the only thing that makes a supersession real, so it goes
   * through acceptMemory rather than flipping the status here: rejecting a
   * proposal must leave the memories it would have replaced untouched.
   */
  const accept = async (memory: Memory) => {
    const writes = acceptMemory(memory, state.memories);
    for (const write of writes) await actions.saveMemory(write);
    const replaced = writes.length - 1;
    actions.toast({
      kind: 'success',
      title: 'Memory accepted',
      detail: replaced
        ? `It is now in use. ${replaced} earlier memor${replaced === 1 ? 'y was' : 'ies were'} marked replaced.`
        : 'It is now in use.',
    });
  };

  const remove = async (memory: Memory) => {
    const ok = await confirm(deleteConfirm('memory', memory.title));
    if (!ok) return;
    await actions.deleteMemory(memory.id);
    actions.toast({ kind: 'success', title: 'Memory deleted' });
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Memories
          <span className="subtitle">
            {state.memories.length} saved · {state.memories.filter((m) => m.pinned).length} pinned
          </span>
        </h1>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setEditing(newMemory())}
        >
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        {/*
          Important messages and memories are different things: a memory is a
          condensed fact, an important message is the original text preserved
          verbatim. Keeping them in one place but on separate tabs makes that
          distinction visible.
        */}
        <Tabs
          tabs={[
            { id: 'memories', label: 'Memories', badge: state.memories.length },
            { id: 'important', label: 'Important messages' },
          ]}
          active={view}
          onChange={setView}
          label="Memory views"
        />

        {view === 'important' ? (
          <ImportantMessages />
        ) : (
        <>
        <SearchInput value={query} onChange={setQuery} placeholder="Search memories…" />

        {/*
          A memory the extractor was not sure about is saved but not used: it
          reaches nothing until someone accepts it. That distinction is only
          honest if there is somewhere to go and accept it.
        */}
        <div className="chip-row" style={{ marginBottom: 10 }}>
          {(
            [
              ['current', 'In use'],
              ['review', `Needs review${needsReview.length ? ` (${needsReview.length})` : ''}`],
              ['replaced', 'Replaced'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chip ${shelf === id ? 'chip-accent' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setShelf(id)}
              aria-pressed={shelf === id}
            >
              {label}
            </button>
          ))}
        </div>

        {shelf === 'review' && (
          <p className="small muted" style={{ marginBottom: 10 }}>
            These were extracted automatically but were either concluded rather than shown, or not
            confident enough to use unattended. None of them is being sent to the AI. Accept the
            ones that are right and delete the rest.
          </p>
        )}
        {shelf === 'replaced' && (
          <p className="small muted" style={{ marginBottom: 10 }}>
            Superseded by a later memory. They are kept because they are the record of what the
            story believed at the time, and they are not sent to the AI.
          </p>
        )}

        <div className="chip-row" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className={`chip ${category === 'all' ? 'chip-accent' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setCategory('all')}
            aria-pressed={category === 'all'}
          >
            All ({state.memories.length})
          </button>
          {MEMORY_CATEGORIES.map((option) => {
            const count = state.memories.filter((m) => m.category === option).length;
            if (!count) return null;
            return (
              <button
                key={option}
                type="button"
                className={`chip ${category === option ? 'chip-accent' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setCategory(option)}
                aria-pressed={category === option}
              >
                {option} ({count})
              </button>
            );
          })}
        </div>

        <div className="row row-between" style={{ marginBottom: 12 }}>
          <div className="chip-row">
            {(['updated', 'importance', 'title'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`chip ${sort === option ? 'chip-accent' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSort(option)}
                aria-pressed={sort === option}
              >
                {option === 'updated' ? 'Recent' : option === 'importance' ? 'Importance' : 'A–Z'}
              </button>
            ))}
          </div>
          {!!state.memories.length && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                downloadFile('memories.json', exportMemories(filtered));
                actions.toast({ kind: 'success', title: `Exported ${filtered.length} memories` });
              }}
            >
              <Icon name="download" />
              Export
            </button>
          )}
        </div>

        {!filtered.length ? (
          <EmptyState
            icon="brain"
            title={state.memories.length ? 'No memories match' : 'No memories yet'}
            message="Memories are durable facts injected into every chat's context. Create one here, or select messages in a chat and choose Remember."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setEditing(newMemory())}
              >
                <Icon name="plus" />
                Create memory
              </button>
            }
          />
        ) : (
          <div className="list">
            {filtered.map((memory) => (
              <div className="card card-button" key={memory.id}>
                <button
                  type="button"
                  onClick={() => setEditing(memory)}
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
                    {memory.pinned && (
                      <Icon name="pin" width={14} height={14} style={{ color: 'var(--accent-text)' }} />
                    )}
                    <strong className="truncate">{memory.title || 'Untitled memory'}</strong>
                    <span className="chip">{memory.category}</span>
                    {memory.importance !== 'normal' && (
                      <span className={`chip ${IMPORTANCE_CHIP[memory.importance]}`}>
                        {memory.importance}
                      </span>
                    )}
                    {memory.origin === 'auto' && <span className="chip">auto</span>}
                    {memoryStatus(memory) === 'proposed' && (
                      <span className="chip chip-warn">needs review</span>
                    )}
                    {memoryStatus(memory) === 'superseded' && (
                      <span className="chip">replaced</span>
                    )}
                    {memoryBasis(memory) !== 'observed' && (
                      <span className="chip">{memoryBasis(memory)}</span>
                    )}
                    {!!knowledgeContexts.get(memory.id)?.size && (
                      <span className="chip">
                        Knowledge tracked · {knowledgeContexts.get(memory.id)!.size} context
                        {knowledgeContexts.get(memory.id)!.size === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <div className="small muted clamp-2" style={{ marginTop: 4 }}>
                    {truncate(memory.content, 150)}
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {memory.sourceMessageIds.length
                      ? `From ${memory.sourceMessageIds.length} message${memory.sourceMessageIds.length === 1 ? '' : 's'} · `
                      : ''}
                    {relativeTime(memory.updatedAt)}
                  </div>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Actions for ${memory.title}`}
                  onClick={() => setMenuFor(memory)}
                >
                  <Icon name="more" />
                </button>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      {editing && (
        <MemoryEditor
          memory={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            await actions.saveMemory(next);
            setEditing(null);
            actions.toast({ kind: 'success', title: 'Memory saved' });
          }}
        />
      )}

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? ''}
        actions={
          menuFor
            ? [
                { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => setEditing(menuFor) },
                ...(memoryStatus(menuFor) === 'proposed'
                  ? [
                      {
                        key: 'accept',
                        label: 'Accept',
                        description: memorySupersedes(menuFor).length
                          ? `Start using this, and mark the ${memorySupersedes(menuFor).length} memory it replaces as replaced.`
                          : 'Start using this memory in the AI context.',
                        icon: 'check',
                        onSelect: () => void accept(menuFor),
                      },
                    ]
                  : []),
                {
                  key: 'source',
                  label: 'View source',
                  description: menuFor.sourceMessageIds.length
                    ? `Jump to the ${menuFor.sourceMessageIds.length} message${
                        menuFor.sourceMessageIds.length === 1 ? '' : 's'
                      } this came from.`
                    : 'This memory was written by hand, so it has no source message.',
                  icon: 'target',
                  disabled: !menuFor.sourceMessageIds.length,
                  onSelect: () => void openSource(menuFor),
                },
                {
                  key: 'pin',
                  label: menuFor.pinned ? 'Unpin' : 'Pin',
                  description: menuFor.pinned
                    ? 'Stop forcing this into every context.'
                    : 'Always include this memory in the AI context.',
                  icon: 'pin',
                  onSelect: () => actions.saveMemory({ ...menuFor, pinned: !menuFor.pinned }),
                },
                ...MEMORY_IMPORTANCE.filter((level) => level !== menuFor.importance).map((level) => ({
                  key: `imp-${level}`,
                  label: `Set importance: ${level}`,
                  icon: 'flag',
                  onSelect: () => actions.saveMemory({ ...menuFor, importance: level }),
                })),
                {
                  key: 'export',
                  label: 'Export',
                  icon: 'download',
                  separatorBefore: true,
                  onSelect: () => {
                    downloadFile(exportFilename('memory', menuFor.title), exportMemory(menuFor));
                    actions.toast({ kind: 'success', title: 'Memory exported' });
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: 'trash',
                  destructive: true,
                  onSelect: () => remove(menuFor),
                },
              ]
            : []
        }
      />
    </>
  );
}

export function MemoryEditor({
  memory,
  onClose,
  onSave,
  extraHeader,
}: {
  memory: Memory;
  onClose: () => void;
  onSave: (memory: Memory) => void | Promise<void>;
  extraHeader?: React.ReactNode;
}) {
  const state = useAppState();
  const [draft, setDraft] = useState<Memory>(memory);
  const [error, setError] = useState<string | null>(null);

  const patch = (changes: Partial<Memory>) => setDraft((current) => ({ ...current, ...changes }));

  const nameOf = (id: string) => {
    const character = state.characters.find((c) => c.id === id);
    if (character) return character.displayName || character.name;
    const persona = state.personas.find((p) => p.id === id);
    if (persona) return persona.displayName || persona.name;
    return 'Someone';
  };

  /** Stored edges about this memory, grouped by the context that recorded them. */
  const knowledgeHere = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; chatTitle: string; branchName: string; edges: typeof state.knowledgeEdges }
    >();
    for (const edge of state.knowledgeEdges) {
      if (edge.subject.kind !== 'memory' || edge.subject.id !== memory.id) continue;
      const key = `${edge.chatId}/${edge.branchId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.edges.push(edge);
        continue;
      }
      groups.set(key, {
        key,
        chatTitle: state.chats.find((c) => c.id === edge.chatId)?.title ?? 'A chat that is gone',
        // Only the open chat's branches are loaded, so a branch elsewhere is
        // named honestly rather than shown as a raw id.
        branchName: state.branches.find((b) => b.id === edge.branchId)?.name ?? 'a branch',
        edges: [edge],
      });
    }
    return [...groups.values()];
  }, [state.knowledgeEdges, state.chats, state.branches, memory.id]);

  const submit = async () => {
    if (!draft.content.trim()) {
      setError('A memory needs content.');
      return;
    }
    setError(null);
    await onSave({
      ...draft,
      title: draft.title.trim() || truncate(draft.content, 50),
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={memory.title ? 'Edit memory' : 'New memory'}
      large
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            <Icon name="save" />
            Save
          </button>
        </>
      }
    >
      {extraHeader}
      <TextField
        label="Title"
        value={draft.title}
        onChange={(title) => patch({ title })}
        hint="Leave blank to derive it from the content."
      />
      <TextArea
        label="Content"
        required
        value={draft.content}
        onChange={(content) => patch({ content })}
        large
        error={error ?? undefined}
      />
      <div className="field-row field-row-2">
        <SelectField
          label="Category"
          value={draft.category}
          onChange={(category) => patch({ category })}
          options={MEMORY_CATEGORIES.map((value) => ({ value, label: value }))}
        />
        <SelectField
          label="Importance"
          value={draft.importance}
          onChange={(importance) => patch({ importance })}
          options={MEMORY_IMPORTANCE.map((value) => ({ value, label: value }))}
          hint="Higher importance survives context trimming."
        />
      </div>
      {/*
        The basis is not decoration: it changes what the AI is told. A memory
        marked as claimed is sent as somebody's word for it rather than as
        something true, which is the difference between a character who lies
        and a character who is retroactively honest.
      */}
      <SelectField
        label="How this is known"
        value={memoryBasis(draft)}
        onChange={(basis) => patch({ basis })}
        options={[
          { value: 'observed', label: 'It happened' },
          { value: 'stated', label: 'Someone said it' },
          { value: 'inferred', label: 'It was concluded' },
        ]}
        hint={
          memoryBasis(draft) === 'observed'
            ? 'Sent as fact.'
            : memoryBasis(draft) === 'stated'
              ? 'Sent as a claim, with whoever made it — the AI is told it may not be true.'
              : 'Sent marked as unconfirmed.'
        }
      />
      <Toggle
        label="Pinned"
        description="Pinned memories are always included, ahead of everything else."
        checked={draft.pinned}
        onChange={(pinned) => patch({ pinned })}
      />
      <TagField label="Tags" values={draft.tags} onChange={(tags) => patch({ tags })} />

      <SelectField
        label="Attached story"
        value={draft.sourceStoryId ?? ''}
        onChange={(value) => patch({ sourceStoryId: value || null })}
        options={[
          { value: '', label: 'Not attached (applies everywhere)' },
          ...state.stories.map((story) => ({ value: story.id, label: story.title || 'Untitled story' })),
        ]}
        hint="Attached memories are still available globally; this records where it came from."
      />

      <div className="field">
        <span className="field-label">Attached characters</span>
        {!state.characters.length ? (
          <p className="small muted">No characters yet.</p>
        ) : (
          <div className="chip-row">
            {state.characters.map((character) => {
              const on = draft.characterIds.includes(character.id);
              return (
                <button
                  key={character.id}
                  type="button"
                  className={`chip ${on ? 'chip-accent' : ''}`}
                  style={{ cursor: 'pointer', minHeight: 34 }}
                  aria-pressed={on}
                  onClick={() =>
                    patch({
                      characterIds: on
                        ? draft.characterIds.filter((id) => id !== character.id)
                        : [...draft.characterIds, character.id],
                    })
                  }
                >
                  {character.name || 'Unnamed'}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!!draft.sourceMessageIds.length && (
        <p className="small muted">
          Created from {draft.sourceMessageIds.length} selected message
          {draft.sourceMessageIds.length === 1 ? '' : 's'}.
        </p>
      )}

      {/*
        Grouped by the chat and branch each attribution belongs to, never merged
        into one list. Two branches can have recorded different people knowing
        this, and flattening that would invent a story-wide state that does not
        exist. Read-only: this page has no timeline, and the scoped view lives
        in the Context Inspector.
      */}
      {!!knowledgeHere.length && (
        <section className="section">
          <h3 className="section-title">Knowledge tracked</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Recorded as having heard this. Not that they believe it, and not that it is true.
          </p>
          {knowledgeHere.map((group) => (
            <div className="card" key={group.key} style={{ marginBottom: 6 }}>
              <div className="small">
                <strong>{group.chatTitle}</strong>
                <span className="muted"> — {group.branchName}</span>
              </div>
              {group.edges.map((edge) => (
                <div className="small muted" key={edge.id} style={{ marginTop: 3 }}>
                  {nameOf(edge.knowerId)} — {edge.basis === 'told' && edge.toldById
                    ? `told by ${nameOf(edge.toldById)}`
                    : edge.basis}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </Sheet>
  );
}

/**
 * Messages the user flagged as important, across every chat.
 *
 * Unlike a memory, the original wording is preserved exactly — this is the
 * "don't paraphrase this" list.
 */
function ImportantMessages() {
  const state = useAppState();
  const actions = useActions();
  const [rows, setRows] = useState<
    Array<{ message: Message; chatTitle: string; chatId: string; storyTitle: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const repo = await import('../storage/repositories');
      const found: typeof rows = [];
      for (const chat of state.chats) {
        const chatMessages = await repo.messages.byChat(chat.id);
        const story = state.stories.find((s) => s.id === chat.storyId);
        for (const message of chatMessages) {
          if (!message.important) continue;
          found.push({
            message,
            chatTitle: chat.title,
            chatId: chat.id,
            storyTitle: story?.title ?? '',
          });
        }
      }
      if (cancelled) return;
      found.sort((a, b) => b.message.createdAt - a.message.createdAt);
      setRows(found);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [state.chats, state.stories]);

  const visible = rows.filter((row) =>
    search.trim() ? row.message.content.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );

  if (loading) return <Spinner label="Finding important messages…" />;

  return (
    <>
      <Banner kind="info" title="Important messages">
        Messages you flagged with <strong>Mark important</strong> in a chat. The original text is
        kept exactly as written — turn one into a memory when you want a condensed version instead.
      </Banner>

      {rows.length > 3 && (
        <SearchInput value={search} onChange={setSearch} placeholder="Search important messages…" />
      )}

      {!visible.length ? (
        <EmptyState
          icon="flag"
          title={rows.length ? 'Nothing matches' : 'No important messages yet'}
          message="Open a message's actions in a chat and choose Mark important."
        />
      ) : (
        <div className="list">
          {visible.map((row) => (
            <div className="card" key={row.message.id}>
              <div className="row row-wrap" style={{ gap: 6 }}>
                <Icon name="flag" width={14} height={14} style={{ color: 'var(--warn)' }} />
                <strong className="truncate">{row.chatTitle}</strong>
                {row.storyTitle && <span className="chip">{row.storyTitle}</span>}
                <span className="chip">{row.message.role === 'user' ? 'You' : 'AI'}</span>
              </div>
              <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {truncate(row.message.content, 400)}
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    location.hash = `#/chat/${row.chatId}`;
                  }}
                >
                  <Icon name="chat" />
                  Open chat
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const ok = await copyText(row.message.content);
                    actions.toast({
                      kind: ok ? 'success' : 'error',
                      title: ok ? 'Copied' : 'Copy failed',
                    });
                  }}
                >
                  <Icon name="copy" />
                  Copy
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await actions.saveMemory(
                      newMemory({
                        title: truncate(row.message.content, 60),
                        content: row.message.content,
                        category: 'Event',
                        sourceMessageIds: [row.message.id],
                        sourceChatId: row.chatId,
                      }),
                    );
                    actions.toast({
                      kind: 'success',
                      title: 'Saved as a memory',
                      detail: 'Edit it in the Memories tab to condense the wording.',
                    });
                  }}
                >
                  <Icon name="brain" />
                  Make a memory
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    const repo = await import('../storage/repositories');
                    await repo.messages.save({ ...row.message, important: false });
                    setRows((current) => current.filter((r) => r.message.id !== row.message.id));
                  }}
                >
                  <Icon name="x" />
                  Unflag
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
