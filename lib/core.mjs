import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  unlink,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, realpathSync, renameSync } from "node:fs";
import { robustFetch } from "./net.mjs";
export const TTL = 5 * 60_000;
export const dataDir = () =>
  process.env.DERPMETER_HOME || join(homedir(), ".derpmeter");
// One-time move of the pre-rename ~/.dumbindex so the statusline restore
// record survives. Old di_ tokens are rejected (401) and re-enrolled.
export function migrateLegacyHome() {
  if (process.env.DERPMETER_HOME) return;
  const legacy = join(homedir(), ".dumbindex");
  const current = dataDir();
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, current);
  } catch {}
}
export const settingsPath = () =>
  join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`Cannot read valid JSON: ${path}`);
  }
}
export async function safeWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Refusing to replace a symbolic link.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
// The service URL is built in; users never configure or see it.
// DERPMETER_ENDPOINT exists only for development and tests.
export const DEFAULT_ENDPOINT = "https://derpmeter.com";
export async function config() {
  const c = await readJson(join(dataDir(), "config.json"), {});
  await clearLegacySessions();
  // Older versions stored a service URL; it is ignored and removed.
  if (Object.hasOwn(c, "sessionOptIn") || Object.hasOwn(c, "endpoint")) {
    delete c.sessionOptIn;
    await saveConfig(c);
  }
  return { ...c, endpoint: process.env.DERPMETER_ENDPOINT || DEFAULT_ENDPOINT };
}
// The service URL is never stored.
export async function saveConfig(next) {
  const rest = { ...next };
  delete rest.endpoint;
  await safeWrite(join(dataDir(), "config.json"), rest);
}
export function endpoint(value) {
  const u = new URL(value);
  if (
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error(
      "Use an HTTPS service origin (HTTP allowed only on loopback).",
    );
  return u.origin;
}
export function extractModel(input) {
  return typeof input?.model?.id === "string" &&
    /^claude-[a-z0-9.-]{1,70}$/.test(input.model.id)
    ? input.model.id
    : undefined;
}
// Claude Code's statusline JSON carries the effort level when the model has one.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export function extractEffort(input) {
  const level = input?.effort?.level;
  return EFFORTS.includes(level) ? level : undefined;
}
// Remove obsolete generated session files on upgrade; no session payload is read.
export async function clearLegacySessions() {
  await unlink(join(dataDir(), "identity.json")).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  await rm(join(dataDir(), "sessions"), { recursive: true, force: true });
  const pending = await readJson(join(dataDir(), "pending-vote.json"), null);
  if (pending?.body?.session)
    await unlink(join(dataDir(), "pending-vote.json"));
}
const score100 = (v) =>
  v === null || (Number.isFinite(v) && v >= 0 && v <= 100);
