/**
 * The sampling knobs, shared by the story editor and the in-chat tuning sheet.
 *
 * Every row starts as "inherited" and only becomes an override once you ask for
 * one, so an untouched story or chat keeps following the provider defaults
 * instead of silently pinning whatever the slider happened to show.
 */
import type { ReactNode } from 'react';
import type { GenerationSettings } from '../../types';
import { NumberField, SliderField, Toggle } from './Field';

export function GenerationOverrides({
  value,
  onChange,
}: {
  value: Partial<GenerationSettings>;
  onChange: (value: Partial<GenerationSettings>) => void;
}) {
  const set = <K extends keyof GenerationSettings>(
    key: K,
    next: GenerationSettings[K] | undefined,
  ) => {
    const copy = { ...value };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };

  const row = (
    key: keyof GenerationSettings,
    label: string,
    control: ReactNode,
  ) => (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row row-between">
        <strong className="small">{label}</strong>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => set(key, value[key] === undefined ? (defaultFor(key) as never) : undefined)}
        >
          {value[key] === undefined ? 'Override' : 'Use default'}
        </button>
      </div>
      {value[key] !== undefined && <div style={{ marginTop: 8 }}>{control}</div>}
    </div>
  );

  return (
    <>
      {row(
        'temperature',
        'Temperature',
        <SliderField
          label="Temperature"
          value={value.temperature ?? 0.9}
          onChange={(v) => set('temperature', v)}
          min={0}
          max={2}
          step={0.05}
          format={(v) => v.toFixed(2)}
        />,
      )}
      {row(
        'maxTokens',
        'Max response tokens',
        <NumberField
          label="Max tokens"
          value={value.maxTokens ?? 900}
          onChange={(v) => set('maxTokens', Math.max(16, Math.round(v)))}
          min={16}
          max={32000}
        />,
      )}
      {row(
        'topP',
        'Top P',
        <SliderField
          label="Top P"
          value={value.topP ?? 1}
          onChange={(v) => set('topP', v)}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
        />,
      )}
      {row(
        'contextSize',
        'Context size',
        <NumberField
          label="Context size (tokens)"
          value={value.contextSize ?? 8192}
          onChange={(v) => set('contextSize', Math.max(512, Math.round(v)))}
          min={512}
          max={1000000}
        />,
      )}
      {row(
        'streaming',
        'Streaming',
        <Toggle
          label="Stream the response"
          checked={value.streaming ?? true}
          onChange={(v) => set('streaming', v)}
        />,
      )}
    </>
  );
}

function defaultFor(key: keyof GenerationSettings) {
  const defaults = {
    temperature: 0.9,
    maxTokens: 900,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    streaming: true,
    contextSize: 8192,
  };
  return defaults[key];
}
