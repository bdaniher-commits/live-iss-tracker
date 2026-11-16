/**
 * MiniApp SDK (client side of the platform bridge).
 *
 * A MiniApp runs inside a sandboxed iframe at an opaque origin. It has no
 * network access of its own (the platform blocks it), no device access (no
 * camera / location / clipboard from the iframe) and no credentials — all
 * privileged work goes through this bridge to the OS host over postMessage.
 *
 * No dependencies, shipped inside the project; import everything from this
 * index. Import only what you use: unused calls are dropped from the bundle,
 * and the store audit checks every bridge call left in it against the
 * manifest.
 *
 * Permissions: every gated call needs a matching manifest declaration and the
 * user's grant. Optional items are granted at runtime — call
 * `ensurePermission([...])` right before the feature that needs them.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type AccessLevel = "read" | "readwrite";
export type LocationPrecision = "coarse" | "precise";

/** The app's current grant (normalized v2 snapshot from the host). */
export interface Granted {
  v: 2;
  files: { dir: string; access: AccessLevel; target: string }[];
  domains: string[];
  ai: { worker_id: string } | null;
  agents: { id: string; worker_id: string; fingerprint: string }[];
  /** Declared Blueprint / Skill aliases the user bound to one of their own
   *  (bridge 1.7; absent on older hosts). */
  blueprints?: { id: string; resource_id: string }[];
  skills?: { id: string; resource_id: string }[];
  notifications: boolean;
  grimoire: { read: { folders: string[]; tags: string[] } | null; write: "inbox" | null } | null;
  location: LocationPrecision | null;
  photos: boolean;
  camera: boolean;
  clipboard: boolean;
  contacts: boolean;
  calendar: AccessLevel | null;
  /** App Cloud (bridge 1.8): the declared room kinds and connections the user
   *  allowed, and whether their nickname/avatar is shared. */
  cloud?: { rooms: string[]; connections: string[]; profile: boolean } | null;
  picked: { id: string; path: string; kind: "file" | "folder"; access: AccessLevel }[];
}

export interface AppContext {
  appId: string;
  slug: string;
  windowId: string;
  lang: string;
  theme: "light" | "dark";
  accent: string;
  /** Host API level, e.g. "1.4" (absent on hosts older than 1.1). */
  bridgeVersion?: string;
  /** Request names this host answers (absent on hosts older than 1.1). */
  capabilities?: string[];
  /** The app's current grant (absent on hosts older than 1.1). */
  granted?: Granted;
}

type EventName =
  | "theme"
  | "lang"
  | "focus"
  | "ai.chunk"
  | "ai.done"
  | "ai.error"
  // ai.complete with onText (bridge 1.9).
  | "ai.complete.delta"
  // App Cloud (bridge 1.8): the `cloud` module subscribes to these for you.
  | "cloud.room.welcome"
  | "cloud.room.resumed"
  | "cloud.room.frame"
  | "cloud.room.state"
  | "cloud.room.presence"
  | "cloud.room.join"
  | "cloud.room.leave"
  | "cloud.room.leader"
  | "cloud.room.status"
  | "cloud.room.error"
  | "cloud.room.closed"
  | "cloud.fetch.chunk"
  | "cloud.fetch.end";
