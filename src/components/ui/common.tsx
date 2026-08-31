import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { CustomField } from '../../types';
import { uid } from '../../utils/uid';

export function EmptyState({
  icon = 'info',
  title,
  message,
  action,
}: {
  icon?: string;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} />
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}

export function Banner({
  kind = 'info',
  title,
  children,
  action,
}: {
  kind?: 'info' | 'warn' | 'error' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon = kind === 'warn' || kind === 'error' ? 'warn' : kind === 'success' ? 'check' : 'info';
  const color =
    kind === 'warn'
      ? 'var(--warn)'
      : kind === 'error'
        ? 'var(--danger)'
        : kind === 'success'
          ? 'var(--success)'
          : 'var(--info)';
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon name={icon} style={{ color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
        {action && <div style={{ marginTop: 10 }}>{action}</div>}
      </div>
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <Icon
        name="search"
        style={{
          position: 'absolute',
          left: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 17,
          height: 17,
          color: 'var(--text-faint)',
          pointerEvents: 'none',
        }}
      />
      <input
        className="input"
        style={{ paddingLeft: 38, paddingRight: value ? 42 : 12 }}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          style={{ position: 'absolute', right: 2, top: 1, minHeight: 40, minWidth: 40 }}
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="chip chip-accent" style={{ marginLeft: 6, padding: '1px 7px' }}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function CustomFieldsEditor({
  values,
  onChange,
  hint,
}: {
  values: CustomField[];
  onChange: (values: CustomField[]) => void;
  hint?: string;
}) {
  const update = (id: string, patch: Partial<CustomField>) =>
    onChange(values.map((field) => (field.id === id ? { ...field, ...patch } : field)));

  return (
    <div className="field">
      <span className="field-label">Custom fields</span>
      {hint && <div className="field-hint" style={{ marginBottom: 8 }}>{hint}</div>}
      <div className="stack">
        {values.map((field) => (
          <div className="row" key={field.id} style={{ alignItems: 'flex-start' }}>
            <input
              className="input"
              style={{ flex: '0 0 34%' }}
              value={field.key}
              placeholder="Field name"
              aria-label="Custom field name"
              onChange={(e) => update(field.id, { key: e.target.value })}
            />
            <textarea
              className="textarea"
              style={{ flex: 1, minHeight: 44 }}
              rows={1}
              value={field.value}
              placeholder="Value"
              aria-label={`Value for ${field.key || 'custom field'}`}
              onChange={(e) => update(field.id, { value: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Remove ${field.key || 'custom field'}`}
              onClick={() => onChange(values.filter((f) => f.id !== field.id))}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        style={{ marginTop: 8 }}
        onClick={() => onChange([...values, { id: uid(), key: '', value: '' }])}
      >
        <Icon name="plus" />
        Add custom field
      </button>
    </div>
  );
}

/** Highlights query matches without ever injecting HTML. */
/**
 * A collapsed section.
 *
 * Editors that carry thirty fields do not need thirty fields on screen. Native
 * `<details>` keeps this keyboard-accessible and findable by the browser's own
 * find-in-page (which expands it) without a line of state.
 */
export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>
        <span className="disclosure-title">{title}</span>
        {hint && <span className="disclosure-hint">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(target);
  let key = 0;
  while (index !== -1 && parts.length < 40) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={key++}>{text.slice(index, index + target.length)}</mark>);
    cursor = index + target.length;
    index = lower.indexOf(target, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Long-press + click handler for touch-first context menus. */
export function useLongPress(onLongPress: () => void, delay = 480) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return {
    fired,
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        // Ignore right-click and multi-touch.
        if (event.button && event.button !== 0) return;
        fired.current = false;
        start.current = { x: event.clientX, y: event.clientY };
        clear();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          onLongPress();
        }, delay);
      },
      onPointerMove: (event: React.PointerEvent) => {
        if (!start.current || !timer.current) return;
        const dx = Math.abs(event.clientX - start.current.x);
        const dy = Math.abs(event.clientY - start.current.y);
        // A scroll gesture must not become a long press.
        if (dx > 10 || dy > 10) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        fired.current = true;
        onLongPress();
      },
    },
  };
}

/** Textarea that grows with its content, capped by CSS max-height. */
export function useAutoResize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [value]);
  return ref;
}

export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn-sm',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        setCopied(ok);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Clipboard with a legacy fallback for browsers without the async API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" />
      <span>{label ?? 'Loading…'}</span>
    </div>
  );
}
