// Customizable statusline rendering. Pure: inputs are the local public cache,
// the current model id, optional cached vote status and user preferences.
// Never touches the network.
import { headline, renderIndex, TTL } from "./core.mjs";

export const FIELDS = [
  "model",
  "score",
  "samples",
  "scope",
  "flags",
  "mood",
  "bar",
  "vote",
];
export const STYLES = {
  classic: {
    fields: ["model", "score", "samples", "scope", "flags"],
    about: "Everything, as before",
  },
  compact: { fields: ["model", "score", "flags"], about: "Model and score" },
  minimal: { fields: ["score"], about: "Just the score" },
  bar: { fields: ["model", "bar", "score"], about: "Score as a 10-step bar" },
  mood: { fields: ["mood", "score", "model"], about: "Derpy's face" },
};
export const DEFAULT_PREFS = {
  style: "classic",
  fields: null, // null = the style's own fields
  color: false,
  // "auto": id for classic, readable name for the shorter styles.
  modelName: "auto", // or "id" (claude-opus-5-5) / "name" (Opus 5.5)
  // Short "go vote" hint while this model can be voted on again.
  nudge: true,
};
// Server default cooldown, used until `derp status` or a vote caches the real one.
const DEFAULT_COOLDOWN = 3600;

export function normalizePrefs(prefs) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  return {
    style: Object.hasOwn(STYLES, p.style) ? p.style : "classic",
    fields: Array.isArray(p.fields)
      ? p.fields.filter((f) => FIELDS.includes(f))
      : null,
    color: p.color === true,
    modelName: ["id", "name"].includes(p.modelName) ? p.modelName : "auto",
    nudge: p.nudge !== false,
  };
}

// When Claude Code can be voted on next with this model (ms; 0 = now):
// the cached server status, and your own recent votes (CLI and MCP) plus the
// cooldown, whichever is later. Local only.
export function nextVoteAt({ voteStatus, localVotes, model }) {
  const id = /^claude-[a-z0-9.-]{1,70}$/.test(model || "") ? model : null;
  const wait = voteStatus?.agents?.find((v) => v.agent === "claude-code");
  const cooldown =
    (Number.isFinite(voteStatus?.cooldownSeconds)
      ? voteStatus.cooldownSeconds
      : DEFAULT_COOLDOWN) * 1000;
  return Math.max(
    0,
    wait?.nextVoteAt ? Date.parse(wait.nextVoteAt) || 0 : 0,
    ...(wait?.models || [])
      .filter((m) => m.model === id)
      .map((m) => Date.parse(m.nextVoteAt) || 0),
    ...(Array.isArray(localVotes) ? localVotes : [])
      .filter(
        (v) =>
          v?.agent === "claude-code" &&
          (v.model ?? null) === id &&
          Number.isFinite(v.at),
      )
      .map((v) => v.at + cooldown),
  );
}

// Catalog name when cached ("Claude Opus 5.5" -> "Opus 5.5"); otherwise derived.
export function prettyModel(id, catalog) {
  const listed = catalog?.models?.find((m) => m.id === id)?.name;
  if (typeof listed === "string") return listed.replace(/^Claude /, "");
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

export function moodFace(score) {
  if (score == null) return "(·_·)";
  return score < 35 ? "(•‿•)" : score < 65 ? "(•_•)" : "(⊙_☉)";
}

const ansi = (code, text, on) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
const scoreColor = (s) => (s == null ? 2 : s < 35 ? 32 : s < 65 ? 33 : 31);
const shortWait = (seconds) =>
  seconds < 60
    ? "<1m"
    : seconds < 3600
      ? `${Math.ceil(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h${Math.ceil((seconds % 3600) / 60)}m`;

export function renderStatusline({
  cache,
  model,
  prefs,
  catalog,
  voteStatus,
  localVotes,
  nudge,
  now = Date.now(),
}) {
  const p = normalizePrefs(prefs);
  const fields = p.fields?.length ? p.fields : STYLES[p.style].fields;
  const until = nextVoteAt({ voteStatus, localVotes, model });
  // Appended to any style while a vote is open; gone once you vote. Skipped
  // when the "vote" field is showing and already says so.
  const voteShown =
    fields.includes("vote") &&
    (until > 0 || !!voteStatus?.agents?.some((v) => v.agent === "claude-code"));
  const hint =
    nudge && p.nudge && until <= now && !voteShown ? ` · ${nudge}` : "";
  return (
    renderLine({ cache, model, p, fields, catalog, voteStatus, until, now }) +
    hint
  );
}

function renderLine({
  cache,
  model,
  p,
  fields,
  catalog,
  voteStatus,
  until,
  now,
}) {
  // The untouched default keeps the original output byte for byte.
  if (p.style === "classic" && !p.fields && !p.color && p.modelName !== "name")
    return renderIndex(cache, model);
  const h = headline(cache, model);
  const score = h.score;
  const validModel = /^claude-[a-z0-9.-]{1,70}$/.test(model || "");
  const modelText = validModel
    ? p.modelName === "name" ||
      (p.modelName === "auto" && p.style !== "classic")
      ? prettyModel(model, catalog)
      : model
    : "Claude Code";
  const stale = !cache || now - cache.fetchedAt > TTL;
  const compact = p.style !== "classic";
  const flags = [
    cache?.data.mode === "demo" ? "DEMO" : compact ? null : "community",
    stale ? (compact ? "stale" : "stale; run derp status") : null,
    h.low ? (compact ? "low n" : "low sample") : null,
  ].filter(Boolean);
  const scoreText =
    score == null
      ? p.style === "bar"
        ? "—"
        : "Derp —"
      : p.style === "classic"
        ? `Derp ${score.toFixed(1)}/100`
        : p.style === "bar"
          ? String(Math.round(score))
          : `Derp ${Math.round(score)}`;
  const filled = score == null ? 0 : Math.round(score / 10);
  const wait = voteStatus?.agents?.find((v) => v.agent === "claude-code");
  const waitSeconds = until ? (until - now) / 1000 : 0;
  const segment = {
    model: modelText,
    score: ansi(scoreColor(score), scoreText, p.color),
    samples: h.samples,
    scope: h.scope,
    flags: flags.length ? ansi(2, flags.join(" · "), p.color) : null,
    mood: ansi(scoreColor(score), moodFace(score), p.color),
    bar: ansi(
      scoreColor(score),
      `▕${"█".repeat(filled)}${"░".repeat(10 - filled)}▏`,
      p.color,
    ),
    vote:
      wait || until
        ? waitSeconds > 0
          ? `vote in ${shortWait(waitSeconds)}`
          : "vote now"
        : null,
  };
  const parts = fields.map((f) => segment[f]).filter(Boolean);
  if (p.style === "classic" && fields[0] === "model" && parts.length > 1)
    return `${parts[0]} | ${parts.slice(1).join(" · ")}`;
  return parts.join(p.style === "bar" ? " " : " · ");
}
