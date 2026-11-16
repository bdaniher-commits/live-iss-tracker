# Live ISS Tracker

A MiniApp built with Vite + React + TypeScript.

## Develop

```bash
npm install
npm run dev     # live preview inside the OS (HMR via polling)
```

## Build & publish

```bash
npm run build   # emits dist/
```

The platform publishes the `dist/` bundle: it is copied server-side into a
versioned location, and installing the app makes it appear on the desktop.

## SDK

The app runs in a sandboxed iframe with no direct network, filesystem or
device access. Everything goes through `src/manufact-sdk`:

- `app.ready()` / `app.getContext()` — handshake, theme/accent/lang, `bridgeVersion`,
  `capabilities`, current grant; `supports(api)` for feature detection
- `app.loaded()` — call once the first screen is rendered; the host shows a
  loading animation until then (up to 8 seconds)
- `on("theme" | "lang" | "focus", cb)` — follow OS changes
- Shell shortcuts (⌘, for the app's settings, ⌘W, ⌘K, …) keep working while
  the app has focus: the SDK (≥ 1.6) hands any ⌘/Ctrl/⌥ key the app did not
  `preventDefault()` back to the OS. Call `preventDefault()` on keys you handle.
- `ensurePermission(keys)` / `permissions.query()` / `permissions.request(keys)`
- `files.*` (private data, `shared:<dir>`, `files.pick`), `storage.*`, `db.*`
- `fetchExternal(url, init)` — needs the URL's host in `permissions.domains`
  (bare host such as `api.open-meteo.com`: no scheme, port or wildcard);
  resolves to `{ status, headers, body }` with `body` as text, so
  `JSON.parse(res.body)` yourself
- `ai.chat(prompt, { agent })` / `ai.start(...)` — an Agent turn; needs
  `permissions.ai` with `"worker": "required"` or `"optional"` (or an agent)
- `ui.notify(...)`
- `ai.chat(prompt, { blueprint: "<alias>", variableValues })` /
  `ai.chat(prompt, { skill: "<alias>" })` (SDK ≥ 1.7) — run the turn as the
  user's own Blueprint or Skill bound to a declared alias (one or the other)
- `ai.chat({ toolBlueprint: "<alias>", variableValues })` (SDK ≥ 1.10, check
  `supports("ai.chat.toolBlueprint")`) — run a Market Blueprint pinned in
  `permissions.toolBlueprints` with exactly the tools the user consented to;
  no prompt, typed string inputs only, only its final text comes back.
  Compare bridge versions with `bridgeAtLeast("1.10")` (never `parseFloat`)
- `ai.complete(prompt, { system, messages, maxTokens, temperature, json, onText })`
  (SDK ≥ 1.9) — one quick answer from the user's lightweight AI model (no
  Agent, no tools). An app whose only AI call is this declares
  `"ai": { "worker": "none", "purpose": "…" }` (no agent to pick at install,
  billed to the user's credits). Use it for frequent short text (game
  dialogue, hints); `ai.chat` for Agent work
- Game AI in your own code (computer opponents, bots, NPC logic, solvers,
  minimax/MCTS) is plain code: it needs no `ai` permission at all
- AI turns are text in, text out: the Agent has no tools, files, web or the
  user's memory in a MiniApp turn. Put everything it needs in the prompt and
  fetch data with `files.*` / `fetchExternal` / the other SDK calls first.
