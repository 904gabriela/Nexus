/**
 * Where the story has been, and where it forked.
 *
 * Both views already existed and both are unchanged: the branch tree lives in
 * BranchPanel, the chronological spine in StoryTimeline. What did not exist was
 * a place where they were the same idea. "Story map" in the header opened the
 * flat timeline, while the tree — the thing that actually answers "what else
 * could have happened here" — was three taps deep under the ⋯ menu, labelled
 * Branches. Someone looking for the shape of their story had no reason to find
 * it.
 *
 * So this is one sheet with two tabs and no logic of its own. It owns no data,
 * duplicates no state, and renders the two existing panels in embedded mode.
 */
import { useEffect, useState } from 'react';
import type { Branch, Chat, ID, Message, Story, StorySummary } from '../../types';
import { Sheet } from '../ui/Sheet';
import { Tabs } from '../ui/common';
import { BranchPanel } from './BranchPanel';
import { StoryTimeline, type JumpTarget } from './StoryTimeline';

export function StoryMap({
  open,
  onClose,
  chat,
  branches,
  messages,
  story,
  chats,
  summary,
  activeChatId,
  onJump,
  initialTab = 'branches',
}: {
  open: boolean;
  onClose: () => void;
  /** Which view to land on — the ⋯ entries name one, the header button does not. */
  initialTab?: 'branches' | 'timeline';
  chat: Chat;
  branches: Branch[];
  messages: Message[];
  story: Story | null;
  chats: Chat[];
  summary: StorySummary | null;
  activeChatId: ID | null;
  onJump: (target: JumpTarget) => void;
}) {
  const [tab, setTab] = useState<'branches' | 'timeline'>(initialTab);

  // Opening from a menu entry that names a view should land on that view, even
  // if the sheet was last closed on the other one.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Sheet open={open} onClose={onClose} title="Story map" large>
      <Tabs
        tabs={[
          { id: 'branches', label: 'Branches', badge: branches.length },
          { id: 'timeline', label: 'Timeline' },
        ]}
        active={tab}
        onChange={setTab}
        label="Story map views"
      />

      {tab === 'branches' ? (
        <BranchPanel
          embedded
          open={open}
          onClose={onClose}
          chat={chat}
          branches={branches}
          messages={messages}
        />
      ) : (
        <StoryTimeline
          embedded
          // The spine reads every chat in the story from the database, so it is
          // only told it is open once its tab is actually showing.
          open={open && tab === 'timeline'}
          onClose={onClose}
          story={story}
          chats={chats}
          summary={summary}
          activeChatId={activeChatId}
          onJump={(target) => {
            onClose();
            onJump(target);
          }}
        />
      )}
    </Sheet>
  );
}
