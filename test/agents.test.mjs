import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  claudeModel,
  codexModel,
  geminiModel,
  resolveModel,
} from "../lib/agents.mjs";
const cli = resolve(new URL("../bin/derp.mjs", import.meta.url).pathname);
function run(args, env, input = "") {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => done({ code, out, err }));
    child.stdin.end(input);
  });
}
test("adapters read only one documented model key", () => {
  assert.equal(
    codexModel('model = "gpt-6-sol"\n[profiles.x]\nmodel = "o"'),
    "gpt-6-sol",
  );
  assert.equal(codexModel('# c\n[profiles.x]\nmodel = "gpt-6-sol"'), undefined);
  assert.equal(codexModel('model = "/etc/passwd"'), undefined);
  assert.equal(
    geminiModel({ model: { name: "gemini-4-argon" } }),
    "gemini-4-argon",
  );
  assert.equal(geminiModel({ model: "gemini-3.8-flash" }), "gemini-3.8-flash");
  assert.equal(geminiModel({ model: { name: "../x" } }), undefined);
  assert.equal(geminiModel(null), undefined);
});
test("agent/model selection, opt-in session link, change/cancel receipts, /derp installer, version check", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-agents-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    HOME: root,
  };
  const calls = [];
  const statusAuth = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/models")
      return res.end(
        JSON.stringify({
          version: 1,
          models: [
            { id: "claude-opus-5-5", agent: "claude-code" },
            { id: "gpt-6-sol", agent: "codex" },
          ],
        }),
      );
    if (req.url === "/api/index")
      return res.end(
        JSON.stringify({
          version: 1,
          mode: "live",
          now: new Date().toISOString(),
          agents: [],
        }),
      );
    if (req.url === "/api/votes/status") {
      statusAuth.push(req.headers.authorization);
      return res.end(
        JSON.stringify({
          agents: [
            { agent: "claude-code", canVote: true, waitSeconds: 0 },
            { agent: "codex", canVote: false, waitSeconds: 2230 },
            { agent: "gemini-cli", canVote: false, waitSeconds: 3900 },
          ],
        }),
      );
    }
    if (req.url === "/api/version")
      return res.end(
        JSON.stringify({ cli: { latest: "9.0.0", minimum: "0.1.0" } }),
      );
    if (req.method === "GET") {
      res.statusCode = 404;
      return res.end("{}");
    }
    let text = "";
    for await (const b of req) text += b;
    calls.push({ method: req.method, body: JSON.parse(text) });
    res.statusCode = req.method === "POST" ? 201 : 200;
    res.end(
      JSON.stringify({
        ok: true,
        replayed: false,
        cancelled: req.method === "DELETE",
        amended: req.method === "PATCH",
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    env.DERPMETER_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    await run(["auth", "--token-stdin"], env, "dm_cli_" + "a".repeat(64));
    // Without opt-in the statusline persists nothing.
    await run(
      ["statusline"],
      env,
      JSON.stringify({ model: { id: "claude-opus-5-5" } }),
    );
    await assert.rejects(access(join(root, "state", "observed.json")));
    assert.equal(
      (await run(["privacy", "session", "on"], env)).code,
      1,
      "needs confirmation",
    );
    assert.equal(
      (await run(["privacy", "session", "on", "--yes"], env)).code,
      0,
    );
    await run(
      ["statusline"],
      env,
      JSON.stringify({
        session_id: "secret-session",
        model: { id: "claude-opus-5-5" },
        cwd: "/secret",
      }),
    );
    const observed = JSON.parse(
      await readFile(join(root, "state", "observed.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(observed["claude-code"]).sort(), [
      "model",
      "seenAt",
    ]);
    assert.ok(!JSON.stringify(observed).includes("secret"));
    // Claude Code vote: observed model + session-linked flag, nothing else.
    assert.equal(
      (await run(["vote", "dumb", "--reason", "hallucination"], env)).code,
      0,
    );
    const { idempotencyKey, ...first } = calls[0].body;
    assert.deepEqual(first, {
      agent: "claude-code",
      source: "cli",
      score: 100,
      model: "claude-opus-5-5",
      failureReason: "hallucination",
      sessionLinked: true,
    });
    // Codex: configured model from config.toml; never session-linked.
    await mkdir(env.CODEX_HOME, { recursive: true });
    await writeFile(
      join(env.CODEX_HOME, "config.toml"),
      'model = "gpt-6-sol"\n',
    );
    assert.equal((await run(["vote", "meh", "--agent", "codex"], env)).code, 0);
    assert.equal(calls[1].body.model, "gpt-6-sol");
    assert.equal(calls[1].body.sessionLinked, undefined);
    // Unlisted detected model is dropped rather than rejected by the server.
    await writeFile(
      join(env.CODEX_HOME, "config.toml"),
      'model = "gpt-unknown"\n',
    );
    await run(["privacy", "session", "off"], env);
    await assert.rejects(access(join(root, "state", "observed.json")));
    const gemini = await run(["vote", "smart", "--agent", "gemini-cli"], env);
    assert.equal(gemini.code, 0);
    assert.equal(calls[2].body.model, undefined);
    for (const bad of [
      ["vote", "smart", "--reason", "other"],
      ["vote", "dumb", "--reason", "it broke"],
      ["vote", "dumb", "--agent", "cursor"],
      ["vote", "dumb", "--model", "/etc/passwd"],
    ])
      assert.equal((await run(bad, env)).code, 1, bad.join(" "));
    // Change/cancel use the stored receipt key of the matching agent.
    assert.equal(
      (await run(["change", "meh", "--agent", "codex"], env)).code,
      0,
    );
    assert.deepEqual(calls[3], {
      method: "PATCH",
      body: {
        source: "cli",
        idempotencyKey: calls[1].body.idempotencyKey,
        score: 50,
      },
    });
    assert.equal((await run(["cancel"], env)).code, 0);
    assert.deepEqual(calls[4], {
      method: "DELETE",
      body: { source: "cli", idempotencyKey },
    });
    assert.equal(
      (await run(["cancel"], env)).code,
      1,
      "receipt removed after cancel",
    );
    // /derp command: confirmation, absolute invocation, never overwrites user files.
    const cmd = join(env.CLAUDE_CONFIG_DIR, "commands", "derp.md");
    assert.equal((await run(["install-command"], env)).code, 1);
    assert.equal((await run(["install-command", "--yes"], env)).code, 0);
    const text = await readFile(cmd, "utf8");
    assert.match(text, /derpmeter-command:v1/);
    assert.match(text, /\$ARGUMENTS/);
    assert.ok(text.includes(cli));
    assert.equal((await run(["uninstall-command"], env)).code, 0);
    await assert.rejects(access(cmd));
    await writeFile(cmd, "my own command");
    assert.equal((await run(["install-command", "--yes"], env)).code, 1);
    assert.equal(await readFile(cmd, "utf8"), "my own command");
    assert.equal((await run(["uninstall-command"], env)).code, 1);
    assert.equal(
      (await run(["install-command", "--agent", "codex", "--yes"], env)).code,
      0,
    );
    await access(join(env.CODEX_HOME, "prompts", "derp.md"));
    const status = await run(["status"], env);
    assert.match(
      status.out,
      /Next vote: Claude Code now · Codex in 38 min · Antigravity in 1 h 5 min/,
    );
    assert.equal(statusAuth[0], "Bearer dm_cli_" + "a".repeat(64));
    const version = JSON.parse((await run(["version"], env)).out);
    assert.equal(version.updateAvailable, true);
    assert.equal(version.unsupported, false);
    assert.ok(!JSON.stringify(calls).includes("secret"));
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
test("first vote self-enrolls a CLI token; logout revokes it on the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-enroll-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    HOME: root,
  };
  const seen = [];
  let issued = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let text = "";
    for await (const b of req) text += b;
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      text,
    });
    if (req.url === "/api/clients" && req.method === "POST") {
      issued++;
      res.statusCode = 201;
      return res.end(
        JSON.stringify({
          token: `dm_cli_${String(issued).repeat(64)}`,
          channel: "cli",
        }),
      );
    }
    if (req.url === "/api/clients" && req.method === "DELETE")
      return res.end(JSON.stringify({ revoked: true }));
    if (req.url === "/api/votes" && req.method === "POST") {
      // The first issued token is treated as expired once.
      if (req.headers.authorization === `Bearer dm_cli_${"1".repeat(64)}`) {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({
            error: "CLI token is invalid, expired or revoked.",
          }),
        );
      }
      res.statusCode = 201;
      return res.end(JSON.stringify({ ok: true, replayed: false }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    env.DERPMETER_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    const voted = await run(["vote", "dumb"], env);
    assert.equal(voted.code, 0, voted.err);
    const flow = seen.map((x) => `${x.method} ${x.url}`);
    assert.deepEqual(flow, [
      "POST /api/clients",
      "POST /api/votes",
      "POST /api/clients",
      "POST /api/votes",
    ]);
    assert.equal(seen[0].text, JSON.stringify({ channel: "cli" }));
    assert.equal(
      seen[1].text,
      seen[3].text,
      "same body and key after re-enrollment",
    );
    const config = JSON.parse(
      await readFile(join(root, "state", "config.json"), "utf8"),
    );
    assert.equal(config.token, `dm_cli_${"2".repeat(64)}`);
    // Existing token is reused: no new enrollment on the next vote.
    await run(["vote", "meh", "--agent", "codex"], env);
    assert.equal(seen.filter((x) => x.url === "/api/clients").length, 2);
    const out = await run(["logout"], env);
    assert.match(out.out, /1 revoked on the server/);
    assert.equal(seen.at(-1).method, "DELETE");
    assert.equal(seen.at(-1).auth, `Bearer dm_cli_${"2".repeat(64)}`);
    assert.equal(
      JSON.parse(await readFile(join(root, "state", "config.json"), "utf8"))
        .token,
      undefined,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code's own settings: full ids, suffixes and family aliases", () => {
  const catalog = {
    models: [
      { id: "claude-opus-5-5", agent: "claude-code" },
      { id: "claude-sonnet-5-5", agent: "claude-code" },
      { id: "claude-haiku-5-5", agent: "claude-code" },
      { id: "claude-fable-5-1", agent: "claude-code" },
      { id: "agy-claude-opus-5-5", agent: "gemini-cli" },
    ],
  };
  assert.equal(claudeModel({ model: "opus" }), "opus");
  assert.equal(claudeModel({ model: "../../x" }), undefined);
  assert.equal(claudeModel({}), undefined);
  const r = (raw, agent = "claude-code") => resolveModel(agent, raw, catalog);
  assert.equal(r("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(r("claude-sonnet-5-5[1m]"), "claude-sonnet-5-5");
  assert.equal(r("claude-haiku-5-5-20261001"), "claude-haiku-5-5");
  assert.equal(r("opus"), "claude-opus-5-5");
  assert.equal(r("opusplan"), "claude-opus-5-5");
  assert.equal(r("sonnet[1m]"), "claude-sonnet-5-5");
  assert.equal(r("default"), undefined);
  assert.equal(r("claude-opus-4"), undefined, "not a current catalog model");
  // Aliases are Claude Code only; ambiguous families resolve to nothing.
  assert.equal(r("opus", "gemini-cli"), undefined);
  const two = {
    models: [
      ...catalog.models,
      { id: "claude-opus-5-6", agent: "claude-code" },
    ],
  };
  assert.equal(resolveModel("claude-code", "opus", two), undefined);
});