type EventHandler = (data: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Error codes the host answers with. */
export const ErrorCode = {
  /** Declared but not granted (yet): ask with permissions.request / ensurePermission. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** Not declared in manufact-app.json: no prompt can help — fix the manifest. */
  NOT_DECLARED: "NOT_DECLARED",
  /** The user dismissed a prompt or cancelled a picker. */
  USER_CANCELLED: "USER_CANCELLED",
  /** The operating system refused the device (camera, location, clipboard). */
  OS_DENIED: "OS_DENIED",
  /** Only while the app window is focused (call it from a user action).
   *  ai.chat / ai.complete started while the window is unfocused reject with
   *  this; calls already in flight keep running after the window blurs. */
  GESTURE_REQUIRED: "GESTURE_REQUIRED",
  /** A `pick:` path whose temporary grant expired: let the user pick again. */
  PICK_EXPIRED: "PICK_EXPIRED",
  /** No result from the device or service (no camera, no fix in time…). */
  UNAVAILABLE: "UNAVAILABLE",
  /** The bound agent was changed locally; the user must restore it. */
  AGENT_MODIFIED: "AGENT_MODIFIED",
  /** The bound agent is gone or no longer matches the app's pin. */
  AGENT_UNAVAILABLE: "AGENT_UNAVAILABLE",
  /** An update needs consent the user has not given yet. */
  RECONSENT_REQUIRED: "RECONSENT_REQUIRED",
  /** The server refuses AI calls this often for one app. */
  RATE_LIMITED: "RATE_LIMITED",
  /** The host does not offer this API (older host, or no such device). */
  NOT_SUPPORTED: "NOT_SUPPORTED",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
  // ── App Cloud (bridge 1.8). `e.details` may carry retry_after / sqlstate /
  // reason. ──
  /** The manifest has no `permissions.cloud` (or not this part of it):
   *  fix the manifest. */
  CLOUD_NOT_DECLARED: "CLOUD_NOT_DECLARED",
  /** The SQL is outside the whitelist (`details.reason` says why). */
  CLOUD_SQL_REJECTED: "CLOUD_SQL_REJECTED",
  /** Postgres refused it (`details.sqlstate`; 42501 = a row-level security
   *  policy said no, 23505 = unique violation…). */
  CLOUD_SQL_ERROR: "CLOUD_SQL_ERROR",
  /** Ran past its time limit (2 s per statement, 5 s per batch). */
  CLOUD_TIMEOUT: "CLOUD_TIMEOUT",
  /** Too many calls; retry after `details.retry_after` seconds. */
  CLOUD_RATE_LIMITED: "CLOUD_RATE_LIMITED",
  /** Storage, room state or another quota is full (SELECT/DELETE still work). */
  CLOUD_QUOTA_EXCEEDED: "CLOUD_QUOTA_EXCEEDED",
  /** The publisher's cloud is read-only (billing): only SELECT works. */
  CLOUD_READ_ONLY: "CLOUD_READ_ONLY",
  /** The platform switched this app's cloud off. */
  CLOUD_SUSPENDED: "CLOUD_SUSPENDED",
  /** The cloud could not be reached right now: try again later. */
  CLOUD_UNAVAILABLE: "CLOUD_UNAVAILABLE",
  /** The room is at `maxMembers`. */
  ROOM_FULL: "ROOM_FULL",
  /** setState with `ver` lost the race: someone else wrote the key first. */
  ROOM_STATE_CONFLICT: "ROOM_STATE_CONFLICT",
  /** A `policy` room's check said this user may not enter. */
  ROOM_FORBIDDEN: "ROOM_FORBIDDEN",
  /** send/setState/setPresence on a room that is not joined (or gone). */
  ROOM_NOT_JOINED: "ROOM_NOT_JOINED",
  /** A room frame over 16 KB. */
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  /** The publisher has not set this connection up (or switched it off). */
  CONN_UNAVAILABLE: "CONN_UNAVAILABLE",
  /** The publisher's service or database failed. */
  CONN_UPSTREAM_ERROR: "CONN_UPSTREAM_ERROR",
  /** The installed MoteOS is too old for App Cloud. */
  HOST_TOO_OLD: "HOST_TOO_OLD",
  // ai.complete (bridge 1.9).
  /** The user has no lightweight AI model (neither their own nor the
   *  platform's): hide the AI feature. */
  NO_AI_MODEL: "NO_AI_MODEL",
  /** Content moderation refused the prompt. */
  CONTENT_BLOCKED: "CONTENT_BLOCKED",
  /** The model failed while answering; trying again may work. */
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  /** The bound Blueprint or Skill needs tools (script, MCP, connector,
   *  browser, knowledge base, Grimoire or skill nodes; a skill that runs
   *  commands), which MiniApp ai.chat turns never have. Refused before any
   *  credits are spent: fetch the data in the app and pass it as text, or
   *  hand the task off to the user's companion chat. */
  RESOURCE_NEEDS_TOOLS: "RESOURCE_NEEDS_TOOLS",
  // ai.chat tool blueprints (bridge 1.10). `e.details.id` names the alias.
  /** A prompt was passed, or variableValues do not fit the blueprint's
   *  inputs (not strings, unknown or missing names, over 4,000 characters
   *  each / 16,000 together, control characters). Fix the call. */
  TOOL_BLUEPRINT_BAD_INPUT: "TOOL_BLUEPRINT_BAD_INPUT",
  /** The alias is not declared in permissions.toolBlueprints or the user did
   *  not grant it: hide the feature or point to the app's settings. */
  TOOL_BLUEPRINT_NOT_GRANTED: "TOOL_BLUEPRINT_NOT_GRANTED",
  /** The pinned version no longer matches what the user consented to (or is
   *  no longer usable, `details.reason`): the user reviews it in the app's
   *  settings; the host shows a notice. */
  TOOL_BLUEPRINT_PIN_MISMATCH: "TOOL_BLUEPRINT_PIN_MISMATCH",
  /** The run tried a tool outside the blueprint's allowlist and was stopped
   *  (`details.tool`). Nothing to retry from the app. */
  TOOL_DENIED: "TOOL_DENIED",
  /** The `conversationId` passed is not an earlier conversation of this
   *  app's same tool blueprint run: drop it and start fresh. */
  MINIAPP_CONVERSATION_INVALID: "MINIAPP_CONVERSATION_INVALID",
  // App Cloud additions.
  /** This user is banned from the app's cloud by the publisher or platform. */
  CLOUD_BANNED: "CLOUD_BANNED",
  /** A listed app's connection host is waiting for platform review. */
  CONN_PENDING_REVIEW: "CONN_PENDING_REVIEW",
  /** The platform did not approve the connection's host. */
  CONN_HOST_REJECTED: "CONN_HOST_REJECTED",
  /** An OAuth 2.0 client-credentials connection could not get a token. */
  CONN_AUTH_FAILED: "CONN_AUTH_FAILED",
  /** A paid app whose purchase or subscription is not active for this user. */
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
} as const;

/** Codes that mean "not allowed / not given" rather than "broken". */
const PERMISSION_CODES = new Set<string>([
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.NOT_DECLARED,
  ErrorCode.USER_CANCELLED,
  ErrorCode.OS_DENIED,
  ErrorCode.GESTURE_REQUIRED,
  ErrorCode.PICK_EXPIRED,
  ErrorCode.AGENT_MODIFIED,
  ErrorCode.AGENT_UNAVAILABLE,
  ErrorCode.RECONSENT_REQUIRED,
  "AI_NOT_GRANTED",
]);

export class BridgeError extends Error {
  code: string;
  /** Extra facts from the server (App Cloud, bridge 1.8): `retry_after`,
   *  `sqlstate`, `reason`, `index`… Absent on most errors. */
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (details) this.details = details;
  }
}

