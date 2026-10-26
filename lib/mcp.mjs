// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0). No SDK dependency.
// The host's clientInfo is reduced in memory to a bounded category and is never
// sent, logged or persisted. The category is a claim, not proof of a model run.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { endpoint, ensureToken, refreshIndex } from "./core.mjs";
import { REASONS } from "./agents.mjs";
import { robustFetch, readBody } from "./net.mjs";
export const MCP_HOSTS = ["claude-code", "codex", "other"];
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const AGENTS = ["claude-code", "codex", "gemini-cli"];
const SCORES = { smart: 0, meh: 50, dumb: 100 };
export function hostCategory(clientInfo) {
  const name = typeof clientInfo?.name === "string" ? clientInfo.name : "";
  if (name === "claude-code") return "claude-code";
  if (/^codex(?:[-_]|$)/i.test(name)) return "codex";
  return "other";
}
export const TOOLS = [
  {
    name: "derp_score",
    description:
      "Read the public DerpMeter Derp Score per coding agent: community sentiment (0 smart to 100 dumb) blending direct votes and Radar (AI-classified public posts) over 7 days, with its components. Not a benchmark.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "derp_vote",
    description:
      "Submit one DerpMeter Smart/Meh/Dumb vote. Call ONLY when the user explicitly asks to rate an agent, with the rating they chose. Never infer a rating. Sends only agent, rating, optional model and a host category.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: AGENTS,
          description:
            "Agent being rated. gemini-cli means Google Antigravity CLI (agy), which replaced Gemini CLI.",
        },
        rating: { type: "string", enum: Object.keys(SCORES) },
        reason: {
          type: "string",
          enum: REASONS,
          description:
            "Optional failure category the user chose (meh/dumb only)",
        },
        model: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9.-]{1,79}$",
          description: "Optional catalog model ID the user explicitly chose",
        },
      },
      required: ["agent", "rating"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];
// derp_score result: the blended score as the headline when the server sends
// it (older servers: the 24h votes), plus the raw 24h vote breakdown.
export function scoreReport(d) {
  const note =
    "Community sentiment, not a benchmark or a confirmed outage. Higher = derpier.";
  if (!d.score)
    return {
      mode: d.mode,
      now: d.now,
      metric: "Derp Score (votes only, latest 24h)",
      note,
      agents: d.agents,
    };
  return {
    mode: d.mode,
    now: d.now,
    metric: `Derp Score: direct votes (each counts ${d.score.voteWeight}x) blended with Radar opinions, UTC days ${d.score.start} to ${d.score.end}`,
    note,
    agents: d.score.agents.map((a) => ({
      agent: a.agent,
      score: a.score,
      votes: a.votes,
      radar: a.radar,
    })),
    votes24h: d.agents,
  };
}
const text = (value, isError = false) => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});
export function voteBody(input, host) {
  const keys = Object.keys(input || {});
  if (keys.some((k) => !["agent", "rating", "model", "reason"].includes(k)))
    throw new Error("Only agent, rating, model and reason are accepted.");
  if (
    input.reason !== undefined &&
    (!REASONS.includes(input.reason) || input.rating === "smart")
  )
    throw new Error("Reason must be a listed category, with meh or dumb.");
  if (!AGENTS.includes(input.agent)) throw new Error("Unknown agent.");
  if (!Object.hasOwn(SCORES, input.rating))
    throw new Error("Use rating smart|meh|dumb.");
  if (
    input.model !== undefined &&
    !/^[a-z0-9][a-z0-9.-]{1,79}$/.test(input.model)
  )
    throw new Error("Provide a catalog model ID; no paths or free text.");
  return {
    agent: input.agent,
    score: SCORES[input.rating],
    ...(input.model ? { model: input.model } : {}),
    ...(input.reason ? { failureReason: input.reason } : {}),
    source: "mcp",
    mcpClient: MCP_HOSTS.includes(host) ? host : "other",
  };
}
async function vote(c, input, host, fetcher) {
  const body = { ...voteBody(input, host), idempotencyKey: randomUUID() };
  // First vote enrolls an MCP-scoped token automatically.
  let token = await ensureToken(c, "mcp", fetcher);
  const origin = endpoint(c.endpoint);
  let lastError,
    reenrolled = false;
  // One retry on network failure with the exact same body and key.
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetcher(`${origin}/api/votes`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = e;
      continue;
    }
    // Expired or revoked token: enroll a new one once and resend the same vote.
    if (r.status === 401 && !reenrolled) {
      reenrolled = true;
      token = await ensureToken(c, "mcp", fetcher, true);
      attempt--;
      continue;
    }
    const result = await readBody(r);
    if (!r.ok)
      throw new Error(`${result.error || "Vote failed"} (HTTP ${r.status}).`);
    return result.demo
      ? "DEMO: preview only; no vote stored."
      : `Vote accepted${result.replayed ? " (previous submission recovered)" : ""}. Feedback is self-reported, never objectively verified.`;
  }
  throw new Error(
    `Vote may not have been sent (${lastError?.message || "network error"}). Not retried with a new key.`,
  );
}
export function createHandler(
  c,
  { host: forcedHost, fetcher = robustFetch } = {},
) {
  let host = forcedHost;
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
      return msg?.id === undefined
        ? null
        : {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32600, message: "Invalid request" },
          };
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.id === undefined) return null; // notifications need no reply
    if (msg.method === "initialize") {
      host ||= hostCategory(msg.params?.clientInfo);
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "derpmeter", version: "0.1.0" },
      });
    }
    if (msg.method === "ping") return ok({});
    if (msg.method === "tools/list") return ok({ tools: TOOLS });
    if (msg.method === "tools/call") {
      const { name, arguments: input } = msg.params || {};
      try {
        if (name === "derp_score") {
          const cache = await refreshIndex(c, fetcher);
          return ok(text(JSON.stringify(scoreReport(cache.data))));
        }
        if (name === "derp_vote")
          return ok(text(await vote(c, input, host || "other", fetcher)));
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Unknown tool" },
        };
      } catch (e) {
        return ok(text(e.message, true));
      }
    }
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "Method not found" },
    };
  };
}
export async function serve(c, options) {
  const handle = createHandler(c, options);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 65_536) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      continue;
    }
    const reply = await handle(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  }
}
