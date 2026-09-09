# The Nexus document format

Everything Nexus exports — a character, a persona, a lorebook, a story, a chat,
a memory, or the whole library — is one shape: an envelope over flat, typed
collections. `kind` says what the file is *about*; it does not change the
structure. A character export and a full backup differ only in which
collections are filled.

Defined in [`src/schema/nexus.ts`](../src/schema/nexus.ts).

## Envelope

```jsonc
{
  "format": "nexus",           // always
  "schema": 1,                 // version of *this* format
  "kind": "character",         // character | persona | lorebook | lore-entry |
                               // story | chat | memory | backup | mixed
  "exportedAt": "2026-08-31T09:12:44.101Z",
  "generator": { "app": "Nexus", "schemaVersion": 5 },
  "primaryId": "chr_a1b2",     // the subject, when the file is about one thing

  // …collections…
}
```

`schema` versions the document format and moves only when the document shape
changes. `generator.schemaVersion` is the app's own storage version, recorded
for diagnosis; readers should not branch on it.

`primaryId` names the row the file is about, so a reader can tell the exported
character from the lorebooks that came along with it. It is absent from a
backup, which is about nothing in particular.

## Collections

Every collection is optional, and an empty one is omitted rather than written
as `[]`. Each is a flat array of Nexus's own row type — the same objects the
app stores, with no renaming, nesting or per-kind wrapper.

| Key | Contents |
| --- | --- |
| `characters` | Character rows |
| `personas` | Persona rows |
| `lorebooks` | Lorebook rows |
| `loreEntries` | Lore entries, each carrying its own `lorebookId` |
| `stories` | Story rows |
| `chats` | Chat rows |
| `branches` | Branches, each carrying its `chatId` |
| `messages` | Messages, each carrying its `chatId` and `branchId` |
| `alternatives` | Alternative generations for a message |
| `checkpoints` | Named points in a chat |
| `memories` | Memory rows |
| `storySummaries` | Long-run rolling summaries |
| `sceneDeltas` | Scene changes the story established, each naming the turns it was read from |
| `relationshipDeltas` | Changes to where two people stand, likewise named to their turns |
| `providers` / `imageProviders` | Provider config, **never** API keys |
| `mediaMeta` | Metadata for stored images |
| `settings` | App settings. Whole-library documents only. |
| `media` | `{ [mediaId]: "data:image/png;base64,…" }` |
| `mediaIncluded` | `false` when a backup deliberately left images out |

Relationships are by id, in the direction the row already stores them: a lore
entry names its lorebook, a message names its branch. Nothing is nested, so a
reader never has to walk a tree to find a row.

### Media

Images travel in `media`, keyed by the media id the rows already reference —
a character's `avatarMediaId`, a story's `coverMediaId`. There is no separate
avatar field: an avatar is a media entry like any other. On import, a document
with exactly one character or persona also has its subject's image pulled back
out of `media`, because the incoming media id may mean nothing on the reading
install.

### What is never exported

API keys. Provider rows keep their configuration — base URL, model, sampling
defaults — and their `apiKey` is emptied on every export path, backups
included.

## Reading a document

```ts
import { isNexusDocument, fromLegacyEnvelope } from './schema/nexus';

const doc = isNexusDocument(parsed) ? parsed : fromLegacyEnvelope(parsed);
if (!doc) {
  // Not ours. Fall through to the foreign-format detectors.
}
```

Rows in a document are used as they are — they are already Nexus's own types,
so passing them through the character-card normalisers would be destructive
(those rebuild a character from `first_mes` and card keys, and know nothing
about a `greetings` array or an id). They are layered over factory defaults
instead, which costs nothing for a real export and makes a partial or
hand-written document safe.

## Backward compatibility

Nexus previously wrote a `nexus-tavern-pro` envelope whose `data` payload had a
different shape per kind:

```jsonc
// character
{ "character": {…}, "avatar": "data:…", "lorebooks": [{ "lorebook": {…}, "entries": [] }] }
// story
{ "story": {…}, "characters": [], "persona": {…}, "chats": [{ "chat": {…}, "messages": [] }] }
// backup — already flat
{ "characters": [], "stories": [], … }
```

Every one of those still imports. `fromLegacyEnvelope` lifts them into
documents and is the only code that knows the old shapes exist; nothing writes
them any more. A file carrying the old marker whose payload matches none of
them falls through to the foreign-format detectors rather than being rejected.

## Foreign formats

SillyTavern character cards (v1, v2, PNG-embedded), Chub packs, world-info
dumps, Agnai exports and plain chat logs are converted into this format at the
edge, in `src/importers/`. Nothing SillyTavern-shaped reaches storage.

Nexus can still *write* a v2 character card on request — see
`exportCharacterAsCardV2` — for moving a character to another app. That is an
interoperability output, not Nexus's own format.
