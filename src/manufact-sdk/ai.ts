/**
 * AI. Imported as `ai` from the SDK index; a module (not an object) so a
 * bundle keeps only the calls it makes — the store audit reads them, and
 * `ai.complete` needs the plain `permissions.ai` where `ai.chat` may run on a
 * declared agent.
 *
 * ai.chat / ai.start (an agent turn) need `permissions.ai` with worker "required" | "optional",
 *  or `permissions.agents` (plus the alias's
 *  `permissions.blueprints` / `permissions.skills` entry when one is named);
 *  the window must be focused.
 *
 *  Text in, text out: in a MiniApp turn the Agent has no tools (no shell,
 *  files, web, connectors, skills or sub-agents) and cannot see the user's
 *  files, memory or other chats, Blueprint and Skill turns included. Put all
 *  the context the turn needs in the prompt; read data with files.* /
 *  fetchExternal / the other SDK calls and pass it as text.
 *
 *  The one exception is a tool blueprint (bridge 1.10):
 *  `ai.chat({ toolBlueprint, variableValues })` runs a Market blueprint
 *  pinned in `permissions.toolBlueprints` with exactly the tools the user
 *  consented to, on the granted AI worker (`permissions.ai` with worker
 *  "required" | "optional"). No prompt; only its final text comes back.
 */
import { request, on, toError } from "./index";

// The option names below are spelled through Record<…> on purpose: App Forge
// scans the app's source for the aliases handed to ai.chat, and only the
// call sites in the app's own code should show up there.

/** A Blueprint run (bridge 1.7): `blueprint` is the `id` of a
 *  `permissions.blueprints` entry; `variableValues` fills its input
 *  variables by name. */
type BlueprintRun = Record<"blueprint", string> & {
  variableValues?: Record<string, string>;
} & Partial<Record<"skill", never>>;
/** A Skill run (bridge 1.7): `skill` is the `id` of a `permissions.skills`
 *  entry. */
type SkillRun = Record<"skill", string> & Partial<Record<"blueprint" | "variableValues", never>>;
type PlainRun = Partial<Record<"blueprint" | "skill" | "variableValues", never>>;

/** At most one of a declared Blueprint or Skill alias; neither = a plain turn.
 *  MiniApp turns have no tools, so only prompt-only Blueprints (LLM
 *  reasoning/formatting nodes) and instruction-only Skills run; one that needs
 *  tools rejects with RESOURCE_NEEDS_TOOLS before any credits are spent.
 *  An alias the user has not bound rejects with PERMISSION_DENIED. Hosts older
 *  than bridge 1.7 ignore it and run a plain turn: check `bridgeAtLeast("1.7")`. */
export type ResourceOptions = BlueprintRun | SkillRun | PlainRun;

export type StartOptions = {
  /** A declared agent's market id (permissions.agents); default: the AI
   *  worker the user picked (permissions.ai), or the only declared agent. */
  agent?: string;
} & ResourceOptions;

export type ChatOptions = StartOptions & {
  /** Called with the reply text so far as it streams. */
  onText?: (text: string) => void;
};

/** A tool blueprint run (bridge 1.10): `toolBlueprint` is the `id` of a
 *  `permissions.toolBlueprints` entry. There is no prompt: `variableValues`
 *  (strings, each ≤ 4,000 characters, ≤ 16,000 together, no control
 *  characters but tab and newline; only the blueprint's declared inputs) is
 *  the whole input. Each run reports its conversation id (`onConversationId`,
 *  from the first stream event); pass it back as `conversationId` to
 *  continue that conversation (anything else: MINIAPP_CONVERSATION_INVALID),
 *  omit it to start fresh. Check `supports("ai.chat.toolBlueprint")` first. */
export type ToolBlueprintRun = Record<"toolBlueprint", string> & {
  variableValues?: Record<string, string>;
  conversationId?: string;
  /** Called once with this run's conversation id (keep it to continue). */
  onConversationId?: (id: string) => void;
  /** Called with the final text so far as it streams. */
  onText?: (text: string) => void;
} & Partial<Record<"blueprint" | "skill" | "agent", never>>;

