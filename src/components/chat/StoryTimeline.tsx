import { useEffect, useMemo, useState } from 'react';
import type { Branch, Chat, Checkpoint, ID, Message, Story, StorySummary } from '../../types';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { EmptyState, Spinner, Tabs } from '../ui/common';
import { relativeTime, truncate } from '../../utils/text';

export type TimelineEntryKind = 'chat-start' | 'fork' | 'checkpoint' | 'important';

export interface TimelineEntry {
  id: string;
  kind: TimelineEntryKind;
  label: string;
  detail: string;
  excerpt: string;
  chatId: ID;
  chatTitle: string;
  branchId: ID;
  messageId: ID;
  /** Message order — the spine's sort key inside a chat. */
  order: number;
  at: number;
}

const ICON: Record<TimelineEntryKind, string> = {
  'chat-start': 'play',
  fork: 'branch',
  checkpoint: 'bookmark',
  important: 'flag',
};

/**
 * Every anchored landmark in a story, on one chronological spine: where each
 * chat began, where branches forked, saved checkpoints, and messages flagged
 * important. Tapping one jumps to that message, switching chat or branch first
 * when the landmark lives somewhere other than where you are now.
 */
function buildStoryTimeline(input: {
  chats: Chat[];
  branches: Branch[];
  messages: Message[];
  checkpoints: Checkpoint[];
}): TimelineEntry[] {
  const { chats, branches, messages, checkpoints } = input;
  const messageById = new Map(messages.map((m) => [m.id, m]));
  const chatById = new Map(chats.map((c) => [c.id, c]));
  const entries: TimelineEntry[] = [];

  const excerptOf = (id: ID) => {
    const message = messageById.get(id);
    return message ? truncate(message.content.replace(/\s+/g, ' ').trim(), 110) : '';
  };

  for (const chat of chats) {
    const own = messages
      .filter((m) => m.chatId === chat.id)
      .sort((a, b) => a.order - b.order);
    const first = own[0];
    if (first) {
      entries.push({
        id: `start-${chat.id}`,
        kind: 'chat-start',
        label: 'Chat started',
        detail: `${own.length} message${own.length === 1 ? '' : 's'} so far`,
        excerpt: excerptOf(first.id),
        chatId: chat.id,
        chatTitle: chat.title,
        branchId: first.branchId,
        messageId: first.id,
        order: first.order,
        at: chat.createdAt,
      });
    }

    for (const branch of branches) {
      if (branch.chatId !== chat.id || !branch.parentBranchId) continue;
      // A fork is anchored to the message it forked from, which belongs to the
      // *parent* branch — that is where the jump has to land.
      const from = branch.createdFromMessageId;
      if (!from || !messageById.has(from)) continue;
      entries.push({
        id: `fork-${branch.id}`,
        kind: 'fork',
        label: `Branched: ${branch.name}`,
        detail: 'A new timeline forked here',
        excerpt: excerptOf(from),
        chatId: chat.id,
        chatTitle: chat.title,
        branchId: messageById.get(from)!.branchId,
        messageId: from,
        order: branch.forkOrder,
        at: branch.createdAt,
      });
    }
  }

  for (const checkpoint of checkpoints) {
    const chat = chatById.get(checkpoint.chatId);
    if (!chat || !messageById.has(checkpoint.messageId)) continue;
    entries.push({
      id: `cp-${checkpoint.id}`,
      kind: 'checkpoint',
      label: `Checkpoint: ${checkpoint.name}`,
      detail: checkpoint.description || 'Saved point',
      excerpt: excerptOf(checkpoint.messageId),
      chatId: chat.id,
      chatTitle: chat.title,
      branchId: checkpoint.branchId,
      messageId: checkpoint.messageId,
      order: checkpoint.messageOrder,
      at: checkpoint.createdAt,
    });
  }

  for (const message of messages) {
    if (!message.important) continue;
    const chat = chatById.get(message.chatId);
    if (!chat) continue;
    entries.push({
      id: `imp-${message.id}`,
      kind: 'important',
      label: 'Important message',
      detail: 'Flagged in the conversation',
      excerpt: excerptOf(message.id),
      chatId: chat.id,
      chatTitle: chat.title,
      branchId: message.branchId,
      messageId: message.id,
      order: message.order,
      at: message.createdAt,
    });
  }

  // Chats in the order they were started, landmarks in story order within each.
  const chatRank = new Map(
    chats
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c, i) => [c.id, i] as const),
  );
  return entries.sort((a, b) => {
    const byChat = (chatRank.get(a.chatId) ?? 0) - (chatRank.get(b.chatId) ?? 0);
    if (byChat) return byChat;
    if (a.order !== b.order) return a.order - b.order;
    return a.at - b.at;
  });
}

