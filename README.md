# DerpMeter CLI (`derp`)

`derp` is the DerpMeter command.

**Upgrading from 0.4 or earlier (breaking):** the `dumbindex` alias is gone, state moves from `~/.dumbindex` to `~/.derpmeter` on first run, tokens are re-issued automatically (`dm_` prefix), and the MCP tools are now `derp_score` / `derp_vote`. Rerun `derp install-statusline --yes` (it re-points an unchanged earlier install) and re-register the MCP server with the new `bin/derp.mjs` path.

Node.js 22.13+, no runtime dependencies. MIT licensed.

## Install

```sh
npm install -g derpmeter        # or: brew install derpmeter/derpmeter/derp
derp status
derp doctor
```

Upgrading from 0.5.5 or earlier (installed as `@derpmeter/cli`): run `npm uninstall -g @derpmeter/cli` first.

Nothing to configure. From the repository root, `npm run cli -- status` also works.

No setup is needed: the first `derp vote` gets an installation token from the service automatically (`POST /api/clients`) and stores it in `~/.derpmeter/config.json` (0600). The token is random, expires after 90 days and is replaced automatically when it expires. Extra tokens give no extra votes, because limits are shared per network. No email, account or device name is involved. An operator-issued token can still be imported without putting it in command-line arguments or history:

```sh
derp auth --token-stdin < /private/location/installation-token.txt
# Delete that temporary token file after import.
derp vote smart
derp vote meh
derp vote dumb
# Model attribution is optional and explicitly chosen:
derp vote dumb --model claude-opus-5-5
```

Use one vote command to intentionally send feedback. The default payload contains only agent/source/score and a random request UUID. The optional model must be a listed model for this agent. One vote per agent and model (no `--model` counts as its own) per installation and per network per hour is accepted (the operator can change the cooldown). Web, CLI, MCP and Menu Bar share the network limit. `derp status` shows when you can vote next for each agent, and a rejected vote says how long to wait. Shared networks can block unrelated people. Credentials and feedback are self-reported; they never prove that a model ran or that a rating is objectively correct.

## Agents, models, reasons, change and cancel

```sh
derp vote dumb --agent codex --reason hallucination   # agents: claude-code (default), codex, antigravity (alias agy)
derp change meh            # change your latest vote for this agent (within 24h)
derp cancel --agent codex  # cancel it; the cooldown for that agent still applies
```

Reasons: `instruction_failure`, `hallucination`, `repeated_mistake`, `poor_output`, `too_slow`, `other` (meh/dumb only). No free text.

Model detection when `--model` is omitted. A detected model is sent only if it is in the server catalog (`/api/models`, cached daily); otherwise the vote goes without a model.

- **Claude Code**: the model the statusline observed, only after `derp privacy session on`.
- **Codex**: the top-level `model` in `$CODEX_HOME/config.toml` (default `~/.codex`). This is your configured default, not proof of the model in use.
- **Antigravity** (`agy`, which replaced Gemini CLI and shares its home): `model.name` (or legacy string `model`) in `~/.gemini/settings.json`.

Nothing else is read from these files.

### Session-linked votes (opt-in)

`derp privacy session on` asks for confirmation. Afterwards the statusline keeps `{model, seenAt}` for Claude Code locally in `~/.derpmeter/observed.json`. A Claude Code vote within 15 minutes of an observation is flagged `sessionLinked`. No session ID, prompt, transcript, path or environment value is stored or sent. The flag only says a local Claude Code session was observed; it is not verification. `derp privacy session off` disables it and deletes the observation file.

### `/derp` command

```sh
derp install-command                  # Claude Code: ~/.claude/commands/derp.md  → /derp dumb --reason poor_output
derp install-command --agent codex    # Codex custom prompt: ~/.codex/prompts/derp.md → /prompts:derp
derp uninstall-command [--agent codex]
```

The command asks the agent to run `derp vote` with your explicit arguments only, and never to guess a rating. The installer confirms first. It refuses to overwrite a file it did not create, and it removes only its own file. `derp version` and `derp doctor` check the server's advertised CLI version.

### Updates

After an explicit command (never the statusline or MCP server), derp checks the advertised version at most once a day and, when a newer release exists, prints one line to stderr at most once a day, for example `derp 0.5.9 is available (you have 0.5.8). Update: brew upgrade derp`. The statusline adds `↑ derp x.y.z (derp update)` from that local cache without any request. `derp update` runs `brew upgrade derp` or `npm install -g derpmeter@latest`, matching how derp was installed, after confirming. Set `DERP_NO_UPDATE_CHECK=1` to turn the check off; it is also skipped in CI and when stderr is not a terminal.

## Statusline styles

```sh
derp statusline-config                     # preview every style with your cached score
derp statusline-config --style compact     # classic | compact | minimal | bar | mood
derp statusline-config --show model,score,vote --color on
derp statusline-config --model-name name   # auto | id | name ("Opus 5.5")
derp statusline-config --reset
```

