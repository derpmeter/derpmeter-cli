import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHandler, hostCategory, voteBody } from "../lib/mcp.mjs";
const cli = resolve(new URL("../bin/derp.mjs", import.meta.url).pathname);
const token = "dm_mcp_" + "a".repeat(64);
test("host category is bounded; vote body carries no raw client data", () => {
  assert.equal(
    hostCategory({ name: "claude-code", version: "2.1.293" }),
    "claude-code",
  );
  assert.equal(hostCategory({ name: "codex-mcp-client" }), "codex");
  assert.equal(hostCategory({ name: "codexfoo" }), "other");
  assert.equal(hostCategory({ name: "Cursor" }), "other");
  assert.equal(hostCategory(undefined), "other");
  assert.deepEqual(voteBody({ agent: "codex", rating: "dumb" }, "Cursor 1.0"), {
    agent: "codex",
    score: 100,
    source: "mcp",
    mcpClient: "other",
  });
  for (const bad of [
    { agent: "codex", rating: "dumb", reason: "private" },
    { agent: "codex", rating: "awful" },
    { agent: "cursor", rating: "dumb" },
    { agent: "codex", rating: "dumb", model: "/secret/path" },
  ])
    assert.throws(() => voteBody(bad, "codex"));
});
test("network failure retries once with the same key; first vote self-enrolls, 401 re-enrolls once", async () => {
  const bodies = [];
  let calls = 0;
  const fetcher = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (calls++ === 0) throw new Error("ECONNRESET");
    return new Response(JSON.stringify({ ok: true, replayed: true }), {
      status: 200,
    });
  };
  const handle = createHandler(
    { endpoint: "http://localhost:3000", mcpToken: token },
    { fetcher },
  );
  await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "codex-mcp-client" } },
  });
  const r = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "derp_vote",
      arguments: { agent: "claude-code", rating: "meh" },
    },
  });
  assert.match(r.result.content[0].text, /recovered/);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].mcpClient, "codex");
  // No token yet: the first vote enrolls an MCP token (stored only in the test home).
  const home = await mkdtemp(join(tmpdir(), "dm-mcp-enroll-"));
  process.env.DERPMETER_HOME = home;
  const seen = [];
  let rejectFirst = true;
  const none = createHandler(
    { endpoint: "http://localhost:3000" },
    {
      fetcher: async (url, init) => {
        seen.push({ url, auth: init.headers?.Authorization, body: init.body });
        if (url.endsWith("/api/clients"))
          return new Response(
            JSON.stringify({
              token: `dm_mcp_${String(seen.length).repeat(64)}`,
            }),
            { status: 201 },
          );
        // First token is treated as revoked: re-enroll once, same vote body.
        if (rejectFirst) {
          rejectFirst = false;
          return new Response("{}", { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true, replayed: false }), {
          status: 201,
        });
      },
    },
  );
  const missing = await none({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "derp_vote",
      arguments: { agent: "codex", rating: "smart" },
    },
  });
  assert.match(missing.result.content[0].text, /Vote accepted/);
  assert.deepEqual(
    seen.map((x) => x.url.replace("http://localhost:3000", "")),
    ["/api/clients", "/api/votes", "/api/clients", "/api/votes"],
  );
  assert.equal(seen[0].body, JSON.stringify({ channel: "mcp" }));
  assert.equal(
    seen[1].body,
    seen[3].body,
    "same vote and key after re-enrollment",
  );
  assert.equal(seen[3].auth, `Bearer dm_mcp_${"3".repeat(64)}`);
  const saved = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  assert.equal(saved.mcpToken, `dm_mcp_${"3".repeat(64)}`);
  delete process.env.DERPMETER_HOME;
  assert.equal(
    await none({ jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
});
test("stdio server speaks MCP and submits only categorical fields with the MCP token", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-mcp-"));
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 201;
    res.end(
      JSON.stringify({ ok: true, demo: false, id: "x", replayed: false }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "config.json"),
      JSON.stringify({
        token: "dm_cli_" + "b".repeat(64),
        mcpToken: token,
      }),
    );
    const child = spawn(process.execPath, [cli, "mcp"], {
      env: {
        ...process.env,
        DERPMETER_HOME: state,
        DERPMETER_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-code", version: "2.1.293" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "derp_vote",
          arguments: { agent: "codex", rating: "dumb", model: "gpt-6-sol" },
        },
      },
      { jsonrpc: "2.0", id: 4, method: "bogus" },
    ];
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    await new Promise((r) => child.on("close", r));
    const replies = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      replies.map((r) => r.id),
      [1, 2, 3, 4],
    );
    assert.equal(replies[0].result.protocolVersion, "2025-06-18");
    assert.deepEqual(
      replies[1].result.tools.map((t) => t.name),
      ["derp_score", "derp_vote"],
    );
    assert.match(replies[2].result.content[0].text, /Vote accepted/);
    assert.equal(replies[3].error.code, -32601);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, `Bearer ${token}`);
    const { idempotencyKey, ...rest } = received[0].body;
    assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(rest, {
      agent: "codex",
      score: 100,
      model: "gpt-6-sol",
      source: "mcp",
      mcpClient: "claude-code",
    });
    assert.ok(!JSON.stringify(received).includes("2.1.293"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
