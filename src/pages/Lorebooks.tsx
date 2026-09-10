import { useMemo, useRef, useState } from 'react';
import type { LoreEntry, Lorebook } from '../types';
import { newLoreEntry, newLorebook } from '../types/factories';
import { useActions, useAppState } from '../state/store';
import { Icon } from '../components/ui/Icon';
import {
  Banner,
  CustomFieldsEditor,
  EmptyState,
  SearchInput,
  Tabs,
} from '../components/ui/common';
import {
  NumberField,
  SelectField,
  TagField,
  TextArea,
  TextField,
  Toggle,
} from '../components/ui/Field';
import { ActionSheet, Sheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { downloadFile, exportFilename, exportLoreEntries, exportLoreEntry } from '../exporters';
import { relativeTime, truncate } from '../utils/text';
import { scanLore } from '../lore/matcher';
import { parseFile, readFile } from '../importers/pipeline';
import type { RouteName } from '../state/router';

/* ------------------------------------------------------------- library */

export function LorebooksPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<Lorebook | null>(null);

  const entryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of state.loreEntries) {
      counts.set(entry.lorebookId, (counts.get(entry.lorebookId) ?? 0) + 1);
    }
    return counts;
  }, [state.loreEntries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.lorebooks
      .filter((book) =>
        needle
          ? [book.name, book.description, book.tags.join(' ')].join(' ').toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.lorebooks, query]);

  const create = async () => {
    const book = await actions.saveLorebook(newLorebook({ name: 'New Lorebook' }));
    navigate('lorebook', book.id);
  };

  const remove = async (book: Lorebook) => {
    const count = entryCounts.get(book.id) ?? 0;
    const ok = await confirm(
      deleteConfirm(
        'lorebook',
        book.name,
        <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
          Its {count} entr{count === 1 ? 'y' : 'ies'} will be deleted too, and it will be detached
          from every story, chat and character.
        </p>,
      ),
    );
    if (!ok) return;
    await actions.deleteLorebook(book.id);
    actions.toast({ kind: 'success', title: 'Lorebook deleted' });
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Lorebooks
          <span className="subtitle">
            {state.lorebooks.length} book{state.lorebooks.length === 1 ? '' : 's'} ·{' '}
            {state.loreEntries.length} entries
          </span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={create}>
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        <SearchInput value={query} onChange={setQuery} placeholder="Search lorebooks…" />

        {!filtered.length ? (
          <EmptyState
            icon="scroll"
            title={query ? 'No lorebooks match' : 'No lorebooks yet'}
            message="A lorebook holds world facts that are injected into the AI's context only when their keywords appear."
            action={
              !query && (
                <div className="btn-row" style={{ justifyContent: 'center' }}>
                  <button type="button" className="btn btn-primary" onClick={create}>
                    <Icon name="plus" />
                    Create lorebook
                  </button>
                  <button type="button" className="btn" onClick={() => navigate('transfer')}>
                    <Icon name="upload" />
                    Import
                  </button>
                </div>
              )
            }
          />
        ) : (
          <div className="list">
            {filtered.map((book) => {
              const count = entryCounts.get(book.id) ?? 0;
              const storyLinks = state.stories.filter((s) => s.lorebookIds.includes(book.id));
              const charLinks = state.characters.filter((c) => c.lorebookIds.includes(book.id));
              return (
                <div className="card card-button" key={book.id}>
                  <button
                    type="button"
                    onClick={() => navigate('lorebook', book.id)}
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
                    <div className="row" style={{ gap: 8 }}>
                      <strong className="truncate">{book.name || 'Untitled lorebook'}</strong>
                      {!book.enabled && <span className="chip chip-danger">Disabled</span>}
                      {book.global && <span className="chip chip-accent">Global</span>}
                    </div>
                    {book.description && (
                      <div className="small muted clamp-2">{truncate(book.description, 120)}</div>
                    )}
                    <div className="small muted" style={{ marginTop: 4 }}>
                      {count} entr{count === 1 ? 'y' : 'ies'}
                      {storyLinks.length ? ` · ${storyLinks.length} stor${storyLinks.length === 1 ? 'y' : 'ies'}` : ''}
                      {charLinks.length ? ` · ${charLinks.length} character${charLinks.length === 1 ? '' : 's'}` : ''}
                      {` · ${relativeTime(book.updatedAt)}`}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Actions for ${book.name}`}
                    onClick={() => setMenuFor(book)}
                  >
                    <Icon name="more" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.name ?? ''}
        actions={
          menuFor
            ? [
                { key: 'open', label: 'Open editor', icon: 'edit', onSelect: () => navigate('lorebook', menuFor.id) },
                {
                  key: 'toggle',
                  label: menuFor.enabled ? 'Disable lorebook' : 'Enable lorebook',
                  icon: menuFor.enabled ? 'eyeOff' : 'eye',
                  onSelect: () => actions.saveLorebook({ ...menuFor, enabled: !menuFor.enabled }),
                },
                {
                  key: 'global',
                  label: menuFor.global ? 'Stop applying globally' : 'Apply to every chat (global)',
                  icon: 'target',
                  onSelect: () => actions.saveLorebook({ ...menuFor, global: !menuFor.global }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicateLorebook(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export',
                  icon: 'download',
                  onSelect: () => {
                    const entries = state.loreEntries.filter((e) => e.lorebookId === menuFor.id);
                    downloadFile(
                      exportFilename('lorebook', menuFor.name),
                      exportLoreEntries(menuFor, entries),
                    );
                    actions.toast({ kind: 'success', title: 'Lorebook exported' });
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: 'trash',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => remove(menuFor),
                },
              ]
            : []
        }
      />
    </>
  );
}

/* -------------------------------------------------------------- editor */

export function LorebookEditor({
  lorebookId,
  onClose,
}: {
  lorebookId: string;
  onClose: () => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const book = state.lorebooks.find((b) => b.id === lorebookId) ?? null;
  const entries = useMemo(
    () =>
      state.loreEntries
        .filter((e) => e.lorebookId === lorebookId)
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
    [state.loreEntries, lorebookId],
  );

  const [tab, setTab] = useState<'entries' | 'settings' | 'test'>('entries');
  const [editing, setEditing] = useState<LoreEntry | null>(null);
  const [menuFor, setMenuFor] = useState<LoreEntry | null>(null);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);

  if (!book) {
    return (
      <div className="page">
        <EmptyState
          icon="warn"
          title="Lorebook not found"
          message="It may have been deleted."
          action={
            <button type="button" className="btn" onClick={onClose}>
              Back to lorebooks
            </button>
          }
        />
      </div>
    );
  }

  const patch = (changes: Partial<Lorebook>) => actions.saveLorebook({ ...book, ...changes });

  const addEntry = async () => {
    const entry = newLoreEntry(book.id, {
      name: `Entry ${entries.length + 1}`,
      order: entries.length,
    });
    setEditing(entry);
  };

  const removeEntry = async (entry: LoreEntry) => {
    const ok = await confirm(deleteConfirm('lore entry', entry.name || 'Untitled entry'));
    if (!ok) return;
    await actions.deleteLoreEntry(entry.id);
    actions.toast({ kind: 'success', title: 'Entry deleted' });
  };

  const importEntries = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const parsed = await parseFile(await readFile(file));
      const incoming = parsed.payload.loreEntries ?? [];
      if (!incoming.length) {
        actions.toast({
          kind: 'error',
          title: 'No entries found',
          detail: `"${file.name}" did not contain any lorebook entries.`,
        });
        return;
      }
      // Merge into THIS book rather than creating another one.
      const rebased = incoming.map((entry, index) => ({
        ...entry,
        id: newLoreEntry(book.id).id,
        lorebookId: book.id,
        order: entries.length + index,
      }));
      await actions.saveLoreEntries(rebased);
      actions.toast({
        kind: 'success',
        title: `Imported ${rebased.length} entr${rebased.length === 1 ? 'y' : 'ies'}`,
      });
    } catch (err) {
      actions.toast({
        kind: 'error',
        title: 'Import failed',
        detail: (err as Error).message,
      });
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const visible = entries.filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [entry.name, entry.content, entry.primaryKeys.join(' '), entry.secondaryKeys.join(' '), entry.category]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  return (
    <div>
      <div className="page-header">
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Back">
          <Icon name="chevronLeft" />
        </button>
        <h1>
          {book.name || 'Untitled lorebook'}
          <span className="subtitle">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
            {book.enabled ? '' : ' · disabled'}
          </span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={addEntry}>
          <Icon name="plus" />
          Entry
        </button>
      </div>

      <div className="page">
        <Tabs
          tabs={[
            { id: 'entries', label: 'Entries', badge: entries.length },
            { id: 'settings', label: 'Settings' },
            { id: 'test', label: 'Tester' },
          ]}
          active={tab}
          onChange={setTab}
          label="Lorebook sections"
        />

        {tab === 'entries' && (
          <>
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <button type="button" className="btn btn-sm" onClick={addEntry}>
                <Icon name="plus" />
                Add entry
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => fileInput.current?.click()}
                disabled={importing}
              >
                {importing ? <span className="spinner" /> : <Icon name="upload" />}
                Import entries
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!entries.length}
                onClick={() => {
                  downloadFile(exportFilename('lorebook', book.name), exportLoreEntries(book, entries));
                  actions.toast({ kind: 'success', title: 'Entries exported' });
                }}
              >
                <Icon name="download" />
                Export entries
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json,.txt,text/plain"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => void importEntries(e.target.files?.[0])}
            />

            {entries.length > 4 && (
              <SearchInput value={query} onChange={setQuery} placeholder="Filter entries…" />
            )}

            {!visible.length ? (
              <EmptyState
                icon="scroll"
                title={entries.length ? 'No entries match' : 'No entries yet'}
                message={
                  entries.length
                    ? 'Try a different filter.'
                    : 'Add an entry with a few keywords. When those words appear in the conversation, the entry is injected into the AI context.'
                }
                action={
                  !entries.length && (
                    <button type="button" className="btn btn-primary" onClick={addEntry}>
                      <Icon name="plus" />
                      Add the first entry
                    </button>
                  )
                }
              />
            ) : (
              <div className="list">
                {visible.map((entry) => (
                  <div className="card card-button" key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(entry)}
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
                        <strong className="truncate">{entry.name || 'Untitled entry'}</strong>
                        {!entry.enabled && <span className="chip chip-danger">Disabled</span>}
                        {entry.activation === 'always' && <span className="chip chip-warn">Always</span>}
                        {entry.category && <span className="chip">{entry.category}</span>}
                      </div>
                      <div className="chip-row" style={{ marginTop: 5 }}>
                        {entry.primaryKeys.length ? (
                          entry.primaryKeys.slice(0, 5).map((key) => (
                            <span className="chip chip-accent" key={key}>
                              {key}
                            </span>
                          ))
                        ) : entry.activation === 'always' ? null : (
                          <span className="chip chip-warn">No keywords — will never trigger</span>
                        )}
                        {entry.primaryKeys.length > 5 && (
                          <span className="chip">+{entry.primaryKeys.length - 5}</span>
                        )}
                      </div>
                      <div className="small muted clamp-2" style={{ marginTop: 5 }}>
                        {truncate(entry.content, 130) || 'No content.'}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Actions for ${entry.name || 'entry'}`}
                      onClick={() => setMenuFor(entry)}
                    >
                      <Icon name="more" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'settings' && (
          <>
            <TextField label="Name" value={book.name} onChange={(name) => patch({ name })} required />
            <TextArea
              label="Description"
              value={book.description}
              onChange={(description) => patch({ description })}
            />
            <TagField label="Tags" values={book.tags} onChange={(tags) => patch({ tags })} />
            <Toggle
              label="Enabled"
              description="A disabled lorebook contributes nothing, whatever it is attached to."
              checked={book.enabled}
              onChange={(enabled) => patch({ enabled })}
            />
            <Toggle
              label="Global"
              description="Apply to every chat without attaching it to a story or character."
              checked={book.global}
              onChange={(global) => patch({ global })}
            />
            <NumberField
              label="Scan depth override"
              value={book.scanDepth}
              onChange={(scanDepth) => patch({ scanDepth: Math.max(0, scanDepth) })}
              min={0}
              max={100}
              hint="How many recent messages are scanned for this book's keywords. 0 uses the global setting from Settings."
            />

            <hr className="divider" />
            <h3 className="section-title">Attached to</h3>
            <AttachmentSummary lorebookId={book.id} />
          </>
        )}

        {tab === 'test' && <LorebookTester lorebookId={book.id} />}
      </div>

      {editing && (
        <LoreEntryEditor
          key={editing.id}
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={async (entry) => {
            await actions.saveLoreEntry(entry);
            setEditing(null);
            actions.toast({ kind: 'success', title: 'Entry saved' });
          }}
          onDelete={
            entries.some((e) => e.id === editing.id)
              ? async () => {
                  await removeEntry(editing);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}

      <ActionSheet
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.name || 'Entry'}
        actions={
          menuFor
            ? [
                { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => setEditing(menuFor) },
                {
                  key: 'toggle',
                  label: menuFor.enabled ? 'Disable entry' : 'Enable entry',
                  icon: menuFor.enabled ? 'eyeOff' : 'eye',
                  onSelect: () => actions.saveLoreEntry({ ...menuFor, enabled: !menuFor.enabled }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicateLoreEntry(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export entry',
                  icon: 'download',
                  onSelect: () => {
                    downloadFile(exportFilename('lore-entry', menuFor.name), exportLoreEntry(menuFor));
                    actions.toast({ kind: 'success', title: 'Entry exported' });
                  },
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: 'trash',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => removeEntry(menuFor),
                },
              ]
            : []
        }
      />
    </div>
  );
}

function AttachmentSummary({ lorebookId }: { lorebookId: string }) {
  const state = useAppState();
  const stories = state.stories.filter((s) => s.lorebookIds.includes(lorebookId));
  const characters = state.characters.filter((c) => c.lorebookIds.includes(lorebookId));
  const chats = state.chats.filter((c) => c.lorebookIds.includes(lorebookId));
  const book = state.lorebooks.find((b) => b.id === lorebookId);

  if (book?.global) {
    return (
      <Banner kind="info" title="Global lorebook">
        This lorebook applies to every chat, in addition to any direct attachments below.
      </Banner>
    );
  }
  if (!stories.length && !characters.length && !chats.length) {
    return (
      <Banner kind="warn" title="Not attached to anything">
        This lorebook will never trigger. Attach it to a story or character, or mark it Global.
      </Banner>
    );
  }
  return (
    <div className="stack">
      {[
        ['Stories', stories.map((s) => s.title || 'Untitled story')] as const,
        ['Characters', characters.map((c) => c.name || 'Unnamed')] as const,
        ['Chats', chats.map((c) => c.title)] as const,
      ]
        .filter(([, list]) => list.length)
        .map(([label, list]) => (
          <div key={label}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {label}
            </div>
            <div className="chip-row">
              {list.map((name, i) => (
                <span className="chip" key={`${name}-${i}`}>
                  {name}
                </span>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

/* --------------------------------------------------------- entry editor */

export function LoreEntryEditor({
  entry,
  onClose,
  onSave,
  onDelete,
}: {
  entry: LoreEntry;
  onClose: () => void;
  onSave: (entry: LoreEntry) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<LoreEntry>(entry);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const patch = (changes: Partial<LoreEntry>) => setDraft((current) => ({ ...current, ...changes }));

  const submit = async () => {
    if (!draft.content.trim() && !draft.primaryKeys.length) {
      setError('An entry needs content, or at least one keyword to be useful.');
      return;
    }
    if (!draft.content.trim()) {
      setError('An entry needs content — that text is what gets injected into the AI context.');
      return;
    }
    if (draft.activation === 'keyword' && !draft.primaryKeys.length && !draft.aliases.length) {
      setError(
        'Keyword-triggered entries need at least one primary keyword or alias. Set activation to "Always active" if it should always apply.',
      );
      return;
    }
    setError(null);
    await onSave({ ...draft, name: draft.name.trim() || draft.primaryKeys[0] || 'Untitled entry' });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Lore entry"
      large
      footer={
        <>
          {onDelete && (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              <Icon name="trash" />
              Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            <Icon name="save" />
            Save
          </button>
        </>
      }
    >
      {error && (
        <Banner kind="error" title="Cannot save yet">
          {error}
        </Banner>
      )}

      <TextField label="Name" value={draft.name} onChange={(name) => patch({ name })} />
      <TextArea
        label="Content"
        required
        value={draft.content}
        onChange={(content) => patch({ content })}
        large
        hint="Exactly this text is injected into the AI context when the entry triggers."
      />
      <TagField
        label="Primary keywords"
        values={draft.primaryKeys}
        onChange={(primaryKeys) => patch({ primaryKeys })}
        hint="Any one of these matching the recent conversation triggers the entry."
      />
      <TagField
        label="Secondary keywords"
        values={draft.secondaryKeys}
        onChange={(secondaryKeys) => patch({ secondaryKeys })}
        hint="Optional. When set, a primary AND a secondary keyword must both match."
      />
      <TagField
        label="Aliases"
        values={draft.aliases}
        onChange={(aliases) => patch({ aliases })}
        hint="Alternative spellings or nicknames, treated like primary keywords."
      />

      <div className="field-row field-row-2">
        <SelectField
          label="Activation"
          value={draft.activation}
          onChange={(activation) => patch({ activation })}
          options={[
            { value: 'keyword', label: 'Keyword triggered' },
            { value: 'always', label: 'Always active' },
            { value: 'story-only', label: 'Story only' },
            { value: 'chat-only', label: 'Chat only' },
            { value: 'character-only', label: 'Character only' },
          ]}
        />
        <TextField label="Category" value={draft.category} onChange={(category) => patch({ category })} />
      </div>

      <Toggle label="Enabled" checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        style={{ marginBottom: 10 }}
      >
        <Icon name={advanced ? 'chevronUp' : 'chevronDown'} />
        Advanced matching &amp; placement
      </button>

      {advanced && (
        <>
          <div className="field-row field-row-2">
            <SelectField
              label="Match mode"
              value={draft.matchMode}
              onChange={(matchMode) => patch({ matchMode })}
              options={[
                { value: 'word-boundary', label: 'Whole words (recommended)' },
                { value: 'partial', label: 'Partial / substring' },
                { value: 'exact-phrase', label: 'Exact phrase' },
              ]}
              hint="Whole words avoid accidental hits like 'cat' inside 'category'."
            />
            <SelectField
              label="Position"
              value={draft.position}
              onChange={(position) => patch({ position })}
              options={[
                { value: 'before-character', label: 'Before character' },
                { value: 'after-character', label: 'After character' },
                { value: 'author-note', label: "With author's note" },
                { value: 'at-depth', label: 'At depth in history' },
              ]}
            />
          </div>
          <div className="field-row field-row-3">
            <NumberField
              label="Priority"
              value={draft.priority}
              onChange={(priority) => patch({ priority })}
              min={0}
              max={1000}
              hint="Higher survives context trimming."
            />
            <NumberField
              label="Depth"
              value={draft.depth}
              onChange={(depth) => patch({ depth })}
              min={0}
              max={50}
            />
            <NumberField
              label="Scan depth"
              value={draft.scanDepth}
              onChange={(scanDepth) => patch({ scanDepth })}
              min={0}
              max={100}
              hint="0 = inherit."
            />
          </div>
          {/*
            Timing, in messages. All three are off at zero, which is how every
            entry written before they existed behaves — nothing changes for a
            book that does not set them.
          */}
          <div className="field-row field-row-3">
            <NumberField
              label="Delay"
              value={draft.delay ?? 0}
              onChange={(delay) => patch({ delay: Math.max(0, Math.round(delay)) })}
              min={0}
              max={500}
              hint="Hold back until the story is this many messages long."
            />
            <NumberField
              label="Sticky"
              value={draft.sticky ?? 0}
              onChange={(sticky) => patch({ sticky: Math.max(0, Math.round(sticky)) })}
              min={0}
              max={100}
              hint="Stay active this many messages after the keyword stops."
            />
            <NumberField
              label="Cooldown"
              value={draft.cooldown ?? 0}
              onChange={(cooldown) => patch({ cooldown: Math.max(0, Math.round(cooldown)) })}
              min={0}
              max={100}
              hint="Rest this many messages after firing."
            />
          </div>
          <Toggle
            label="Case sensitive"
            checked={draft.caseSensitive}
            onChange={(caseSensitive) => patch({ caseSensitive })}
          />
          <TextField label="Scope" value={draft.scope} onChange={(scope) => patch({ scope })} />
          <TextArea label="Comment" value={draft.comment} onChange={(comment) => patch({ comment })} />
          <CustomFieldsEditor
            values={draft.customFields}
            onChange={(customFields) => patch({ customFields })}
          />
        </>
      )}
    </Sheet>
  );
}

/* -------------------------------------------------------------- tester */

export function LorebookTester({ lorebookId }: { lorebookId?: string }) {
  const state = useAppState();
  const [text, setText] = useState('');
  const [scopeAll, setScopeAll] = useState(!lorebookId);

  const entries = useMemo(
    () =>
      scopeAll || !lorebookId
        ? state.loreEntries
        : state.loreEntries.filter((e) => e.lorebookId === lorebookId),
    [state.loreEntries, lorebookId, scopeAll],
  );

  const result = useMemo(() => {
    const books = state.lorebooks;
    return scanLore({
      recentTexts: text.trim() ? [text] : [],
      lorebooks: books,
      entries,
      scope: {
        source: 'test',
        // In test mode every book counts as attached so entries are judged on
        // their own rules rather than on where they happen to be linked.
        storyLorebookIds: books.map((b) => b.id),
        chatLorebookIds: books.map((b) => b.id),
        characterLorebookIds: books.map((b) => b.id),
      },
      defaultScanDepth: state.settings.loreScanDepth,
      maxEntries: state.settings.maxLoreEntries,
    });
  }, [text, entries, state.lorebooks, state.settings.loreScanDepth, state.settings.maxLoreEntries]);

  return (
    <div>
      <Banner kind="info" title="Lorebook tester">
        Paste any text — a message you might send, or a scene description — to see exactly which
        entries would be injected. This uses the same retrieval code as the live AI context.
        Delay is not applied here, since pasted text has no story length; sticky and cooldown
        are judged on the pasted text alone.
      </Banner>

      <TextArea
        label="Test text"
        value={text}
        onChange={setText}
        large
        placeholder="What is the current context? e.g. “We ride north toward Ashfell before the storm hits.”"
      />

      {lorebookId && (
        <Toggle
          label="Test against every lorebook"
          description="Off: only this lorebook's entries are evaluated."
          checked={scopeAll}
          onChange={setScopeAll}
        />
      )}

      <hr className="divider" />

      <h3 className="section-title">
        Triggered entries
        <span className="chip chip-success">{result.hits.length}</span>
      </h3>
      {!result.hits.length ? (
        <p className="small muted">
          {text.trim()
            ? 'Nothing triggered. Check the excluded list below for the reason.'
            : 'Type some text above to run the test.'}
        </p>
      ) : (
        <div className="list">
          {result.hits.map((hit) => (
            <div className="card" key={hit.entry.id}>
              <div className="row row-between row-wrap">
                <strong>{hit.entry.name || 'Untitled entry'}</strong>
                <span className="chip">{hit.lorebookName}</span>
              </div>
              <div className="small" style={{ color: 'var(--success)', marginTop: 4 }}>
                {hit.reason}
              </div>
              {!!hit.matched.length && (
                <div className="chip-row" style={{ marginTop: 6 }}>
                  {hit.matched.map((key) => (
                    <span className="chip chip-success" key={key}>
                      {key}
                    </span>
                  ))}
                </div>
              )}
              <pre className="ctx-part-body mono" style={{ marginTop: 8, borderRadius: 8 }}>
                {hit.entry.content}
              </pre>
            </div>
          ))}
        </div>
      )}

      <h3 className="section-title" style={{ marginTop: 20 }}>
        Excluded entries
        <span className="chip">{result.misses.length}</span>
      </h3>
      {!result.misses.length ? (
        <p className="small muted">Every entry triggered.</p>
      ) : (
        <div className="list">
          {result.misses.map((miss) => (
            <div className="card" key={miss.entry.id} style={{ opacity: 0.85 }}>
              <div className="row row-between row-wrap">
                <strong className="truncate">{miss.entry.name || 'Untitled entry'}</strong>
                <span className="chip">{miss.lorebookName}</span>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                Excluded because: {miss.reason}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