Fields: `model`, `score`, `samples`, `scope`, `flags`, `mood`, `bar`, `vote`. The `vote` field counts down to your next allowed Claude Code vote, using the time cached by `derp status`; nothing is fetched while the statusline renders. Preferences live in `~/.derpmeter/config.json`.

## MCP server

`derp mcp` is a stdio MCP server exposing `derp_score` (read-only) and `derp_vote`. It uses a separate MCP-scoped token (`dm_mcp_…`), which it also obtains automatically on the first vote. A CLI token is not accepted for MCP votes, and an MCP token is not accepted for CLI votes. The server must enable `VOTE_CHANNELS=mcp`.

```sh
derp auth --token-stdin < /private/location/mcp-token.txt   # stored separately from the CLI token
claude mcp add derpmeter -- derp mcp --host claude-code
codex mcp add derpmeter -- derp mcp --host codex
```

The agent being rated is chosen per vote, independent of the host: a Codex host can rate Claude Code. Without `--host`, the host's MCP `clientInfo.name` is reduced in memory to `claude-code`, `codex` or `other`. Only that category is sent. Raw client names, versions, session IDs, prompts, paths and environment values are never sent or stored. The category is a claim, not proof of which model ran. The vote tool tells the model to submit only an explicit user request. Each call uses a new request UUID with at most one same-key retry on network failure. There is no persistent queue.

## Claude Code statusline

```sh
derp install-statusline
```

Installation asks before changing user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). The explicit noninteractive equivalent is `--yes`; there is no automatic postinstall hook. An existing supported statusline command is saved and composed before DerpMeter output, receiving its original stdin locally. That independent command retains its own behavior; DerpMeter cannot guarantee its privacy or networking. Unsupported configuration or an existing backup causes a safe refusal. Project/managed settings can override user settings. Restart Claude Code after installation.

DerpMeter extracts **only `model.id`** from supported statusline JSON, displays it immediately and never persists it. It ignores `session_id`, paths, repository identity, transcripts, prompts, code, costs and environment values. It never scans conversation files or processes. No session identifier or recent-session record is created, even locally. Session opt-in and `--with-session` have been removed; those flags are refused instead of being silently accepted.

The adapter makes **zero DerpMeter network requests** (the update hint is read from the local cache). `derp status` explicitly refreshes the public score cache, at most once every five minutes. No daemon is installed; run status when you want fresh data. The display labels agent vs model score, 24h sample size, low samples, stale cache and demo data. Unavailable model samples fall back to the agent score with an `agent 24h` label. Invalid stdin fails quietly. `doctor` reads local configuration and readiness, makes no network calls and prints no credential; it does not claim remote authentication succeeded.

## Minimal local state and retries

`~/.derpmeter` (override with `DERPMETER_HOME`) holds only the service origin/credential, public cache, minimal statusline restore record and one unresolved vote body/key/time. Files are written 0600 in directories created 0700. Restore records contain local command/settings paths solely to restore configuration; none are sent to the service.

Before a vote is sent, its exact body, origin, UUID and creation time are saved. On ambiguous failure, repeat the same command/options to recover the same receipt. Concurrent votes or a changed pending payload are blocked. Unresolved votes are refused after 24 hours so an expired receipt is not silently reused. This is one manual retry slot, not a background offline queue. To explicitly clear local retry state:

```sh
derp discard-pending
```

Discarding cannot undo an already accepted request. Stale locks are not stolen automatically: ensure no other CLI process is running before removing `vote.lock` or the indicated settings lock. On upgrade the CLI removes its obsolete local session identity/records/consent and session-linked pending data; previously accepted submissions may still exist. No legacy session payload is uploaded.

The server separates 24-hour abuse guards from historical ratings. It retains no session IDs or free text. The privacy summary is on [derpmeter.com/apps](https://derpmeter.com/apps).

## Uninstall and restore

```sh
derp uninstall-statusline   # confirms before restoring the previous setting
derp logout
npm uninstall -g derpmeter   # or: brew uninstall derp
```

Restore before deleting the package: the installed command uses its absolute path. Only `statusLine` is restored; newer unrelated settings remain. If you edited it after installation, automatic restoration refuses to overwrite your change. Inspect `~/.derpmeter/statusline-install.json` and copy its `previous` value into the recorded settings file's `statusLine` (remove the key if null), preserving other settings. Remove the backup record once restored; never overwrite the whole current settings file with an old copy.

`derp logout` revokes your tokens on the server and removes them locally. After restoring settings/resolving any pending request, explicitly remove `~/.derpmeter` to erase remaining local state if desired. Server-side aggregates are separate; historical votes have no retained client/browser/network identity columns after migration 004 and cleanup.

[Official Claude Code statusline stdin schema](https://code.claude.com/docs/en/statusline), consulted October 21, 2026. Only the documented current model identifier is consumed by DerpMeter.
