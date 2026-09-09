/**
 * The controls you actually reach for mid-scene.
 *
 * Everything here already existed; what did not exist was a way to get at it
 * without leaving the story. The chat's ⋯ menu had grown to seventeen flat
 * entries covering export, archiving, duplication and renaming alongside the
 * three or four things anyone touches while playing, which is how an
 * application starts to feel like an admin console for its own data.
 *
 * So this sheet holds the short list — how it writes, who is in the room, what
 * it remembers — and the long tail stays in the ⋯ menu where it belongs. It
 * owns no state of its own: presets live on the chat, presence lives on the
 * chat's SceneState, the toggles live in Settings, and everything here reads
 * and writes those.
 */
import type {
  Character,
  Chat,
  ID,
  NarrationPreset,
  SceneDelta,
  SceneState,
  Settings,
} from '../../types';
import { useEffect, useState } from 'react';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { TextArea, TextField, Toggle } from '../ui/Field';
import { availablePresets } from '../../narration/presets';
import type { ResolvedScene } from '../../context/scene';

export interface QuickSettingsProps {
  open: boolean;
  onClose: () => void;
  chat: Chat;
  /**
   * The story's own selection. A chat inherits it until it overrides, so the
   * panel needs both to say which is in force — the compiler's precedence is
   * `chat ?? story ?? none`, and showing only the chat's value made a story
   * preset look inactive while it was being sent.
   */
  storyPresetIds: ID[];
  /** The story's cast, so presence can be set from the people who exist. */
  cast: Character[];
  scene: ResolvedScene;
  /**
   * The scene as it stands, base plus whatever the story moved. The fields
   * below show this rather than `chat.scene`, so the editor and the prompt
   * never disagree about where everyone is.
   */
  sceneNow: SceneState;
  /** Fields the story moved, keyed as the field name (or `characterStates:<id>`). */
  sceneDerived: Map<string, SceneDelta>;
  settings: Settings;
  personaName: string | null;
  /** Token usage, when the user has asked to see counts. */
  contextSummary: string | null;
  /** The tuning already in force, so it reads without opening the sheet. */
  responseSummary: string;
  onPatchChat: (patch: Partial<Chat>) => void | Promise<unknown>;
  /** Writes a scene edit to the canonical base and hands back the fields it took over. */
  onCommitScene: (partial: Partial<SceneState>) => void | Promise<unknown>;
  onCommitCharacterState: (characterId: ID, text: string) => void | Promise<unknown>;
  onUndoSceneChange: (deltaId: ID) => void | Promise<unknown>;
  onPatchSettings: (patch: Partial<Settings>) => void | Promise<unknown>;
  onOpenInspector: () => void;
  onOpenPersona: () => void;
  onOpenResponseSettings: () => void;
  onOpenMemories: () => void;
  onOpenAdvanced: () => void;
}