/** A refusal: a permission not declared / not granted / denied by the user or
 *  the OS. Handle it with a friendly fallback, never as a crash. */
export class PermissionError extends BridgeError {
  /** For PERMISSION_DENIED from ensurePermission: the keys still not granted. */
  denied: string[];
  constructor(code: string, message: string, denied: string[] = []) {
    super(code, message);
    this.name = "PermissionError";
    this.denied = denied;
  }
}

export function toError(code: string, message: string, details?: Record<string, unknown>): BridgeError {
  if (PERMISSION_CODES.has(code)) {
    const e = new PermissionError(code, message);
    if (details) e.details = details;
    return e;
  }
  return new BridgeError(code, message, details);
}

// ── Transport ────────────────────────────────────────────────────────────────

const BRIDGE_VERSION = 1;
/** Host API level this SDK speaks, reported in the handshake. From "1.5" on,
 *  the host keeps its loading screen up until `app.loaded()` (or a timeout);
 *  "1.6" adds handing unused shortcuts back to the host (see below); "1.7"
 *  lets ai.chat run a declared Blueprint or Skill; "1.8" adds App Cloud
 *  (the `cloud` namespace); "1.9" adds ai.complete (the lightweight model). */
const SDK_API = "1.9";
const parentWindow = window.parent;

let context: AppContext | null = null;
let nonce: string | null = null;
let seq = 0;
const pending = new Map<string, Pending>();
const listeners = new Map<EventName, Set<EventHandler>>();
let readyResolve: (ctx: AppContext) => void;
const readyPromise = new Promise<AppContext>((r) => (readyResolve = r));

function isFromHost(e: MessageEvent): boolean {
  return e.source === parentWindow;
}

function post(msg: unknown): void {
  // The host is the parent window; target "*" because the app cannot know the
  // host origin at build time and never sends anything sensitive upward.
  parentWindow.postMessage(msg, "*");
}

window.addEventListener("message", (e: MessageEvent) => {
  if (!isFromHost(e)) return;
  const d = e.data;
  if (!d || typeof d !== "object") return;

  if (d.type === "hello") {
    context = d.ctx as AppContext;
    nonce = d.nonce;
    post({ type: "ready", nonce, sdk: SDK_API });
    readyResolve(context);
    return;
  }

  if (d.type === "response") {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.data);
    else p.reject(toError(d.error?.code ?? "INTERNAL", d.error?.message ?? "error", d.error?.details));
    return;
  }

  if (d.type === "event") {
    if (d.name === "theme" && context) context = { ...context, ...(d.data as object) };
    if (d.name === "lang" && context) context = { ...context, lang: (d.data as { lang: string }).lang };
    const set = listeners.get(d.name as EventName);
    if (set) for (const cb of set) cb(d.data);
    return;
  }
});

