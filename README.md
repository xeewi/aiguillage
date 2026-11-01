<div align="center">

<img src="build/icon.png" alt="" width="96" height="96">

# Aiguillage

**Run several Claude Code agents in parallel, each on its own branch, from a single window.**
100% local: no account, no cloud, no telemetry.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![macOS · browser](https://img.shields.io/badge/macOS%20%C2%B7%20browser-lightgrey?logo=apple)](#install)
[![Tests](https://img.shields.io/badge/tests-83%20%2B%2026%20e2e-brightgreen)](#tests)
[![i18n](https://img.shields.io/badge/i18n-English%20%C2%B7%20Fran%C3%A7ais-orange)](#languages)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

[Install](#install) · [Features](#features) · [Configuration](#per-repo-configuration) · [Languages](#languages) · [Contributing](CONTRIBUTING.md)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
  <img src="docs/screenshots/hero.png" alt="Aiguillage: four workspaces in the sidebar, a conversation with the agent in the middle, the branch diff on the right" width="100%">
</picture>

</div>

## Why Aiguillage

One agent per isolated branch, five agents at a time: Aiguillage gives you that workflow without an account or a remote service.

- **It drives your own `claude` CLI.** Your subscription, models, MCP servers, hooks and skills stay yours. Aiguillage doesn't reimplement Claude Code and doesn't call the API.
- **Every agent works in its own git worktree**, on an `aig/<name>` branch. Your main checkout is never touched.
- **Everything stays on your machine.** The server only listens on `127.0.0.1`, and nothing is loaded from a CDN.

*Aiguillage* is French for a railway switch: the lever that sends each train down its own track.

## Install

**Requirements:** Node ≥ 22, git, and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), already logged in (`claude` on your `PATH`). [`gh`](https://cli.github.com) is optional (for the PR button).

Never used a terminal? Open the `.dmg` app: on first launch it checks git, Claude Code and your Claude login, and installs each missing one in one click.

```bash
git clone https://github.com/xeewi/aiguillage.git
cd aiguillage
npm install
```

Then pick one:

```bash
npm start      # in your browser → http://127.0.0.1:4317
npm run app    # in a macOS app window (Electron)
npm run dist   # builds dist/Aiguillage-<version>-arm64.dmg
```

> [!NOTE]
> The app and the browser share port 4317: if one is already running, the other connects to it instead of starting a second server. `PORT=xxxx` changes the port; `--no-open` skips opening the browser.
>
> The `.dmg` isn't signed by Apple yet: on first launch, right-click → **Open**.

### Updates

The app checks [GitHub releases](https://github.com/xeewi/aiguillage/releases) at launch and every 4 hours, downloads a new version in the background and offers **Restart to update** in the sidebar (or *Aiguillage → Check for Updates…*). It comes back on the same workspace and tab, with conversations and running scripts; an update left pending installs when you quit. This check is the app's only network request of its own: turn it off in **Settings**. If the app isn't in a folder it can write to (still on the `.dmg`, in Downloads), it offers the download instead.

To publish a version: bump `version` in `package.json`, commit, then `git tag v0.2.0 && git push --tags`. The [release workflow](.github/workflows/release.yml) builds the `.dmg` and the `.zip` the updater downloads, and publishes the release.

## How it works

1. **Add a local repo**, then click `+`: a worktree and its `aig/<city>` branch are created from `origin/<base>`, and your `setup` script runs.
2. **Talk to the agent.** Replies stream in, with tool calls and todos shown as they happen. You can interrupt at any time.
3. **Review the diff, test in the terminal** or with your Run scripts.
4. **Open a PR** (via `gh`) or **merge locally**, then **archive** the workspace.

Meanwhile, the other workspaces keep going. A colored badge shows each one's state: *working*, *needs you*, *finished*.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Permissions and plans

Four modes per workspace:

- **Auto**: everything is approved, except file edits outside the worktree, which are refused.
- **Ask**: you approve every tool call.
- **Auto edits**: file edits go through, everything else asks you.
- **Plan**: you approve the agent's plan, or reject it with a comment.

Model and thinking effort are also set per workspace.

</td>
<td width="50%"><img src="docs/screenshots/permissions.png" alt="Permission card: the agent wants to run git push, with Deny and Allow buttons"></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/run.png" alt="Run tab: the workspace's dev server runs on its own port"></td>
<td width="50%" valign="top">

### Terminal and Run scripts

A real shell in the worktree, plus a **Run** tab with your named scripts. Each workspace gets its own ports, so five dev servers can run side by side without clashing.

The agent knows its worktree, its ports and the Run script's log file, which it can read to debug.

</td>
</tr>
</table>

| | |
|---|---|
| **Chat** | One `claude` process per workspace (stream-json): streaming, tool calls and todos, nested subagents, Stop button. Sessions resume with `--resume`. |
| **Checkpoints** | ↺ on any of your messages rolls back the files **and** the conversation to just before it. |
| **Diff** | Everything that changed since the base branch: commits, modified files, new files, uncommitted changes included. |
| **Shipping** | Commit, local merge into the base branch, PR via `gh`, archive (worktree removed, branch kept and restorable). |
| **Ignored files** | Files listed in `.worktreeinclude` (else `file_include_globs`, else `.env*`) are copied into every new worktree. |
| **Notifications** | System notification when an agent finishes or needs you. <kbd>⌘</kbd><kbd>1</kbd>…<kbd>9</kbd> switches workspaces. |

## Per-repo configuration

Aiguillage reads these files, highest priority first:

1. `<repo>/.aiguillage/settings.local.toml`: your own overrides (add it to `.gitignore`)
2. `<repo>/.aiguillage/settings.toml`: shared with the team
3. `~/.aiguillage/settings.toml`: defaults for all your repos
4. otherwise: `aiguillage.json`

No run script anywhere? Aiguillage guesses from the project files and lists every match in the Run tab, the first one being the default: `Makefile` / `justfile` targets `dev` `start` `run` `serve`, `package.json` and `deno.json` scripts (with your lockfile's package manager), `Procfile` `web:`, then `cargo run`, `go run .`, Django `manage.py runserver`, `main.py` / `app.py`, `bin/rails server`, `mix phx.server`, `swift run`, Gradle, Maven, `dotnet run`, `docker compose up`. `$PORT` is set to the workspace port.
Nothing recognized? **Ask the agent** in the Run tab: it works out the command and writes `.aiguillage/settings.toml` for you.

```toml
[scripts]
setup = "pnpm install"
run_mode = "concurrent"      # "nonconcurrent": only one workspace of the repo runs its script at a time

[scripts.run.dev]
command = "pnpm dev --port $AIGUILLAGE_PORT"
default = true

[scripts.run.test]
command = "pnpm test --watch"
```

<details>
<summary>JSON format</summary>

```json
{ "setup": "npm install", "run": "npm run dev -- --port $AIGUILLAGE_PORT", "archive": "" }
```

</details>

<details>
<summary>Environment variables for scripts, the terminal and the agent</summary>

| Variable | Value |
|---|---|
| `AIGUILLAGE_ROOT_PATH` | path of the main repo |
| `AIGUILLAGE_WORKSPACE_NAME` | workspace name (`tokyo`, `lima`…) |
| `AIGUILLAGE_WORKSPACE_ID` | internal id |
| `AIGUILLAGE_WORKSPACE_PATH` | path of the worktree |
| `AIGUILLAGE_DEFAULT_BRANCH` | base branch |
| `AIGUILLAGE_IS_LOCAL` | always `1` |
| `AIGUILLAGE_PORT` | first of the 10 ports reserved for the workspace |

</details>

## Languages

The interface follows your browser or system language, and you can switch it from the sidebar. English and French ship today.

<details>
<summary>Screenshot in French</summary>

<img src="docs/screenshots/french.png" alt="The Aiguillage interface in French">

</details>

Translations use [i18next](https://www.i18next.com). Adding a language means adding one JSON file, no code: see [Adding a language](CONTRIBUTING.md#adding-a-language).

## Data and privacy

- Everything lives in `~/.aiguillage/` (`state.json`, `logs/`, `worktrees/`). Set `AIGUILLAGE_HOME` to move it.
- Checkpoints are private git refs, `refs/aiguillage/*`, in your repo.
- Only the `claude` CLI talks to the network, exactly as when you use it directly. API keys are stripped from the agent's environment, so usage is billed to your Claude account.

## Architecture

Node and vanilla JavaScript, no build step. You can read the whole codebase in an evening.

```
server.js          HTTP + WebSocket + terminals (node-pty)
lib/agent.js       claude process, permissions, briefing
lib/git.js         worktrees, diff, checkpoints
lib/config.js      per-repo settings (TOML / JSON)
lib/i18n.js        server-side messages (i18next)
lib/store.js       persisted state
public/            UI (index.html, app.js, i18n.js, style.css)
public/locales/    translations, one JSON file per language
electron/main.js   macOS app window
```

More: [docs/DNA.md](docs/DNA.md) (project principles, in French) and [DESIGN.md](DESIGN.md) (visual system).

## Tests

```bash
npm test           # unit + integration (83 tests, ~5 s)
npm run test:e2e   # browser flows, Playwright (26 tests, ~10 s)
npm run test:all   # both
```

The tests never call the real Claude. `test/fake-claude.mjs` mimics the CLI (same stream-json protocol, permission requests, resumed and rewound sessions), and Aiguillage uses it through `AIGUILLAGE_CLAUDE`. Each test file starts its own isolated server.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Disclaimer

Aiguillage is an independent project, not affiliated with Anthropic.

## License

[MIT](LICENSE) © Guillaume Gautier
