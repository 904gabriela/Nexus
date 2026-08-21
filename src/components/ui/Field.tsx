import { useId, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

interface BaseProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  id?: string;
}

export function TextField({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete = 'off',
  inputMode,
  disabled,
  id,
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'url' | 'email';
  disabled?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <input
        id={fieldId}
        className="input"
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        disabled={disabled}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && !error && (
        <div className="field-hint" id={`${fieldId}-hint`}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={`${fieldId}-error`} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  placeholder,
  rows,
  large,
  id,
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  large?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <textarea
        id={fieldId}
        className={`textarea${large ? ' textarea-lg' : ''}`}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && !error && (
        <div className="field-hint" id={`${fieldId}-hint`}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={`${fieldId}-error`} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  id,
  disabled,
}: BaseProps & {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        {label}
      </label>
      <select
        id={fieldId}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <label className="switch-label" htmlFor={id} style={{ flex: 1, cursor: 'pointer' }}>
        {label}
        {description && <span className="switch-desc">{description}</span>}
      </label>
      <button
        type="button"
        id={id}
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  id,
}: BaseProps & {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label className="field-label" htmlFor={fieldId}>
        {label}
      </label>
      <input
        id={fieldId}
        className="input"
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const next = Number.parseFloat(e.target.value);
          onChange(Number.isFinite(next) ? next : (min ?? 0));
        }}
      />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
  hint,
}: BaseProps & {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        />
        <span className="range-value">{format ? format(value) : value}</span>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** Chip-style list editor used for tags, keywords, aliases and traits. */
export function TagField({
  label,
  hint,
  values,
  onChange,
  placeholder = 'Type and press Enter',
}: BaseProps & {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const part of parts) {
      if (!next.some((v) => v.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    onChange(next);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div
        className="tag-input-shell"
        onClick={() => inputRef.current?.focus()}
        role="presentation"
      >
        {values.map((tag) => (
          <span className="chip chip-accent" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((v) => v !== tag));
              }}
            >
              <Icon name="x" width={12} height={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          autoComplete="off"
        />
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">{legend}</h3>
      {children}
    </section>
  );
}
