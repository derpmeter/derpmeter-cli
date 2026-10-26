# DerpMeter CLI (`derp`)

**How derpy is your AI today?** Vote Smart / Meh / Dumb on the coding agent you're using, and see the community's 24h [Derp Score](https://derpmeter.com) right in your terminal.

One package gives you:

- the `derp` command,
- a Claude Code **statusline** that shows the score for the model you're using and nudges you when you can vote,
- an **MCP server** so Claude Code or Codex can submit a vote you ask for.

Agents: Claude Code, Codex and Antigravity. Node.js 22.13+, no runtime dependencies, MIT licensed.

[![npm](https://img.shields.io/npm/v/derpmeter)](https://www.npmjs.com/package/derpmeter)

## Install

```sh
npm install -g derpmeter
# or
brew install derpmeter/derpmeter/derp
```

## Quick start

```sh
derp status                    # current scores and when you can vote next
derp vote dumb                 # rate Claude Code (the default agent)
derp vote smart --agent codex  # rate another agent
derp install-statusline        # show the score in Claude Code
derp install-command           # add /derp to Claude Code
```

There is nothing to sign up for. The first vote gets a random installation token automatically (no email, account or device name) and stores it in `~/.derpmeter/config.json`.

## Voting

```sh
derp vote smart|meh|dumb [--agent claude-code|codex|antigravity] [--model <id>] [--reason <reason>]
derp change meh            # change your latest vote for this agent (within 24h)
derp cancel --agent codex  # cancel it; the cooldown still applies
```

- **Agents:** `claude-code` (default), `codex`, `antigravity` (alias `agy`).
- **Reasons** (meh/dumb only): `instruction_failure`, `hallucination`, `repeated_mistake`, `poor_output`, `too_slow`, `other`. There is no free text.
- **Cooldown:** one vote per agent and model per hour (`--model` omitted counts as its own model). Web, CLI, MCP and menu bar share a per-network limit, so extra tokens give no extra votes. `derp status` shows when you can vote next; a rejected vote says how long to wait.
- A vote is a self-reported opinion. It never proves which model ran.

### Which model gets the vote

`--model <id>` must be a model listed for that agent. Without it, `derp` sends a detected model only if it is in the server catalog (`/api/models`, cached daily), and otherwise sends no model:

| Agent       | Where the model comes from                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Claude Code | The model the statusline last saw, only after `derp privacy session on`                          |
| Codex       | The top-level `model` in `$CODEX_HOME/config.toml` (default `~/.codex`): your configured default |
| Antigravity | `model.name` (or the legacy string `model`) in `~/.gemini/settings.json`                         |

Nothing else is read from these files.

### Session-linked votes (opt-in)

`derp privacy session on` asks for confirmation. The statusline then keeps `{model, effort, seenAt}` for Claude Code in `~/.derpmeter/observed.json` (effort is the level Claude Code reports, such as `high` or `xhigh`). The CLI never sends the effort level; the menu bar app may include it when it counts a broken Derp Smash CRT. A Claude Code vote within 15 minutes of an observation is flagged `sessionLinked`. No session ID, prompt, transcript, path or environment value is stored or sent. `derp privacy session off` turns it off and deletes the file.

### `/derp` slash command

```sh
derp install-command                  # Claude Code: ~/.claude/commands/derp.md  →  /derp dumb --reason poor_output
derp install-command --agent codex    # Codex: ~/.codex/prompts/derp.md          →  /prompts:derp
derp uninstall-command [--agent codex]
```

The command asks the agent to run `derp vote` with your arguments only, never to guess a rating. The installer asks first, never overwrites a file it did not create, and removes only its own file.

## Claude Code statusline

```sh
derp install-statusline
```

It asks before changing `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`); `--yes` skips the question. An existing statusline command is kept and runs first, with its own output in front of DerpMeter's. Restart Claude Code afterwards.

```
claude-opus-5-5 | Derp 72.4/100 · n=140 · agent 24h · community   # classic (default)
Opus 5.5 · Derp 72                                                 # compact
Opus 5.5 ▕███████░░░▏ 72                                           # bar
(⊙_☉) · Derp 72 · Opus 5.5                                         # mood
```

### Styles

```sh
derp statusline-config                     # preview every style with your cached score
derp statusline-config --style compact     # classic | compact | minimal | bar | mood
derp statusline-config --show model,score,vote --color on
derp statusline-config --model-name name   # auto | id | name ("Opus 5.5")
derp statusline-config --nudge off         # hide the vote nudge
derp statusline-config --reset
```

Fields: `model`, `score`, `samples`, `scope`, `flags`, `mood`, `bar`, `vote`. The `vote` field counts down to your next allowed Claude Code vote. Preferences live in `~/.derpmeter/config.json`.

### Vote nudge

On by default. While you can vote on Claude Code with the current model, the statusline ends with `🗳 vote: /derp` (or `derp vote` when the slash command is not installed). After you vote with `derp vote` or the MCP `derp_vote`, it disappears until that model's cooldown ends; `derp cancel` brings it back.

- It is worked out from your own recent votes in `~/.derpmeter/local-votes.json` (agent, model, time; pruned after 48 hours) and the cooldown cached by `derp status` or a vote. Votes made on the website are not seen.
- `derp install-statusline` sets Claude Code's `refreshInterval` to 60 seconds (an existing value is kept), so the nudge appears even in a quiet session. If you installed the statusline before 0.5.10, run it again.
- `derp statusline-config --nudge off` hides it.

### What the statusline reads

- From Claude Code's statusline JSON it reads **only `model.id`**. It ignores session IDs, paths, repository, transcript, prompts, code, costs and environment values. It never scans conversation files or processes.
- It makes **no network requests**. Scores come from the cache that `derp status` refreshes (at most every five minutes). No daemon is installed.
- It labels agent vs model score, the 24h sample size, low samples, stale cache and demo data. Without enough model votes it falls back to the agent score (`agent 24h`).

## MCP server

`derp mcp` is a stdio MCP server with two tools: `derp_score` (read-only) and `derp_vote`.

```sh
claude mcp add derpmeter -- derp mcp --host claude-code
codex mcp add derpmeter -- derp mcp --host codex
```

- It uses its own MCP token (`dm_mcp_…`), also obtained on the first vote. CLI and MCP tokens are not interchangeable.
- The rated agent is chosen per vote, so a Codex host can rate Claude Code.
- Only the host category (`claude-code`, `codex` or `other`) is sent. Without `--host` it comes from the MCP `clientInfo.name`, reduced in memory. Raw client names, versions, session IDs, prompts, paths and environment values are never sent.
- The vote tool tells the model to vote only when you explicitly ask. Each call has a new request UUID and at most one retry on network failure.

## Updates

After an explicit command (never the statusline or MCP server), `derp` checks the latest version at most once a day. When there is a new one it prints one line to stderr, and the statusline shows `↑ derp x.y.z`. `derp update` runs `brew upgrade derp` or `npm install -g derpmeter@latest`, matching how you installed it, after asking. Set `DERP_NO_UPDATE_CHECK=1` to turn the check off.

## Local state and retries

Everything lives in `~/.derpmeter` (override with `DERPMETER_HOME`). Files are written 0600 in 0700 directories:

- the service origin and your tokens,
- the public score cache,
- a record of the statusline setting it replaced (to restore it),
- your own recent CLI/MCP votes (for the vote nudge, 48 hours),
- at most one unresolved vote (body, request key, time).

Before a vote is sent, its exact body and request UUID are saved. If the network fails in an ambiguous way, run the same command again to get the same receipt. Unresolved votes are refused after 24 hours. There is no background queue. To clear it:

```sh
derp discard-pending
```

Discarding cannot undo a vote the server already accepted. If a lock is left behind, make sure no other `derp` process is running before removing `vote.lock`.

The server keeps 24-hour abuse guards apart from the rating history and stores no session IDs or free text. The privacy summary is on [derpmeter.com/apps](https://derpmeter.com/apps).

## All commands

```
vote smart|meh|dumb [--agent <id>] [--model <id>] [--reason <reason>]
change smart|meh|dumb [--agent <id>]  |  cancel [--agent <id>]
status  |  doctor  |  version  |  update
install-statusline  |  uninstall-statusline  |  statusline-config [...]
install-command  |  uninstall-command [--agent claude-code|codex]
privacy  |  privacy session on|off
auth --token-stdin  |  logout  |  discard-pending
statusline   (Claude Code JSON on stdin; local only)
mcp [--host claude-code|codex|other]
```

`derp doctor` checks the local setup without any network call and never prints a credential. To use a token you were given instead of an automatic one, pipe it in so it stays out of your shell history: `derp auth --token-stdin < token.txt`.

## Uninstall

```sh
derp uninstall-statusline   # asks, then restores your previous statusline
derp uninstall-command
derp logout                 # revokes your tokens on the server and deletes them locally
npm uninstall -g derpmeter  # or: brew uninstall derp
rm -rf ~/.derpmeter         # optional: remaining local state
```

Restore the statusline before removing the package, because the installed command uses its absolute path. Only `statusLine` is restored. If you edited it after installing, the restore refuses to overwrite your change; copy the `previous` value from `~/.derpmeter/statusline-install.json` by hand instead.

## Upgrading from older versions

- **0.5.5 or earlier** (installed as `@derpmeter/cli`): run `npm uninstall -g @derpmeter/cli` first.
- **0.4 or earlier:** the `dumbindex` alias is gone, state moves from `~/.dumbindex` to `~/.derpmeter` on first run, tokens are re-issued (`dm_` prefix), and the MCP tools are now `derp_score` / `derp_vote`. Run `derp install-statusline --yes` again and re-register the MCP server.

## Development

```sh
node --test test/*.test.mjs
node bin/derp.mjs status
```

Statusline input follows the [Claude Code statusline schema](https://code.claude.com/docs/en/statusline).

## Source

This repository is a read-only mirror of the CLI in the DerpMeter monorepo, updated on each release ([derpmeter/derpmeter-cli](https://github.com/derpmeter/derpmeter-cli)). Issues are welcome. Pull requests are applied upstream (with credit) and arrive with the next release. Related: [menu bar app](https://github.com/derpmeter/derpmeter-menubar).

MIT © DerpMeter
