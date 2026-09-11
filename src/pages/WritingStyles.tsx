/**
 * Writing styles.
 *
 * A style is one or two sentences telling the narrator how to write. They have
 * always been data — combinable, set per story or per chat — but until now
 * the text was fixed in code and the only way to change it was to know where
 * it lived. This is where a person reads what a style actually says, changes
 * it, keeps their own, and names the combinations they reach for.
 *
 * The rule the whole page keeps: a style shapes the telling and nothing else.
 * It is never a length, never a temperature. A saved combination may carry
 * reply settings, because that is a person describing one story's whole feel;
 * a style may not, because "Detailed" quietly making replies longer would be
 * a setting hiding inside a word.
 */
import { useMemo, useState } from 'react';
import type { ID, NarrationPreset, StyleCombination } from '../types';
import { useActions, useAppState } from '../state/store';
import { Banner } from '../components/ui/common';
import { NumberField, TextArea, TextField, Toggle } from '../components/ui/Field';
import { Icon } from '../components/ui/Icon';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import {
  availablePresets,
  builtInPreset,
  duplicatePreset,
  isBuiltInPreset,
  newCombination,
  newPreset,
} from '../narration/presets';

export function WritingStylesPage() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();

  const stored = state.settings.narrationPresets ?? [];
  const combinations = state.settings.styleCombinations ?? [];
  const presets = useMemo(() => availablePresets(stored), [stored]);

  /* ------------------------------------------------------------ styles */

  const savePreset = (preset: NarrationPreset) =>
    actions.saveSettings({
      narrationPresets: [...stored.filter((p) => p.id !== preset.id), preset],
    });

  /** A built-in goes back to its shipped text; a custom one is removed. */
  const removeStored = (id: ID) =>
    actions.saveSettings({ narrationPresets: stored.filter((p) => p.id !== id) });

  const createPreset = () => savePreset(newPreset());

  const duplicate = (preset: NarrationPreset) => savePreset(duplicatePreset(preset));

  const deletePreset = async (preset: NarrationPreset) => {
    const ok = await confirm(deleteConfirm('style', preset.name));
    if (!ok) return;
    await removeStored(preset.id);
    // A combination that named it should not keep pointing at nothing.
    const cleaned = combinations
      .map((c) => ({ ...c, presetIds: c.presetIds.filter((id) => id !== preset.id) }));
    if (JSON.stringify(cleaned) !== JSON.stringify(combinations)) {
      await actions.saveSettings({ styleCombinations: cleaned });
    }
  };

  /* ------------------------------------------------------ combinations */

  const saveCombination = (combination: StyleCombination) =>
    actions.saveSettings({
      styleCombinations: [
        ...combinations.filter((c) => c.id !== combination.id),
        combination,
      ],
    });

  const deleteCombination = async (combination: StyleCombination) => {
    const ok = await confirm(deleteConfirm('combination', combination.name));
    if (!ok) return;
    await actions.saveSettings({
      styleCombinations: combinations.filter((c) => c.id !== combination.id),
    });
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Writing styles</h1>
          <p className="small muted">How the narrator writes, in your words.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={createPreset}>
          <Icon name="plus" />
          New style
        </button>
      </header>

      <div className="page">
        <Banner kind="info" title="A style shapes the telling, nothing else">
          It never changes who is present, what has happened, or how long a reply is. Styles
          combine — Slow Burn and Detailed together is a normal choice — so each one is one
          or two sentences, and you can rewrite any of them.
        </Banner>

        <h3 className="section-title">Styles</h3>
        <div className="list">
          {presets.map((preset) => (
            <StyleCard
              key={preset.id}
              preset={preset}
              edited={isBuiltInPreset(preset.id) && stored.some((p) => p.id === preset.id)}
              onSave={savePreset}
              onDuplicate={() => duplicate(preset)}
              onReset={() => removeStored(preset.id)}
              onDelete={() => deletePreset(preset)}
            />
          ))}
        </div>

        <hr className="divider" />

        <div className="row row-between row-wrap" style={{ marginBottom: 8 }}>
          <div>
            <h3 className="section-title" style={{ margin: 0 }}>
              Saved combinations
            </h3>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              A named set of styles, applied to a chat in one tap from Chat settings. It can
              carry reply settings too, for a story with a feel of its own.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => saveCombination(newCombination())}
          >
            <Icon name="plus" />
            New combination
          </button>
        </div>

        {!combinations.length ? (
          <p className="small muted">
            None yet. Pick styles in a chat and choose “Save this combination”, or start one
            here.
          </p>
        ) : (
          <div className="list">
            {[...combinations]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((combination) => (
                <CombinationCard
                  key={combination.id}
                  combination={combination}
                  presets={presets}
                  onSave={saveCombination}
                  onDelete={() => deleteCombination(combination)}
                />
              ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- one style */

function StyleCard({
  preset,
  edited,
  onSave,
  onDuplicate,
  onReset,
  onDelete,
}: {
  preset: NarrationPreset;
  /** A built-in whose text has been changed. */
  edited: boolean;
  onSave: (preset: NarrationPreset) => void | Promise<unknown>;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(preset);
  const [open, setOpen] = useState(!preset.builtIn && !preset.instruction.trim());
  // Something saved elsewhere (a reset, an edit on another device) wins over
  // a stale draft, but never over one the person is typing into.
  const dirty =
    draft.name !== preset.name ||
    draft.description !== preset.description ||
    draft.instruction !== preset.instruction;
  const shown = dirty ? draft : preset;
  const original = preset.builtIn ? builtInPreset(preset.id) : null;

  const patch = (changes: Partial<NarrationPreset>) =>
    setDraft((current) => ({ ...(dirty ? current : preset), ...changes }));

  return (
    <div className="card" data-testid="style-card" data-preset-id={preset.id}>
      <button
        type="button"
        className="row row-between row-wrap"
        style={{ width: '100%', background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${preset.name}`}
      >
        <span>
          <strong>{shown.name || 'Untitled style'}</strong>
          {shown.description && <span className="muted"> — {shown.description}</span>}
        </span>
        <span className="row" style={{ gap: 4 }}>
          {preset.builtIn ? (
            <span className="chip">{edited ? 'Built-in, edited' : 'Built-in'}</span>
          ) : (
            <span className="chip chip-accent">Yours</span>
          )}
          <Icon name={open ? 'x' : 'edit'} />
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <TextField label="Name" value={shown.name} onChange={(name) => patch({ name })} />
          <TextField
            label="Description"
            value={shown.description}
            onChange={(description) => patch({ description })}
            hint="Shown in the picker. Never sent to the model."
          />
          <TextArea
            label="Instruction"
            value={shown.instruction}
            onChange={(instruction) => patch({ instruction })}
            rows={3}
            hint={
              original && original.instruction !== shown.instruction
                ? `Shipped text: ${original.instruction}`
                : 'One or two sentences, written as guidance to the narrator. Sent with every reply while the style is on.'
            }
          />
          <div className="row row-wrap" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!dirty}
              onClick={() => onSave({ ...draft, builtIn: preset.builtIn })}
            >
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={onDuplicate}>
              Duplicate
            </button>
            {preset.builtIn ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={!edited}
                onClick={() => {
                  setDraft(original ?? preset);
                  onReset();
                }}
              >
                Reset to built-in
              </button>
            ) : (
              <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------- one combination */

function CombinationCard({
  combination,
  presets,
  onSave,
  onDelete,
}: {
  combination: StyleCombination;
  presets: NarrationPreset[];
  onSave: (combination: StyleCombination) => void | Promise<unknown>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(combination);
  const dirty = JSON.stringify(draft) !== JSON.stringify(combination);
  const shown = dirty ? draft : combination;
  const withSettings = shown.temperature != null || shown.maxTokens != null;

  const patch = (changes: Partial<StyleCombination>) =>
    setDraft((current) => ({ ...(dirty ? current : combination), ...changes }));

  const toggle = (id: ID) =>
    patch({
      presetIds: shown.presetIds.includes(id)
        ? shown.presetIds.filter((p) => p !== id)
        : [...shown.presetIds, id],
    });

  return (
    <div className="card" data-testid="combination-card" data-combination-id={combination.id}>
      <TextField label="Name" value={shown.name} onChange={(name) => patch({ name })} />
      <div className="field">
        <span className="field-label">Styles</span>
        <div className="chip-row">
          {presets
            .filter((p) => p.instruction.trim())
            .map((preset) => {
              const on = shown.presetIds.includes(preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`chip chip-tap ${on ? 'chip-accent' : ''}`}
                  aria-pressed={on}
                  title={preset.description}
                  onClick={() => toggle(preset.id)}
                >
                  {preset.name}
                </button>
              );
            })}
        </div>
      </div>
      <Toggle
        label="Set reply settings with it"
        description="Temperature and longest reply are applied to the chat along with the styles."
        checked={withSettings}
        onChange={(on) =>
          patch(on ? { temperature: 0.9, maxTokens: 900 } : { temperature: null, maxTokens: null })
        }
      />
      {withSettings && (
        <div className="row row-wrap" style={{ gap: 12 }}>
          <NumberField
            label="Temperature"
            value={shown.temperature ?? 0.9}
            onChange={(temperature) => patch({ temperature: Math.max(0, Math.min(2, temperature)) })}
            min={0}
            max={2}
            step={0.05}
          />
          <NumberField
            label="Longest reply (tokens)"
            value={shown.maxTokens ?? 900}
            onChange={(maxTokens) => patch({ maxTokens: Math.max(64, Math.round(maxTokens)) })}
            min={64}
            max={32000}
            step={64}
          />
        </div>
      )}
      <div className="row row-wrap" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!dirty}
          onClick={() => onSave(draft)}
        >
          Save
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
