/**
 * Grimoire (bridge 1.3): the user's knowledge base. Reach it only through
 * these calls — the Grimoire folder is a reserved path that `files.*` and
 * `shared:` can never open. Needs `permissions.grimoire`: `read` (scoped to
 * the declared folders/tags) for list/read, `write: "inbox"` for writeInbox.
 * Imported as `grimoire` from the SDK index.
 */
import { request } from "./index";

export interface GrimoirePage {
  /** Vault-relative ("notes/…", "wiki/…"). */
  path: string;
  title: string;
  tags: string[];
  /** ISO 8601, UTC. */
  mtime: string;
}

export function list(opts: { folder?: string; tag?: string; cursor?: string; limit?: number } = {}) {
  return request<{ items: GrimoirePage[]; nextCursor: string | null }>("grimoire.list", opts);
}

export function read(path: string) {
  return request<GrimoirePage & { body: string }>("grimoire.read", { path });
}

/** A new note in the user's inbox (markdown body). */
export function writeInbox(note: { title: string; body?: string; tags?: string[] }) {
  return request<{ path: string }>("grimoire.writeInbox", note);
}
