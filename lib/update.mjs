// Update prompts: compare this CLI with the server's advertised version
// (/api/version). Checked at most once a day after explicit commands, cached
// locally; the statusline and MCP server only ever read the cache.
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { dataDir, readJson, safeWrite } from "./core.mjs";

export const CHECK_EVERY_MS = 86400_000;
export const NOTIFY_EVERY_MS = 86400_000;
const SEMVER = /^\d+\.\d+\.\d+$/;
const cachePath = () => join(dataDir(), "update-check.json");

// true when version a is older than b (x.y.z only; anything else is never older).
export function older(a, b) {
  if (!SEMVER.test(a) || !SEMVER.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// Homebrew installs live under a Cellar; everything else came from npm.
export function updateCommand(scriptPath) {
  let path = scriptPath;
  try {
    path = realpathSync(scriptPath);
  } catch {}
  return /\/(Cellar|homebrew|linuxbrew)\//.test(path)
    ? "brew upgrade derp"
    : "npm install -g derpmeter@latest";
}

// What to tell the user, from a cached check; null when up to date or unknown.
export function updateState(version, cache) {
  const latest = cache?.latest;
  if (typeof latest !== "string" || !older(version, latest)) return null;
  return {
    latest,
    unsupported:
      typeof cache.minimum === "string" && older(version, cache.minimum),
  };
}

export async function readUpdateCache() {
  return readJson(cachePath(), null).catch(() => null);
}

// Refresh the cache when it is older than a day. Never throws.
export async function checkForUpdate(origin, fetcher, now = Date.now()) {
  const cache = await readUpdateCache();
  if (cache && now - cache.checkedAt < CHECK_EVERY_MS) return cache;
  try {
    const r = await fetcher(`${origin}/api/version`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    const v = (await r.json())?.cli;
    if (!r.ok || typeof v?.latest !== "string") throw new Error();
    const next = {
      ...cache,
      checkedAt: now,
      latest: v.latest,
      minimum: typeof v.minimum === "string" ? v.minimum : null,
    };
    await safeWrite(cachePath(), next);
    return next;
  } catch {
    return cache;
  }
}

// One stderr line, at most once a day (every time when unsupported).
export function noticeText(version, state, command) {
  return state.unsupported
    ? `derp ${version} is no longer supported (latest ${state.latest}). Update: ${command}`
    : `derp ${state.latest} is available (you have ${version}). Update: ${command}`;
}
export async function maybeNotify(version, cache, command, now = Date.now()) {
  const state = updateState(version, cache);
  if (!state) return null;
  if (
    !state.unsupported &&
    cache.notifiedAt &&
    cache.notified === state.latest &&
    now - cache.notifiedAt < NOTIFY_EVERY_MS
  )
    return null;
  await safeWrite(cachePath(), {
    ...cache,
    notifiedAt: now,
    notified: state.latest,
  }).catch(() => {});
  return noticeText(version, state, command);
}
