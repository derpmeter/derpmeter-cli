import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  older,
  updateCommand,
  updateState,
  checkForUpdate,
  maybeNotify,
} from "../lib/update.mjs";

test("versions compare numerically; malformed versions are never older", () => {
  assert.equal(older("0.5.7", "0.5.10"), true);
  assert.equal(older("0.5.10", "0.5.7"), false);
  assert.equal(older("0.5.7", "0.5.7"), false);
  assert.equal(older("0.5.7", "1.0.0"), true);
  assert.equal(older("0.5.7", "latest"), false);
  assert.equal(older("dev", "0.5.8"), false);
});

test("the update command follows the install method", () => {
  assert.equal(
    updateCommand("/opt/homebrew/Cellar/derp/0.5.7/libexec/bin/derp.mjs"),
    "brew upgrade derp",
  );
  assert.equal(
    updateCommand("/usr/local/lib/node_modules/derpmeter/bin/derp.mjs"),
    "npm install -g derpmeter@latest",
  );
});

test("update state: newer latest, unsupported below minimum", () => {
  assert.equal(updateState("0.5.7", null), null);
  assert.equal(updateState("0.5.7", { latest: "0.5.7" }), null);
  assert.deepEqual(
    updateState("0.5.7", { latest: "0.5.8", minimum: "0.5.0" }),
    {
      latest: "0.5.8",
      unsupported: false,
    },
  );
  assert.deepEqual(
    updateState("0.4.9", { latest: "0.5.8", minimum: "0.5.0" }),
    {
      latest: "0.5.8",
      unsupported: true,
    },
  );
});

test("checks at most daily, notifies at most daily, again for a newer release", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-update-"));
  process.env.DERPMETER_HOME = root;
  let calls = 0;
  let latest = "0.5.8";
  const fetcher = async (url) => {
    calls++;
    assert.match(url, /\/api\/version$/);
    return {
      ok: true,
      json: async () => ({ cli: { latest, minimum: "0.5.0" } }),
    };
  };
  try {
    const t0 = 1_000_000_000_000;
    let cache = await checkForUpdate("https://x.test", fetcher, t0);
    assert.equal(cache.latest, "0.5.8");
    assert.equal(calls, 1);
    cache = await checkForUpdate("https://x.test", fetcher, t0 + 3600_000);
    assert.equal(calls, 1); // cached
    const cmd = "npm install -g derpmeter@latest";
    assert.match(
      await maybeNotify("0.5.7", cache, cmd, t0),
      /derp 0\.5\.8 is available \(you have 0\.5\.7\)\. Update: npm install/,
    );
    cache = JSON.parse(await readFile(join(root, "update-check.json"), "utf8"));
    assert.equal(await maybeNotify("0.5.7", cache, cmd, t0 + 60_000), null);
    // A newer release is announced right away; up to date says nothing.
    latest = "0.5.9";
    cache = await checkForUpdate("https://x.test", fetcher, t0 + 86400_000);
    assert.match(
      await maybeNotify("0.5.7", cache, cmd, t0 + 86400_000),
      /0\.5\.9/,
    );
    assert.equal(await maybeNotify("0.5.9", cache, cmd, t0 + 86400_000), null);
    // Network failure keeps the last cache instead of throwing.
    await writeFile(
      join(root, "update-check.json"),
      JSON.stringify({ ...cache, checkedAt: 0 }),
    );
    const failed = await checkForUpdate(
      "https://x.test",
      async () => {
        throw new Error("offline");
      },
      t0 + 2 * 86400_000,
    );
    assert.equal(failed.latest, "0.5.9");
  } finally {
    delete process.env.DERPMETER_HOME;
    await rm(root, { recursive: true, force: true });
  }
});