- `grimoire.*`, `contacts.list()`, `calendar.*`
- `location.get()`, `camera.capture()`, `photos.pick()`, `clipboard.read/write()`
- `cloud.*` (SDK ≥ 1.8, needs `permissions.cloud`) — App Cloud, the
  publisher's shared backend: `cloud.available()` (false on older hosts: show
  an update notice), `cloud.me()`, `cloud.db.query/exec/batch` (shared
  Postgres; tables and row-level security policies in
  `cloud/migrations/NNNN_name.sql`), `cloud.rooms.join(kind, room)` (realtime
  presence, frames, compare-and-set state), `cloud.fetch(conn, …)` /
  `cloud.query(conn, name, params)` (the publisher's connections),
  `cloud.report(…)`. Check `cloud/` with `app-dev cloud lint --dir .`

Refusals reject with `PermissionError` (`code`: `NOT_DECLARED`,
`PERMISSION_DENIED`, `USER_CANCELLED`, `OS_DENIED`, `GESTURE_REQUIRED`, …).

## Manifest

`manufact-app.json` declares the app identity, the permissions it needs and
the input devices it supports. Only declared, user-granted capabilities work
at runtime. Declare the minimum; every sensitive item needs a `purpose` (shown
to the user at consent; the store refuses a listing without one). Items with
`"required": false` are asked for at runtime with `ensurePermission`. An
object without `required` counts as required.

```json
"permissions": {
  "files": [
    { "dir": "Documents/Receipts", "access": "read", "purpose": "Import receipts you saved", "required": false }
  ],
  "domains": ["api.example.com"],
  "ai": { "worker": "optional", "purpose": "Summarize your notes", "required": false },
  "blueprints": [{ "id": "weekly-plan", "name": "Weekly plan", "purpose": "Turn your tasks into a weekly plan", "required": false }],
  "skills": [{ "id": "tone", "name": "Writing tone", "purpose": "Rewrite drafts in your own tone", "required": false }],
  "notifications": { "required": false, "purpose": "Remind you when a timer ends" },
  "grimoire": { "read": { "folders": ["notes/recipes"], "tags": [] }, "write": "inbox", "required": false, "purpose": "Save recipes to your Grimoire" },
  "location": { "precision": "coarse", "required": false, "purpose": "Show local weather" },
  "camera": { "required": false, "purpose": "Scan a receipt" },
  "photos": { "required": false, "purpose": "Attach a picture" },
  "clipboard": { "read": true, "required": false, "purpose": "Paste a tracking number" },
  "contacts": { "required": false, "purpose": "Split a bill with friends" },
  "calendar": { "access": "readwrite", "required": false, "purpose": "Add due dates to your calendar" }
},
"devices": { "touch": true, "keyboard": "optional" }
```

This lists every category for reference — a real app declares only what it
uses. `ai.worker` is `"none"` for an app that only calls `ai.complete`
(`{ "worker": "none", "purpose": "Give hints in the puzzle" }`), and
`"required"` / `"optional"` only for one that runs `ai.chat` / `ai.start`;
leave `ai` out when no language model is called. `domains` lists every host
`fetchExternal` calls; after a version is installed, adding one means
publishing a new version, which installed copies get once the user accepts
the upgrade. `agents` entries (market agents the app depends on) are pinned by App
Forge (`id`, `version`, `fingerprint`); do not edit those by hand.
`blueprints` / `skills` entries are aliases (`id`, chosen by the app) the user
binds to one of their own Blueprints / Skills at install (or later in the
app's settings); they run through
`ai.chat`, so the app also declares `ai` with a worker (or an agent). Declare them
`"required": false` unless the app cannot work without them, pass the alias as
a string literal (`ai.chat(text, { skill: "tone" })`), and treat
`PERMISSION_DENIED` (alias not bound) as "feature unavailable". MiniApp turns
have no tools: only prompt-only Blueprints (LLM reasoning/formatting nodes) and
instruction-only Skills run; one with script, MCP, connector, browser,
knowledge-base, Grimoire or skill steps is refused with `RESOURCE_NEEDS_TOOLS`
before any credits are spent. Fetch the data in the app and pass it in the
prompt or `variableValues`; hand flows that need tools to the user's companion
chat. `toolBlueprints` entries pin a published Market Blueprint that may use
tools (`id`, `listing_id`, `version`, `fingerprint`, `purpose`, `required`):
copy the pin from App Forge's permissions editor, never invent it; they need
`ai` with a `"required"` / `"optional"` worker. Start AI calls while the window
is focused (`GESTURE_REQUIRED` otherwise; calls in flight finish after a blur).
Never put an App Cloud service key (`sk_…`) anywhere in this project: it
belongs on the publisher's server (publishing refuses it).
`devices`: keep the default (works on touch screens; keyboard optional) unless
the app truly cannot work without a keyboard (`"keyboard": "required"`).

`permissions.cloud` (`db`, `rooms`, `connections`, `profile`, each with a
`purpose`) turns on App Cloud. Its shared data belongs to the publisher, which
the user is told at install.

`splash` picks the loading animation the host shows until `app.loaded()`:

```json
"splash": { "style": "icon-pulse", "background": "theme", "image": "./splash.svg" }
```

`style` is `icon-pulse` (default), `spinner`, `bar` or `none`; `background` is
`theme` (default) or a `#rrggbb` color; the optional `image` (svg/png/webp,
at most 256 KB, next to the manifest) replaces the app icon. A missing or
invalid `splash` falls back to the default.