/** Start a turn; chunks arrive as ai.chunk / ai.done / ai.error events. */
export function start(prompt: string, opts?: StartOptions): Promise<{ streamId: string }>;
export function start(run: Omit<ToolBlueprintRun, "onText" | "onConversationId">): Promise<{ streamId: string }>;
export function start(
  prompt: string | Omit<ToolBlueprintRun, "onText" | "onConversationId">,
  opts: StartOptions = {},
): Promise<{ streamId: string }> {
  const params: Record<string, unknown> = {};
  const src: Record<string, unknown> = typeof prompt === "string" ? { ...opts, prompt } : { ...prompt };
  for (const k of ["prompt", "agent", "blueprint", "skill", "toolBlueprint", "variableValues", "conversationId"]) {
    if (src[k] !== undefined) params[k] = src[k];
  }
  return request<{ streamId: string }>("ai.chat", params);
}

/** One turn, resolved with the full reply text. Start it while the window is
 *  focused (GESTURE_REQUIRED otherwise; a turn already running continues
 *  after the window blurs). Refusals (PERMISSION_DENIED, GESTURE_REQUIRED,
 *  RESOURCE_NEEDS_TOOLS, AGENT_MODIFIED, AGENT_UNAVAILABLE, RATE_LIMITED,
 *  QUOTA_EXCEEDED…) reject with their code. A tool blueprint run
 *  (`chat({ toolBlueprint, variableValues })`) also rejects with
 *  TOOL_BLUEPRINT_BAD_INPUT, TOOL_BLUEPRINT_NOT_GRANTED,
 *  TOOL_BLUEPRINT_PIN_MISMATCH or TOOL_DENIED (`details.tool`). */
export async function chat(prompt: string, opts?: ChatOptions): Promise<string>;
export async function chat(run: ToolBlueprintRun): Promise<string>;
export async function chat(prompt: string | ToolBlueprintRun, opts: ChatOptions = {}): Promise<string> {
  const { onText, ...startOpts } = typeof prompt === "string" ? opts : prompt;
  const onConversationId = typeof prompt === "string" ? undefined : prompt.onConversationId;
  delete (startOpts as { onConversationId?: unknown }).onConversationId;
  let conversationSeen = false;
  const blocks = new Map<string, string>();
  const text = () => [...blocks.values()].join("");
  let streamId: string | null = null;
  const early: { name: string; data: Record<string, unknown> }[] = [];
  return new Promise<string>((resolve, reject) => {
    const offs: (() => void)[] = [];
    const finish = (fn: () => void) => {
      for (const off of offs) off();
      fn();
    };
    const handle = (name: string, data: Record<string, unknown>) => {
      // Tool blueprint runs carry their conversation id on the first event.
      const conv = data.conversationId ?? data.conversation_id;
      if (!conversationSeen && typeof conv === "string" && conv) {
        conversationSeen = true;
        onConversationId?.(conv);
      }
      if (name === "ai.chunk") {
        const c = data.chunk as { type?: string; id?: string; content?: string } | undefined;
        // Content chunks carry the accumulated text of their block.
        if (c?.type === "content" && typeof c.content === "string") {
          blocks.set(c.id ?? "", c.content);
          onText?.(text());
        }
      } else if (name === "ai.done") {
        if (data.ok === false) {
          const code = String(data.code ?? "INTERNAL");
          finish(() => reject(toError(code, `ai.chat ended: ${code}`)));
        } else finish(() => resolve(text()));
      } else if (name === "ai.error") {
        const code = String(data.code ?? "INTERNAL");
        // RESOURCE_NEEDS_TOOLS names the resource (`kind`, `id`) and the tool
        // kinds it would need (`needs`: "script", "connector", …).
        // Tool blueprint refusals carry the alias (`id`), a pin mismatch its
        // `reason`, TOOL_DENIED the `tool` outside the allowlist.
        const details =
          code === "RESOURCE_NEEDS_TOOLS"
            ? { kind: data.kind, id: data.id, needs: data.needs ?? [] }
            : code.startsWith("TOOL_BLUEPRINT_") || code === "TOOL_DENIED"
              ? Object.fromEntries(
                  (["id", "reason", "tool"] as const).filter((k) => data[k] !== undefined).map((k) => [k, data[k]]),
                )
              : undefined;
        finish(() => reject(toError(code, String(data.message ?? "ai.chat failed"), details)));
      }
    };
    for (const name of ["ai.chunk", "ai.done", "ai.error"] as const) {
      offs.push(
        on(name, (d) => {
          const data = (d ?? {}) as Record<string, unknown>;
          if (streamId === null) early.push({ name, data });
          else if (data.streamId === streamId) handle(name, data);
        }),
      );
    }
    const started =
      typeof prompt === "string" ? start(prompt, startOpts as StartOptions) : start(startOpts as Omit<ToolBlueprintRun, "onText" | "onConversationId">);
    started.then(
      (r) => {
        streamId = r.streamId;
        for (const e of early.splice(0)) if (e.data.streamId === streamId) handle(e.name, e.data);
      },
      (e) => finish(() => reject(e)),
    );
  });
}

