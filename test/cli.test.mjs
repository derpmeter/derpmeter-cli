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
import { extractModel, renderIndex } from "../lib/core.mjs";
const cli = resolve(new URL("../bin/derp.mjs", import.meta.url).pathname);
function run(args, env, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
const snapshot = {
  version: 1,
  mode: "live",
  now: new Date().toISOString(),
  agents: [
    {
      agent: "claude-code",
      score: 50,
      count: 3,
      models: [{ model: "claude-opus-4", score: 100, count: 1 }],
    },
  ],
};
test("adapter extracts only current model; session and private input are ignored", () => {
  assert.equal(
    extractModel({
      session_id: "private",
      model: { id: "claude-opus-4" },
      cwd: "/secret",
      prompt: "secret",
    }),
    "claude-opus-4",
  );
  assert.equal(extractModel({ model: { id: "/secret/path" } }), undefined);
  assert.match(
    renderIndex({ data: snapshot, fetchedAt: 0 }, "claude-opus-4"),
    /stale/,
  );
});
test("statusline never fetches or persists sessions; vote includes only explicit model; retries reuse key", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-private-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  let gets = 0;
  const bodies = [];
  // Drop more connections than the CLI's retry budget (4 attempts).
  let failures = 4;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/index") {
      gets++;
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method === "GET") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    let text = "";
    for await (const b of req) text += b;
    bodies.push(JSON.parse(text));
    if (failures > 0) {
      failures--;
      req.socket.destroy();
      return;
    }
    res.end(
      JSON.stringify({ ok: true, evidenceKind: "public", replayed: true }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    env.DERPMETER_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    await run(["status"], env);
    await run(["status"], env);
    assert.equal(gets, 1);
    for (let i = 0; i < 3; i++) {
      const r = await run(
        ["statusline"],
        env,
        JSON.stringify({
          session_id: "private",
          model: { id: "claude-opus-4" },
          transcript_path: "/secret",
          prompt: "never-upload",
        }),
      );
      assert.match(r.out, /Derp 100.0/);
    }
    assert.equal(gets, 1);
    await assert.rejects(access(join(root, "state", "sessions")));
    await assert.rejects(access(join(root, "state", "identity.json")));
    await run(["auth", "--token-stdin"], env, "dm_cli_" + "f".repeat(64));
    assert.equal((await run(["privacy", "on", "--yes"], env)).code, 1);
    assert.equal((await run(["vote", "dumb", "--with-session"], env)).code, 1);
    assert.equal(bodies.length, 0);
    const offline = await run(["vote", "dumb"], env);
    assert.equal(offline.code, 1);
    assert.match(offline.err, /Could not reach DerpMeter/);
    assert.doesNotMatch(offline.err, /127\.0\.0\.1|http/);
    assert.equal(bodies.length, 4, "retried automatically");
    assert.equal((await run(["vote", "dumb"], env)).code, 0);
    // Every automatic and manual retry resends the exact body and key.
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
    assert.deepEqual(
      Object.keys(bodies[0]).sort(),
      ["agent", "source", "score", "idempotencyKey"].sort(),
    );
    assert.equal(
      (await run(["vote", "smart", "--model", "claude-opus-4"], env)).code,
      0,
    );
    assert.equal(bodies[5].model, "claude-opus-4");
    assert.ok(!JSON.stringify(bodies).includes("private"));
    const doctor = await run(["doctor"], env);
    assert.ok(!doctor.out.includes("dm_cli_"));
    assert.match(doctor.out, /"sessionCollection": false/);
    assert.ok(!doctor.out.includes("127.0.0.1"), "service URL is not shown");
    await writeFile(join(root, "state", "vote.lock"), "");
    assert.equal((await run(["vote", "dumb"], env)).code, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
test("upgrades erase legacy local session identities and session-linked pending data", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-upgrade-"));
  const env = { DERPMETER_HOME: root };
  await mkdir(join(root, "sessions"));
  await writeFile(join(root, "sessions", "old.json"), "private");
  await writeFile(join(root, "identity.json"), "private");
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ sessionOptIn: true }),
  );
  await writeFile(
    join(root, "pending-vote.json"),
    JSON.stringify({ body: { session: { sessionId: "private" } } }),
  );
  try {
    assert.equal((await run(["doctor"], env)).code, 0);
    for (const f of ["sessions", "identity.json", "pending-vote.json"])
      await assert.rejects(access(join(root, f)));
    assert.ok(
      !JSON.parse(await readFile(join(root, "config.json"), "utf8"))
        .sessionOptIn,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("statusline confirmation, composition and targeted restore preserve unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-settings-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  await mkdir(env.CLAUDE_CONFIG_DIR);
  const file = join(env.CLAUDE_CONFIG_DIR, "settings.json");
  const prior = {
    type: "command",
    command: "printf 'existing-status'",
    padding: 2,
  };
  await writeFile(
    file,
    JSON.stringify({
      statusLine: prior,
      permissions: { deny: ["Read(secrets)"] },
    }),
  );
  try {
    assert.equal((await run(["install-statusline"], env)).code, 1);
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).statusLine,
      prior,
    );
    assert.equal((await run(["install-statusline", "--yes"], env)).code, 0);
    assert.match((await run(["statusline"], env, "{}")).out, /existing-status/);
    // Reinstalling over an unchanged older install (bin moved) re-points it.
    const recordPath = join(env.DERPMETER_HOME, "statusline-install.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.installed.command = "'node' '/old/bin/dumbindex.mjs' statusline";
    await writeFile(recordPath, JSON.stringify(record));
    const moved = JSON.parse(await readFile(file, "utf8"));
    moved.statusLine = record.installed;
    await writeFile(file, JSON.stringify(moved));
    assert.equal((await run(["install-statusline", "--yes"], env)).code, 0);
    const repointed = JSON.parse(await readFile(file, "utf8")).statusLine;
    assert.match(repointed.command, /bin\/derp\.mjs' statusline$/);
    assert.equal(repointed.padding, 2);
    assert.deepEqual(
      JSON.parse(await readFile(recordPath, "utf8")).previous,
      prior,
    );
    const installed = JSON.parse(await readFile(file, "utf8"));
    installed.newSetting = true;
    await writeFile(file, JSON.stringify(installed));
    assert.equal((await run(["uninstall-statusline", "--yes"], env)).code, 0);
    const restored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(restored.statusLine, prior);
    assert.equal(restored.newSetting, true);
    await run(["install-statusline", "--yes"], env);
    restored.statusLine.command = "user-change";
    await writeFile(file, JSON.stringify(restored));
    assert.equal((await run(["uninstall-statusline", "--yes"], env)).code, 1);
    assert.equal((await run(["statusline"], env, "not-json")).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the service URL is built in: never stored, shown or configurable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-endpoint-"));
  const env = { DERPMETER_HOME: root, DERPMETER_ENDPOINT: "" };
  const file = join(root, "config.json");
  const read = async () => JSON.parse(await readFile(file, "utf8"));
  try {
    // A URL stored by older versions is ignored and removed.
    await writeFile(
      file,
      JSON.stringify({ endpoint: "https://elsewhere.example", token: "x" }),
    );
    await run(["version"], env);
    assert.deepEqual(await read(), { token: "x" });
    // `configure` is a harmless no-op kept for old scripts.
    const configured = await run(
      ["configure", "--endpoint", "http://127.0.0.1:9"],
      env,
    );
    assert.equal(configured.code, 0);
    assert.match(configured.out, /Nothing to configure/);
    assert.equal((await read()).endpoint, undefined);
    const help = await run(["--help"], env);
    assert.doesNotMatch(
      help.out + help.err,
      /configure|endpoint|derpmeter\.com/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
