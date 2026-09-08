import { useMemo, useState } from 'react';
import type { Branch, Checkpoint, Chat, Message } from '../../types';
import { buildBranchTree, flattenBranchTree, resolveTimeline } from '../../services/timeline';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/common';
import { useActions, useAppState } from '../../state/store';
import { useConfirm, deleteConfirm } from '../../components/ui/Confirm';
import { formatDate, relativeTime, truncate } from '../../utils/text';

/** Branch tree with rename / switch / delete, and the checkpoint list. */
export function BranchPanel({
  open,
  onClose,
  chat,
  branches,
  messages,
  embedded,
}: {
  open: boolean;
  onClose: () => void;
  chat: Chat;
  branches: Branch[];
  messages: Message[];
  /**
   * Render the body without its own sheet, so the Story Map can host it as a
   * tab. The panel is otherwise unchanged — same tree, same actions, same
   * data — because there is only one branch view and this is it.
   */
  embedded?: boolean;
}) {
  const actions = useActions();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState<Branch | null>(null);
  const [name, setName] = useState('');

  const nodes = useMemo(
    () => flattenBranchTree(buildBranchTree(branches, messages)),
    [branches, messages],
  );

  const remove = async (branch: Branch) => {
    const descendants = nodes.filter(
      (n) => n.id !== branch.id && isDescendant(nodes, n.id, branch.id),
    );
    const ok = await confirm(
      deleteConfirm(
        'branch',
        branch.name,
        <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
          {descendants.length
            ? `${descendants.length} branch${descendants.length === 1 ? '' : 'es'} forked from it will be deleted too. `
            : ''}
          Only messages written on {descendants.length ? 'these branches' : 'this branch'} are
          removed — the timeline it forked from is untouched.
        </p>,
      ),
    );
    if (!ok) return;
    await actions.deleteBranch(branch.id);
    actions.toast({ kind: 'success', title: 'Branch deleted' });
  };

  const body = (
    <>
        <p className="small muted">
          Branching forks the conversation at a message. Every branch keeps the history it inherited
          and adds its own messages — the original timeline is never changed.
        </p>

        <div className="list" style={{ marginTop: 12 }}>
          {nodes.map((node) => {
            const active = node.id === chat.activeBranchId;
            const forkMessage = node.createdFromMessageId
              ? messages.find((m) => m.id === node.createdFromMessageId)
              : null;
            const length = resolveTimeline(messages, branches, node.id).length;
            return (
              <div className="card" key={node.id} style={active ? { borderColor: 'var(--accent)' } : undefined}>
                <button
                  type="button"
                  className={`branch-row${active ? ' active' : ''}`}
                  data-testid="branch-row"
                  aria-label={`Switch to branch ${node.name}`}
                  onClick={async () => {
                    await actions.switchBranch(node.id);
                    onClose();
                  }}
                >
                  <span className="branch-indent">{'│  '.repeat(node.depth)}{node.depth ? '└─ ' : ''}</span>
                  <Icon name="branch" width={15} height={15} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                      {node.name}
                    </span>
                    <span className="small muted">
                      {length} message{length === 1 ? '' : 's'} · {relativeTime(node.createdAt)}
                      {node.parentBranchId ? '' : ' · root'}
                    </span>
                  </span>
                  {active && <span className="chip chip-accent">Active</span>}
                </button>

                {forkMessage && (
                  <div className="small muted" style={{ marginTop: 6, paddingLeft: 8 }}>
                    Forked at: “{truncate(forkMessage.content, 70)}”
                  </div>
                )}

                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Rename branch ${node.name}`}
                    onClick={() => {
                      setRenaming(node);
                      setName(node.name);
                    }}
                  >
                    <Icon name="edit" />
                    Rename
                  </button>
                  {(node.parentBranchId || branches.length > 1) && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(node)}>
                      <Icon name="trash" />
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
    </>
  );

  return (
    <>
      {embedded ? (
        body
      ) : (
        <Sheet open={open} onClose={onClose} title="Timeline branches" large>
          {body}
        </Sheet>
      )}

      {renaming && (
        <Sheet
          open
          onClose={() => setRenaming(null)}
          title="Rename branch"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await actions.renameBranch(renaming.id, name);
                  setRenaming(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="branch-name">
              Branch name
            </label>
            <input
              id="branch-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          </div>
        </Sheet>
      )}
    </>
  );
}

function isDescendant(
  nodes: Array<{ id: string; parentBranchId: string | null }>,
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let current = byId.get(candidateId);
  const seen = new Set<string>();
  while (current?.parentBranchId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentBranchId === ancestorId) return true;
    current = byId.get(current.parentBranchId);
  }
  return false;
}

export function CheckpointPanel({
  open,
  onClose,
  chat,
  checkpoints,
  messages,
  onOpenChat,
}: {
  open: boolean;
  onClose: () => void;
  chat: Chat;
  checkpoints: Checkpoint[];
  messages: Message[];
  onOpenChat: (chatId: string) => void;
}) {
  const actions = useActions();
  const confirm = useConfirm();
  const state = useAppState();
  const [renaming, setRenaming] = useState<Checkpoint | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const mine = checkpoints
    .filter((c) => c.chatId === chat.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Checkpoints" large>
        <p className="small muted">
          A checkpoint marks a point in the conversation. Restoring one forks a new branch there
          (nothing is lost), or you can start a brand-new chat from it.
        </p>

        {!mine.length ? (
          <EmptyState
            icon="bookmark"
            title="No checkpoints in this chat"
            message="Open any message's actions and choose Checkpoint to save one."
          />
        ) : (
          <div className="list" style={{ marginTop: 12 }}>
            {mine.map((checkpoint) => {
              const message = messages.find((m) => m.id === checkpoint.messageId);
              const branch = state.branches.find((b) => b.id === checkpoint.branchId);
              return (
                <div className="card" key={checkpoint.id}>
                  <div className="row row-between row-wrap">
                    <strong className="truncate">{checkpoint.name}</strong>
                    <span className="chip">{formatDate(checkpoint.createdAt)}</span>
                  </div>
                  {checkpoint.description && (
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {checkpoint.description}
                    </div>
                  )}
                  <div className="small muted" style={{ marginTop: 5 }}>
                    Branch: {branch?.name ?? 'unknown'} · at “{truncate(message?.content ?? '(message deleted)', 60)}”
                  </div>

                  <div className="btn-row" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={async () => {
                        const branchCreated = await actions.restoreCheckpoint(checkpoint.id);
                        if (branchCreated) {
                          actions.toast({
                            kind: 'success',
                            title: 'Restored',
                            detail: `Forked a new branch "${branchCreated.name}" at this checkpoint.`,
                          });
                          onClose();
                        }
                      }}
                    >
                      <Icon name="refresh" />
                      Restore here
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        const newChat = await actions.chatFromCheckpoint(checkpoint.id);
                        if (newChat) {
                          actions.toast({ kind: 'success', title: `Started "${newChat.title}"` });
                          onClose();
                          onOpenChat(newChat.id);
                        }
                      }}
                    >
                      <Icon name="chat" />
                      New chat from here
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setRenaming(checkpoint);
                        setName(checkpoint.name);
                        setDescription(checkpoint.description);
                      }}
                    >
                      <Icon name="edit" />
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        const ok = await confirm(deleteConfirm('checkpoint', checkpoint.name));
                        if (!ok) return;
                        await actions.deleteCheckpoint(checkpoint.id);
                      }}
                    >
                      <Icon name="trash" />
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Sheet>

      {renaming && (
        <Sheet
          open
          onClose={() => setRenaming(null)}
          title="Rename checkpoint"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await actions.renameCheckpoint(renaming.id, name, description);
                  setRenaming(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="cp-name">
              Name
            </label>
            <input
              id="cp-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cp-desc">
              Description
            </label>
            <textarea
              id="cp-desc"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </Sheet>
      )}
    </>
  );
}