export function QuickSettings({
  open,
  onClose,
  chat,
  storyPresetIds,
  cast,
  scene,
  sceneNow,
  sceneDerived,
  settings,
  personaName,
  contextSummary,
  responseSummary,
  onPatchChat,
  onCommitScene,
  onCommitCharacterState,
  onUndoSceneChange,
  onPatchSettings,
  onOpenInspector,
  onOpenPersona,
  onOpenResponseSettings,
  onOpenMemories,
  onOpenAdvanced,
}: QuickSettingsProps) {
  const presets = availablePresets(settings.narrationPresets ?? []);

  /*
   * Mirror the compiler exactly: `chat ?? story ?? none`. `null` on the chat
   * means inherit; an empty array is a deliberate "no style at all", which is
   * why the test is for null rather than for length.
   */
  const overridden = chat.narrationPresetIds != null;
  const selected = overridden ? chat.narrationPresetIds! : storyPresetIds;

  /*
   * The first edit of an inherited selection starts from that selection rather
   * than from nothing. Otherwise tapping one chip would silently drop
   * everything the story had chosen — the edit would read as "add Cinematic"
   * and behave as "replace the story's styles with Cinematic".
   */
  const togglePreset = (preset: NarrationPreset) => {
    const on = selected.includes(preset.id);
    onPatchChat({
      narrationPresetIds: on
        ? selected.filter((id) => id !== preset.id)
        : [...selected, preset.id],
    });
  };

  /** Back to whatever the story says, now and in future. */
  const useStoryPresets = () => onPatchChat({ narrationPresetIds: null });

  /**
   * Presence is stored, never inferred, so setting it is an explicit act.
   *
   * A scene that has never been declared resolves to the focal character
   * alone; the first tap in here therefore writes what is already true rather
   * than suddenly emptying the room.
   */
  /**
   * Every scene write goes through here.
   *
   * The fields show the scene as it stands — base plus whatever the story
   * moved — and commit to the canonical base. The handler decides what
   * actually changed, so opening the sheet and closing it again writes
   * nothing and takes nothing back from the story.
   */
  const patchScene = (partial: Partial<SceneState>) => onCommitScene(partial);

  const togglePresent = (character: Character) => {
    const current = scene.present.map((c) => c.id);
    const next = current.includes(character.id)
      ? current.filter((id) => id !== character.id)
      : [...current, character.id];
    // Everyone leaving the room is not a scene. Refusing the last removal is
    // kinder than accepting it and having the narrator address nobody.
    if (!next.length) return;
    patchScene({
      presentCharacterIds: next,
      primaryCharacterId: next.includes(sceneNow.primaryCharacterId ?? '')
        ? sceneNow.primaryCharacterId
        : next[0],
    });
  };

  /**
   * Scene-local state for one character: what is true of them right now, not
   * who they are. Clearing the text removes the key rather than storing an
   * empty string, so the compiler sees no line at all for that character.
   */
  const setCharacterState = (id: ID, text: string) => onCommitCharacterState(id, text);

  return (
    <Sheet open={open} onClose={onClose} title="Chat settings" large>
      <section className="qs-section">
        <h3 className="qs-heading">This scene</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Where you are and what is going on. This is the top of every prompt and the one part the
          model is told it may not contradict.
        </p>

        <SceneField
          label="Where"
          value={sceneNow.location}
          placeholder="The Nexus Tavern, back room"
          onCommit={(location) => patchScene({ location })}
          derived={sceneDerived.has('location')}
          onUndo={() => onUndoSceneChange(sceneDerived.get('location')!.id)}
        />
        <SceneField
          label="What is happening"
          value={sceneNow.situation}
          placeholder="The storm has shut the roads for a third night."
          multiline
          onCommit={(situation) => patchScene({ situation })}
          derived={sceneDerived.has('situation')}
          onUndo={() => onUndoSceneChange(sceneDerived.get('situation')!.id)}
        />
        <SceneField
          label="Right now"
          value={sceneNow.objective}
          placeholder="Get Sera to admit who sealed the cellar."
          hint="The immediate goal or open question driving this scene."
          onCommit={(objective) => patchScene({ objective })}
        />

        <h4 className="qs-subheading">Who is here</h4>
        {!scene.declared && (
          <p className="small muted" style={{ marginTop: 0 }}>
            Nobody has been placed in this scene yet, so only{' '}
            {scene.primary?.name ?? 'the lead'} is treated as present. Tap a name to say who else
            is in the room.
          </p>
        )}
        {!cast.length ? (
          <p className="small muted">This chat has no cast yet.</p>
        ) : (
          <div className="qs-cast">
            {cast.map((character) => {
              const here = scene.present.some((c) => c.id === character.id);
              return (
                <button
                  key={character.id}
                  type="button"
                  className={`chip chip-tap ${here ? 'chip-accent' : ''}`}
                  aria-pressed={here}
                  onClick={() => togglePresent(character)}
                >
                  <Icon name={here ? 'check' : 'user'} width={13} height={13} />
                  {character.name}
                </button>
              );
            })}
          </div>
        )}
        <p className="small muted">
          Only the people in the room are described as present, and only their relationships are
          sent. Everyone else stays in the story without crowding the prompt.
        </p>

        {/*
          Scene-local state: what is true of someone right now. Deliberately
          only for the people actually present, and deliberately not a place to
          describe who they are — that is the character record, and this is
          cleared when the scene moves on.
        */}
        {!!scene.present.length && (
          <>
            <h4 className="qs-subheading">How they are right now</h4>
            {scene.present.map((character) => (
              <SceneField
                key={character.id}
                label={character.displayName || character.name}
                value={sceneNow.characterStates[character.id] ?? ''}
                placeholder="Injured, guarded, hiding something…"
                onCommit={(text) => setCharacterState(character.id, text)}
              />
            ))}
            <p className="small muted">
              Temporary, and only for this scene — injuries, mood, what they are concealing. Who
              they are belongs on the character.
            </p>
          </>
        )}
      </section>

      <section className="qs-section">
        <h3 className="qs-heading">How it writes</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Styles combine — Slow Burn and Detailed together is a normal choice. They shape the
          telling, never what a character knows or what has happened.
        </p>
        <div className="chip-row">
          {presets.map((preset) => {
            const on = selected.includes(preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                className={`chip chip-tap ${on ? 'chip-accent' : ''}`}
                aria-pressed={on}
                title={preset.description}
                onClick={() => togglePreset(preset)}
              >
                {preset.name}
              </button>
            );
          })}
        </div>
        {/*
          Where the active selection came from. Without this the panel is
          ambiguous in the one case that matters: styles are active, none of
          them was chosen here, and nothing on screen says why.
        */}
        <p className="small muted qs-origin" style={{ marginBottom: 0 }}>
          {overridden ? (
            <>
              <span className="chip">This chat</span>
              {storyPresetIds.length ? (
                <>
                  {' '}Overriding the story’s selection.{' '}
                  <button type="button" className="link-button" onClick={useStoryPresets}>
                    Use story presets
                  </button>
                </>
              ) : (
                ' Set for this chat only.'
              )}
            </>
          ) : selected.length ? (
            <>
              <span className="chip">From story</span> These come from the story and apply to every
              chat in it. Changing one here affects only this chat.
            </>
          ) : (
            'No style selected, here or on the story. The scene decides.'
          )}
        </p>
      </section>

      <section className="qs-section">
        <h3 className="qs-heading">What it remembers</h3>
        <Toggle
          label="Write memories automatically"
          description="Records what changed after a scene beat. Anything it is unsure of waits for you in Memories."
          checked={settings.autoMemory}
          onChange={(autoMemory) => onPatchSettings({ autoMemory })}
        />
        <Toggle
          label="Notice new characters"
          description="Lists people the story names who are not in the cast, under the story’s Cast tab. Nothing is created without you."
          checked={settings.autoCharacters ?? true}
          onChange={(autoCharacters) => onPatchSettings({ autoCharacters })}
        />
        <Toggle
          label="Keep a long-run summary"
          description="Folds older messages into a running summary so a long story still fits."
          checked={settings.useStorySummary}
          onChange={(useStorySummary) => onPatchSettings({ useStorySummary })}
        />
      </section>

      <section className="qs-section">
        <h3 className="qs-heading">Go to</h3>
        <div className="qs-links">
          <QuickLink
            icon="user"
            label="Persona"
            detail={personaName ? `Writing as ${personaName}` : 'No persona set'}
            onClick={() => {
              onClose();
              onOpenPersona();
            }}
          />
          <QuickLink
            icon="settings"
            label="Response settings"
            detail={responseSummary}
            onClick={() => {
              onClose();
              onOpenResponseSettings();
            }}
          />
          <QuickLink
            icon="brain"
            label="Memories"
            detail="Everything the story remembers, and anything waiting for review."
            onClick={() => {
              onClose();
              onOpenMemories();
            }}
          />
          <QuickLink
            icon="layers"
            label="Context Inspector"
            detail={contextSummary ?? 'Exactly what is being sent, block by block.'}
            onClick={() => {
              onClose();
              onOpenInspector();
            }}
          />
          <QuickLink
            icon="settings"
            label="All settings"
            detail="Providers, context size, appearance."
            onClick={() => {
              onClose();
              onOpenAdvanced();
            }}
          />
        </div>
      </section>
    </Sheet>
  );
}

