// Local-first agent integrations. Each adapter reads one documented setting and
// nothing else: no transcripts, prompts, paths, history or environment dumps.
import { readFile, unlink, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, readJson, safeWrite } from "./core.mjs";
export const AGENTS = ["claude-code", "codex", "gemini-cli"];
// Google's agent is now Antigravity CLI (`agy`); its id stays "gemini-cli"
// so existing votes and API clients keep working.
const AGENT_ALIASES = { antigravity: "gemini-cli", agy: "gemini-cli" };
export const agentArg = (value) =>
  value ? (AGENT_ALIASES[value] ?? value) : "claude-code";
export const AGENT_USAGE = "claude-code|codex|antigravity (alias agy)";
export const REASONS = [
  "instruction_failure",
  "hallucination",
  "repeated_mistake",
  "poor_output",
  "too_slow",
  "other",
];
export const OBSERVATION_TTL = 15 * 60_000;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const claudeHome = () =>
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const geminiHome = () => join(homedir(), ".gemini");
// Codex: top-level `model = "..."` in config.toml (documented). Tables are ignored.
export function codexModel(toml) {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*model\s*=\s*"([^"]+)"\s*(#.*)?$/);
    if (m) return MODEL_ID.test(m[1]) ? m[1] : undefined;
  }
  return undefined;
}
// Antigravity CLI (and the retired Gemini CLI) share ~/.gemini: `model.name`
// in settings.json (older releases used a string `model`).
export function geminiModel(settings) {
  const value =
    typeof settings?.model === "string"
      ? settings.model
      : settings?.model?.name;
  return typeof value === "string" && MODEL_ID.test(value) ? value : undefined;
}
// Claude Code: `model` in its user settings (~/.claude/settings.json or
// $CLAUDE_CONFIG_DIR). May be a full id or an alias such as "opus".
export function claudeModel(settings) {
  const value = settings?.model;
  return typeof value === "string" && /^[A-Za-z0-9.[\]-]{1,80}$/.test(value)
    ? value
    : undefined;
}
// Maps a configured value to a catalog id for the agent. Exact ids win
// ("[1m]" and date suffixes are ignored); a Claude alias maps to the single
// current catalog model of that family, otherwise nothing.
export function resolveModel(agent, raw, catalog) {
  if (!raw) return undefined;
  const ids = (catalog?.models || [])
    .filter((m) => m.agent === agent)
    .map((m) => m.id);
  const id = raw
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
  if (ids.includes(id)) return id;
  if (agent !== "claude-code") return undefined;
  const family = id === "opusplan" ? "opus" : id;
  if (!/^(opus|sonnet|haiku|fable)$/.test(family)) return undefined;
  const matches = ids.filter((m) => m.startsWith(`claude-${family}-`));
  return matches.length === 1 ? matches[0] : undefined;
}
// Configured default model, not a session observation.
export async function configuredModel(agent) {
  try {
    if (agent === "claude-code")
      return claudeModel(
        JSON.parse(await readFile(join(claudeHome(), "settings.json"), "utf8")),
      );
    if (agent === "codex")
      return codexModel(
        await readFile(join(codexHome(), "config.toml"), "utf8"),
      );
    if (agent === "gemini-cli")
      return geminiModel(
        JSON.parse(await readFile(join(geminiHome(), "settings.json"), "utf8")),
      );
  } catch {
    return undefined;
  }
  return undefined;
}
// Opt-in only: the statusline records {model, seenAt} per agent, locally.
const observedPath = () => join(dataDir(), "observed.json");
export async function recordObservation(agent, model, now = Date.now()) {
  const all = await readJson(observedPath(), {}).catch(() => ({}));
  const prev = all[agent];
  // Throttle writes so frequent statusline refreshes stay cheap.
  if (prev?.model === model && now - prev.seenAt < 60_000) return;
  await safeWrite(observedPath(), { ...all, [agent]: { model, seenAt: now } });
}
export async function freshObservation(agent, now = Date.now()) {
  const all = await readJson(observedPath(), {}).catch(() => ({}));
  const o = all?.[agent];
  return o &&
    Number.isFinite(o.seenAt) &&
    now - o.seenAt >= 0 &&
    now - o.seenAt < OBSERVATION_TTL
    ? { model: MODEL_ID.test(o.model || "") ? o.model : undefined }
    : null;
}
export async function clearObservations() {
  await unlink(observedPath()).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}
// Receipts let `derp change`/`derp cancel` find your own vote for 24h.
const receiptsPath = () => join(dataDir(), "receipts.json");
export async function saveReceipt(origin, agent, key, now = Date.now()) {
  const list = (await readJson(receiptsPath(), [])).filter(
    (r) => now - r.at < 86400_000,
  );
  list.push({ origin, agent, key, at: now });
  await safeWrite(receiptsPath(), list.slice(-20));
}
export async function latestReceipt(origin, agent, now = Date.now()) {
  const list = await readJson(receiptsPath(), []);
  return list
    .filter(
      (r) => r.origin === origin && r.agent === agent && now - r.at < 86400_000,
    )
    .at(-1);
}
export async function dropReceipt(key) {
  const list = await readJson(receiptsPath(), []);
  await safeWrite(
    receiptsPath(),
    list.filter((r) => r.key !== key),
  );
}
// Slash command / custom prompt that runs `derp vote` with explicit arguments.
const MARKER = "<!-- derpmeter-command:v1";
export function commandPath(agent) {
  if (agent === "claude-code") return join(claudeHome(), "commands", "derp.md");
  if (agent === "codex") return join(codexHome(), "prompts", "derp.md");
  throw new Error("Command install supports claude-code and codex.");
}
export function commandText(agent, invoke) {
  const header =
    agent === "claude-code"
      ? `---\ndescription: DerpMeter — rate your AI coding agent (smart | meh | dumb)\nargument-hint: smart|meh|dumb [--agent <id>] [--reason <reason>]\n---\n`
      : `---\ndescription: DerpMeter — rate your AI coding agent (smart | meh | dumb)\n---\n`;
  return `${header}${MARKER} managed by \`derp install-command\`; remove with \`derp uninstall-command\` -->

The user wants to submit a DerpMeter vote. Arguments: $ARGUMENTS

If the arguments are empty, run \`${invoke} status\` and show its output.
Otherwise run exactly one shell command: \`${invoke} vote <arguments>\`

Rules:
- The first argument must be smart, meh or dumb. If it is missing or unclear, ask the user; never guess a rating.
- Allowed options only: --agent (claude-code|codex|antigravity), --model <catalog id>, --reason (${REASONS.join("|")}).
- Never add code, file paths, prompts or conversation content to the command.
- Report the command output verbatim. A vote is self-reported sentiment, not a verified measurement.
`;
}
export async function installCommand(agent, invoke, confirm) {
  const file = commandPath(agent);
  const existing = await readFile(file, "utf8").catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing !== null && !existing.includes(MARKER))
    throw new Error(
      `${file} exists and is not managed by DerpMeter. No changes made.`,
    );
  if (!(await confirm(`Write the /derp command to ${file}?`))) return false;
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(file, commandText(agent, invoke), { mode: 0o600 });
  return true;
}
export async function uninstallCommand(agent) {
  const file = commandPath(agent);
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === null) return false;
  if (!existing.includes(MARKER))
    throw new Error(`${file} is not managed by DerpMeter. Not removed.`);
  await unlink(file);
  return true;
}
