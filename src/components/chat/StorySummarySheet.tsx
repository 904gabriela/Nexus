import { useEffect, useState } from 'react';
import type { StorySummary } from '../../types';
import { newStorySummary } from '../../types/factories';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Banner } from '../ui/common';
import { TextArea, Toggle } from '../ui/Field';
import { useActions, useStore } from '../../state/store';
import {
  applyDraft,
  generateStorySummary,
  pendingMessages,
  type SummaryDraft,
} from '../../memory/storySummary';
import type { UseGeneration } from '../../hooks/useGeneration';
import { relativeTime } from '../../utils/text';

/**
 * The story's long-run memory, exposed for reading and editing.
 *
 * This is what lets a story run for months without either forgetting itself or
 * blowing the context budget, so it is worth showing plainly rather than
 * hiding behind automation.
 */
export function StorySummarySheet({
  open,
  onClose,
  gen,
}: {
  open: boolean;
  onClose: () => void;
  gen: UseGeneration;
}) {
  const actions = useActions();
  const { state, timeline } = { state: useStore().state, timeline: useStore().timeline };

  const [draft, setDraft] = useState<StorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open || !gen.story) return;
    setDraft(gen.summary ?? newStorySummary(gen.story.id));
    setNote(null);
    setDirty(false);
  }, [open, gen.story, gen.summary]);

  if (!gen.story) {
    return (
      <Sheet open={open} onClose={onClose} title="Story summary">
        <Banner kind="info" title="No story attached">
          Long-run memory belongs to a story. Attach this chat to a story to use it.
        </Banner>
      </Sheet>
    );
  }

  const pending = draft
    ? pendingMessages({
        story: gen.story,
        existing: gen.summary,
        characters: gen.characters,
        persona: gen.persona,
        timeline,
        window: state.settings.summaryWindow,
        provider: gen.provider,
      }).length
    : 0;

  const patch = (changes: Partial<StorySummary>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
    setDirty(true);
  };

  const regenerate = async () => {
    if (!gen.story || !draft) return;
    setBusy(true);
    try {
      const result: SummaryDraft = await generateStorySummary({
        story: gen.story,
        existing: gen.summary,
        characters: gen.characters,
        persona: gen.persona,
        timeline,
        window: state.settings.summaryWindow,
        provider: gen.provider,
      });
      setDraft(applyDraft(draft, result));
      setNote(result.note ?? null);
      setDirty(true);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    await actions.saveStorySummary(draft);
    setDirty(false);
    actions.toast({ kind: 'success', title: 'Story summary saved' });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Story summary"
      large
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn"
            onClick={regenerate}
            disabled={busy || draft?.locked}
          >
            {busy ? <span className="spinner" /> : <Icon name="sparkle" />}
            {gen.summary?.rollingSummary ? 'Regenerate' : 'Generate'}
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty}>
            <Icon name="save" />
            Save
          </button>
        </>
      }
    >
      <Banner kind="info" title="How this is used">
        Messages older than the last {state.settings.summaryWindow} are replaced in the AI context by
        this summary. That keeps a very long story affordable without losing the plot.
        {pending > 0 && ` ${pending} message(s) are waiting to be folded in.`}
      </Banner>

      {note && (
        <Banner kind="warn" title="About this draft">
          {note}
        </Banner>
      )}

      {draft?.locked && (
        <Banner kind="warn" title="Summary is locked">
          Automatic regeneration is disabled. Unlock it below to let the app keep it current.
        </Banner>
      )}

      {draft && (
        <>
          <TextArea
            label="Where things stand"
            value={draft.currentSummary}
            onChange={(currentSummary) => patch({ currentSummary })}
            hint="A few sentences describing the present moment of the story."
          />
          <TextArea
            label="History so far"
            value={draft.rollingSummary}
            onChange={(rollingSummary) => patch({ rollingSummary })}
            large
            hint="The compacted record of everything before the recent window."
          />
          <TextArea
            label="Key events"
            value={draft.importantEvents.join('\n')}
            onChange={(value) =>
              patch({ importantEvents: value.split('\n').map((s) => s.trim()).filter(Boolean) })
            }
            hint="One per line. These are never dropped."
          />
          <TextArea
            label="Relationship state"
            value={draft.relationshipState}
            onChange={(relationshipState) => patch({ relationshipState })}
            hint="How the cast stands with each other right now."
          />

          <div className="field">
            <span className="field-label">Character state</span>
            <div className="field-hint" style={{ marginBottom: 8 }}>
              Each character's current condition, location and immediate goal.
            </div>
            <div className="stack">
              {gen.characters.map((character) => (
                <div key={character.id}>
                  <label className="small muted" htmlFor={`cs-${character.id}`}>
                    {character.displayName || character.name}
                  </label>
                  <textarea
                    id={`cs-${character.id}`}
                    className="textarea"
                    style={{ minHeight: 52 }}
                    value={draft.characterState[character.id] ?? ''}
                    onChange={(e) =>
                      patch({
                        characterState: { ...draft.characterState, [character.id]: e.target.value },
                      })
                    }
                  />
                </div>
              ))}
              {!gen.characters.length && (
                <p className="small muted">No characters in this story yet.</p>
              )}
            </div>
          </div>

          <Toggle
            label="Lock this summary"
            description="Stops automatic regeneration overwriting your edits."
            checked={draft.locked}
            onChange={(locked) => patch({ locked })}
          />

          {draft.lastGeneratedAt > 0 && (
            <p className="small muted">Last generated {relativeTime(draft.lastGeneratedAt)}.</p>
          )}
        </>
      )}
    </Sheet>
  );
}
