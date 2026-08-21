import { memo, useMemo, useState } from 'react';
import type { Character, Message, MessageAlternative, Persona, Story } from '../../types';
import { Avatar, useMediaUrl } from '../media/MediaImage';
import { Icon } from '../ui/Icon';
import { useLongPress } from '../ui/common';
import { formatDate } from '../../utils/text';
import { speakerFor } from '../../hooks/useGeneration';

export interface MessageItemProps {
  message: Message;
  characters: Character[];
  persona: Persona | null;
  /** All personas, so an older message can resolve its own author. */
  personas: Persona[];
  story: Story | null;
  alternatives: MessageAlternative[];
  content: string;
  streaming: boolean;
  streamingText: string;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpenMenu: (message: Message) => void;
  onQuickAction: (action: QuickAction, message: Message) => void;
  onSetAlternative: (messageId: string, alternativeId: string | null) => void;
  onViewImage: (mediaId: string) => void;
  showTimestamps: boolean;
  /** Briefly ringed after a timeline jump lands on this message. */
  highlighted?: boolean;
}

export type QuickAction = 'edit' | 'copy' | 'regenerate' | 'delete' | 'important';

/**
 * A single chat message.
 *
 * All actions are reachable by tap (the ⋯ button) and by long press — nothing
 * depends on hover, which does not exist on touch devices.
 */
export const MessageItem = memo(function MessageItem({
  message,
  characters,
  persona,
  personas,
  story,
  alternatives,
  content,
  streaming,
  streamingText,
  selecting,
  selected,
  onToggleSelect,
  onOpenMenu,
  onQuickAction,
  onSetAlternative,
  onViewImage,
  showTimestamps,
  highlighted,
}: MessageItemProps) {
  const { name, character, persona: author } = speakerFor(
    message,
    characters,
    persona,
    story,
    personas,
  );
  const isUser = message.role === 'user';

  const longPress = useLongPress(() => {
    if (selecting) onToggleSelect(message.id);
    else onOpenMenu(message);
  });

  // Alternatives form a ring: index 0 is the message's own content.
  const versions = useMemo(
    () => [
      { id: null as string | null, content: message.content },
      ...alternatives
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((a) => ({ id: a.id as string | null, content: a.content })),
    ],
    [message.content, alternatives],
  );
  const activeIndex = Math.max(
    0,
    versions.findIndex((v) => v.id === message.activeAlternativeId),
  );

  const displayText = streaming ? streamingText : content;

  return (
    <article
      className={`msg${isUser ? ' msg-user' : ''}${highlighted ? ' msg-highlighted' : ''}`}
      data-message-id={message.id}
      aria-label={`${name} message`}
    >
      {!isUser && (
        <Avatar
          mediaId={character?.avatarMediaId ?? null}
          fallbackUrl={character?.avatarUrl}
          name={name}
          size={34}
        />
      )}
      {isUser && (
        <Avatar
          mediaId={author?.avatarMediaId ?? null}
          fallbackUrl={author?.avatarUrl}
          name={name}
          size={34}
        />
      )}

      <div className="msg-body">
        <div className="msg-meta">
          {selecting && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(message.id)}
              aria-label={`Select message from ${name}`}
              style={{ width: 18, height: 18 }}
            />
          )}
          <span>{name}</span>
          {message.important && (
            <Icon name="flag" width={12} height={12} style={{ color: 'var(--warn)' }} />
          )}
          {showTimestamps && <span>· {formatDate(message.createdAt)}</span>}
        </div>

        <div
          data-testid="message-bubble"
          data-role={message.role}
          className={`bubble${selected ? ' selected' : ''}${message.important ? ' important' : ''}${
            message.error ? ' error' : ''
          }`}
          {...longPress.handlers}
          onClick={() => {
            if (selecting && !longPress.fired.current) onToggleSelect(message.id);
          }}
          role={selecting ? 'button' : undefined}
          tabIndex={selecting ? 0 : undefined}
          onKeyDown={(e) => {
            if (selecting && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onToggleSelect(message.id);
            }
          }}
        >
          {displayText || (streaming ? '' : <span className="muted">(empty)</span>)}
          {streaming && (
            <span className="typing-dots" style={{ marginLeft: 6 }} aria-label="Generating">
              <i />
              <i />
              <i />
            </span>
          )}
          {message.error && (
            <div className="small" style={{ marginTop: 8 }}>
              ⚠ {message.error}
            </div>
          )}

          {!!message.attachments?.length && (
            <div className="msg-attachments">
              {message.attachments.map((attachment) =>
                attachment.kind === 'image' && attachment.mediaId ? (
                  <AttachmentThumb
                    key={attachment.id}
                    mediaId={attachment.mediaId}
                    filename={attachment.filename}
                    onView={() => onViewImage(attachment.mediaId!)}
                  />
                ) : (
                  <span className="chip" key={attachment.id}>
                    <Icon name="file" width={13} height={13} />
                    {attachment.filename}
                  </span>
                ),
              )}
            </div>
          )}
        </div>

        {versions.length > 1 && !streaming && (
          <div className="alt-nav">
            <button
              type="button"
              aria-label="Previous response"
              disabled={activeIndex === 0}
              onClick={() => onSetAlternative(message.id, versions[activeIndex - 1].id)}
            >
              <Icon name="chevronLeft" width={14} height={14} />
            </button>
            <span>
              {activeIndex + 1} / {versions.length}
            </span>
            <button
              type="button"
              aria-label="Next response"
              disabled={activeIndex === versions.length - 1}
              onClick={() => onSetAlternative(message.id, versions[activeIndex + 1].id)}
            >
              <Icon name="chevronRight" width={14} height={14} />
            </button>
          </div>
        )}

        {!selecting && !streaming && (
          <div className="msg-actions">
            <button
              type="button"
              className="msg-action"
              onClick={() => onQuickAction('copy', message)}
              aria-label="Copy message"
              title="Copy"
            >
              <Icon name="copy" />
            </button>
            <button
              type="button"
              className="msg-action"
              onClick={() => onQuickAction('edit', message)}
              aria-label="Edit message"
              title="Edit"
            >
              <Icon name="edit" />
            </button>
            {!isUser && (
              <button
                type="button"
                className="msg-action"
                onClick={() => onQuickAction('regenerate', message)}
                aria-label="Regenerate response"
                title="Regenerate"
              >
                <Icon name="refresh" />
              </button>
            )}
            <button
              type="button"
              className="msg-action"
              onClick={() => onOpenMenu(message)}
              aria-label="More message actions"
              title="More"
            >
              <Icon name="more" />
            </button>
          </div>
        )}
      </div>
    </article>
  );
});

function AttachmentThumb({
  mediaId,
  filename,
  onView,
}: {
  mediaId: string;
  filename: string;
  onView: () => void;
}) {
  const { url, missing } = useMediaUrl(mediaId);
  const [failed, setFailed] = useState(false);

  if (missing || failed) {
    return (
      <span className="chip chip-danger" title={filename}>
        <Icon name="warn" width={13} height={13} />
        Image unavailable
      </span>
    );
  }
  if (!url) {
    return (
      <span
        className="attachment-preview"
        style={{ width: 108, height: 108 }}
        aria-busy="true"
        aria-label={`Loading ${filename}`}
      />
    );
  }
  return (
    <img
      src={url}
      alt={filename}
      onClick={onView}
      onError={() => setFailed(true)}
      loading="lazy"
      decoding="async"
    />
  );
}