export interface JumpTarget {
  chatId: ID;
  branchId: ID;
  messageId: ID;
}

interface LoadedSpine {
  messages: Message[];
  branches: Branch[];
  checkpoints: Checkpoint[];
}

export function StoryTimeline({
  open,
  onClose,
  story,
  chats,
  summary,
  activeChatId,
  onJump,
  embedded,
}: {
  open: boolean;
  onClose: () => void;
  /** Render the body without its own sheet, for hosting inside the Story Map. */
  embedded?: boolean;
  story: Story | null;
  /** Every chat in the story — the spine spans all of them, not just the open one. */
  chats: Chat[];
  summary: StorySummary | null;
  activeChatId: ID | null;
  onJump: (target: JumpTarget) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'checkpoint' | 'fork' | 'important'>('all');
  const [spine, setSpine] = useState<LoadedSpine | null>(null);

  // The store only keeps the open chat's working set, so the other chats'
  // messages and branches have to be read from the database. Re-keyed on the
  // chat ids so a new chat in the story reloads the spine.
  const chatKey = chats.map((c) => c.id).join(',');
  useEffect(() => {
    if (!open) {
      setSpine(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const repo = await import('../../storage/repositories');
      const perChat = await Promise.all(
        chats.map((chat) =>
          Promise.all([
            repo.messages.byChat(chat.id),
            repo.branches.byChat(chat.id),
            repo.checkpoints.byChat(chat.id),
          ]),
        ),
      );
      if (cancelled) return;
      setSpine({
        messages: perChat.flatMap((p) => p[0]),
        branches: perChat.flatMap((p) => p[1]),
        checkpoints: perChat.flatMap((p) => p[2]),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chatKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(
    () => (spine ? buildStoryTimeline({ chats, ...spine }) : []),
    [chats, spine],
  );

  const shown = filter === 'all' ? entries : entries.filter((e) => e.kind === filter);
  const counts = {
    checkpoint: entries.filter((e) => e.kind === 'checkpoint').length,
    fork: entries.filter((e) => e.kind === 'fork').length,
    important: entries.filter((e) => e.kind === 'important').length,
  };

  const recorded = summary?.importantEvents?.filter((e) => e.trim()) ?? [];

  const body = (
    <>
      <p className="small muted">
        {story ? `Every landmark in “${story.title}”` : 'Every landmark in this chat'}, oldest first.
        Tap one to jump straight to that message.
      </p>

      <Tabs
        tabs={[
          { id: 'all', label: 'All', badge: entries.length },
          { id: 'checkpoint', label: 'Checkpoints', badge: counts.checkpoint },
          { id: 'fork', label: 'Branches', badge: counts.fork },
          { id: 'important', label: 'Important', badge: counts.important },
        ]}
        active={filter}
        onChange={setFilter}
        label="Timeline filters"
      />

      {!spine ? (
        <Spinner label="Reading the story…" />
      ) : !shown.length ? (
        <EmptyState
          icon="clock"
          title={entries.length ? 'Nothing of this kind yet' : 'No landmarks yet'}
          message={
            entries.length
              ? 'Try another filter — the story has landmarks of other kinds.'
              : 'Save a checkpoint, flag a message as important, or branch the conversation, and it will appear here.'
          }
        />
      ) : (
        <ol className="story-timeline" data-testid="story-timeline">
          {shown.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="timeline-entry"
                data-testid="timeline-entry"
                data-kind={entry.kind}
                aria-label={`Jump to ${entry.label}`}
                onClick={() => onJump(entry)}
              >
                <span className={`timeline-dot timeline-dot-${entry.kind}`} aria-hidden="true">
                  <Icon name={ICON[entry.kind]} width={13} height={13} />
                </span>
                <span className="timeline-body">
                  <span className="timeline-head">
                    <strong className="truncate">{entry.label}</strong>
                    <span className="small muted">{relativeTime(entry.at)}</span>
                  </span>
                  <span className="small muted">
                    {entry.detail}
                    {entry.chatId !== activeChatId && ` · in “${entry.chatTitle}”`}
                  </span>
                  {entry.excerpt && <span className="timeline-excerpt">{entry.excerpt}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {!!recorded.length && (
        <>
          <h3 className="section-title" style={{ marginTop: 18 }}>
            Recorded events
            <span className="chip">{recorded.length}</span>
          </h3>
          <p className="small muted">
            Beats kept in the story summary. These are not tied to a single message, so they have no
            place on the spine above.
          </p>
          <ul className="list" style={{ marginTop: 8 }}>
            {recorded.map((event, i) => (
              <li className="card" key={`${i}-${event.slice(0, 20)}`}>
                {event}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <Sheet open={open} onClose={onClose} title="Story timeline" large>
      {body}
    </Sheet>
  );
}
