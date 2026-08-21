/** Split a comma / newline separated field into a clean list. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinList(list: string[] | undefined): string {
  return (list ?? []).join(', ');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relativeTime(ts: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ts);
}

/** Filename-safe slug for exports. */
export function slugify(text: string, fallback = 'untitled'): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60);
  return slug || fallback;
}

/** First non-empty string from a list of candidates. */
export function firstOf(...values: Array<unknown>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Coerce loosely-typed imported data into a string list. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter(Boolean);
  }
  if (typeof value === 'string') return splitList(value);
  return [];
}

/** Coerce loosely-typed imported data into a plain string. */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    // Some formats nest {value: "..."} or {content: "..."}.
    const obj = value as Record<string, unknown>;
    for (const key of ['value', 'content', 'text', 'description']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    return '';
  }
  return '';
}

export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1|on)$/i.test(value.trim())) return true;
    if (/^(false|no|0|off)$/i.test(value.trim())) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

export function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}
