import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { renderIndex } from "../lib/core.mjs";
import {
  renderStatusline,
  normalizePrefs,
  prettyModel,
  STYLES,
} from "../lib/statusline.mjs";
const cli = resolve(new URL("../bin/derp.mjs", import.meta.url).pathname);
const now = Date.parse("2026-10-22T12:00:00Z");
const cache = {
  fetchedAt: now - 1000,
  data: {
    version: 1,
    mode: "live",
    now: new Date(now).toISOString(),
    agents: [
      {
        agent: "claude-code",
        score: 72.4,
        count: 140,
        models: [{ model: "claude-fable-5-1", score: 20, count: 12 }],
      },
    ],
  },
};
const render = (prefs, extra = {}) =>
  renderStatusline({ cache, model: "claude-opus-5-5", prefs, now, ...extra });
test("default stays byte-identical to the original statusline", () => {
  assert.equal(render(undefined), renderIndex(cache, "claude-opus-5-5"));
  assert.equal(
    render({ style: "classic" }),
    renderIndex(cache, "claude-opus-5-5"),
  );
});
test("styles, fields, readable names, color and vote countdown", () => {
  assert.equal(render({ style: "compact" }), "Opus 5.5 · Derp 72");
  assert.equal(render({ style: "minimal" }), "Derp 72");
  assert.equal(render({ style: "bar" }), "Opus 5.5 ▕███████░░░▏ 72");
  assert.equal(render({ style: "mood" }), "(⊙_☉) · Derp 72 · Opus 5.5");
  assert.equal(
    render({ style: "compact", modelName: "id" }),
    "claude-opus-5-5 · Derp 72",
  );
  assert.equal(
    render({ style: "classic", modelName: "name" }),
    "Opus 5.5 | Derp 72.4/100 · n=140 · agent 24h · community",
  );
  // Model-level score (n=12, low sample).
  assert.equal(
    renderStatusline({
      cache,
      model: "claude-fable-5-1",
      prefs: { style: "mood" },
      now,
    }),
    "(•‿•) · Derp 20 · Fable 5.1", // mood has no flags field
  );
  assert.equal(
    renderStatusline({
      cache,
      model: "claude-fable-5-1",
      prefs: { style: "compact" },
      now,
    }),
    "Fable 5.1 · Derp 20 · low n",
  );
  assert.equal(
    render({ style: "minimal", fields: ["score", "samples", "scope"] }),
    "Derp 72 · n=140 · agent 24h",
  );
  const colored = render({ style: "minimal", color: true });
  assert.equal(colored, "\x1b[31mDerp 72\x1b[0m");
  const vote = (iso) =>
    render(
      { style: "minimal", fields: ["score", "vote"] },
      { voteStatus: { agents: [{ agent: "claude-code", nextVoteAt: iso }] } },
    );
  assert.equal(
    vote(new Date(now + 37 * 60000).toISOString()),
    "Derp 72 · vote in 37m",
  );
  assert.equal(vote(new Date(now - 1000).toISOString()), "Derp 72 · vote now");
  assert.equal(vote(null), "Derp 72 · vote now");
  // Per-model cooldown: only the current model's own wait counts.
  const perModel = (model) =>
    render(
      { style: "minimal", fields: ["score", "vote"] },
      {
        voteStatus: {
          agents: [
            {
              agent: "claude-code",
              nextVoteAt: null,
              models: [
                {
                  model,
                  nextVoteAt: new Date(now + 12 * 60000).toISOString(),
                },
              ],
            },
          ],
        },
      },
    );
  assert.equal(perModel("claude-opus-5-5"), "Derp 72 · vote in 12m");
  assert.equal(perModel("claude-sonnet-5-5"), "Derp 72 · vote now");
  assert.equal(
    render({ style: "minimal", fields: ["score", "vote"] }),
    "Derp 72",
    "no cached status: field omitted",
  );
  // No cache: stale and no score, never throws.
  assert.equal(
    renderStatusline({
      cache: null,
      model: undefined,
      prefs: { style: "compact" },
      now,
    }),
    "Claude Code · Derp — · stale",
  );
  // Untrusted model ids are never echoed.
  assert.equal(
    renderStatusline({
      cache,
      model: "/etc/passwd",
      prefs: { style: "compact" },
      now,
    }),
    "Claude Code · Derp 72",
  );
});
test("preferences are validated and names prefer the cached catalog", () => {
  assert.deepEqual(
    normalizePrefs({
      style: "nope",
      fields: ["model", "evil"],
      color: "yes",
      modelName: "x",
    }),
    {
      style: "classic",
      fields: ["model"],
      color: false,
      modelName: "auto",
    },
  );
  assert.equal(prettyModel("claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(prettyModel("claude-opus-4"), "Opus 4");
  assert.equal(
    prettyModel("claude-x-9", {
      models: [{ id: "claude-x-9", name: "Claude Special 9" }],
    }),
    "Special 9",
  );
  assert.ok(Object.keys(STYLES).length >= 5);
});
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
test("statusline-config saves preferences and the statusline uses them", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-sl-"));
  const env = {
    DERPMETER_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    HOME: root,
    DERPMETER_ENDPOINT: "https://derp.example",
  };
  try {
    await mkdir(env.DERPMETER_HOME, { recursive: true });
    await writeFile(
      join(env.DERPMETER_HOME, "config.json"),
      JSON.stringify({ sessionLink: false }),
    );
    await writeFile(
      join(env.DERPMETER_HOME, "index.json"),
      JSON.stringify({
        origin: "https://derp.example",
        fetchedAt: Date.now(),
        data: cache.data,
      }),
    );
    const preview = await run(["statusline-config"], env);
    assert.equal(preview.code, 0);
    assert.match(preview.out, /compact\s+Opus 5\.5 · Derp 72/);
    assert.equal(
      (await run(["statusline-config", "--style", "fancy"], env)).code,
      1,
    );
    assert.equal(
      (await run(["statusline-config", "--show", "model,secrets"], env)).code,
      1,
    );
    const saved = await run(
      ["statusline-config", "--style", "bar", "--color", "on"],
      env,
    );
    assert.equal(saved.code, 0, saved.err);
    const config = JSON.parse(
      await readFile(join(env.DERPMETER_HOME, "config.json"), "utf8"),
    );
    assert.deepEqual(config.statusline, {
      style: "bar",
      fields: null,
      color: true,
      modelName: "auto",
    });
    assert.equal(config.sessionLink, false, "other settings kept");
    const line = await run(
      ["statusline"],
      env,
      JSON.stringify({
        model: { id: "claude-opus-5-5" },
        session_id: "secret",
      }),
    );
    assert.equal(
      line.out.trim(),
      "Opus 5.5 \x1b[31m▕███████░░░▏\x1b[0m \x1b[31m72\x1b[0m",
    );
    await run(["statusline-config", "--reset"], env);
    const reset = await run(
      ["statusline"],
      env,
      JSON.stringify({ model: { id: "claude-opus-5-5" } }),
    );
    assert.match(reset.out, /^claude-opus-5-5 \| Derp 72\.4\/100/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("installer prefers a stable interpreter path over a version-pinned one", async () => {
  const { stableNodePath } = await import("../lib/core.mjs");
  const { mkdtemp, mkdir, writeFile, symlink } =
    await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "dm-node-"));
  const pinned = join(dir, "Cellar", "node", "26.10.0", "bin", "node");
  await mkdir(join(pinned, ".."), { recursive: true });
  await writeFile(pinned, "");
  const stable = join(dir, "bin-node");
  await symlink(pinned, stable);
  assert.equal(stableNodePath(pinned, [join(dir, "missing"), stable]), stable);
  assert.equal(stableNodePath(pinned, [join(dir, "missing")]), pinned);
  assert.equal(stableNodePath(join(dir, "nope"), [stable]), join(dir, "nope"));
});

test("blended Derp Score leads when the server sends it; model does not change it", () => {
  const blended = {
    ...cache,
    data: {
      ...cache.data,
      score: {
        start: "2026-10-16",
        end: "2026-10-22",
        voteWeight: 3,
        agents: [
          {
            agent: "claude-code",
            score: 35.2,
            sample: 706,
            votes: { n: 7, score: 14.3 },
            radar: { n: 685, score: 35.2 },
            days: [],
          },
        ],
      },
    },
  };
  const at = (model, prefs) =>
    renderStatusline({ cache: blended, model, prefs, now });
  assert.equal(
    renderIndex({ ...blended, fetchedAt: Date.now() }, "claude-fable-5-1"),
    "claude-fable-5-1 | Derp 35.2/100 · votes 7 · Radar 685 · 7d · community",
  );
  assert.equal(
    at("claude-fable-5-1", { style: "compact" }),
    "Fable 5.1 · Derp 35",
  );
  assert.equal(
    at("claude-opus-5-5", {
      style: "minimal",
      fields: ["score", "samples", "scope"],
    }),
    "Derp 35 · votes 7 · Radar 685 · 7d",
  );
  // Radar unavailable: votes only, and a small weighted sample is flagged.
  const votesOnly = structuredClone(blended);
  Object.assign(votesOnly.data.score.agents[0], {
    radar: null,
    sample: 21,
    score: 14.3,
  });
  assert.equal(
    renderStatusline({
      cache: votesOnly,
      model: undefined,
      prefs: { style: "compact" },
      now,
    }),
    "Claude Code · Derp 14 · low n",
  );
});

test("snapshot validation: blended score optional but strict when present", async () => {
  const { snapshotValid } = await import("../lib/core.mjs");
  const base = { ...cache.data, agents: [{ ...cache.data.agents[0] }] };
  assert.ok(snapshotValid(base));
  assert.ok(snapshotValid({ ...base, score: null }));
  const agent = {
    agent: "claude-code",
    score: 40,
    sample: 10,
    votes: { n: 1, score: 50 },
    radar: null,
  };
  assert.ok(snapshotValid({ ...base, score: { agents: [agent] } }));
  assert.ok(
    !snapshotValid({ ...base, score: { agents: [{ ...agent, score: 101 }] } }),
  );
  assert.ok(
    !snapshotValid({
      ...base,
      score: { agents: [{ ...agent, votes: { n: -1, score: 1 } }] },
    }),
  );
  assert.ok(!snapshotValid({ ...base, score: { agents: "x" } }));
});
