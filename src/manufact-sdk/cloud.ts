/**
 * App Cloud (bridge 1.8): the publisher's shared backend for this app.
 *
 * - `db`: a Postgres schema shared by every user of the app. Tables are
 *   created by `cloud/migrations/NNNN_name.sql`; row-level security policies
 *   (written with `app.user_id()`) decide who reads and writes which rows.
 * - `rooms`: realtime rooms (presence, broadcast frames, small shared state).
 * - `fetch` / `query`: the publisher's own HTTP service or database through a
 *   named connection; the secrets stay on the server.
 *
 * The data belongs to the publisher (it is shown at install): never store
 * anything here the user would not expect the publisher to see. The iframe
 * still has no network: the host makes every call. Needs `permissions.cloud`.
 * Imported as `cloud` from the SDK index.
 */
import { bridgeAtLeast, on, request, supports, toError } from "./index";

export * as db from "./cloudDb";
export * as rooms from "./cloudRooms";
export type { CloudQueryResult, CloudStatement, CloudQueryRows } from "./cloudDb";

export interface CloudMe {
  /** This user's id in this app (pseudonymous: differs per app, never the
   *  MoteOS account). Compare it with `owner` columns and room `from`s. */
  appUid: string;
  /** "owner" | "admin" | "member" or a role the app's migrations added. */
  role: string;
  /** Only when the user shared their profile (`cloud.profile`). */
  displayName?: string;
  /** "dev" in an App Forge preview (its own data), "prod" when installed. */
  env: "dev" | "prod";
}

/**
 * Whether this host offers App Cloud (bridge ≥ 1.8). Call after `ready()`.
 * When false, show an "update MoteOS to use this app" notice instead of the
 * cloud features — an older host answers every `cloud.*` call with an error.
 */
export function available(): boolean {
  return bridgeAtLeast("1.8") && supports("cloud.me");
}

/** Who the current user is in this app's cloud. */
export function me(): Promise<CloudMe> {
  return request<CloudMe>("cloud.me");
}

// ── Connections (paas/10) ────────────────────────────────────────────────────

export interface CloudFetchInit {
  /** Must start with "/": it is appended to the connection's base URL, which
   *  only the publisher sets (never a host here). */
  path: string;
  method?: string;
  query?: Record<string, string>;
  /** Authorization / Cookie / Host are dropped; the platform adds the
   *  connection's credentials and `X-Mote-App-User` / `X-Mote-Assertion`. */
  headers?: Record<string, string>;
  /** Text body (JSON.stringify objects yourself) or base64 (`bodyEncoding`). */
  body?: string;
  bodyEncoding?: "utf8" | "base64";
  /** Stream the response: called with each text chunk as it arrives (an LLM
   *  answer, say). The promise still resolves with the whole body. */
  onChunk?: (text: string) => void;
}

export interface CloudFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Text, or base64 when `encoding` is "base64" (binary content types). */
  body: string;
  encoding: "utf8" | "base64";
}

let streamListeners = 0;
const streams = new Map<string, { onChunk: (t: string) => void; done: (status: number, err?: { code: string; message: string }) => void }>();
const early = new Map<string, { chunks: string[]; end?: { status: number; error?: { code: string; message: string } } }>();

function listenStreams(): void {
  if (streamListeners++) return;
  on("cloud.fetch.chunk", (d) => {
    const { id, data } = d as { id: string; data: string };
    const s = streams.get(id);
    if (s) s.onChunk(data);
    else {
      const e = early.get(id) ?? { chunks: [] };
      e.chunks.push(data);
      early.set(id, e);
    }
  });
  on("cloud.fetch.end", (d) => {
    const { id, status, error } = d as { id: string; status: number; error?: { code: string; message: string } };
    const s = streams.get(id);
    if (s) s.done(status, error);
    else {
      const e = early.get(id) ?? { chunks: [] };
      e.end = { status, error };
      early.set(id, e);
    }
  });
}

/**
 * Call the publisher's HTTP service through the declared connection `conn`
 * (`permissions.cloud.connections[].name`, kind "http"). An optional
 * connection the user switched off rejects with PERMISSION_DENIED (ask with
 * `ensurePermission(["cloud.connections:<conn>"])`).
 */
export async function fetch(conn: string, init: CloudFetchInit): Promise<CloudFetchResult> {
  const { onChunk, ...rest } = init;
  const params = { conn, ...rest, stream: onChunk ? true : undefined };
  if (!onChunk) return request<CloudFetchResult>("cloud.fetch", params);
  listenStreams();
  const { id } = await request<{ id: string }>("cloud.fetch", params);
  return new Promise<CloudFetchResult>((resolve, reject) => {
    let body = "";
    const chunk = (t: string) => {
      body += t;
      onChunk(t);
    };
    const done = (status: number, err?: { code: string; message: string }) => {
      streams.delete(id);
      if (err) reject(toError(err.code, err.message));
      else resolve({ status, headers: {}, body, encoding: "utf8" });
    };
    streams.set(id, { onChunk: chunk, done });
    const e = early.get(id);
    if (e) {
      early.delete(id);
      for (const c of e.chunks) chunk(c);
      if (e.end) done(e.end.status, e.end.error);
    }
  });
}

/**
 * Run the named query `cloud/queries/<conn>/<name>.sql` on the publisher's
 * database connection `conn` (kind "postgres" or "mysql"). The app only
 * passes parameter values, by name (`:order_id` → `{ order_id: 42 }`).
 */
export function query(conn: string, name: string, params: Record<string, unknown> = {}) {
  return request<{ columns: string[]; rows: unknown[][]; truncated: boolean }>("cloud.query", { conn, name, params });
}

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * Let a user report content other users wrote (a row, a room) to the
 * publisher. Offer it wherever user-written content is shown.
 * `target`: e.g. `{ table: "scores", pk: 42 }` or `{ room: "lobby" }`.
 */
export function report(opts: { target: Record<string, unknown>; reason: string; detail?: string }) {
  return request<{ id: string }>("cloud.report", opts);
}