function QuickLink({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="qs-link" onClick={onClick}>
      <Icon name={icon} />
      <span>
        {label}
        <span className="qs-link-detail">{detail}</span>
      </span>
      <Icon name="chevronRight" width={15} height={15} />
    </button>
  );
}

/**
 * A scene field that writes when you leave it, not as you type.
 *
 * Every keystroke through onPatchChat would be a database write per character
 * and a re-render of the chat behind the sheet. Holding the text locally and
 * committing on blur keeps the stored scene in step with what is on screen
 * without making typing expensive.
 */
function SceneField({
  label,
  value,
  placeholder,
  hint,
  multiline,
  onCommit,
  derived,
  onUndo,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
  /** True when this value came from the story rather than from the user. */
  derived?: boolean;
  onUndo?: () => void;
}) {
  const [draft, setDraft] = useState(value);

  // Re-seed when the stored value changes underneath — reopening the sheet, or
  // another surface editing the same chat.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  // The shared field components take no onBlur, and adding one to them for a
  // single caller is a worse trade than a wrapper: focusout bubbles, so this
  // catches the same event without changing a component every form uses.
  return (
    <div onBlur={commit}>
      {multiline ? (
        <TextArea
          label={label}
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          hint={hint}
          rows={2}
        />
      ) : (
        <TextField
          label={label}
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          hint={hint}
        />
      )}
      {derived && onUndo && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          From the story.{' '}
          <button
            type="button"
            className="btn-link"
            onClick={onUndo}
            aria-label={`Undo the story's change to ${label}`}
          >
            Undo
          </button>
        </p>
      )}
    </div>
  );
}
