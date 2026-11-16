/**
 * App Cloud realtime rooms (bridge 1.8), reached as `cloud.rooms`. Needs the
 * room kind in `permissions.cloud.rooms`.
 *
 * The host opens and keeps the connection (reconnects and resumes on its own;
 * you only see `status`). A room is "now": presence, broadcast frames and a
 * small key/value state. Anything that must outlive the room goes to
 * `cloud.db`.
 *
 * Rooms are client-authoritative: the platform orders frames (`seq`), makes
 * the sender (`from`) unforgeable and does compare-and-set on state, but it
 * cannot check what a client sends. Let the `leader` settle disputes, and use
 * `setState(key, value, { ver })` for turn-based moves.
 */
import { on, request, toError } from "./index";

export type RoomStatus = "joining" | "live" | "reconnecting" | "paused" | "closed";

export interface RoomMember {
  /** One connection (a user with two windows open is two members). */
  conn: string;
  appUid: string;
  role: string;
  presence: unknown;
  /** Only when that user shared their profile (`cloud.profile`). */
  displayName?: string;
}

/** Who sent a frame: a member ("client") or the publisher's server. */
export type FrameSource = "client" | "server";

/** Hosts that do not forward `src` still send `from`/`by` null for server frames. */
function sourceOf(d: Record<string, unknown>, who: unknown): FrameSource {
  if (d.src === "server" || d.src === "client") return d.src;
  return who == null ? "server" : "client";
}

export interface RoomEventMap {
  /** A full snapshot: on join, and again after a reconnect that could not
   *  resume. Rebuild anything derived from members/state. */
  welcome: { members: RoomMember[]; state: Record<string, { value: unknown; ver: number }> };
  /** A broadcast frame (`from` is the sender's appUid, set by the server).
   *  `src: "server"` (and `from: null`) = sent by the publisher's own server
   *  with a service key; members can never send that, so it is trustworthy. */
  frame: { seq: number; src: FrameSource; from: string | null; topic: string; data: unknown };
  /** A state key changed (`value` null = deleted). Your own writes too.
   *  `by: null` / `src: "server"` = written by the publisher's server. */
  state: { seq: number; src: FrameSource; by: string | null; key: string; value: unknown; ver: number };
  presence: { seq: number; appUid: string; presence: unknown };
  join: { seq: number; member: RoomMember };
  leave: { seq: number; member: { conn: string; appUid: string } };
  /** The longest-present member changed. */
  leader: { appUid: string | null };
  status: { state: RoomStatus };
  /** A non-fatal server error no call waits on (rate limit, frame too large). */
  error: { code: string; ref?: string };
  /** Final: the room is gone (ROOM_FULL, ROOM_FORBIDDEN, KICKED…). */
  closed: { code: string };
  /** After any of the above: re-render from `room.members` / `room.state`. */
  change: Record<string, never>;
}

export interface Room {
  readonly kind: string;
  readonly name: string;
  readonly status: RoomStatus;
  /** Live snapshot, kept up to date from the events. */
  readonly members: RoomMember[];
  readonly state: Record<string, { value: unknown; ver: number }>;
  /** appUid of the leader, or null. */
  readonly leader: string | null;
  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof RoomEventMap>(event: K, cb: (data: RoomEventMap[K]) => void): () => void;
  /** Broadcast `data` (JSON, ≤ 16 KB with its envelope) on `topic`.
   *  `echo: true` also delivers it to this member. */
  send(topic: string, data: unknown, opts?: { echo?: boolean }): Promise<void>;
  /** Set a shared key (`null` deletes it). With `ver`, only if the key is
   *  still at that version (0 = absent), else ROOM_STATE_CONFLICT. */
  setState(key: string, value: unknown, opts?: { ver?: number }): Promise<{ ver: number }>;
  /** Replace this member's presence (the whole object, not a patch). */
  setPresence(presence: Record<string, unknown>): Promise<void>;
  leave(): Promise<void>;
}

export interface JoinOptions {
  /** This member's presence from the start (e.g. `{ name, color }`). */
  presence?: Record<string, unknown>;
}

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A fresh unguessable room name (128 random bits) for a private room. */
export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Handler = (data: unknown) => void;

class RoomImpl implements Room {
  status: RoomStatus = "joining";
  members: RoomMember[] = [];
  state: Record<string, { value: unknown; ver: number }> = {};
  leader: string | null = null;
  private handlers = new Map<string, Set<Handler>>();

  constructor(
    readonly kind: string,
    readonly name: string,
  ) {}

