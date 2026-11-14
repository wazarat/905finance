import "server-only";
import { QATOM_MCP_URL, fetchQatom } from "./config";

/**
 * A minimal client for Qatom's master MCP endpoint: open a session, call one
 * tool, read the answer. It speaks the same handshake as Qatom's own
 * reference client (JSON-RPC over HTTP, answered as JSON or as an event
 * stream).
 */

export class QatomUnauthorized extends Error {
  constructor() {
    super("Qatom did not accept the access token.");
    this.name = "QatomUnauthorized";
  }
}

export type ToolResult = {
  /** True when the tool itself reported an error. */
  isError: boolean;
  /** Everything the tool returned, for the caller to search. Untrusted. */
  content: unknown;
};

type RpcReply = { id?: unknown; result?: unknown; error?: { message?: unknown } };

/** Read a JSON-RPC answer whether it came as plain JSON or as server-sent events. */
function readReply(contentType: string, text: string, id: number): RpcReply | null {
  if (!contentType.includes("text/event-stream")) {
    try {
      return JSON.parse(text) as RpcReply;
    } catch {
      return null;
    }
  }
  let found: RpcReply | null = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as RpcReply;
      if (message.id === id) found = message;
    } catch {
      // Not a message for us.
    }
  }
  return found;
}

/** Call one tool on Qatom's master MCP as the signed-in account. */
export async function callQatomTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let sessionId: string | null = null;
  let nextId = 1;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetchQatom(QATOM_MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    if (response.status === 401) throw new QatomUnauthorized();
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };

  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    const response = await post({ id, method, params });
    const text = await response.text();
    if (!response.ok) throw new Error(`Qatom answered ${response.status} to ${method}.`);
    const reply = readReply(response.headers.get("content-type") ?? "", text, id);
    if (!reply) throw new Error(`Qatom's answer to ${method} could not be read.`);
    if (reply.error) throw new Error(`Qatom refused ${method}: ${String(reply.error.message ?? "").slice(0, 200)}`);
    return reply.result;
  };

  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "905-finance", version: "1.0.0" },
  });
  // A notification: there is no answer to wait for.
  await (await post({ method: "notifications/initialized" })).text();

  const result = (await request("tools/call", { name, arguments: args })) as
    | { isError?: unknown }
    | null
    | undefined;
  return { isError: result?.isError === true, content: result ?? null };
}

/**
 * Every JSON object found anywhere in a tool's answer, including objects
 * written as text inside it. Qatom returns the seller's response inside its
 * receipt, as text and as JSON, and the exact wrapping is not published, so
 * the answer is searched rather than read at a fixed path.
 */
export function objectsWithin(value: unknown, depth = 0, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (depth > 8 || found.length > 200) return found;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 200_000) return found;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        objectsWithin(JSON.parse(text), depth + 1, found);
        return found;
      } catch {
        // Fall through and look for objects embedded in the prose.
      }
    }
    for (const candidate of embeddedObjects(text)) {
      try {
        objectsWithin(JSON.parse(candidate), depth + 1, found);
      } catch {
        // Not JSON after all.
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) objectsWithin(entry, depth + 1, found);
    return found;
  }
  if (value && typeof value === "object") {
    found.push(value as Record<string, unknown>);
    for (const entry of Object.values(value)) objectsWithin(entry, depth + 1, found);
  }
  return found;
}

/** Top-level `{...}` spans in a piece of text, respecting strings and nesting. */
function embeddedObjects(text: string): string[] {
  const spans: string[] = [];
  let start = -1;
  let level = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && level > 0) inString = true;
    else if (char === "{") {
      if (level === 0) start = i;
      level += 1;
    } else if (char === "}" && level > 0) {
      level -= 1;
      if (level === 0 && start >= 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans.slice(0, 20);
}
