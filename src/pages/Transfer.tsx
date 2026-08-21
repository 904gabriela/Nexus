import { useMemo, useRef, useState } from 'react';
import {
  IMPORT_KIND_LABELS,
  ImportError,
  TXT_TARGETS,
  buildFromText,
  commitImport,
  findConflicts,
  parseFile,
  readFile,
  type ConflictStrategy,
  type ImportKind,
  type ParsedImport,
} from '../importers/pipeline';
import {
  backupFilename,
  buildBackup,
  downloadFile,
  exportChat,
  exportCharacter,
  exportFilename,
  exportLoreEntries,
  exportMemories,
  exportPersona,
  exportStory,
} from '../exporters';
import { useActions, useAppState } from '../state/store';
import { Icon } from '../components/ui/Icon';
import { Banner, Tabs } from '../components/ui/common';
import { Sheet } from '../components/ui/Sheet';
import { SelectField, Toggle } from '../components/ui/Field';
import { useConfirm } from '../components/ui/Confirm';
import { formatBytes, truncate } from '../utils/text';

export function TransferPage() {
  const [tab, setTab] = useState<'import' | 'export' | 'backup'>('import');
  return (
    <>
      <div className="page-header">
        <h1>
          Import / Export
          <span className="subtitle">Move data in and out of Storyline</span>
        </h1>
      </div>
      <div className="page">
        <Tabs
          tabs={[
            { id: 'import', label: 'Import' },
            { id: 'export', label: 'Export' },
            { id: 'backup', label: 'Backup & Restore' },
          ]}
          active={tab}
          onChange={setTab}
          label="Transfer sections"
        />
        {tab === 'import' && <ImportCenter />}
        {tab === 'export' && <ExportCenter />}
        {tab === 'backup' && <BackupCenter />}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- import */

function ImportCenter() {
  const actions = useActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedImport[]>([]);
  const [errors, setErrors] = useState<Array<{ file: string; message: string; detail?: string }>>([]);
  const [active, setActive] = useState<ParsedImport | null>(null);

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (!list.length) return;
    setParsing(true);
    setErrors([]);
    const results: ParsedImport[] = [];
    const failures: typeof errors = [];
    for (const file of list) {
      try {
        const read = await readFile(file);
        const result = await parseFile(read);
        result.conflicts = await findConflicts(result);
        results.push(result);
      } catch (err) {
        failures.push({
          file: file.name,
          message: err instanceof ImportError ? err.message : (err as Error).message,
          detail: err instanceof ImportError ? err.detail : undefined,
        });
      }
    }
    setParsed((current) => [...current, ...results]);
    setErrors(failures);
    setParsing(false);
    if (fileInput.current) fileInput.current.value = '';
    if (results.length === 1 && !failures.length) setActive(results[0]);
  };

  return (
    <>
      <Banner kind="info" title="What can be imported">
        Character cards (JSON or PNG), personas, lorebooks and world-info files, stories, chat logs,
        memories, plain text files, and full Storyline backups. Every file is previewed before anything
        is written, and nothing is ever silently overwritten.
      </Banner>

      <div
        className={`drop-zone${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        {parsing ? (
          <>
            <span className="spinner" style={{ width: 28, height: 28 }} />
            <p style={{ marginTop: 10 }}>Reading files…</p>
          </>
        ) : (
          <>
            <Icon name="upload" />
            <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Choose files to import</p>
            <p className="small muted" style={{ margin: 0 }}>
              Tap to browse, or drop files here. JSON · TXT · PNG · JPG · WEBP
            </p>
          </>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".json,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/json,text/plain,image/*"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {!!errors.length && (
        <div style={{ marginTop: 14 }}>
          {errors.map((error) => (
            <Banner kind="error" title={`Could not read "${error.file}"`} key={error.file}>
              {error.message}
              {error.detail && (
                <>
                  {' '}
                  <span className="small muted">{error.detail}</span>
                </>
              )}
            </Banner>
          ))}
        </div>
      )}

      {!!parsed.length && (
        <>
          <h3 className="section-title" style={{ marginTop: 20 }}>
            Ready to import ({parsed.length})
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setParsed([])}
            >
              Clear all
            </button>
          </h3>
          <div className="list">
            {parsed.map((item) => (
              <div className="card card-button" key={item.id}>
                <button
                  type="button"
                  onClick={() => setActive(item)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 0,
                    color: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <div className="row row-wrap" style={{ gap: 6 }}>
                    <strong className="truncate">{item.title || 'Untitled'}</strong>
                    <span className="chip chip-accent">{IMPORT_KIND_LABELS[item.kind]}</span>
                    {!!item.conflicts.length && (
                      <span className="chip chip-warn">
                        {item.conflicts.length} conflict{item.conflicts.length === 1 ? '' : 's'}
                      </span>
                    )}
                    {item.issues.some((i) => i.level === 'error') && (
                      <span className="chip chip-danger">Has errors</span>
                    )}
                  </div>
                  <div className="small muted truncate">
                    {item.sourceName} · {item.sourceFormat}
                  </div>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove ${item.sourceName} from the import queue`}
                  onClick={() => setParsed((current) => current.filter((p) => p.id !== item.id))}
                >
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {active && (
        <ImportPreview
          parsed={active}
          onClose={() => setActive(null)}
          onReparse={async (kind) => {
            if (!active.rawText) return;
            const next = await buildFromText(active.rawText, active.sourceName, kind);
            next.id = active.id;
            next.conflicts = await findConflicts(next);
            setParsed((current) => current.map((p) => (p.id === active.id ? next : p)));
            setActive(next);
          }}
          onDone={(imported) => {
            setParsed((current) => current.filter((p) => p.id !== imported.id));
            setActive(null);
            void actions.reload();
          }}
        />
      )}
    </>
  );
}

function ImportPreview({
  parsed,
  onClose,
  onDone,
  onReparse,
}: {
  parsed: ParsedImport;
  onClose: () => void;
  onDone: (parsed: ParsedImport) => void;
  onReparse: (kind: ImportKind) => Promise<void>;
}) {
  const actions = useActions();
  const confirm = useConfirm();
  const [strategy, setStrategy] = useState<ConflictStrategy>('copy');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');

  const blocking = parsed.issues.filter((i) => i.level === 'error');
  const counts = useMemo(() => {
    const p = parsed.payload;
    return [
      ['Characters', p.characters?.length ?? 0],
      ['Personas', p.personas?.length ?? 0],
      ['Lorebooks', p.lorebooks?.length ?? 0],
      ['Lore entries', p.loreEntries?.length ?? 0],
      ['Stories', p.stories?.length ?? 0],
      ['Chats', p.chats?.length ?? 0],
      ['Messages', p.messages?.length ?? 0],
      ['Alternatives', p.alternatives?.length ?? 0],
      ['Branches', p.branches?.length ?? 0],
      ['Checkpoints', p.checkpoints?.length ?? 0],
      ['Memories', p.memories?.length ?? 0],
      ['Images', Object.keys(p.media ?? {}).length + (p.avatarDataUrl || p.avatarFile ? 1 : 0)],
      ['Providers', p.providers?.length ?? 0],
    ].filter(([, n]) => (n as number) > 0) as Array<[string, number]>;
  }, [parsed]);

  const run = async () => {
    if (parsed.kind === 'backup') {
      const ok = await confirm({
        title: 'Restore this backup?',
        message: (
          <>
            <p style={{ margin: 0 }}>
              {strategy === 'replace'
                ? 'Items with matching ids will be overwritten by the backup.'
                : strategy === 'merge'
                  ? 'Existing items are kept; blank fields are filled in from the backup.'
                  : 'Everything is imported as new copies; nothing existing is touched.'}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              API keys are never included in backups and will need re-entering.
            </p>
          </>
        ),
        confirmLabel: 'Restore',
      });
      if (!ok) return;
    }

    setImporting(true);
    setProgress('Starting…');
    try {
      const result = await commitImport(parsed, { strategy, onProgress: setProgress });
      const summary = Object.entries(result.counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${key}`)
        .join(', ');
      actions.toast({
        kind: 'success',
        title: `Imported ${parsed.title || parsed.sourceName}`,
        detail: summary || 'Nothing new to add.',
      });
      for (const warning of result.warnings) {
        actions.toast({ kind: 'warn', title: 'Import warning', detail: warning });
      }
      onDone(parsed);
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Import failed',
        detail: (err as Error).message,
      });
    } finally {
      setImporting(false);
      setProgress('');
    }
  };

  return (
    <Sheet
      open
      onClose={importing ? () => {} : onClose}
      title={`Import preview — ${IMPORT_KIND_LABELS[parsed.kind]}`}
      large
      hideClose={importing}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={run}
            disabled={importing || !!blocking.length}
          >
            {importing ? <span className="spinner" /> : <Icon name="check" />}
            {importing ? progress || 'Importing…' : 'Confirm import'}
          </button>
        </>
      }
    >
      {parsed.needsKindChoice && (
        <div className="card" style={{ marginBottom: 14 }}>
          <strong>What should this file become?</strong>
          <p className="small muted" style={{ marginTop: 4 }}>
            Plain text has no structure, so choose the type — the preview updates immediately.
          </p>
          <div className="chip-row" style={{ marginTop: 8 }}>
            {TXT_TARGETS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`chip ${parsed.kind === kind ? 'chip-accent' : ''}`}
                style={{ cursor: 'pointer', minHeight: 36 }}
                aria-pressed={parsed.kind === kind}
                onClick={() => void onReparse(kind)}
              >
                {IMPORT_KIND_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row row-between row-wrap">
          <strong className="truncate">{parsed.title || 'Untitled'}</strong>
          <span className="chip">{parsed.sourceFormat}</span>
        </div>
        <div className="small muted" style={{ marginTop: 3 }}>
          Source: {parsed.sourceName}
        </div>
        {!!counts.length && (
          <div className="chip-row" style={{ marginTop: 8 }}>
            {counts.map(([label, n]) => (
              <span className="chip" key={label}>
                {n} {label.toLowerCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {parsed.issues.map((issue, i) => (
        <Banner
          key={i}
          kind={issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warn' : 'info'}
        >
          {issue.message}
        </Banner>
      ))}

      <h3 className="section-title">Preview</h3>
      <ul className="preview-list">
        {parsed.summary.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      {parsed.rawText && (
        <details style={{ marginTop: 10 }}>
          <summary className="small muted" style={{ cursor: 'pointer', minHeight: 34 }}>
            Show the raw file content
          </summary>
          <pre className="ctx-part-body mono" style={{ marginTop: 8, borderRadius: 8, maxHeight: 240 }}>
            {truncate(parsed.rawText, 4000)}
          </pre>
        </details>
      )}

      {!!parsed.conflicts.length && (
        <>
          <h3 className="section-title" style={{ marginTop: 18 }}>
            Conflicts ({parsed.conflicts.length})
          </h3>
          <Banner kind="warn" title="Some items already exist">
            Choose what should happen. Nothing is overwritten unless you pick Replace.
          </Banner>
          <div className="list" style={{ marginBottom: 12 }}>
            {parsed.conflicts.slice(0, 12).map((conflict, i) => (
              <div className="card" key={`${conflict.existingId}-${i}`}>
                <div className="small">
                  <strong>{conflict.incomingName || 'Untitled'}</strong> ({IMPORT_KIND_LABELS[conflict.kind]})
                  {' — '}
                  {conflict.reason === 'same-id'
                    ? 'the same item already exists'
                    : `an item named "${conflict.existingName}" already exists`}
                </div>
              </div>
            ))}
            {parsed.conflicts.length > 12 && (
              <p className="small muted">…and {parsed.conflicts.length - 12} more.</p>
            )}
          </div>
        </>
      )}

      <SelectField
        label="If something already exists"
        value={strategy}
        onChange={setStrategy}
        options={[
          { value: 'copy', label: 'Create a copy (safest — nothing existing is changed)' },
          { value: 'replace', label: 'Replace the existing item' },
          { value: 'merge', label: 'Merge — keep existing values, fill in blanks' },
        ]}
        hint={
          strategy === 'replace'
            ? 'Existing data with the same id or name will be overwritten permanently.'
            : strategy === 'merge'
              ? 'Existing values win; only empty fields and missing list items are added.'
              : 'Everything is imported under fresh ids. Your current library is untouched.'
        }
      />
    </Sheet>
  );
}

/* -------------------------------------------------------------- export */

function ExportCenter() {
  const state = useAppState();
  const actions = useActions();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      actions.toast({ kind: 'error', title: 'Export failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const section = <T extends { id: string }>(
    title: string,
    items: T[],
    nameOf: (item: T) => string,
    exporter: (item: T) => Promise<string>,
    kind: Parameters<typeof exportFilename>[0],
  ) => (
    <section className="section" data-testid={`export-section-${kind}`}>
      <h3 className="section-title">
        {title}
        <span className="chip">{items.length}</span>
      </h3>
      {!items.length ? (
        <p className="small muted">Nothing to export yet.</p>
      ) : (
        <div className="list">
          {items.map((item) => (
            <div className="card card-button" key={item.id} data-testid={`export-row-${kind}`}>
              <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                {nameOf(item) || 'Untitled'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`Export ${kind}: ${nameOf(item) || 'Untitled'}`}
                disabled={busy === item.id}
                onClick={() =>
                  run(item.id, async () => {
                    downloadFile(exportFilename(kind, nameOf(item)), await exporter(item));
                    actions.toast({ kind: 'success', title: `Exported ${nameOf(item)}` });
                  })
                }
              >
                {busy === item.id ? <span className="spinner" /> : <Icon name="download" />}
                Export
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <>
      <Banner kind="info" title="Human-readable JSON">
        Exports are plain, indented JSON you can read and edit. API keys are never included.
      </Banner>

      {section(
        'Characters',
        state.characters,
        (c) => c.name,
        (c) => exportCharacter(c, { includeAvatar: true, includeLorebooks: true }),
        'character',
      )}
      {section('Personas', state.personas, (p) => p.name, (p) => exportPersona(p), 'persona')}
      {section(
        'Lorebooks',
        state.lorebooks,
        (b) => b.name,
        async (b) =>
          exportLoreEntries(b, state.loreEntries.filter((e) => e.lorebookId === b.id)),
        'lorebook',
      )}
      {section(
        'Stories',
        state.stories,
        (s) => s.title,
        (s) => exportStory(s.id, { includeChats: true, includeMedia: true }),
        'story',
      )}
      {section('Chats', state.chats, (c) => c.title, (c) => exportChat(c.id, true), 'chat')}

      <section className="section">
        <h3 className="section-title">
          Memories
          <span className="chip">{state.memories.length}</span>
        </h3>
        <button
          type="button"
          className="btn btn-block"
          disabled={!state.memories.length}
          onClick={() => {
            downloadFile('memories.json', exportMemories(state.memories));
            actions.toast({ kind: 'success', title: 'Memories exported' });
          }}
        >
          <Icon name="download" />
          Export all {state.memories.length} memories
        </button>
      </section>
    </>
  );
}

/* -------------------------------------------------------------- backup */

function BackupCenter() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const [includeMedia, setIncludeMedia] = useState(true);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState('');
  const [restore, setRestore] = useState<ParsedImport | null>(null);
  const [wipeFirst, setWipeFirst] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const mediaBytes = state.media.reduce((sum, m) => sum + m.size, 0);

  const build = async () => {
    setBuilding(true);
    try {
      const json = await buildBackup({ includeMedia, onProgress: setProgress });
      downloadFile(backupFilename(), json);
      actions.toast({
        kind: 'success',
        title: 'Backup downloaded',
        detail: includeMedia
          ? 'Images are bundled inside the file.'
          : 'Images were not bundled — export them separately from the Media library if you need them.',
      });
    } catch (err) {
      actions.toast({ kind: 'error', title: 'Backup failed', detail: (err as Error).message });
    } finally {
      setBuilding(false);
      setProgress('');
    }
  };

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const parsed = await parseFile(await readFile(file));
      if (parsed.kind !== 'backup') {
        actions.toast({
          kind: 'error',
          title: 'Not a backup file',
          detail: `"${file.name}" looks like a ${IMPORT_KIND_LABELS[parsed.kind].toLowerCase()}. Use the Import tab for that.`,
        });
        return;
      }
      parsed.conflicts = await findConflicts(parsed);
      setRestore(parsed);
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Could not read the backup',
        detail: err instanceof ImportError ? err.message : (err as Error).message,
      });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const runRestore = async () => {
    if (!restore) return;
    if (wipeFirst) {
      const ok = await confirm({
        title: 'Erase everything and restore?',
        message: (
          <Banner kind="error" title="This deletes your current library">
            Every character, persona, story, chat, lorebook, memory and image on this device will be
            removed before the backup is restored. This cannot be undone.
          </Banner>
        ),
        confirmLabel: 'Erase and restore',
        destructive: true,
        typeToConfirm: 'ERASE',
      });
      if (!ok) return;
    }
    setRestoring(true);
    setProgress('Restoring…');
    try {
      const result = await commitImport(restore, {
        strategy: wipeFirst ? 'replace' : 'replace',
        wipeFirst,
        onProgress: setProgress,
      });
      await actions.reload();
      actions.toast({
        kind: 'success',
        title: 'Backup restored',
        detail: Object.entries(result.counts)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k}`)
          .join(', '),
      });
      setRestore(null);
    } catch (err) {
      actions.toast({ kind: 'error', title: 'Restore failed', detail: (err as Error).message });
    } finally {
      setRestoring(false);
      setProgress('');
    }
  };

  return (
    <>
      <section className="section">
        <h3 className="section-title">Back up everything</h3>
        <div className="card">
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            {[
              ['Characters', state.characters.length],
              ['Personas', state.personas.length],
              ['Stories', state.stories.length],
              ['Chats', state.chats.length],
              ['Lorebooks', state.lorebooks.length],
              ['Entries', state.loreEntries.length],
              ['Memories', state.memories.length],
              ['Images', state.media.length],
            ].map(([label, value]) => (
              <div className="stat" key={label as string} style={{ cursor: 'default' }}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <Toggle
            label="Include images in the backup file"
            description={`Bundles ${state.media.length} image(s), roughly ${formatBytes(
              Math.round(mediaBytes * 1.37),
            )} once encoded. Turn this off for a much smaller, text-only backup.`}
            checked={includeMedia}
            onChange={setIncludeMedia}
          />

          <Banner kind="warn" title="API keys are not included">
            Backups deliberately omit provider API keys. After restoring, re-enter them in Settings.
          </Banner>

          <button type="button" className="btn btn-primary btn-block" onClick={build} disabled={building}>
            {building ? <span className="spinner" /> : <Icon name="download" />}
            {building ? progress || 'Building backup…' : 'Download full backup'}
          </button>
        </div>
      </section>

      <section className="section">
        <h3 className="section-title">Restore from a backup</h3>
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>
            Select a backup file. You will see exactly what it contains and can choose how conflicts
            are handled before anything is written.
          </p>
          <button type="button" className="btn btn-block" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" />
            Choose backup file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => void pick(e.target.files)}
          />
        </div>
      </section>

      {restore && (
        <Sheet
          open
          onClose={restoring ? () => {} : () => setRestore(null)}
          title="Restore backup"
          large
          hideClose={restoring}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRestore(null)} disabled={restoring}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${wipeFirst ? 'btn-danger' : 'btn-primary'}`}
                onClick={runRestore}
                disabled={restoring}
              >
                {restoring ? <span className="spinner" /> : <Icon name="refresh" />}
                {restoring ? progress || 'Restoring…' : wipeFirst ? 'Erase and restore' : 'Restore'}
              </button>
            </>
          }
        >
          <h3 className="section-title">This backup contains</h3>
          <ul className="preview-list">
            {restore.summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>

          {restore.issues.map((issue, i) => (
            <Banner
              key={i}
              kind={issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warn' : 'info'}
            >
              {issue.message}
            </Banner>
          ))}

          <hr className="divider" />

          <Toggle
            label="Erase the current library first"
            description="Off (recommended): the backup is merged in, overwriting items with the same id. On: everything currently on this device is deleted first, giving an exact restore."
            checked={wipeFirst}
            onChange={setWipeFirst}
          />

          {wipeFirst && (
            <Banner kind="error" title="Destructive">
              Your current {state.characters.length} character(s), {state.stories.length} story/ies,{' '}
              {state.chats.length} chat(s) and {state.media.length} image(s) will be permanently
              deleted before the restore.
            </Banner>
          )}
        </Sheet>
      )}
    </>
  );
}