/** Resolves once the host handshake completed; yields the initial context. */
export function ready(): Promise<AppContext> {
  return readyPromise;
}

/** The current context (null before the handshake completes). */
export function getContext(): AppContext | null {
  return context;
}

/** Low-level request; prefer the typed helpers below. */
export function request<T = unknown>(api: string, params?: unknown): Promise<T> {
  const id = `q${++seq}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ v: BRIDGE_VERSION, id, type: "request", api, params });
  });
}

/** Subscribe to a host event (theme/lang/focus/ai.*). Returns an unsubscribe fn. */
export function on(event: EventName, cb: EventHandler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);
  return () => set!.delete(cb);
}

// ── Capability detection ─────────────────────────────────────────────────────

/** API families added in bridge 1.1+; everything else predates versioning.
 *  (A pattern, not a list of names: the store audit reads quoted bridge call
 *  names in the bundle as calls the app makes.) */
const NEWER_API = /^(permissions|grimoire|contacts|calendar|location|camera|photos|clipboard|cloud)\.|^files\.pick$|^app\.(loaded|hostKey)$/;

/** The host API level ("1.0" for hosts that predate versioning). */
export function bridgeVersion(): string {
  return context?.bridgeVersion ?? "1.0";
}

/** Compare dotted versions component by component ("1.10" > "1.9"; never
 *  parseFloat, which reads "1.10" as 1.1). Negative, 0 or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether the host API level is at least `min` (e.g. "1.10"). */
export function bridgeAtLeast(min: string): boolean {
  return compareVersions(bridgeVersion(), min) >= 0;
}

/** Whether this host answers `api` (e.g. "camera.capture"). Device APIs are
 *  listed only where the device exists, so hide the feature when false. Call
 *  after `ready()`. */
export function supports(api: string): boolean {
  const caps = context?.capabilities;
  return caps ? caps.includes(api) : !NEWER_API.test(api);
}

// ── First screen (bridge 1.5) ────────────────────────────────────────────────

let loadedOnce: Promise<void> | null = null;

/**
 * Tell the host the first screen is ready, so it fades out its loading
 * animation. Call it once the first meaningful render is on screen (after the
 * first frame / asset load for a game). Idempotent and safe on older hosts;
 * without it the host waits up to 8 seconds before revealing the app.
 */
export function loaded(): Promise<void> {
  if (!loadedOnce) {
    loadedOnce = readyPromise
      .then(() => (supports("app.loaded") ? request<null>("app.loaded") : null))
      .then(
        () => undefined,
        () => undefined,
      );
  }
  return loadedOnce;
}

// ── Shell shortcuts (bridge 1.6) ─────────────────────────────────────────────

// Keys pressed inside this iframe never reach the OS shell, so its menu bar
// and global shortcuts (⌘, settings, ⌘W, ⌘K…) would go dead while the app has
// focus. A ⌘/Ctrl/⌥ key the app did not handle (not `preventDefault`ed) is
// handed back to the host. Bubble phase on `window`, so the app's own handlers
// run first and win. Plain typing is never sent; ⌘Q / Ctrl+Q is never sent.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.defaultPrevented || e.isComposing) return;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return;
  if ((e.metaKey || e.ctrlKey) && (e.code === "KeyQ" || e.key.toLowerCase() === "q")) return;
  if (!context?.capabilities?.includes("app.hostKey")) return;
  const { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } = e;
  request<null>("app.hostKey", { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat }).catch(() => undefined);
});

// ── App / UI ─────────────────────────────────────────────────────────────────

export const app = {
  ready,
  loaded,
  getContext,
  request,
  on,
  supports,
  bridgeVersion,
  setTitle: (title: string) => request<null>("app.setTitle", { title }),
  close: () => request<null>("app.close"),
};

/** Needs `permissions.notifications`. */
export const ui = {
  notify: (opts: { title: string; body?: string }) => request<string>("ui.notify", opts),
};

// ── Permissions (bridge 1.1) ─────────────────────────────────────────────────

/**
 * Permission keys, as used by `permissions.request` / `ensurePermission`:
 * "files:<dir>" (the declared dir, without "shared:"), "domains:<host>", "ai",
 * or a category: "notifications", "grimoire", "location", "photos", "camera",
 * "clipboard", "contacts", "calendar". App Cloud's optional parts:
 * "cloud.connections:<name>", "cloud.profile" (`cloud` itself and every
 * room kind are granted at install). Agents, Blueprints and Skills are
 * bound by the user at install or in the app's settings, never requested at
 * runtime.
 */
export type PermissionKey = string;

/** Keys a normalized grant holds. */
export function heldKeys(g: Granted | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!g) return out;
  for (const f of g.files ?? []) out.add(`files:${f.dir}`);
  for (const h of g.domains ?? []) out.add(`domains:${h}`);
  if (g.ai) out.add("ai");
  for (const a of g.agents ?? []) out.add(`agents:${a.id}`);
  for (const r of g.blueprints ?? []) out.add(`blueprints:${r.id}`);
  for (const r of g.skills ?? []) out.add(`skills:${r.id}`);
  for (const k of ["notifications", "photos", "camera", "clipboard", "contacts"] as const) if (g[k]) out.add(k);
  for (const k of ["grimoire", "location", "calendar"] as const) if (g[k] != null) out.add(k);
  if (g.cloud) {
    out.add("cloud");
    for (const k of g.cloud.rooms ?? []) out.add(`cloud.rooms:${k}`);
    for (const n of g.cloud.connections ?? []) out.add(`cloud.connections:${n}`);
    if (g.cloud.profile) out.add("cloud.profile");
  }
  return out;
}

export const permissions = {
  /** What the installed version declares and what the user granted. */
  query: () => request<{ declared: unknown; granted: Granted }>("permissions.query"),
  /** Ask for declared optional items (window must be focused). A refusal is a
   *  result, not an error: `denied` lists what is still not granted. */
  request: (keys: PermissionKey[]) =>
    request<{ granted: Granted; denied: string[] }>("permissions.request", { keys }),
};

/**
 * Make sure `keys` are granted, asking the user for the missing ones. Call it
 * from a user action, right before the feature that needs them. Resolves with
 * the grant; throws PermissionError (PERMISSION_DENIED with `denied`,
 * NOT_DECLARED, USER_CANCELLED, GESTURE_REQUIRED) otherwise. On hosts older
 * than bridge 1.1 everything was granted at install, so it resolves as is.
 */
export async function ensurePermission(keys: PermissionKey[]): Promise<Granted | null> {
  await ready();
  if (!supports("permissions.query")) return null;
  const { granted } = await permissions.query();
  const held = heldKeys(granted);
  const missing = keys.filter((k) => !held.has(k));
  if (missing.length === 0) return granted;
  const res = await permissions.request(missing);
  if (res.denied.length) {
    throw new PermissionError(ErrorCode.PERMISSION_DENIED, `not granted: ${res.denied.join(", ")}`, res.denied);
  }
  return res.granted;
}

// ── Files ────────────────────────────────────────────────────────────────────

export interface FileOptions {
  /** "base64" reads/writes binary content as a base64 string. */
  encoding?: "base64";
}

export interface PickedItem {
  /** `pick:<token>` (a file) or `pick:<token>/` (a folder): use with files.*. */
  path: string;
  name: string;
  kind: "file" | "folder";
  access: AccessLevel;
  /** Kept until the user revokes it in the app's settings. */
  persisted: boolean;
}

/**
 * Paths: a bare path is the app's private data dir (always allowed);
 * "shared:<declared dir>/…" is a declared folder the user granted (possibly
 * remapped by the user — the app never sees where); "pick:<token>…" is
 * something the user chose with files.pick.
 */
export const files = {
  read: (path: string, opts?: FileOptions) =>
    request<string>("files.read", { path, encoding: opts?.encoding }),
  write: (path: string, content: string, opts?: FileOptions) =>
    request<null>("files.write", { path, content, encoding: opts?.encoding }),
  list: (path: string) => request<string[]>("files.list", { path }),
  /** Let the user choose files or a folder (no declaration needed; bridge 1.2).
   *  Cancel throws PermissionError USER_CANCELLED. */
  pick: (opts: {
    kind: "file" | "folder";
    access?: AccessLevel;
    /** Files only. */
    multiple?: boolean;
    /** Files only, e.g. ["csv", "txt"]. */
    extensions?: string[];
    /** Offer "Always allow" so the pick survives restarts. */
    persist?: boolean;
  }) => request<{ items: PickedItem[] }>("files.pick", opts),
};

export const storage = {
  get: (key: string) => request<unknown>("storage.get", { key }),
  set: (key: string, value: unknown) => request<null>("storage.set", { key, value }),
  remove: (key: string) => request<null>("storage.remove", { key }),
};

export interface DbResult {
  columns: string[];
  /** Row values are SQLite types; BLOB columns arrive as base64 strings. */
  rows: unknown[][];
  changes: number;
  last_insert_rowid: number;
}

/**
 * Private per-app SQLite database (server-side, quota'd). One statement per
 * call; always bind values via `params`, never string-concatenate them.
 */
export const db = {
  query: (sql: string, params: unknown[] = []) =>
    request<DbResult>("db.query", { sql, params }),
  exec: (sql: string, params: unknown[] = []) =>
    request<DbResult>("db.query", { sql, params }),
};

// ── Network ──────────────────────────────────────────────────────────────────

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Text body (JSON.stringify objects yourself). */
  body?: string;
}

/** Fetch through the platform proxy; the host must be in `permissions.domains`. */
export function fetchExternal(
  url: string,
  init: FetchInit = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return request("fetch", { url, method: init.method, headers: init.headers, body: init.body });
}

// ── AI ───────────────────────────────────────────────────────────────────────

/** `ai.chat` / `ai.start` (an agent turn: `permissions.ai` or
 *  `permissions.agents`) and `ai.complete` (bridge 1.9: one quick answer
 *  from the user's lightweight model: `permissions.ai`). See ./ai.ts. */
export * as ai from "./ai";
export type { StartOptions, ChatOptions, ResourceOptions, CompleteOptions, CompleteMessage, CompleteResult } from "./ai";

// ── Grimoire (bridge 1.3) — the user's knowledge base, never via files ──────
// One module per namespace whose methods need different permissions, so a
// bundle keeps only the methods it calls (the store audit reads them).

/** Needs `permissions.grimoire` (read: folders/tags scope; write: "inbox"). */
export * as grimoire from "./grimoire";
export type { GrimoirePage } from "./grimoire";

// ── Contacts (bridge 1.3) ────────────────────────────────────────────────────

export interface Contact {
  user_id: string;
  nickname: string;
  /** data: URL, or null. */
  avatar_url: string | null;
}

/** Needs `permissions.contacts`. */
export const contacts = {
  list: () => request<{ items: Contact[] }>("contacts.list"),
};

// ── Calendar (bridge 1.3) ────────────────────────────────────────────────────

/** Needs `permissions.calendar` (access "readwrite" for create/update/delete). */
export * as calendar from "./calendar";
export type { CalendarEvent, CalendarEventInput } from "./calendar";

// ── Devices (bridge 1.4) — reached by the host, results come back as data ───

export interface LocationResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
  /** What was delivered: "coarse" when the grant is coarse. */
  precision: LocationPrecision;
}

/** A JPEG at most `maxEdge` (default 2048) px on the long side. */
export interface ImageResult {
  dataUrl: string;
  mime: "image/jpeg";
  width: number;
  height: number;
}

/** Needs `permissions.location`. Check `supports("location.get")` first. */
export const location = {
  get: (opts: { precision?: LocationPrecision; timeoutMs?: number } = {}) =>
    request<LocationResult>("location.get", opts),
};

/** Needs `permissions.camera`. Check `supports("camera.capture")` first. */
export const camera = {
  capture: (opts: { facing?: "user" | "environment"; maxEdge?: number } = {}) =>
    request<ImageResult>("camera.capture", opts),
};

/** Needs `permissions.photos`. */
export const photos = {
  pick: (opts: { multiple?: boolean; max?: number; maxEdge?: number } = {}) =>
    request<{ items: (ImageResult & { name: string })[] }>("photos.pick", opts),
};

/** write: no declaration needed; read: needs `permissions.clipboard` and
 *  shows a host prompt the user confirms. Both need the window focused. */
export * as clipboard from "./clipboard";

// ── App Cloud (bridge 1.8) — the publisher's shared backend ─────────────────
// Shared database (RLS), realtime rooms and the publisher's connections. The
// data lives in the publisher's App Cloud, not on the user's volume. Needs
// `permissions.cloud`; check `cloud.available()` first (false on older hosts).

export * as cloud from "./cloud";
export type {
  CloudMe,
  CloudQueryResult,
  CloudStatement,
  CloudFetchInit,
  CloudFetchResult,
  CloudQueryRows,
} from "./cloud";
export type { Room, RoomMember, RoomEventMap, RoomStatus, JoinOptions } from "./cloudRooms";