// ── ai.complete (bridge 1.9): the lightweight model ─────────────────────────

export interface CompleteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** Instructions for the model (persona, rules, output format). */
  system?: string;
  /** Earlier turns, ending with the user's; use instead of a prompt. */
  messages?: CompleteMessage[];
  /** Longest answer, in tokens (1–2048, default 512). */
  maxTokens?: number;
  /** 0–2; leave unset for the model's default. */
  temperature?: number;
  /** Ask for a bare JSON value; the parsed value comes back as `data`. */
  json?: boolean;
  /** Called with the answer so far as it streams. */
  onText?: (text: string) => void;
}

export interface CompleteResult {
  text: string;
  /** The model that answered (the user's own when they set one). */
  model?: string;
  /** With `json: true`: the parsed answer (undefined when it was not JSON). */
  data?: unknown;
}

let completeSeq = 0;

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** One quick answer from the user's lightweight AI model (their own key and
 *  model when they configured one, else the platform's), billed to the user
 *  like any AI use. Far faster and cheaper than `chat` — use it for short,
 *  frequent text: a game character's next line, a hint, a rewrite, a
 *  classification. It is a raw completion: no agent, no tools, no memory,
 *  nothing but what you pass (`prompt` = one user message; or `messages`).
 *  `ai.complete("…", opts)` and `ai.complete({ prompt | messages, … })`
 *  are the same call.
 *
 *  Needs `permissions.ai` (a declared agent does not cover it); an app
 *  whose only AI call is this declares `{ "worker": "none", "purpose" }`.
 *  Start it while the window is focused (GESTURE_REQUIRED otherwise; a call
 *  already in flight continues after the window blurs). Rejects with
 *  GESTURE_REQUIRED, PERMISSION_DENIED, RATE_LIMITED (details.
 *  retry_after; at most 30 calls a minute and 3 at once per app),
 *  QUOTA_EXCEEDED, NO_AI_MODEL (nothing configured: hide the feature),
 *  CONTENT_BLOCKED, UPSTREAM_ERROR or BAD_REQUEST. Hosts below bridge 1.9
 *  answer UNKNOWN_API: check `supports("ai.complete")`. */
export async function complete(
  prompt: string | (CompleteOptions & { prompt?: string }),
  opts: CompleteOptions = {},
): Promise<CompleteResult> {
  const all: CompleteOptions & { prompt?: string } = typeof prompt === "string" ? { ...opts, prompt } : { ...prompt };
  const { onText, ...rest } = all;
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v;
  let off: (() => void) | null = null;
  if (onText) {
    const streamId = `c${Date.now().toString(36)}${++completeSeq}`;
    params.streamId = streamId;
    let text = "";
    off = on("ai.complete.delta", (d) => {
      const data = (d ?? {}) as { streamId?: string; text?: string };
      if (data.streamId !== streamId || typeof data.text !== "string") return;
      text += data.text;
      onText(text);
    });
  }
  try {
    const res = await request<{ text: string; model?: string }>("ai.complete", params);
    return all.json ? { ...res, data: parseJson(res.text) } : res;
  } finally {
    off?.();
  }
}