  on<K extends keyof RoomEventMap>(event: K, cb: (data: RoomEventMap[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb as Handler);
    return () => set!.delete(cb as Handler);
  }

  emit(event: keyof RoomEventMap, data: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(data);
    if (event !== "change") for (const cb of this.handlers.get("change") ?? []) cb({});
  }

  /** Apply one host event to the snapshot, then tell the app. */
  apply(name: string, d: Record<string, unknown>): void {
    switch (name) {
      case "welcome": {
        this.members = ((d.members as RoomMember[]) ?? []).slice();
        this.state = { ...((d.state as Room["state"]) ?? {}) };
        // The welcome names the leader by connection; events name it by user.
        const lead = this.members.find((m) => m.conn === d.leader);
        this.leader = lead ? lead.appUid : null;
        this.status = "live";
        this.emit("welcome", { members: this.members, state: this.state });
        return;
      }
      case "frame":
        this.emit("frame", { seq: d.seq, src: sourceOf(d, d.from), from: d.from ?? null, topic: d.topic, data: d.data });
        return;
      case "state": {
        const key = d.key as string;
        if (d.value === null || d.value === undefined) delete this.state[key];
        else this.state[key] = { value: d.value, ver: d.ver as number };
        this.emit("state", { seq: d.seq, src: sourceOf(d, d.by), by: d.by ?? null, key, value: d.value ?? null, ver: d.ver });
        return;
      }
      case "presence":
        this.members = this.members.map((m) => (m.appUid === d.appUid ? { ...m, presence: d.presence } : m));
        this.emit("presence", { seq: d.seq, appUid: d.appUid, presence: d.presence });
        return;
      case "join": {
        const m = d.member as RoomMember;
        this.members = [...this.members.filter((x) => x.conn !== m.conn), m];
        this.emit("join", { seq: d.seq, member: m });
        return;
      }
      case "leave": {
        const m = d.member as { conn: string; appUid: string };
        this.members = this.members.filter((x) => x.conn !== m.conn);
        this.emit("leave", { seq: d.seq, member: m });
        return;
      }
      case "leader":
        this.leader = (d.appUid as string) ?? null;
        this.emit("leader", { appUid: this.leader });
        return;
      case "status":
        this.status = d.state as RoomStatus;
        this.emit("status", { state: this.status });
        return;
      case "error":
        this.emit("error", { code: d.code, ref: d.ref });
        return;
      case "closed":
        this.status = "closed";
        forget(this);
        this.emit("closed", { code: d.code });
        return;
    }
  }

  private check(): void {
    if (this.status === "closed") throw toError("ROOM_NOT_JOINED", `room "${this.name}" is closed`);
  }

  async send(topic: string, data: unknown, opts: { echo?: boolean } = {}): Promise<void> {
    this.check();
    await request("cloud.rooms.send", { room: this.name, topic, data, echo: opts.echo === true });
  }

  setState(key: string, value: unknown, opts: { ver?: number } = {}): Promise<{ ver: number }> {
    this.check();
    const params: Record<string, unknown> = { room: this.name, key, value };
    if (opts.ver !== undefined) params.ver = opts.ver;
    return request<{ ver: number }>("cloud.rooms.setState", params);
  }

  async setPresence(presence: Record<string, unknown>): Promise<void> {
    this.check();
    await request("cloud.rooms.setPresence", { room: this.name, presence });
  }

  async leave(): Promise<void> {
    if (this.status === "closed") return;
    this.status = "closed";
    forget(this);
    await request("cloud.rooms.leave", { room: this.name }).catch(() => undefined);
    this.emit("status", { state: "closed" });
  }
}

const joined = new Map<string, { room: RoomImpl; ready: Promise<Room> }>();
let listening = false;

function forget(r: RoomImpl): void {
  if (joined.get(r.name)?.room === r) joined.delete(r.name);
}

const EVENTS = ["welcome", "resumed", "frame", "state", "presence", "join", "leave", "leader", "status", "error", "closed"] as const;

function listen(): void {
  if (listening) return;
  listening = true;
  for (const ev of EVENTS) {
    on(`cloud.room.${ev}`, (raw) => {
      const d = (raw ?? {}) as Record<string, unknown>;
      const r = joined.get(d.room as string)?.room;
      if (r && ev !== "resumed") r.apply(ev, d);
    });
  }
}

/**
 * Join room `room` of the declared kind `kind` (`permissions.cloud.rooms[]`).
 * Resolves once the first snapshot arrived (`room.members` / `room.state` are
 * filled). Joining a room this window already joined returns the same Room.
 * Rejects with ROOM_FULL, ROOM_FORBIDDEN, CLOUD_NOT_DECLARED, CLOUD_TIMEOUT…
 * Room names match [A-Za-z0-9_-]{1,64}; for a private room use `newId()`
 * and share the name.
 */
export function join(kind: string, room: string, opts: JoinOptions = {}): Promise<Room> {
  if (!ROOM_RE.test(room)) return Promise.reject(toError("BAD_REQUEST", "room must match [A-Za-z0-9_-]{1,64}"));
  const existing = joined.get(room);
  if (existing && existing.room.kind === kind) return existing.ready;
  listen();
  // Registered before the request: the host sends the welcome event just
  // ahead of the join reply.
  const r = new RoomImpl(kind, room);
  const params: Record<string, unknown> = { kind, room };
  if (opts.presence) params.presence = opts.presence;
  const ready = request<{ conn: string }>("cloud.rooms.join", params).then(
    () => r as Room,
    (e) => {
      forget(r);
      throw e;
    },
  );
  joined.set(room, { room: r, ready });
  return ready;
}
