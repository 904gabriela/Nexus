/**
 * Tuning the AI without leaving the conversation.
 *
 * Two things live here because they answer the same question — "how should it
 * reply?" — and both used to require closing the chat and opening the story
 * editor. Direction is plain language ("shorter replies") and goes into the
 * prompt; the sliders are the sampling knobs and go into the request body.
 *
 * Both are scoped to this chat, so tuning one conversation never changes
 * another chat in the same story.
 */
import { useEffect, useState } from 'react';
import type { Chat, GenerationSettings, Provider, Story } from '../../types';
import { Sheet } from '../ui/Sheet';
import { TextArea } from '../ui/Field';
import { Banner } from '../ui/common';
import { Icon } from '../ui/Icon';
import { GenerationOverrides } from '../ui/GenerationOverrides';

/**
 * One-tap nudges. Each is a whole sentence, so what the chip inserts is
 * exactly what the model is told — the box below always shows the truth.
 */
const PRESETS: { id: string; label: string; text: string }[] = [
  { id: 'shorter', label: 'Shorter replies', text: 'Keep replies short — a paragraph at most.' },
  { id: 'longer', label: 'Longer replies', text: 'Write longer, fuller replies with more detail.' },
  { id: 'dialogue', label: 'More dialogue', text: 'Favour spoken dialogue over narration.' },
  { id: 'description', label: 'More description', text: 'Describe the scene, senses and body language richly.' },
  { id: 'slower', label: 'Slower pace', text: 'Move the scene slowly; let moments breathe.' },
  { id: 'faster', label: 'Move things along', text: 'Advance the plot; do not linger on the current moment.' },
  { id: 'norepeat', label: 'Less repetition', text: 'Do not repeat phrasing or restate what already happened.' },
  { id: 'nospeak', label: "Don't speak for me", text: 'Never write my character\'s words, thoughts or actions.' },
  { id: 'darker', label: 'Darker tone', text: 'Keep the tone dark and serious.' },
  { id: 'lighter', label: 'Lighter tone', text: 'Keep the tone light, warm and a little humorous.' },
];

export function ResponseSettingsSheet({
  open,
  onClose,
  chat,
  story,
  provider,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  chat: Chat;
  story: Story | null;
  provider: Provider | null;
  onSave: (patch: Partial<Chat>) => void | Promise<unknown>;
}) {
  const [direction, setDirection] = useState(chat.direction ?? '');
  const [settings, setSettings] = useState<Partial<GenerationSettings>>(chat.settings ?? {});

  // Reopening must show what is actually stored, not a stale draft from the
  // last time the sheet was open.
  useEffect(() => {
    if (!open) return;
    setDirection(chat.direction ?? '');
    setSettings(chat.settings ?? {});
  }, [open, chat.direction, chat.settings]);

  const lines = direction.split('\n').map((l) => l.trim()).filter(Boolean);
  const isOn = (text: string) => lines.includes(text);

  const togglePreset = (text: string) => {
    setDirection(
      isOn(text)
        ? lines.filter((l) => l !== text).join('\n')
        : [...lines, text].join('\n'),
    );
  };

  const save = async () => {
    await onSave({ direction, settings });
    onClose();
  };

  // Which knobs are inherited rather than set here, so the sheet can say where
  // the current numbers actually come from.
  const inheritedFrom = (key: keyof GenerationSettings) => {
    if (settings[key] !== undefined) return 'this chat';
    if (story?.settings?.[key] !== undefined) return 'the story';
    return provider ? provider.name : 'the defaults';
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Response settings"
      large
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            <Icon name="save" />
            Apply
          </button>
        </>
      }
    >
      <Banner kind="info" title="This chat only">
        Everything here applies to this conversation and takes effect on the next reply. Other chats
        in the same story are untouched.
      </Banner>

      <h3 className="section-title">Direction</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Tell it how to write. Tap a nudge or write your own — this goes into the prompt as-is.
      </p>

      <div className="chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`btn btn-sm ${isOn(preset.text) ? 'btn-primary' : ''}`}
            aria-pressed={isOn(preset.text)}
            onClick={() => togglePreset(preset.text)}
          >
            {isOn(preset.text) && <Icon name="check" />}
            {preset.label}
          </button>
        ))}
      </div>

      <TextArea
        label="Direction sent to the AI"
        value={direction}
        onChange={setDirection}
        large
        hint={
          direction.trim()
            ? 'Edit freely — the nudges above just add and remove lines here.'
            : 'Empty means no extra direction; the story and characters speak for themselves.'
        }
      />

      {direction.trim() !== (chat.direction ?? '').trim() && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          Not applied yet — tap Apply.
        </p>
      )}

      <hr className="divider" />

      <h3 className="section-title">Sampling</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Temperature is currently coming from {inheritedFrom('temperature')}. Override anything here
        to pin it for this chat.
      </p>
      <GenerationOverrides value={settings} onChange={setSettings} />
    </Sheet>
  );
}
