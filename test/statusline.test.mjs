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
// Your own vote a minute ago: the score is revealed for this model.
const votedFor = (model) => [
  { agent: "claude-code", model, key: "k", at: now - 60_000 },
];
const render = (prefs, extra = {}) =>
  renderStatusline({
    cache,
    model: "claude-opus-5-5",
    prefs,
    now,
    localVotes: votedFor("claude-opus-5-5"),
    ...extra,
  });
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
      localVotes: votedFor("claude-fable-5-1"),
    }),
    "(•‿•) · Derp 20 · Fable 5.1", // mood has no flags field
  );
  assert.equal(
    renderStatusline({
      cache,
      model: "claude-fable-5-1",
      prefs: { style: "compact" },
      now,
      localVotes: votedFor("claude-fable-5-1"),
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
      {
        voteStatus: { agents: [{ agent: "claude-code", nextVoteAt: iso }] },
        localVotes: [],
      },
    );
  assert.equal(
    vote(new Date(now + 37 * 60000).toISOString()),
    "Derp 72 · vote in 37m",
  );
  // Once you can vote again the score hides until you do.
  assert.equal(vote(new Date(now - 1000).toISOString()), "Derp ? · vote now");
  assert.equal(vote(null), "Derp ? · vote now");
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
        localVotes: [],
      },
    );
  assert.equal(perModel("claude-opus-5-5"), "Derp 72 · vote in 12m");
  // Your vote was for another model: this one can vote, so no score.
  assert.equal(perModel("claude-sonnet-5-5"), "Derp ? · vote now");
  assert.equal(
    render({ style: "minimal", fields: ["score", "vote"] }, { localVotes: [] }),
    "Derp ?",
    "no cached status and no vote: field omitted, score hidden",
  );
  // No cache: stale and no score, never throws.
  assert.equal(
    renderStatusline({
      cache: null,
      model: undefined,
      prefs: { style: "compact" },
      now,
      localVotes: votedFor(null),
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
      localVotes: votedFor(null),
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
      nudge: true,
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
    // No vote yet: the preview keeps the score hidden too.
    assert.match(preview.out, /compact\s+Opus 5\.5 · Derp \?/);
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
      nudge: true,
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
      // No vote yet: score hidden, and the CLI nudge (no /derp installed).
      "Opus 5.5 \x1b[2m▕░░░░░░░░░░▏\x1b[0m \x1b[2m?\x1b[0m · 🗳 vote: derp vote",
    );
    // After your own vote for this model the score shows.
    await writeFile(
      join(env.DERPMETER_HOME, "local-votes.json"),
      JSON.stringify([
        {
          agent: "claude-code",
          model: "claude-opus-5-5",
          key: "k",
          at: Date.now() - 60_000,
        },
      ]),
    );
    const after = await run(
      ["statusline"],
      env,
      JSON.stringify({ model: { id: "claude-opus-5-5" } }),
    );
    assert.equal(
      after.out.trim(),
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
    renderStatusline({
      cache: blended,
      model,
      prefs,
      now,
      localVotes: votedFor(model ?? null),
    });
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
      localVotes: votedFor(null),
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

test("vote nudge shows while this model can vote and hides after your vote", () => {
  const nudge = "🗳 vote: /derp";
  const hiddenBase =
    "claude-opus-5-5 | Derp ? · shown after you vote · community";
  assert.equal(
    render(undefined, { nudge, localVotes: [] }),
    `${hiddenBase} · ${nudge}`,
  );
  assert.equal(
    render(undefined, { localVotes: [] }),
    hiddenBase,
    "no nudge text, no nudge",
  );
  // Your own vote for this model hides it for the cached cooldown.
  const voted = (at, model = "claude-opus-5-5", cooldownSeconds = 7200) =>
    render(
      { style: "minimal" },
      {
        nudge,
        voteStatus: { cooldownSeconds, agents: [] },
        localVotes: [{ agent: "claude-code", model, key: "k", at }],
      },
    );
  assert.equal(voted(now - 3600_000), "Derp 72");
  assert.equal(voted(now - 7300_000), `Derp ? · ${nudge}`);
  assert.equal(voted(now - 60_000, "claude-fable-5-1"), `Derp ? · ${nudge}`);
  // Unknown cooldown: the server default of one hour.
  assert.equal(
    render(
      { style: "minimal" },
      {
        nudge,
        localVotes: [
          {
            agent: "claude-code",
            model: "claude-opus-5-5",
            at: now - 1800_000,
          },
        ],
      },
    ),
    "Derp 72",
  );
  // Server status says the model is cooling down.
  assert.equal(
    render(
      { style: "minimal" },
      {
        nudge,
        voteStatus: {
          agents: [
            {
              agent: "claude-code",
              nextVoteAt: null,
              models: [
                {
                  model: "claude-opus-5-5",
                  nextVoteAt: new Date(now + 60_000).toISOString(),
                },
              ],
            },
          ],
        },
      },
    ),
    "Derp 72",
  );
  assert.equal(
    render({ style: "minimal", nudge: false }, { nudge, localVotes: [] }),
    "Derp ?",
  );
  // The "vote" field already says it; no duplicate.
  assert.equal(
    render(
      { style: "minimal", fields: ["score", "vote"] },
      {
        nudge,
        voteStatus: { agents: [{ agent: "claude-code", nextVoteAt: null }] },
        localVotes: [],
      },
    ),
    "Derp ? · vote now",
  );
});

test("score shows only after your vote, until this model can vote again", () => {
  const at = (prefs, localVotes) =>
    renderStatusline({
      cache,
      model: "claude-opus-5-5",
      prefs,
      now,
      localVotes,
      voteStatus: { cooldownSeconds: 3600, agents: [] },
    });
  const fresh = votedFor("claude-opus-5-5");
  const expired = [
    { agent: "claude-code", model: "claude-opus-5-5", at: now - 3601_000 },
  ];
  // Before voting: no score, sample size or mood in any style.
  assert.equal(at({ style: "compact" }, []), "Opus 5.5 · Derp ?");
  assert.equal(at({ style: "bar" }, []), "Opus 5.5 ▕░░░░░░░░░░▏ ?");
  assert.equal(at({ style: "mood" }, []), "(·_·) · Derp ? · Opus 5.5");
  assert.equal(
    at({ style: "minimal", fields: ["score", "samples", "scope"] }, []),
    "Derp ? · shown after you vote",
  );
  assert.ok(!at(undefined, []).includes("72"));
  assert.ok(!at(undefined, []).includes("n=140"));
  // Within the cooldown of your vote: the score shows.
  assert.equal(at({ style: "compact" }, fresh), "Opus 5.5 · Derp 72");
  assert.equal(at(undefined, fresh), renderIndex(cache, "claude-opus-5-5"));
  // Cooldown over: hidden again until the next vote.
  assert.equal(at({ style: "compact" }, expired), "Opus 5.5 · Derp ?");
  // Another agent's vote does not reveal Claude Code's score.
  assert.equal(
    at({ style: "compact" }, [
      { agent: "codex", model: null, at: now - 60_000 },
    ]),
    "Opus 5.5 · Derp ?",
  );
});
