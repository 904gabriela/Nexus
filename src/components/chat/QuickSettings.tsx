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
import type { Character, Chat, ID, NarrationPreset, Settings } from '../../types';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Toggle } from '../ui/Field';
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
  settings: Settings;
  personaName: string | null;
  /** Token usage, when the user has asked to see counts. */
  contextSummary: string | null;
  onPatchChat: (patch: Partial<Chat>) => void | Promise<unknown>;
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
  settings,
  personaName,
  contextSummary,
  onPatchChat,
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
  const togglePresent = (character: Character) => {
    const current = scene.present.map((c) => c.id);
    const next = current.includes(character.id)
      ? current.filter((id) => id !== character.id)
      : [...current, character.id];
    // Everyone leaving the room is not a scene. Refusing the last removal is
    // kinder than accepting it and having the narrator address nobody.
    if (!next.length) return;
    onPatchChat({
      scene: {
        ...(chat.scene ?? { location: '', situation: '', objective: '', characterStates: [] }),
        presentCharacterIds: next,
        primaryCharacterId: next.includes(chat.scene?.primaryCharacterId ?? '')
          ? chat.scene?.primaryCharacterId
          : next[0],
      },
    });
  };

  return (
    <Sheet open={open} onClose={onClose} title="Chat settings" large>
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
        <h3 className="qs-heading">This scene</h3>
        {(scene.location || scene.situation) && (
          <dl className="qs-facts">
            {scene.location && (
              <>
                <dt>Where</dt>
                <dd>{scene.location}</dd>
              </>
            )}
            {scene.situation && (
              <>
                <dt>What is happening</dt>
                <dd>{scene.situation}</dd>
              </>
            )}
          </dl>
        )}
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
            detail="Direction and sampling for this chat."
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
