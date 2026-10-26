#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import {
  config,
  endpoint,
  dataDir,
  readJson,
  safeWrite,
  saveConfig,
  extractModel,
  extractEffort,
  cachedIndex,
  refreshIndex,
  refreshCatalog,
  ensureToken,
  migrateLegacyHome,
  stableNodePath,
  renderIndex,
  withVoteLock,
} from "../lib/core.mjs";
import {
  installStatusline,
  uninstallStatusline,
  previousStatusline,
} from "../lib/settings.mjs";
import { serve, MCP_HOSTS } from "../lib/mcp.mjs";
import { robustFetch, readBody } from "../lib/net.mjs";
import {
  FIELDS,
  STYLES,
  normalizePrefs,
  renderStatusline,
} from "../lib/statusline.mjs";
import {
  AGENTS,
  AGENT_USAGE,
  agentArg,
  REASONS,
  configuredModel,
  resolveModel,
  freshObservation,
  recordObservation,
  clearObservations,
  saveReceipt,
  latestReceipt,
  dropReceipt,
  recordLocalVote,
  readLocalVotes,
  dropLocalVote,
  commandPath,
  installCommand,
  uninstallCommand,
} from "../lib/agents.mjs";
import {
  checkForUpdate,
  maybeNotify,
  readUpdateCache,
  updateCommand,
  updateState,
} from "../lib/update.mjs";
import { existsSync, readFileSync } from "node:fs";
const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;
const SCORES = { smart: 0, meh: 50, dumb: 100 };
const args = process.argv.slice(2);
const command = args[0];
const UPDATE = updateCommand(fileURLToPath(import.meta.url));
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
async function confirm(message) {
  if (args.includes("--yes")) return true;
  if (!process.stdin.isTTY)
    throw new Error("Confirmation requires a terminal or explicit --yes.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
async function stdin(max = 1_048_576) {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > max) throw new Error("Input too large.");
  }
  return text;
}
const NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Antigravity",
};
function waitText(seconds) {
  if (seconds < 60) return "<1 min";
  const m = Math.ceil(seconds / 60);
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
async function voteWait(c) {
  try {
    const r = await robustFetch(`${endpoint(c.endpoint)}/api/votes/status`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      headers: { Authorization: `Bearer ${c.token}` },
    });
    const d = await r.json();
    if (!r.ok || !Array.isArray(d.agents)) return null;
    // Cached for the statusline's optional "vote" field (computed locally).
    await safeWrite(join(dataDir(), "vote-status.json"), {
      fetchedAt: Date.now(),
      cooldownSeconds: Number.isFinite(d.cooldownSeconds)
        ? d.cooldownSeconds
        : null,
      agents: d.agents.map((a) => ({
        agent: a.agent,
        nextVoteAt: a.nextVoteAt ?? null,
        // Per-model cooldowns (model null = vote without --model).
        models: (a.models || []).map((m) => ({
          model: m.model ?? null,
          nextVoteAt: m.nextVoteAt,
        })),
      })),
    }).catch(() => {});
    // The cooldown is per agent and model; list models still cooling down.
    return `Next vote: ${d.agents
      .map((a) => {
        const cooling = (a.models || [])
          .map((m) => `${m.model ?? "no model"} in ${waitText(m.waitSeconds)}`)
          .join(", ");
        return `${NAMES[a.agent] || a.agent} ${a.canVote ? "now" : `in ${waitText(a.waitSeconds)}`}${a.canVote && cooling ? ` (${cooling})` : ""}`;
      })
      .join(" · ")}`;
  } catch {
    return null;
  }
}
// Compare against the server's advertised versions; never blocks other commands.
async function versionStatus(c) {
  try {
    const r = await robustFetch(`${endpoint(c.endpoint)}/api/version`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    const v = (await r.json())?.cli;
    if (!r.ok || typeof v?.latest !== "string") throw new Error();
    const state = updateState(VERSION, v);
    return {
      cli: VERSION,
      latest: v.latest,
      updateAvailable: !!state,
      unsupported: !!state?.unsupported,
      ...(state ? { update: UPDATE } : {}),
    };
  } catch {
    return { cli: VERSION, latest: "unavailable" };
  }
}
async function main() {
  migrateLegacyHome();
  const c = await config();
  if (command === "configure") {
    // Removed: the service is built in. Kept so old scripts do not fail.
    console.log("Nothing to configure.");
    return;
  }
  if (command === "auth") {
    if (!args.includes("--token-stdin"))
      throw new Error(
        "Use auth --token-stdin; never put credentials in command arguments.",
      );
    const token = (await stdin(256)).trim();
    // Each channel has its own credential; the server enforces its scope.
    const slot = token.match(/^dm_(cli|mcp)_[0-9a-f]{64}$/)?.[1];
    if (!slot) throw new Error("Invalid installation token format.");
    await saveConfig({
      ...c,
      [slot === "mcp" ? "mcpToken" : "token"]: token,
    });
    console.log("Installation token saved locally (0600).");
    return;
  }
  if (command === "logout") {
    // Revoke on the server (best effort), then forget locally.
    let revoked = 0;
    for (const token of [c.token, c.mcpToken].filter(Boolean)) {
      const r = await robustFetch(`${endpoint(c.endpoint)}/api/clients`, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (r?.ok) revoked++;
    }
    delete c.token;
    delete c.mcpToken;
    await saveConfig(c);
    console.log(
      `Local tokens removed${revoked ? `; ${revoked} revoked on the server` : "; server revocation not confirmed"}.`,
    );
    return;
  }
  if (command === "privacy") {
    if (args[1] === "on")
      throw new Error(
        "Session IDs are never collected. Use privacy session on to opt in to identifier-free session-linked votes.",
      );
    if (args[1] === "session" && ["on", "off"].includes(args[2])) {
      const on = args[2] === "on";
      if (
        on &&
        !(await confirm(
          "Opt in? The statusline will keep your current Claude Code model and effort level locally, and votes within 15 minutes are marked session-linked. No session ID, prompt, path or transcript is stored or sent.",
        ))
      )
        return;
      await saveConfig({
        ...c,
        sessionLink: on,
      });
      if (!on) await clearObservations();
      console.log(`Session-linked votes ${on ? "enabled" : "disabled"}.`);
      return;
    }
    console.log(
      `Session-linked votes: ${c.sessionLink ? "on" : "off"} (privacy session on|off). No session IDs, transcripts, prompts, paths or environment values are ever collected. With opt-in, only the current model is kept locally for 15 minutes and votes carry a session-linked flag.`,
    );
    return;
  }
  if (command === "status") {
    console.log(renderIndex(await refreshIndex(c), undefined));
    // Explicit command only (never the statusline): when can this installation vote next?
    if (c.token) {
      const wait = await voteWait(c);
      if (wait) console.log(wait);
    }
    return;
  }
  if (command === "statusline") {
    const raw = await stdin();
    const input = JSON.parse(raw);
    const model = extractModel(input);
    // Opt-in only; failures must never break the statusline.
    if (c.sessionLink && model)
      await recordObservation("claude-code", model, extractEffort(input)).catch(
        () => {},
      );
    const prior = await previousStatusline();
    if (prior) {
      const output = spawnSync(prior, {
        shell: true,
        input: raw,
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      if (output.stdout?.trim())
        process.stdout.write(output.stdout.trimEnd() + "\n");
    }
    console.log(
      renderStatusline({
        cache: await cachedIndex(c),
        model,
        prefs: c.statusline,
        catalog: (
          await readJson(join(dataDir(), "models.json"), null).catch(() => null)
        )?.data,
        voteStatus: await readJson(
          join(dataDir(), "vote-status.json"),
          null,
        ).catch(() => null),
        localVotes: await readLocalVotes(),
        nudge: voteNudge(),
      }) + statuslineUpdate(await readUpdateCache()),
    );
    return;
  }
  if (command === "statusline-config") {
    // Local display preferences only; nothing is sent anywhere.
    let prefs = normalizePrefs(c.statusline);
    if (args.includes("--reset")) prefs = normalizePrefs(null);
    const style = option("--style");
    if (args.includes("--style")) {
      if (!Object.hasOwn(STYLES, style))
        throw new Error(`Use --style ${Object.keys(STYLES).join("|")}.`);
      prefs = { ...prefs, style, fields: null };
    }
    if (args.includes("--show")) {
      const list = (option("--show") || "").split(",").filter(Boolean);
      if (!list.length || list.some((f) => !FIELDS.includes(f)))
        throw new Error(`Use --show with any of: ${FIELDS.join(",")}.`);
      prefs = { ...prefs, fields: list };
    }
    if (args.includes("--color")) {
      const v = option("--color");
      if (!["on", "off"].includes(v)) throw new Error("Use --color on|off.");
      prefs = { ...prefs, color: v === "on" };
    }
    if (args.includes("--nudge")) {
      const v = option("--nudge");
      if (!["on", "off"].includes(v)) throw new Error("Use --nudge on|off.");
      prefs = { ...prefs, nudge: v === "on" };
    }
    if (args.includes("--model-name")) {
      const v = option("--model-name");
      if (!["auto", "id", "name"].includes(v))
        throw new Error("Use --model-name auto|id|name.");
      prefs = { ...prefs, modelName: v };
    }
    const changed = [
      "--reset",
      "--style",
      "--show",
      "--color",
      "--model-name",
      "--nudge",
    ].some((f) => args.includes(f));
    if (changed)
      await saveConfig({
        ...c,
        statusline: prefs,
      });
    const sample = {
      cache: await cachedIndex(c),
      model: option("--model") || "claude-opus-5-5",
      catalog: (
        await readJson(join(dataDir(), "models.json"), null).catch(() => null)
      )?.data,
      voteStatus: await readJson(
        join(dataDir(), "vote-status.json"),
        null,
      ).catch(() => null),
    };
    console.log(
      `${changed ? "Saved. " : ""}Current: style=${prefs.style} show=${(prefs.fields || STYLES[prefs.style].fields).join(",")} color=${prefs.color ? "on" : "off"} model-name=${prefs.modelName} nudge=${prefs.nudge ? "on" : "off"}`,
    );
    console.log(`  → ${renderStatusline({ ...sample, prefs })}\n`);
    console.log("Styles (derp statusline-config --style <name>):");
    for (const [name, def] of Object.entries(STYLES))
      console.log(
        `  ${name.padEnd(8)} ${renderStatusline({ ...sample, prefs: { ...prefs, style: name, fields: null } })}    (${def.about})`,
      );
    console.log(
      `\nFields (--show a,b,c): ${FIELDS.join(", ")}\nAlso: --color on|off, --model-name auto|id|name, --nudge on|off, --reset. The "vote" field and the nudge use your own recent votes and the time cached by derp status.`,
    );
    return;
  }
  if (command === "install-statusline") {
    const done = await installStatusline(
      resolve(fileURLToPath(import.meta.url)),
      confirm,
    );
    console.log(
      done
        ? "Installed. Restart Claude Code. Run derp status to refresh the cache."
        : "No changes.",
    );
    return;
  }
  if (command === "uninstall-statusline") {
    console.log(
      (await uninstallStatusline(confirm))
        ? "Previous statusline restored."
        : "No changes.",
    );
    return;
  }
  if (command === "doctor") {
    const cache = await cachedIndex(c);
    console.log(
      JSON.stringify(
        {
          node: process.versions.node,
          credential: c.token
            ? "configured (not remotely checked)"
            : "missing; ask operator",
          mcpCredential: c.mcpToken
            ? "configured (not remotely checked)"
            : "missing; MCP voting unavailable",
          sessionCollection: false,
          sessionLinkedVotes: !!c.sessionLink,
          version: await versionStatus(c),
          cache: cache
            ? {
                mode: cache.data.mode,
                ageSeconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
              }
            : "missing; run status",
          statuslineBackup: !!(await readJson(
            join(dataDir(), "statusline-install.json"),
            null,
          )),
          pendingVote: !!(await readJson(
            join(dataDir(), "pending-vote.json"),
            null,
          )),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "change" || command === "cancel")
    return withVoteLock(async () => {
      const agent = agentArg(option("--agent"));
      if (!AGENTS.includes(agent))
        throw new Error(`Use --agent ${AGENT_USAGE}.`);
      if (!c.token)
        throw new Error("Installation token missing. Use auth --token-stdin.");
      const origin = endpoint(c.endpoint);
      const receipt = await latestReceipt(origin, agent);
      if (!receipt)
        throw new Error(
          `No ${agent} vote from this installation in the last 24 hours.`,
        );
      const body = { source: "cli", idempotencyKey: receipt.key };
      if (command === "change") {
        if (!Object.hasOwn(SCORES, args[1]))
          throw new Error(
            "Use change smart|meh|dumb [--agent <id>] [--reason <reason>].",
          );
        body.score = SCORES[args[1]];
        const reason = option("--reason");
        if (args.includes("--reason")) {
          if (!REASONS.includes(reason) || body.score === 0)
            throw new Error("Use --reason with meh or dumb only.");
          body.failureReason = reason;
        }
      }
      const r = await robustFetch(`${origin}/api/votes`, {
        method: command === "change" ? "PATCH" : "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.token}`,
        },
        body: JSON.stringify(body),
      });
      const result = await readBody(r);
      if (r.status === 410 || (command === "cancel" && r.ok)) {
        await dropReceipt(receipt.key);
        await dropLocalVote(receipt.key).catch(() => {});
      }
      if (!r.ok)
        throw new Error(
          `${result.error || "Request failed"} (HTTP ${r.status}).`,
        );
      console.log(
        result.demo
          ? "DEMO: preview only; nothing changed."
          : command === "change"
            ? "Vote changed."
            : "Vote cancelled. Your 24h limit for this agent still applies.",
      );
    });
  if (command === "install-command" || command === "uninstall-command") {
    const agent = agentArg(option("--agent"));
    if (command === "uninstall-command") {
      console.log(
        (await uninstallCommand(agent)) ? "Command removed." : "No changes.",
      );
      return;
    }
    const invoke = `${quote(stableNodePath())} ${quote(resolve(fileURLToPath(import.meta.url)))}`;
    console.log(
      (await installCommand(agent, invoke, confirm))
        ? `Installed. Use /derp ${agent === "codex" ? "(as /prompts:derp) " : ""}in ${agent}.`
        : "No changes.",
    );
    return;
  }
  if (command === "version") {
    console.log(JSON.stringify(await versionStatus(c), null, 2));
    return;
  }
  if (command === "update") {
    const v = await versionStatus(c);
    if (v.latest === "unavailable")
      throw new Error(
        `Could not check for updates. Update manually: ${UPDATE}`,
      );
    if (!v.updateAvailable) {
      console.log(`derp ${VERSION} is up to date.`);
      return;
    }
    if (
      !(await confirm(`Update derp ${VERSION} → ${v.latest} with: ${UPDATE}?`))
    )
      return;
    const run = spawnSync(UPDATE, { shell: true, stdio: "inherit" });
    if (run.status !== 0) throw new Error(`Update failed. Run: ${UPDATE}`);
    return;
  }
  if (command === "mcp") {
    // stdout is the protocol channel; only JSON-RPC replies are written there.
    const host = option("--host");
    if (args.includes("--host") && !MCP_HOSTS.includes(host))
      throw new Error("Use --host claude-code|codex|other.");
    await serve(c, { host });
    return;
  }
  if (command === "vote")
    return withVoteLock(async () => {
      if (!Object.hasOwn(SCORES, args[1]))
        throw new Error(
          "Use vote smart|meh|dumb [--agent <id>] [--model <id>] [--reason <reason>].",
        );
      if (args.includes("--with-session") || args.includes("--session"))
        throw new Error(
          "Session-linked voting has been removed; no session identifiers are collected.",
        );
      const agent = agentArg(option("--agent"));
      if (!AGENTS.includes(agent))
        throw new Error(`Use --agent ${AGENT_USAGE}.`);
      const body = { agent, source: "cli", score: SCORES[args[1]] };
      const reason = option("--reason");
      if (args.includes("--reason")) {
        if (!REASONS.includes(reason))
          throw new Error(`Use --reason ${REASONS.join("|")}.`);
        if (body.score === 0)
          throw new Error("A reason is only accepted with meh or dumb.");
      }
      let model = option("--model");
      if (args.includes("--model") && (!model || !MODEL_ID.test(model)))
        throw new Error("Provide a catalog model ID; no paths or free text.");
      // Detection fallbacks: opt-in statusline observation, then the agent's own config.
      const observed = c.sessionLink ? await freshObservation(agent) : null;
      if (!model) {
        const detected = observed?.model || (await configuredModel(agent));
        const catalog = detected ? await refreshCatalog(c) : null;
        const resolved = resolveModel(agent, detected, catalog);
        if (resolved) model = resolved;
        else if (detected)
          console.error(
            `Detected model ${detected} is not in the DerpMeter catalog; voting without a model.`,
          );
      }
      if (model) body.model = model;
      if (reason) body.failureReason = reason;
      if (observed) body.sessionLinked = true;
      const origin = endpoint(c.endpoint);
      const pendingPath = join(dataDir(), "pending-vote.json");
      const pending = await readJson(pendingPath, null);
      if (
        pending &&
        (pending.origin !== origin ||
          JSON.stringify(pending.body) !== JSON.stringify(body))
      )
        throw new Error(
          "An unresolved vote exists. Retry the same vote/options or explicitly run discard-pending.",
        );
      if (
        pending &&
        (!Number.isFinite(pending.createdAt) ||
          Date.now() - pending.createdAt >= 86400_000)
      )
        throw new Error(
          "Pending vote expired after 24 hours. Explicitly discard it; it will not be sent.",
        );
      const key = pending?.key || randomUUID();
      await safeWrite(pendingPath, {
        origin,
        body,
        key,
        createdAt: pending?.createdAt || Date.now(),
      });
      // Explicit execution only. Network failures keep the exact payload and key for safe retries.
      const send = (token) =>
        robustFetch(`${origin}/api/votes`, {
          method: "POST",
          redirect: "error",
          // Covers retries too; the same body and key are resent each time.
          signal: AbortSignal.timeout(20_000),
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ ...body, idempotencyKey: key }),
        });
      // First vote enrolls automatically; an expired or revoked token is replaced once.
      let r = await send(await ensureToken(c, "cli"));
      if (r.status === 401)
        r = await send(await ensureToken(c, "cli", robustFetch, true));
      const result = await readBody(r);
      if (!r.ok)
        throw new Error(
          `${result.error || "Vote failed"} (HTTP ${r.status}); pending vote retained.`,
        );
      await unlink(pendingPath);
      if (!result.demo) {
        await saveReceipt(origin, agent, key);
        // Hides the statusline vote nudge until this model's cooldown ends,
        // then caches the server's own timing (best effort).
        await recordLocalVote(agent, body.model, key).catch(() => {});
        const fresh = await config();
        if (fresh.token) await voteWait(fresh).catch(() => null);
      }
      console.log(
        result.demo
          ? "DEMO: preview only; no vote stored."
          : `Vote accepted · ${result.evidenceKind || "public"}${result.replayed ? " · previous submission recovered" : ""}; feedback is self-reported, never objectively verified.`,
      );
      return;
    });
  if (command === "discard-pending") {
    if (
      await confirm(
        "Discard local retry state? An ambiguous prior request may already have been accepted.",
      )
    )
      await withVoteLock(() =>
        unlink(join(dataDir(), "pending-vote.json")).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        }),
      );
    return;
  }
  console.log(
    "DerpMeter CLI (derp) — How derpy is your AI today?\nvote smart|meh|dumb [--agent claude-code|codex|antigravity] [--model <id>] [--reason <reason>]\nchange smart|meh|dumb [--agent <id>] | cancel [--agent <id>]\ninstall-command|uninstall-command [--agent claude-code|codex] | privacy session on|off | version | update\nstatusline-config [--style classic|compact|minimal|bar|mood] [--show <fields>] [--color on|off] [--model-name auto|id|name] [--nudge on|off] [--reset]\nstatus | doctor\nauth --token-stdin | logout\nprivacy | install-statusline | uninstall-statusline | discard-pending\nstatusline (Claude Code JSON stdin; local only)\nmcp [--host claude-code|codex|other] (MCP stdio server)",
  );
  if (command && !["help", "--help"].includes(command)) process.exitCode = 1;
}
// Statusline vote nudge: the /derp slash command when it is installed.
function voteNudge() {
  try {
    return existsSync(commandPath("claude-code"))
      ? "🗳 vote: /derp"
      : "🗳 vote: derp vote";
  } catch {
    return "🗳 vote: derp vote";
  }
}
// Statusline: cache only (no network), a short hint while an update waits.
function statuslineUpdate(cache) {
  const state = updateState(VERSION, cache);
  return state ? ` · ↑ derp ${state.latest} (derp update)` : "";
}
// After an interactive command: a daily check and at most one stderr line a day.
// Skipped for the statusline and MCP (machine channels), pipes, CI and opt-out.
async function updateNotice() {
  if (
    ["statusline", "mcp", "update", "version"].includes(command) ||
    !process.stderr.isTTY ||
    process.env.CI ||
    process.env.DERP_NO_UPDATE_CHECK
  )
    return;
  const c = await config();
  const cache = await checkForUpdate(endpoint(c.endpoint), robustFetch);
  const text = await maybeNotify(VERSION, cache, UPDATE);
  if (text) console.error(`\n${text}`);
}
main()
  .then(() => updateNotice().catch(() => {}))
  .catch((e) => {
    if (command === "statusline") {
      console.log("Claude Code | Derp unavailable · run derp doctor");
    } else {
      console.error(e.message);
      process.exitCode = 1;
    }
  });
