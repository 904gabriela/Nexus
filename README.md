# Nexus

A private, local-first AI roleplay engine. You create a story — its characters,
your persona, its world — and then you play. Nexus remembers what matters,
follows the scene as it moves, keeps track of who stands where with whom, and
decides what the AI needs to be told for each turn, so you can stay inside the
story instead of managing its context by hand.

Everything lives in your browser, on your machine. There are no accounts, no
servers and no credits. The AI itself runs wherever you point Nexus — most
often [Ollama](https://ollama.com) on the same computer.

## What you need

- **Node.js** — version 22 or newer. Download from [nodejs.org](https://nodejs.org).
- **Ollama** with at least one model pulled, for example:

  ```
  ollama pull llama3.1
  ```

## Run it

In a terminal, inside this folder:

```
npm install
npm run dev
```

Then open **http://localhost:5173** in your browser. The first command only
needs running once; after that, `npm run dev` is enough.

## Your first five minutes

1. **Connect your AI.** Settings → AI Providers → Add provider → choose
   *Ollama*. Set the Base URL to `http://localhost:11434`, press *Fetch models*,
   pick one, and save.
2. **Make a character.** Library → Characters → New. Or bring one in from
   elsewhere: Transfer accepts SillyTavern character cards, lorebooks and
   personas.
3. **Make yourself.** Library → Personas → New. This is who *you* are in the
   story.
4. **Make a story.** Stories → New. Add your character to the cast, choose your
   persona, and — if you have one — attach a lorebook for the world.
5. **Play.** Open the story and start a chat.

## What Nexus does while you play

Most of this is on from the moment you start. You do not have to switch it on
or manage it, and you can always look at what it has done and take it back.

- **It remembers.** Every few replies, Nexus quietly asks the AI what in the
  exchange is worth keeping — a promise, a revelation, a shift between two
  people — and files it. Hundreds of messages later, when it matters again, the
  memory comes back. Everything it keeps is under *Memories*, where you can
  edit, pin or delete anything it got wrong.
- **The scene follows the story.** When your characters leave the kitchen for
  the rooftop, the top of every prompt follows them. Each move is announced and
  can be undone from *Chat settings → This scene*. What you wrote about the
  scene yourself is never overwritten.
- **It notices people.** When someone new is named, Nexus offers them in the
  story's Cast tab and, until you decide, reminds the AI they exist so they are
  not reinvented every turn.
- **It tracks how people stand.** A falling-out or a growing closeness is
  recorded beside your own notes about the pair, never written over them.
- **It stays on your timeline.** Branch a chat and take a different path, and
  memories, scene changes and relationships that only happened on the other
  path stay there.

**If you want less of this:** Settings → Memory. Scene changes can be set to
*notice and ask* instead of applying automatically, and memory can be turned
off entirely. A small local model will sometimes read a scene wrong — "maybe
they should go to the rooftop" is not the same as going there, and whether the
AI can tell the difference is up to the AI. The undo is there for exactly that.

**To see what the AI is being told:** open a chat, then Chat settings →
Context Inspector. Every block of the prompt is shown, with why it was
included, what was left out, and why.

## Keep your stories safe

Nexus stores everything in your browser. That means a cleared browser, a new
computer or a different browser starts empty. Take a backup:

Transfer → Backup & Restore → **Download full backup**

The file contains everything — characters, stories, chats, memories, lore —
and can be restored on the same screen. API keys are never included in any
export.

## From a phone or another device

Nexus is built to be played from a phone. Run it on your computer with

```
npm run dev -- --host
```

and open the address it prints on your phone's browser. In the provider
settings, use your computer's address on your home network rather than
`localhost` — Nexus will tell you if you have it wrong. If your phone cannot
reach Ollama, Ollama needs to be started so it accepts connections from other
devices:

```
OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve
```

## For developers

```
npm run build       # typecheck and production build
npm run lint
npm run test        # full Playwright suite, both phone and desktop
npm run preview     # serve the production build
```

The document format Nexus exports and imports is described in
[`docs/nexus-json.md`](docs/nexus-json.md). Tests live in `tests/` and run
against a mocked model; nothing in them claims to validate how a real model
behaves.
