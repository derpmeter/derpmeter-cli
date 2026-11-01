import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  QUESTIONS,
  askFollowUp,
  followUpHint,
  followUpQuestions,
  parseDetailArgs,
} from "../lib/details.mjs";
const cli = resolve(new URL("../bin/derp.mjs", import.meta.url).pathname);

test("follow-up questions match the web's set, order and rotation", async () => {
  const web = await readFile(
    new URL("../../../src/lib/vote-details.ts", import.meta.url),
    "utf8",
  ).catch(() => null);
  // The monorepo copy is the source of truth; the public mirror has no web.
  if (web)
    for (const [id, q] of Object.entries(QUESTIONS))
      for (const value of Object.keys(q.choices))
        assert.ok(web.includes(`"${value}"`), `${id}.${value} on the web`);
  for (let r = 0; r < 10; r++) {
    const dumb = followUpQuestions(100, r);
    assert.equal(dumb[0], "vs_usual");
    assert.equal(new Set(dumb).size, 3);
    assert.ok(!dumb.includes("went_well"));
  }
  const smart = new Set(
    [0, 1, 2, 3, 4].flatMap((r) => followUpQuestions(0, r)),
  );
  assert.ok(smart.has("went_well") && smart.has("frequency"));
});

test("details flags take only listed choices", () => {
  assert.deepEqual(
    parseDetailArgs(
      ["details", "--vs-usual", "better", "--languages", "go,rust,go"],
      100,
    ),
    { vs_usual: "better", languages: ["go", "rust"] },
  );
  assert.deepEqual(parseDetailArgs(["details", "--went-well", "fast"], 0), {
    went_well: ["fast"],
  });
  for (const bad of [
    ["--task", "vibes"],
    ["--task", "docs,test"],
    ["--languages", ""],
    ["--session"],
  ])
    assert.throws(() => parseDetailArgs(["details", ...bad], 0));
  assert.throws(
    () => parseDetailArgs(["details", "--went-well", "fast"], 50),
    /smart/,
  );
  assert.match(
    followUpHint(["vs_usual"]),
    /derp details --vs-usual much_better\|better\|same\|worse\|much_worse/,
  );
});

test("interactive follow-up: numbers pick, Enter skips, junk is ignored", async () => {
  const replies = ["2", "", "1, 3, 99"];
  const out = [];
  const answers = await askFollowUp(
    ["vs_usual", "task", "languages"],
    async () => replies.shift(),
    (t) => out.push(t),
  );
  assert.deepEqual(answers, { vs_usual: "better", languages: ["ts_js", "go"] });
  assert.match(out.join(""), /Enter skips/);
});

function run(args, env) {
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
    child.stdin.end("");
  });
}

test("vote lists the optional questions; details sends them with the vote's key", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-details-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    HOME: root,
  };
  const seen = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let text = "";
    for await (const b of req) text += b;
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: text ? JSON.parse(text) : null,
    });
    if (req.url === "/api/votes" && req.method === "POST") {
      res.statusCode = 201;
      return res.end(JSON.stringify({ ok: true, evidenceKind: "public" }));
    }
    if (req.url === "/api/votes/details")
      return res.end(JSON.stringify({ ok: true, demo: false }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    env.DERPMETER_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    await mkdir(env.DERPMETER_HOME, { recursive: true });
    const token = `dm_cli_${"a".repeat(64)}`;
    await writeFile(
      join(env.DERPMETER_HOME, "config.json"),
      JSON.stringify({ token }),
    );
    // Before any vote: nothing to add to.
    const early = await run(["details", "--task", "docs"], env);
    assert.equal(early.code, 1);
    assert.match(early.err, /No claude-code vote/);

    const vote = await run(["vote", "dumb", "--model", "claude-opus-5-5"], env);
    assert.equal(vote.code, 0, vote.err);
    assert.match(vote.out, /Vote accepted/);
    // Not a terminal: the questions are listed, never asked or sent.
    assert.match(vote.out, /Optional follow-up/);
    assert.match(vote.out, /derp details --vs-usual/);
    assert.equal(seen.filter((s) => s.url === "/api/votes/details").length, 0);
    const key = seen.find((s) => s.url === "/api/votes").body.idempotencyKey;

    // went_well is refused locally after a Dumb vote.
    const wrong = await run(["details", "--went-well", "fast"], env);
    assert.equal(wrong.code, 1);
    const ok = await run(
      ["details", "--vs-usual", "worse", "--task", "bugfix"],
      env,
    );
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Thanks/);
    const sent = seen.filter((s) => s.url === "/api/votes/details");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${token}`);
    assert.deepEqual(sent[0].body, {
      agent: "claude-code",
      source: "cli",
      idempotencyKey: key,
      answers: { vs_usual: "worse", task: "bugfix" },
    });

    // --no-questions keeps the output to the vote line.
    const quiet = await run(
      ["vote", "smart", "--agent", "codex", "--no-questions"],
      env,
    );
    assert.equal(quiet.code, 0, quiet.err);
    assert.doesNotMatch(quiet.out, /follow-up/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
