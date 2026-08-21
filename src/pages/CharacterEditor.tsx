import { useMemo, useState } from 'react';
import type { Character, Greeting } from '../types';
import { newCharacter, newGreeting } from '../types/factories';
import { useActions, useAppState } from '../state/store';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { Icon } from '../components/ui/Icon';
import { Tabs, CustomFieldsEditor, Banner } from '../components/ui/common';
import { TagField, TextArea, TextField, Toggle } from '../components/ui/Field';
import { ImagePicker } from '../components/media/ImagePicker';
import { downloadFile, exportCharacter, exportCharacterAsCardV2, exportFilename } from '../exporters';
import { ActionSheet } from '../components/ui/Sheet';
import { getMediaBlob, blobToDataUrl } from '../media/mediaStore';

type TabId = 'identity' | 'description' | 'background' | 'roleplay' | 'relations' | 'world' | 'advanced';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'description', label: 'Description' },
  { id: 'background', label: 'Background' },
  { id: 'roleplay', label: 'Roleplay' },
  { id: 'relations', label: 'Relationships' },
  { id: 'world', label: 'World' },
  { id: 'advanced', label: 'Advanced' },
];

export function CharacterEditor({
  characterId,
  onClose,
  onSaved,
}: {
  characterId: string | null;
  onClose: () => void;
  onSaved?: (character: Character) => void;
}) {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();

  const existing = useMemo(
    () => state.characters.find((c) => c.id === characterId) ?? null,
    [state.characters, characterId],
  );

  const [draft, setDraft] = useState<Character>(() => existing ?? newCharacter());
  const [tab, setTab] = useState<TabId>('identity');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [menuOpen, setMenuOpen] = useState(false);

  const patch = (changes: Partial<Character>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setDirty(true);
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = 'A character needs a name.';
    setErrors(next);
    if (Object.keys(next).length) setTab('identity');
    return !Object.keys(next).length;
  };

  const save = async (): Promise<Character | null> => {
    if (!validate()) {
      actions.toast({ kind: 'error', title: 'Fix the highlighted field before saving.' });
      return null;
    }
    setSaving(true);
    try {
      const saved = await actions.saveCharacter(draft);
      setDraft(saved);
      setDirty(false);
      actions.toast({ kind: 'success', title: `Saved "${saved.name}"` });
      onSaved?.(saved);
      return saved;
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        message: <p style={{ margin: 0 }}>Your edits to this character have not been saved yet.</p>,
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const remove = async () => {
    if (!existing) return;
    const usedIn = state.stories.filter((s) =>
      s.characters.some((c) => c.characterId === existing.id),
    );
    const ok = await confirm(
      deleteConfirm(
        'character',
        existing.name,
        usedIn.length ? (
          <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
            It is used in {usedIn.length} stor{usedIn.length === 1 ? 'y' : 'ies'} and will be removed
            from {usedIn.length === 1 ? 'it' : 'them'}. Existing chat messages are kept.
          </p>
        ) : undefined,
      ),
    );
    if (!ok) return;
    await actions.deleteCharacter(existing.id);
    actions.toast({ kind: 'success', title: 'Character deleted' });
    onClose();
  };

  return (
    <div>
      <div className="page-header">
        <button type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Back">
          <Icon name="chevronLeft" />
        </button>
        <h1>
          {existing ? 'Edit Character' : 'New Character'}
          <span className="subtitle">{draft.name || 'Unnamed'}{dirty ? ' · unsaved' : ''}</span>
        </h1>
        {existing && (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setMenuOpen(true)}
            aria-label="More actions"
          >
            <Icon name="more" />
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="save" />}
          Save
        </button>
      </div>

      <div className="page">
        <Tabs tabs={TABS} active={tab} onChange={setTab} label="Character sections" />

        {tab === 'identity' && (
          <>
            <ImagePicker
              label="Avatar"
              mediaId={draft.avatarMediaId}
              onChange={(mediaId) => patch({ avatarMediaId: mediaId })}
              ownerType="character"
              ownerId={draft.id}
              shape="round"
              urlValue={draft.avatarUrl}
              onUrlChange={(avatarUrl) => patch({ avatarUrl })}
              hint="Pick any picture from your device's gallery — it is stored on this device and survives a refresh."
            />
            <TextField
              label="Name"
              required
              value={draft.name}
              onChange={(name) => patch({ name })}
              error={errors.name}
              hint="How the AI refers to this character. Used for the {{char}} macro."
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
            <div className="field-row field-row-2">
              <TextField label="Species" value={draft.species} onChange={(v) => patch({ species: v })} />
              <TextField label="Race" value={draft.race} onChange={(v) => patch({ race: v })} />
            </div>
            <div className="field-row field-row-2">
              <TextField label="Occupation" value={draft.occupation} onChange={(v) => patch({ occupation: v })} />
              <TextField label="Role" value={draft.role} onChange={(v) => patch({ role: v })} />
            </div>
            <TagField label="Tags" values={draft.tags} onChange={(tags) => patch({ tags })} />
            <Toggle
              label="Favourite"
              description="Favourites appear first in the character library."
              checked={draft.favorite}
              onChange={(favorite) => patch({ favorite })}
            />
          </>
        )}

        {tab === 'description' && (
          <>
            <TextField
              label="Short description"
              value={draft.shortDescription}
              onChange={(v) => patch({ shortDescription: v })}
              hint="One line shown in the library and used as a summary."
            />
            <TextArea
              label="Full description"
              value={draft.description}
              onChange={(v) => patch({ description: v })}
              large
              hint="The main body of the character. Supports {{char}} and {{user}} macros."
            />
            <TextArea label="Appearance" value={draft.appearance} onChange={(v) => patch({ appearance: v })} />
            <TextArea label="Physical traits" value={draft.physicalTraits} onChange={(v) => patch({ physicalTraits: v })} />
            <TextArea label="Personality" value={draft.personality} onChange={(v) => patch({ personality: v })} large />
            <TextArea label="Temperament" value={draft.temperament} onChange={(v) => patch({ temperament: v })} />
            <TagField label="Traits" values={draft.traits} onChange={(traits) => patch({ traits })} />
          </>
        )}

        {tab === 'background' && (
          <>
            <TextArea label="Backstory" value={draft.backstory} onChange={(v) => patch({ backstory: v })} large />
            <TextArea label="History" value={draft.history} onChange={(v) => patch({ history: v })} />
            <div className="field-row field-row-2">
              <TextArea label="Goals" value={draft.goals} onChange={(v) => patch({ goals: v })} />
              <TextArea label="Motivations" value={draft.motivations} onChange={(v) => patch({ motivations: v })} />
            </div>
            <div className="field-row field-row-2">
              <TextArea label="Fears" value={draft.fears} onChange={(v) => patch({ fears: v })} />
              <TextArea label="Secrets" value={draft.secrets} onChange={(v) => patch({ secrets: v })} />
            </div>
            <div className="field-row field-row-2">
              <TextArea label="Likes" value={draft.likes} onChange={(v) => patch({ likes: v })} />
              <TextArea label="Dislikes" value={draft.dislikes} onChange={(v) => patch({ dislikes: v })} />
            </div>
            <TextArea label="Hobbies" value={draft.hobbies} onChange={(v) => patch({ hobbies: v })} />
            <div className="field-row field-row-2">
              <TextArea label="Values" value={draft.values} onChange={(v) => patch({ values: v })} />
              <TextArea label="Beliefs" value={draft.beliefs} onChange={(v) => patch({ beliefs: v })} />
            </div>
          </>
        )}

        {tab === 'roleplay' && (
          <>
            <TextArea
              label="Scenario"
              value={draft.scenario}
              onChange={(v) => patch({ scenario: v })}
              hint="The default situation when a chat begins. A story's scenario overrides this."
            />
            <GreetingsEditor
              greetings={draft.greetings}
              defaultId={draft.defaultGreetingId}
              onChange={(greetings, defaultGreetingId) => patch({ greetings, defaultGreetingId })}
            />
            <TextArea label="Speaking style" value={draft.speakingStyle} onChange={(v) => patch({ speakingStyle: v })} />
            <TextArea label="Speech patterns" value={draft.speechPatterns} onChange={(v) => patch({ speechPatterns: v })} />
            <TextArea
              label="Example dialogue"
              value={draft.exampleDialogue}
              onChange={(v) => patch({ exampleDialogue: v })}
              large
              hint="Teaches the model the character's voice. Use {{char}}: and {{user}}: prefixes."
            />
            <TextArea
              label="System prompt"
              value={draft.systemPrompt}
              onChange={(v) => patch({ systemPrompt: v })}
              hint="Added to the global system prompt whenever this character is active."
            />
            <TextArea
              label="Author's note"
              value={draft.authorNote}
              onChange={(v) => patch({ authorNote: v })}
              hint="Injected near the end of the context, where it steers the reply most strongly."
            />
          </>
        )}

        {tab === 'relations' && (
          <>
            <TextArea label="Relationships" value={draft.relationships} onChange={(v) => patch({ relationships: v })} large />
            <div className="field-row field-row-2">
              <TextArea label="Friends" value={draft.friends} onChange={(v) => patch({ friends: v })} />
              <TextArea label="Enemies" value={draft.enemies} onChange={(v) => patch({ enemies: v })} />
            </div>
            <div className="field-row field-row-2">
              <TextArea label="Family" value={draft.family} onChange={(v) => patch({ family: v })} />
              <TextArea label="Romantic relationships" value={draft.romantic} onChange={(v) => patch({ romantic: v })} />
            </div>
          </>
        )}

        {tab === 'world' && (
          <>
            <div className="field-row field-row-2">
              <TextField label="Home" value={draft.home} onChange={(v) => patch({ home: v })} />
              <TextField label="Location" value={draft.location} onChange={(v) => patch({ location: v })} />
            </div>
            <div className="field-row field-row-2">
              <TextField label="Faction" value={draft.faction} onChange={(v) => patch({ faction: v })} />
              <TextField label="World" value={draft.world} onChange={(v) => patch({ world: v })} />
            </div>

            <div className="field">
              <span className="field-label">Attached lorebooks</span>
              <div className="field-hint" style={{ marginBottom: 8 }}>
                Entries from these lorebooks are considered whenever this character is active in a chat.
              </div>
              {!state.lorebooks.length ? (
                <p className="small muted">No lorebooks yet. Create one from the Lorebooks tab.</p>
              ) : (
                <div className="stack">
                  {state.lorebooks.map((book) => {
                    const attached = draft.lorebookIds.includes(book.id);
                    const count = state.loreEntries.filter((e) => e.lorebookId === book.id).length;
                    return (
                      <Toggle
                        key={book.id}
                        label={book.name || 'Untitled lorebook'}
                        description={`${count} entr${count === 1 ? 'y' : 'ies'}${book.global ? ' · global' : ''}`}
                        checked={attached}
                        onChange={(on) =>
                          patch({
                            lorebookIds: on
                              ? [...draft.lorebookIds, book.id]
                              : draft.lorebookIds.filter((id) => id !== book.id),
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'advanced' && (
          <>
            <TextField label="Creator" value={draft.creator} onChange={(v) => patch({ creator: v })} />
            <TextArea label="Creator notes" value={draft.creatorNotes} onChange={(v) => patch({ creatorNotes: v })} />
            <TextField label="Version" value={draft.version} onChange={(v) => patch({ version: v })} />
            <CustomFieldsEditor
              values={draft.customFields}
              onChange={(customFields) => patch({ customFields })}
              hint="Unrecognised fields from imported cards land here and are included in the AI context."
            />
            {!!Object.keys(draft.metadata ?? {}).length && (
              <div className="field">
                <span className="field-label">Imported metadata (read-only)</span>
                <pre className="ctx-part-body mono" style={{ borderRadius: 8, border: '1px solid var(--border)' }}>
                  {JSON.stringify(draft.metadata, null, 2)}
                </pre>
              </div>
            )}
            <Banner kind="info" title="Identifier">
              <span className="mono">{draft.id}</span>
            </Banner>
            {existing && (
              <button type="button" className="btn btn-danger btn-block" onClick={remove}>
                <Icon name="trash" />
                Delete character
              </button>
            )}
          </>
        )}
      </div>

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={draft.name || 'Character'}
        actions={[
          {
            key: 'duplicate',
            label: 'Duplicate',
            icon: 'copy',
            onSelect: async () => {
              if (!existing) return;
              const copy = await actions.duplicateCharacter(existing.id);
              if (copy) actions.toast({ kind: 'success', title: `Duplicated as "${copy.name}"` });
            },
          },
          {
            key: 'export',
            label: 'Export as JSON',
            description: 'Includes the avatar and attached lorebooks.',
            icon: 'download',
            onSelect: async () => {
              const json = await exportCharacter(draft, { includeAvatar: true, includeLorebooks: true });
              downloadFile(exportFilename('character', draft.name), json);
              actions.toast({ kind: 'success', title: 'Character exported' });
            },
          },
          {
            key: 'export-card',
            label: 'Export as character card (v2)',
            description: 'Compatible with SillyTavern and similar apps.',
            icon: 'download',
            onSelect: async () => {
              let avatar: string | undefined;
              if (draft.avatarMediaId) {
                const blob = await getMediaBlob(draft.avatarMediaId);
                if (blob) avatar = await blobToDataUrl(blob);
              }
              downloadFile(`card-${draft.name || 'character'}.json`, exportCharacterAsCardV2(draft, avatar));
              actions.toast({ kind: 'success', title: 'Character card exported' });
            },
          },
          {
            key: 'delete',
            label: 'Delete character',
            icon: 'trash',
            destructive: true,
            separatorBefore: true,
            onSelect: remove,
          },
        ]}
      />
    </div>
  );
}

function GreetingsEditor({
  greetings,
  defaultId,
  onChange,
}: {
  greetings: Greeting[];
  defaultId: string | null;
  onChange: (greetings: Greeting[], defaultId: string | null) => void;
}) {
  const update = (id: string, patch: Partial<Greeting>) =>
    onChange(greetings.map((g) => (g.id === id ? { ...g, ...patch } : g)), defaultId);

  const add = () => {
    const greeting = newGreeting('', `Greeting ${greetings.length + 1}`);
    onChange([...greetings, greeting], defaultId ?? greeting.id);
  };

  const remove = (id: string) => {
    const next = greetings.filter((g) => g.id !== id);
    onChange(next, defaultId === id ? (next[0]?.id ?? null) : defaultId);
  };

  const randomize = () => {
    if (greetings.length < 2) return;
    const others = greetings.filter((g) => g.id !== defaultId);
    const pick = others[Math.floor(Math.random() * others.length)];
    onChange(greetings, pick.id);
  };

  return (
    <div className="field">
      <div className="row row-between" style={{ marginBottom: 6 }}>
        <span className="field-label" style={{ marginBottom: 0 }}>
          Greetings ({greetings.length})
        </span>
        <div className="btn-row">
          {greetings.length > 1 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={randomize}>
              <Icon name="refresh" />
              Randomise default
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={add}>
            <Icon name="plus" />
            Add greeting
          </button>
        </div>
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        The default greeting opens a new chat. Extra greetings give you alternative openings.
      </div>

      {!greetings.length ? (
        <p className="small muted">
          No greetings yet. Without one, chats with this character start empty.
        </p>
      ) : (
        <div className="stack">
          {greetings.map((greeting, index) => (
            <div className="card" key={greeting.id}>
              <div className="row row-between" style={{ marginBottom: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1, minHeight: 38 }}
                  value={greeting.label}
                  aria-label={`Greeting ${index + 1} label`}
                  placeholder={`Greeting ${index + 1}`}
                  onChange={(e) => update(greeting.id, { label: e.target.value })}
                />
                <button
                  type="button"
                  className={`btn btn-sm ${defaultId === greeting.id ? 'btn-primary' : ''}`}
                  onClick={() => onChange(greetings, greeting.id)}
                  aria-pressed={defaultId === greeting.id}
                >
                  <Icon name={defaultId === greeting.id ? 'check' : 'star'} />
                  {defaultId === greeting.id ? 'Default' : 'Set default'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Delete ${greeting.label || `greeting ${index + 1}`}`}
                  onClick={() => remove(greeting.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
              <textarea
                className="textarea"
                value={greeting.content}
                aria-label={`Greeting ${index + 1} text`}
                placeholder="*She looks up as you enter…*"
                onChange={(e) => update(greeting.id, { content: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