const count0 = (v) => Number.isFinite(v) && v >= 0;
// The blended Derp Score (votes + Radar, 7 days). Optional: older servers and
// demo snapshots omit it, but when present it must be well formed.
function blendedValid(s) {
  if (s === undefined || s === null) return true;
  const part = (p) => count0(p?.n) && score100(p.score);
  return (
    Array.isArray(s.agents) &&
    s.agents.every(
      (a) =>
        typeof a.agent === "string" &&
        score100(a.score) &&
        count0(a.sample) &&
        part(a.votes) &&
        (a.radar === null || part(a.radar)),
    )
  );
}
export function snapshotValid(x) {
  return (
    x?.version === 1 &&
    blendedValid(x.score) &&
    ["live", "demo"].includes(x.mode) &&
    Number.isFinite(Date.parse(x.now)) &&
    Array.isArray(x.agents) &&
    x.agents.every(
      (a) =>
        typeof a.agent === "string" &&
        Number.isSafeInteger(a.count) &&
        a.count >= 0 &&
        (a.score === null ||
          (Number.isFinite(a.score) && a.score >= 0 && a.score <= 100)) &&
        Array.isArray(a.models) &&
        a.models.every(
          (m) =>
            typeof m.model === "string" &&
            Number.isSafeInteger(m.count) &&
            m.count >= 0 &&
            (m.score === null ||
              (Number.isFinite(m.score) && m.score >= 0 && m.score <= 100)),
        ),
    )
  );
}
export async function cachedIndex(c) {
  const cache = await readJson(join(dataDir(), "index.json"), null).catch(
    () => null,
  );
  return cache?.origin === endpoint(c.endpoint) && snapshotValid(cache?.data)
    ? cache
    : null;
}
export async function refreshIndex(c, fetcher = robustFetch) {
  const origin = endpoint(c.endpoint);
  const cache = await cachedIndex(c);
  if (cache && Date.now() - cache.fetchedAt < TTL) return cache;
  try {
    const r = await fetcher(`${origin}/api/index`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!r.ok) throw new Error(`Index HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 256_000) throw new Error("Oversized snapshot");
    const data = JSON.parse(text);
    if (!snapshotValid(data)) throw new Error("Invalid index response");
    const next = { origin, fetchedAt: Date.now(), data };
    await safeWrite(join(dataDir(), "index.json"), next);
    return next;
  } catch (e) {
    if (cache) return cache;
    throw e;
  }
}
// The number shown for one agent. The blended Derp Score (votes + Radar over
// 7 days) is agent-level only, so the current model does not change it. Older
// servers and demo snapshots send no blend: then the 24h vote score, per model
// when that model has votes.
export function headline(cache, model, agentId = "claude-code") {
  const blended = cache?.data.score?.agents?.find((a) => a.agent === agentId);
  if (blended)
    return {
      score: blended.score,
      samples: [
        `votes ${blended.votes.n}`,
        blended.radar ? `Radar ${blended.radar.n}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      scope: "7d",
      low: blended.sample < 30,
    };
  const agent = cache?.data.agents.find((a) => a.agent === agentId);
  const match = agent?.models.find((m) => m.model === model);
  const a = match || agent;
  return {
    score: a?.score ?? null,
    samples: `n=${a?.count || 0}`,
    scope: `${match ? "model" : "agent"} 24h`,
    low: !!a && a.count < 30,
  };
}
export function renderIndex(cache, model) {
  const h = headline(cache, model);
  const safeModel = /^claude-[a-z0-9.-]{1,70}$/.test(model || "")
    ? model
    : "Claude Code";
  const score = h.score == null ? "—" : h.score.toFixed(1);
  const flags = [
    cache?.data.mode === "demo" ? "DEMO" : "community",
    !cache || Date.now() - cache.fetchedAt > TTL
      ? "stale; run derp status"
      : null,
    h.low ? "low sample" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${safeModel} | Derp ${score}/100 · ${h.samples} · ${h.scope} · ${flags}`;
}

export async function withVoteLock(action) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const lock = join(dataDir(), "vote.lock");
  let handle;
  try {
    handle = await import("node:fs/promises").then((fs) =>
      fs.open(lock, "wx", 0o600),
    );
  } catch {
    throw new Error(
      "Another vote is in progress. Remove a stale vote.lock only after confirming no CLI process is running.",
    );
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
// Public model catalog (daily cache). Auto-detected models are sent only if listed.
export async function refreshCatalog(c, fetcher = robustFetch) {
  const origin = endpoint(c.endpoint);
  const path = join(dataDir(), "models.json");
  const cache = await readJson(path, null).catch(() => null);
  const valid = (x) =>
    Array.isArray(x?.models) &&
    x.models.every(
      (m) => typeof m?.id === "string" && typeof m?.agent === "string",
    );
  if (
    cache?.origin === origin &&
    valid(cache.data) &&
    Date.now() - cache.fetchedAt < 86400_000
  )
    return cache.data;
  try {
    const r = await fetcher(`${origin}/api/models`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
    const data = await r.json();
    if (!valid(data)) throw new Error("Invalid catalog");
    await safeWrite(path, { origin, fetchedAt: Date.now(), data });
    return data;
  } catch {
    return cache?.origin === origin && valid(cache.data) ? cache.data : null;
  }
}
// Self-enrollment: get an installation token on first use (POST /api/clients).
// Tokens are origin-bound and stored 0600 next to the config. Returns null in demo mode.
export async function ensureToken(
  c,
  channel,
  fetcher = robustFetch,
  force = false,
) {
  const slot = channel === "mcp" ? "mcpToken" : "token";
  if (c[slot] && !force) return c[slot];
  const origin = endpoint(c.endpoint);
  const r = await fetcher(`${origin}/api/clients`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      `${d.error || "Could not get an installation token"} (HTTP ${r.status}).`,
    );
  if (d.demo) return null;
  const pattern = new RegExp(
    `^dm_${channel === "mcp" ? "mcp" : "cli"}_[0-9a-f]{64}$`,
  );
  if (!pattern.test(d.token || ""))
    throw new Error("Invalid token from server.");
  const path = join(dataDir(), "config.json");
  const current = await readJson(path, {});
  await saveConfig({ ...current, [slot]: d.token });
  c[slot] = d.token;
  return d.token;
}
// Version-pinned interpreter paths (e.g. Homebrew's /Cellar/node/<ver>/bin/node)
// vanish on upgrade. Prefer a stable symlink that resolves to the same binary.
export function stableNodePath(
  execPath = process.execPath,
  candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ],
) {
  let real;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of candidates) {
    try {
      if (candidate !== execPath && realpathSync(candidate) === real)
        return candidate;
    } catch {}
  }
  return execPath;
}
