import { useMemo, useState } from 'react';
import type { Persona } from '../types';
import { newPersona } from '../types/factories';
import { useActions, useAppState } from '../state/store';
import { Avatar } from '../components/media/MediaImage';
import { ImagePicker } from '../components/media/ImagePicker';
import { Icon } from '../components/ui/Icon';
import { Banner, CustomFieldsEditor, EmptyState, SearchInput, Tabs } from '../components/ui/common';
import { TagField, TextArea, TextField, Toggle } from '../components/ui/Field';
import { ActionSheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { downloadFile, exportFilename, exportPersona } from '../exporters';
import { relativeTime, truncate } from '../utils/text';
import type { RouteName } from '../state/router';

export function PersonasPage({
  navigate,
}: {
  navigate: (name: RouteName, param?: string | null) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<Persona | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.personas
      .filter((persona) =>
        needle
          ? [persona.name, persona.personality, persona.tags.join(' ')]
              .join(' ')
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  }, [state.personas, query]);

  const remove = async (persona: Persona) => {
    const ok = await confirm(deleteConfirm('persona', persona.name));
    if (!ok) return;
    await actions.deletePersona(persona.id);
    actions.toast({ kind: 'success', title: 'Persona deleted' });
  };

  return (
    <>
      <div className="page-header">
        <h1>
          Personas
          <span className="subtitle">Who you are in the story</span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('persona', 'new')}>
          <Icon name="plus" />
          New
        </button>
      </div>

      <div className="page">
        <SearchInput value={query} onChange={setQuery} placeholder="Search personas…" />

        {!filtered.length ? (
          <EmptyState
            icon="user"
            title={query ? 'No personas match' : 'No personas yet'}
            message="A persona is the character you play. The AI uses it to address you correctly."
            action={
              !query && (
                <button type="button" className="btn btn-primary" onClick={() => navigate('persona', 'new')}>
                  <Icon name="plus" />
                  Create persona
                </button>
              )
            }
          />
        ) : (
          <div className="list">
            {filtered.map((persona) => (
              <div className="card card-button" key={persona.id}>
                <button
                  type="button"
                  onClick={() => navigate('persona', persona.id)}
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
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
                  <Avatar
                    mediaId={persona.avatarMediaId}
                    fallbackUrl={persona.avatarUrl}
                    name={persona.name}
                    size={52}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="truncate">{persona.name || 'Unnamed'}</strong>
                      {persona.isDefault && <span className="chip chip-accent">Default</span>}
                    </div>
                    <div className="small muted clamp-2">
                      {truncate(persona.personality || persona.appearance, 110) || 'No description yet.'}
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {relativeTime(persona.updatedAt)}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Actions for ${persona.name}`}
                  onClick={() => setMenuFor(persona)}
                >
                  <Icon name="more" />
                </button>
              </div>
            ))}
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
                { key: 'edit', label: 'Edit', icon: 'edit', onSelect: () => navigate('persona', menuFor.id) },
                {
                  key: 'default',
                  label: menuFor.isDefault ? 'Clear default persona' : 'Set as default persona',
                  icon: 'star',
                  onSelect: () => actions.savePersona({ ...menuFor, isDefault: !menuFor.isDefault }),
                },
                {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => actions.duplicatePersona(menuFor.id),
                },
                {
                  key: 'export',
                  label: 'Export',
                  icon: 'download',
                  onSelect: async () => {
                    downloadFile(exportFilename('persona', menuFor.name), await exportPersona(menuFor));
                    actions.toast({ kind: 'success', title: 'Persona exported' });
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

type TabId = 'identity' | 'profile' | 'voice' | 'advanced';

export function PersonaEditor({
  personaId,
  onClose,
}: {
  personaId: string | null;
  onClose: () => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const existing = state.personas.find((p) => p.id === personaId) ?? null;

  const [draft, setDraft] = useState<Persona>(() => existing ?? newPersona());
  const [tab, setTab] = useState<TabId>('identity');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (changes: Partial<Persona>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setDirty(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError('A persona needs a name.');
      setTab('identity');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await actions.savePersona(draft);
      setDraft(saved);
      setDirty(false);
      actions.toast({ kind: 'success', title: `Saved "${saved.name}"` });
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm(deleteConfirm('persona', existing.name));
    if (!ok) return;
    await actions.deletePersona(existing.id);
    onClose();
  };

  return (
    <div>
      <div className="page-header">
        <button type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Back">
          <Icon name="chevronLeft" />
        </button>
        <h1>
          {existing ? 'Edit Persona' : 'New Persona'}
          <span className="subtitle">{draft.name || 'Unnamed'}{dirty ? ' · unsaved' : ''}</span>
        </h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="save" />}
          Save
        </button>
      </div>

      <div className="page">
        <Tabs
          tabs={[
            { id: 'identity', label: 'Identity' },
            { id: 'profile', label: 'Profile' },
            { id: 'voice', label: 'Voice' },
            { id: 'advanced', label: 'Advanced' },
          ]}
          active={tab}
          onChange={setTab}
          label="Persona sections"
        />

        {tab === 'identity' && (
          <>
            <ImagePicker
              label="Avatar"
              mediaId={draft.avatarMediaId}
              onChange={(avatarMediaId) => patch({ avatarMediaId })}
              ownerType="persona"
              ownerId={draft.id}
              shape="round"
              urlValue={draft.avatarUrl}
              onUrlChange={(avatarUrl) => patch({ avatarUrl })}
            />
            <TextField
              label="Name"
              required
              value={draft.name}
              onChange={(name) => patch({ name })}
              error={error ?? undefined}
              hint="The AI addresses you by this name. Used for the {{user}} macro."
            />
            <div className="field-row field-row-2">
              <TextField label="Display name" value={draft.displayName} onChange={(v) => patch({ displayName: v })} />
              <TextField label="Nickname" value={draft.nickname} onChange={(v) => patch({ nickname: v })} />
            </div>
            <div className="field-row field-row-3">
              <TextField label="Age" value={draft.age} onChange={(v) => patch({ age: v })} />
              <TextField label="Gender" value={draft.gender} onChange={(v) => patch({ gender: v })} />
              <TextField label="Pronouns" value={draft.pronouns} onChange={(v) => patch({ pronouns: v })} />
            </div>
            <TextField label="Species" value={draft.species} onChange={(v) => patch({ species: v })} />
            <Toggle
              label="Default persona"
              description="Used automatically for new chats and stories."
              checked={draft.isDefault}
              onChange={(isDefault) => patch({ isDefault })}
            />
          </>
        )}

        {tab === 'profile' && (
          <>
            <TextArea label="Appearance" value={draft.appearance} onChange={(v) => patch({ appearance: v })} />
            <TextArea label="Personality" value={draft.personality} onChange={(v) => patch({ personality: v })} large />
            <TagField label="Traits" values={draft.traits} onChange={(traits) => patch({ traits })} />
            <TextArea label="Backstory" value={draft.backstory} onChange={(v) => patch({ backstory: v })} large />
            <TextField label="Occupation" value={draft.occupation} onChange={(v) => patch({ occupation: v })} />
            <TextArea label="Goals" value={draft.goals} onChange={(v) => patch({ goals: v })} />
            <div className="field-row field-row-2">
              <TextArea label="Likes" value={draft.likes} onChange={(v) => patch({ likes: v })} />
              <TextArea label="Dislikes" value={draft.dislikes} onChange={(v) => patch({ dislikes: v })} />
            </div>
          </>
        )}

        {tab === 'voice' && (
          <>
            <TextArea label="Speech style" value={draft.speechStyle} onChange={(v) => patch({ speechStyle: v })} />
            <TextArea
              label="Custom instructions"
              value={draft.customInstructions}
              onChange={(v) => patch({ customInstructions: v })}
              large
              hint="Extra directions added to the context whenever this persona is active — tone, boundaries, formatting preferences."
            />
            <TagField label="Tags" values={draft.tags} onChange={(tags) => patch({ tags })} />
          </>
        )}

        {tab === 'advanced' && (
          <>
            <CustomFieldsEditor
              values={draft.customFields}
              onChange={(customFields) => patch({ customFields })}
            />
            <Banner kind="info" title="Identifier">
              <span className="mono">{draft.id}</span>
            </Banner>
            {existing && (
              <button type="button" className="btn btn-danger btn-block" onClick={remove}>
                <Icon name="trash" />
                Delete persona
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
