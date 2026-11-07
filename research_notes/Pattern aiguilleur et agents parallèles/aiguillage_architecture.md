# Aiguillage: architecture actuelle (aiguilleur + agents parallèles), état au commit 88bf7a0 / v0.14.0

Sources: code of the repo at `/Users/brucecoaster/.aiguillage/worktrees/claudeGod-1geke8ja/recherche-orchestration`. Citations are `file:line` relative to that root (commits by short hash). Line numbers are those of HEAD 88bf7a0 (2026-11-05).

System in one paragraph: a Node HTTP + WebSocket server on 127.0.0.1:4317 (`server.js`) drives one long-lived `claude -p` CLI process per "workspace" (one git worktree on an `aig/<name>` branch), speaking stream-json over stdio (`lib/agent.js`). A special workspace, the "aiguilleur", is itself a `claude -p` process with a different appended system prompt, running in `~/.aiguillage/aiguilleur`; it acts on the other agents only by `curl`-ing the same local HTTP API that the UI uses (`lib/remote.js`). A Telegram bot (long polling, outbound only) mirrors the aiguilleur's conversation, a pinned status board and permission requests to the user's phone.

## 1. What is the aiguilleur, and how is it implemented?

### Takeaway
The aiguilleur is a plain Claude Code CLI session (same `start()` code path as any worker) distinguished only by (a) its own appended system prompt `brief()`, (b) a working directory outside every repo used as file-based memory, (c) Auto permission mode, and (d) a server-side prompt wrapper that prepends unread agent reports to each user message. It has no custom tools: its "tools" are Bash + `curl` against Aiguillage's local REST API. Its "report and relay, never decide" role is enforced by prompt only.

### Cited Findings
- It is a Claude Code agent of its own, sees every repo and workspace, and relays instructions through the server's own HTTP API; its memory is `~/.aiguillage/aiguilleur` (CLAUDE.md + projects/*.md) — [lib/remote.js:1-5](lib/remote.js:1)
- Created at server start as a pseudo-workspace `{ id: 'aiguilleur', name: 'aiguilleur', permissionMode: 'auto', model: '', effort: '' }`, path `HOME/aiguilleur`, with `brief: brief(port)`; "A workspace of its own outside every repo, so it can't edit any project's files" — [lib/remote.js:534-542](lib/remote.js:534)
- Spawned through the same `start()` as workers; the only difference is `--append-system-prompt ws.brief ?? briefing(ws)` ("brief: the aiguilleur's own") — [lib/agent.js:135-139](lib/agent.js:135)
- Default model/effort: empty strings, i.e. the CLI's own default unless the user changes it (the aiguilleur accepts `PATCH /api/workspaces/aiguilleur`) — [lib/remote.js:536](lib/remote.js:536); [server.js:437-438](server.js:437)
- Its HTTP surface on itself is restricted: for id `aiguilleur` only log, commands, PATCH, send, upload, interrupt, stop-task, permission routes apply ("Not a worktree") — [server.js:437-438](server.js:437); [server.js:491-494](server.js:491)
- **System prompt verbatim (appended to Claude Code's default system prompt)** — [lib/remote.js:69-98](lib/remote.js:69):
  > You are the aiguilleur (the switchman who sets the points) of Aiguillage, a local app on the user's Mac that runs several Claude Code agents in parallel, one per git worktree (a "workspace").
  > The user talks to you from Aiguillage's window or, when away, from Telegram (their message then starts with [Telegram]): one conversation, shown on both sides. Be brief, in the user's language. Both sides render Markdown: keep it light (short paragraphs, lists, bold, `code`) so it reads well on a phone screen: no tables, no headings.
  > You are the user's one interlocutor: the agents report to you and the user answers through you.
  > Your role is to report and to relay, never to decide. The user makes every decision and gives every instruction:
  > - You report: what each agent is doing, has done, is stuck on or asks. Facts, not advice, unless the user asks for your opinion.
  > - You relay: when the user tells you to give an agent an instruction, send it what the user said, faithfully (their intent, their words where possible). Add only the context the agent needs to understand it; never add tasks, steps or choices of your own.
  > - Nothing on your own initiative: no message to an agent, no new workspace, no interrupt, commit, merge or PR unless the user asked for that very action in their message. An agent asking a question or waiting for a choice is something you report to the user, not something you answer.
  > - Unsure which workspace they mean or what exactly to send? Ask the user; don't guess.
  > You don't write code. You read and act through Aiguillage's HTTP API at http://127.0.0.1:${port} (curl; POST bodies are JSON, with -H 'content-type: application/json'):
  > - GET /api/state: repos, and workspaces (id, repoId, name, title, branch, path, busy, failed, pending permission requests, archived). Ignore archived ones. Those with free: true are sessions tied to no project (no repo, branch or diff).
  > - GET /api/workspaces/<id>/log: its conversation as a JSON array, often long: pipe it through python3 or jq and keep the last entries (cg_user = what the user said, assistant = the agent).
  > - GET /api/workspaces/<id>/diff: its changes against its base branch.
  > - POST /api/workspaces/<id>/send {"text": "...", "files": ["/path", ...]}: relay the user's instruction to that agent. When it finishes its turn, Aiguillage shows its report to the user in this conversation (and on Telegram) by itself: no need to wait for it or pass it on.
  > - To show the user an image, a video or a sound (a screenshot an agent took…), embed its absolute path as Markdown, ![caption](/path/to/shot.png): the window shows it, and Telegram gets it as a photo, video or file. Media in an agent's report reach the user by themselves.
  > - Files the user sends you (photos, documents, voice notes from Telegram) are listed under "Attached files": when they are for an agent, pass their paths on in files, as given (the agent gets its own copy); other paths are ignored. Look at them only if you need to […]. A voice note you can't listen to: transcribe it if a tool is at hand (whisper-cli, with ffmpeg), otherwise say so.
  > - When the user asks for it: POST /api/workspaces/<id>/interrupt; POST /api/workspaces {"repoId": "...", "name": "short-slug"} (a new workspace, then relay their task to it); /commit {"message": "..."}, /merge, /pr.
  > Permission requests are not yours to answer: the user gets Allow / Deny buttons for them, in Aiguillage and on Telegram.
  > The repos are on disk (paths in /api/state): read them freely to answer questions about the projects, but never edit them.
  > Your memory is the folder you run in, the only place you may write: [CLAUDE.md index; projects/<repo name>.md per project; "## Journal" section appended by Aiguillage after each agent turn; "Facts only, short, dated… Never store secrets. Writing your notes is the one thing you do without being asked."]
  > Agents' reports (their last words when they finish a turn, marked ✅ or ❌ with the project and workspace) are shown to the user as they come. Those you haven't read yet head the user's next message, under [Reports from the agents since your last message]: take them in to know where things stand; don't repeat them unless asked.
  > A message with [Reply to the report of <project> / <workspace> (id <id>)] is the user answering that agent: relay it to that workspace, faithfully, unless it is clearly a question for you.
- Tools available to the aiguilleur = whatever the user's Claude Code has (Bash, Read, etc., plus user MCP/skills), minus `AskUserQuestion` which is disallowed for every agent in `-p` mode — [lib/agent.js:138](lib/agent.js:138). No custom MCP server or tool is registered by Aiguillage (no `--mcp-config` in the spawn args) — [lib/agent.js:135-148](lib/agent.js:135)
- Running in Auto mode, every tool call is auto-approved except `ExitPlanMode`; Edit/Write/MultiEdit/NotebookEdit outside its own folder are refused — [lib/agent.js:168-176](lib/agent.js:168); [lib/remote.js:536](lib/remote.js:536)
- README description: "It reports and relays, it never decides… it sends your instruction as you gave it and does nothing you didn't ask for. It acts through Aiguillage's local API and leaves the code to the workspaces' agents." — [README.md:130](README.md:130)

### Inferences
- Architecturally the aiguilleur is an "LLM-as-router/relay" layer on top of a conventional (non-LLM) orchestrator: the Node server does all process management, state, and event routing deterministically; the LLM only translates user intent into REST calls and summarizes status. It is deliberately *not* a planner/supervisor in the AutoGen/LangGraph "manager" sense.
- The "never decide" constraint and "never edit repos" constraint are soft (prompt-level). Hard enforcement exists only for file-editing tools via path check; Bash (including `curl` POST to `/merge`, `/pr`, or `git` commands in a repo) is unrestricted because the aiguilleur runs in Auto (see DNA anti-goal note, [docs/DNA.md:34](docs/DNA.md:34)).

### Gaps
- No eval or test checks that the aiguilleur actually obeys "relay faithfully / no initiative"; tests only cover routing, prompt construction and staleness ([test/remote.test.js](test/remote.test.js)). Behavioural compliance is unmeasured.

## 2. Worker agents: spawning, configuration, isolation, concurrency

### Takeaway
Each workspace = one git worktree on branch `aig/<name>` created from `origin/<base>` when available, one persistent `claude -p` process (stream-json, resumed with `--resume`), 10 reserved ports, a private attachments dir, and a short appended "briefing". Isolation is filesystem-level by convention plus a hard guard on edit tools only; there is no sandbox for shell commands and no concurrency cap.

### Cited Findings
- Worktree creation: name = slug or a free city name, `-vN` suffix on collision; path `~/.aiguillage/worktrees/<repo>-<repoId>/<name>`; `git fetch origin <base>` best effort, then `git worktree add --no-track -b aig/<name> <path> origin/<base>` — [server.js:119-136](server.js:119); [lib/git.js:33](lib/git.js:33)
- Gitignored files (.env…) copied into the new worktree from `.worktreeinclude`, else `file_include_globs`, else `.env*`; then the repo's `setup` script runs in a pty — [server.js:137-151](server.js:137)
- Per-repo config layering: `<root>/.aiguillage/settings.local.toml` > `<workspace>/.aiguillage/settings.toml` > `~/.aiguillage/settings.toml` > `aiguillage.json`; run-command auto-detection table — [lib/config.js:1-3](lib/config.js:1); [lib/config.js:43-79](lib/config.js:43)
- Ports: first free multiple-of-10 slot from 40000; `ports ${port}-${port+9}` reserved; env `PORT` and `AIGUILLAGE_PORT` set — [server.js:157-162](server.js:157); [lib/agent.js:55-66](lib/agent.js:55); [lib/agent.js:100](lib/agent.js:100)
- Defaults for new workspaces: `permissionMode` (default `auto`), `model`, `effort` from Settings — [server.js:161](server.js:161); [server.js:328-332](server.js:328)
- Spawn command: `claude -p --verbose --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool stdio --permission-mode <mode> --disallowedTools AskUserQuestion --append-system-prompt <briefing> --add-dir <attachments> [--model] [--effort] [--resume <session> [--resume-session-at <uuid> --fork-session]]`, cwd = worktree — [lib/agent.js:133-149](lib/agent.js:133)
- Environment: API keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) stripped so billing goes to the user's Claude subscription; nesting vars removed — [lib/agent.js:45-53](lib/agent.js:45)
- Worker briefing verbatim (appended system prompt) — [lib/agent.js:90-107](lib/agent.js:90):
  > You are running inside Aiguillage, a local app that runs several Claude Code agents in parallel, each in its own git worktree.
  > Your workspace is ${ws.path} (branch ${ws.branch}, created from ${ws.baseRef || ws.base}). Create and edit files only inside it: edits elsewhere are refused.
  > Other agents work at the same time in sibling worktrees; leave the main checkout (${root}) and other worktrees alone.
  > Ports ${ws.port}-${ws.port + 9} are reserved for this workspace ($AIGUILLAGE_PORT is the first); use them for dev servers.
  > Output of the user's setup/run script is written to ${runLogPath(ws.id)}; read it when asked about the running app or its errors.
  > The user reviews your diff against ${ws.base} in Aiguillage and merges from there.
  > The chat shows images, videos and sounds: to show one, embed its local path in your reply as Markdown […]. Those in your last message of a turn also reach the user on their phone when they are away: put a screenshot they asked for there.
- Workers are **not** told about the aiguilleur, the HTTP API or other agents' ids — [lib/agent.js:90-107](lib/agent.js:90)
- Permission modes: UI "auto" maps to CLI `default` mode but Aiguillage auto-answers every `can_use_tool` itself (instead of `bypassPermissions`) "so every tool call still reaches us and edits outside the worktree can be refused"; other modes `default` (Ask), `acceptEdits`, `plan` — [lib/agent.js:68-72](lib/agent.js:68); [server.js:329](server.js:329)
- Hard guard: Edit/MultiEdit/Write/NotebookEdit whose path resolves (following symlinks) outside the worktree are denied with a message — [lib/agent.js:72-87](lib/agent.js:72); [lib/agent.js:170-172](lib/agent.js:170)
- Shell commands are not confined: "Les outils d'édition sont bloqués hors du worktree ; une commande shell reste techniquement libre." — [docs/DNA.md:34](docs/DNA.md:34)
- Attachments live outside the worktree in `~/.aiguillage/attachments/<wsId>/<uploadId>/<name>` (never in the diff), readable via `--add-dir`; passed to the model as a path list, not inline base64 — [lib/store.js:11-13](lib/store.js:11); [lib/agent.js:141-142](lib/agent.js:141); [lib/agent.js:235-240](lib/agent.js:235)
- Model and effort switchable live (`set_model` control request) or applied on restart with `--resume`; `/model` and `/effort` typed in chat persist after the CLI confirms — [lib/agent.js:269-274](lib/agent.js:269); [lib/agent.js:382-401](lib/agent.js:382)
- Workspace title generated by a throwaway Haiku call (no tools, no MCP, no hooks, 60 s timeout) from the first message — [lib/agent.js:291-305](lib/agent.js:291)
- "Sessions tied to no project": an agent in `~/.aiguillage/sessions/<id>` (its own git repo for checkpoints), chat only, reported to the aiguilleur as « Session / … » — [server.js:164-176](server.js:164); commit c97ee2c
- Max concurrency: no limit found in code; port allocation is unbounded (`while (used.has(port)) port += 10`) — [server.js:158-160](server.js:158). The only concurrency control is `run_mode = "nonconcurrent"` for *run scripts* (kills other workspaces' run scripts of the same repo) — [server.js:402-406](server.js:402). Marketing says "five agents at a time" — [README.md:30](README.md:30); PRODUCT.md targets "3–5 agents" — [PRODUCT.md:10](PRODUCT.md:10)
- Each worker can itself spawn Claude Code subagents and background shells; Aiguillage tracks them (`task_started/progress/notification`) and can stop one (`stop_task`) — [lib/agent.js:27-43](lib/agent.js:27); [lib/agent.js:348-352](lib/agent.js:348)

### Inferences
- Two-level hierarchy in practice: aiguilleur (LLM relay) → workspace agents (Claude Code sessions) → each agent's own native subagents (Task/Agent tool). Aiguillage observes but does not orchestrate level 3.
- Isolation model = git worktree + edit-tool path guard + port range + per-workspace env; comparable to "workspace-per-agent" patterns, but no container/VM sandbox.

### Gaps
- No hard cap on simultaneous processes or rate-limit-aware scheduling; whether practical limits (plan quota, CPU) are ever hit is undocumented.

## 3. Communication protocol, topology and shared state

### Takeaway
Strict hub-and-spoke with a human at the hub's back: user ⇄ aiguilleur ⇄ (REST) ⇄ server ⇄ (stdio stream-json) ⇄ workers. Downward messages are free-text "send" calls (a new user turn in the worker's session); upward messages are automatic "reports" = the worker's last assistant text of each turn, injected as an event into the aiguilleur's log and lazily prepended to its next prompt. Workers never talk to each other or to the aiguilleur. Shared state is a JSON file + per-workspace JSONL logs + the aiguilleur's Markdown notes.

### Cited Findings
- Downward: `POST /api/workspaces/<id>/send {"text","files"}` → `sendTo()` → `A.send()` which writes `{type:'user', message:{role:'user', content}}` to the worker's stdin — [server.js:368](server.js:368); [server.js:429-435](server.js:429); [lib/agent.js:245-267](lib/agent.js:245)
- Each send is serialized per workspace (promise lock), takes a git checkpoint first, logs a `cg_user` event (with `via: 'telegram'` when relevant) — [lib/agent.js:232-233](lib/agent.js:232); [lib/agent.js:249-257](lib/agent.js:249)
- A message sent mid-turn is folded by the CLI into the running turn; "busy" is tracked from the CLI's `system/init` to `result`, not by counting messages — [lib/agent.js:184-191](lib/agent.js:184)
- Upward ("report"): every agent event goes through `record()` → append to log + WebSocket broadcast + `R.onEvent` — [lib/agent.js:109](lib/agent.js:109); [server.js:41](server.js:41)
- `onEvent` keeps the last non-subagent assistant text per workspace; on `result` or `cg_error` it records a `cg_report {ws, label, ok, text}` in the aiguilleur's log (text = last words, relative media paths made absolute) — [lib/remote.js:244-263](lib/remote.js:244)
- Reports do **not** wake the aiguilleur (no model call); they are prepended to the next user message under `[Reports from the agents since your last message]` — [lib/remote.js:278-290](lib/remote.js:278); README: "so it knows where things stand without being woken for each one" — [README.md:132](README.md:132)
- Pull channel: the aiguilleur can fetch any workspace's full log (`GET …/log`) and diff (`GET …/diff`, capped at 3 MB) on demand — [server.js:360-361](server.js:360); prompt at [lib/remote.js:82-83](lib/remote.js:82)
- Replies from Telegram to a report message are mapped (Telegram message id → workspace id, LRU 1000) and become `[Reply to the report of <project> / <workspace> (id …)]` for the aiguilleur, which must relay — [lib/remote.js:47-56](lib/remote.js:47); [lib/remote.js:181](lib/remote.js:181); [lib/remote.js:288](lib/remote.js:288)
- `/stop` replied to a report interrupts that agent directly (no LLM involved) — [lib/remote.js:48](lib/remote.js:48); [lib/remote.js:460](lib/remote.js:460)
- Real-time UI channel: server pushes `state` (debounced 30 ms), `ev`, `delta` (streaming text) over WebSocket — [server.js:26-41](server.js:26); [lib/agent.js:178-183](lib/agent.js:178)
- Shared state: `~/.aiguillage/state.json` (repos, workspaces, telegram, aiguilleur), whole-file atomic rewrite on each change ("fine for hundreds of workspaces"); per-workspace logs `logs/<id>.jsonl` append-only — [lib/store.js:5-38](lib/store.js:5)
- Long-term memory for the hub only: `~/.aiguillage/aiguilleur/CLAUDE.md` + `projects/<repo>.md`; after every successful worker turn, a Haiku call (no tools, 120 s timeout) reads user ask (≤3000 chars), agent answer (≤4000), existing notes (last 6000) and appends ≤5 dated lines under `## Journal`, or nothing ("NOTHING") — [lib/remote.js:314-351](lib/remote.js:314); [lib/remote.js:90-94](lib/remote.js:90)
- Workers have no shared memory or blackboard; each has only its Claude Code session transcript and its worktree. The briefing tells them to leave other worktrees alone — [lib/agent.js:98](lib/agent.js:98)

### Inferences
- Topology: star (hub-and-spoke) with an asynchronous mailbox: worker → hub is event-driven and batched at the next human message; hub → worker is imperative. No peer-to-peer, no blackboard, no broadcast to workers.
- The hub's "memory" is a write-behind journal summarised by a cheaper model (Haiku) — a form of external memory / reflection, but per project, not per task.
- Workers can technically reach `http://127.0.0.1:4317/api/...` via Bash (no auth beyond Host/Origin checks, [server.js:466-469](server.js:466)) but are never told about it; inter-agent calls are therefore possible but undocumented and unintended (observation, not tested).

### Gaps
- No structured message schema between hub and workers (free text only); no task ids, acknowledgements, or completion criteria.

## 4. Human-in-the-loop: permissions, Telegram, review, merge/PR

### Takeaway
The human is the only decision-maker: permission prompts (in non-Auto modes), plan approvals, commit/merge/PR are all user actions, available from the window or (permissions only) from Telegram buttons. The aiguilleur is explicitly forbidden to answer permission requests. Telegram is an outbound-polling mirror of the aiguilleur conversation plus a live pinned board.

### Cited Findings
- Permission flow: CLI emits `control_request can_use_tool` on stdout (`--permission-prompt-tool stdio`); Aiguillage auto-denies out-of-worktree edits, auto-allows in Auto (except `ExitPlanMode`), else stores it as pending and shows it — [lib/agent.js:168-176](lib/agent.js:168)
- Answer: `POST /api/workspaces/:id/permission {id, allow, message}` → `control_response` allow/deny (deny with optional comment = "Reject with a comment"); approving a plan switches the session to Auto — [server.js:383](server.js:383); [lib/agent.js:363-380](lib/agent.js:363)
- Switching a workspace to Auto approves all pending requests except plans — [lib/agent.js:397-398](lib/agent.js:397)
- Telegram permission messages: `🔐 <project / workspace>` + tool name + fenced command/file/input JSON (or the plan text for ExitPlanMode), with green Allow / red Deny inline buttons (`callback_data p:<ws>:<1|0>:<reqId>`); posted once per request; buttons removed after answer — [lib/remote.js:353-366](lib/remote.js:353); [lib/remote.js:451-456](lib/remote.js:451)
- Telegram setup: bot token checked with `getMe`, then a one-time `t.me/<bot>?start=<code>` deep link ties exactly one chat; other chats get a "pair" reply and are ignored — [lib/remote.js:133-141](lib/remote.js:133); [lib/remote.js:31-45](lib/remote.js:31)
- Outbound only: long polling `getUpdates` (50 s), offset saved *before* handling so a message is never acted on twice after a crash; 5 s back-off on error — [lib/remote.js:514-531](lib/remote.js:514)
- Remote mode (sidebar switch or `/remote` `/local`): when on, everything in the aiguilleur conversation is pushed (reports, what the user types at the Mac, the aiguilleur's answers) plus permission requests; turning it on catches up (board, reports missed while off, still-pending requests) and runs `caffeinate -is` — [lib/remote.js:13-18](lib/remote.js:13); [lib/remote.js:265-276](lib/remote.js:265); [lib/remote.js:302-312](lib/remote.js:302); [lib/remote.js:502-508](lib/remote.js:502). When off, only answers to Telegram-originated messages go back — [lib/remote.js:274](lib/remote.js:274)
- Board: one pinned message edited in place (≤1 edit per 2 s, minute tick), first line = counts (🔐 pending, ⏳ working, ❌ failed, 💤 idle), then plan usage session & week with reset time (🔴 ≥90 %), then per repo each workspace's short title (≤30 chars) with what it waits for or its last tool call and elapsed time; idle ones on one line — [lib/remote.js:368-437](lib/remote.js:368)
- Activity text = last tool call summarized (`Bash: <description>`, file basename, pattern, url…, ≤50 chars) — [lib/remote.js:370-375](lib/remote.js:370)
- Long texts: split into parts ≤16,000 chars (rich Markdown messages) cut between lines, code fences closed/reopened; fallback to plain text parts ≤4096 if Telegram refuses the Markdown — [lib/remote.js:143-182](lib/remote.js:143)
- Media inbound: photo/document/video/audio/voice/animation/video_note downloaded (≤20 MB, Bot API limit) into the aiguilleur's attachments; albums gathered with a 1.5 s wait — [lib/remote.js:59-67](lib/remote.js:59); [lib/remote.js:461-491](lib/remote.js:461). Passing to a worker copies the file into that worker's attachments; only the workspace's own or the aiguilleur's attachment paths are accepted — [server.js:274-285](server.js:274)
- Media outbound: `![caption](path)` local media in a report or aiguilleur answer are replaced by `📎 caption` and sent after the text as photo/video/audio/document (≤50 MB, max 10 per message, photo falls back to document) — [lib/remote.js:184-229](lib/remote.js:184)
- Security note in docs: "Anyone who controls your Telegram account can drive your agents, and the aiguilleur can run commands on the Mac" — [README.md:155](README.md:155)
- Review & ship (window only): Diff tab = `git diff <merge-base> <snapshot-tree>` (commits + uncommitted + untracked) — [lib/git.js:61-67](lib/git.js:61); Commit = `git add -A && git commit` — [server.js:410-414](server.js:410); Merge = `git merge --no-ff` into the base if it is checked out in the main repo (refuses if either side is dirty), else fast-forward-only ref update — [server.js:204-219](server.js:204); PR = `git push -u origin aig/<name>` + `gh pr create --fill --head … --base …` — [server.js:416-420](server.js:416). Merge/PR buttons disabled while the diff is empty — [public/app.js:893-894](public/app.js:893)
- The aiguilleur may call commit/merge/PR only "when the user asks for it" — [lib/remote.js:87](lib/remote.js:87)
- Checkpoints: before each user message, a snapshot (HEAD + index + full working tree via a throwaway index) pinned at `refs/aiguillage/<wsId>/<ts>`; "↺" reverts files *and* conversation (`--resume-session-at <uuid> --fork-session`) — [lib/agent.js:250-255](lib/agent.js:250); [lib/git.js:73-126](lib/git.js:73); [lib/agent.js:423-443](lib/agent.js:423)
- Archive: runs the repo's archive script, pins uncommitted work at `refs/aiguillage/<id>/archive`, removes the worktree, keeps the branch; unarchive restores — [server.js:178-202](server.js:178)
- Desktop notifications when an agent finishes or needs you; unread markers — [public/app.js:113-117](public/app.js:113); [README.md:123](README.md:123)

### Inferences
- HITL design is "approval gating + human-only integration": the system never merges, pushes or answers an agent's question on its own. This is closer to a supervised assistant than an autonomous multi-agent system.
- Telegram makes the human-in-the-loop asynchronous/mobile; the board is a compact situational-awareness view (counts + current tool + duration) rather than semantic progress.

### Gaps
- No diff review from Telegram except by asking the aiguilleur to read `GET /diff` and summarize (no native diff rendering on the phone).

## 5. Context management (how much worker output reaches the hub; compaction)

### Takeaway
Only each worker's *final assistant text of a turn* flows to the hub automatically; it is truncated to 2,000 chars per report and at most the 30 most recent unread reports are prepended to a user message. Full transcripts stay in the worker sessions and are available on demand via the log API. The hub's own context is bounded by a reset policy (new session after 1 h idle or >100k tokens); workers rely on Claude Code's native auto-compact, whose fill level Aiguillage displays.

### Cited Findings
- Report text = last assistant message text (text blocks only, top-level, not subagents) at turn end; on error the error text — [lib/remote.js:249-259](lib/remote.js:249)
- `MAX_REPORTS = 30, MAX_REPORT = 2000`; older ones are announced as "(N older ones left out: GET /api/workspaces/aiguilleur/log)"; each tagged `(workspace id …)`; separated from the user message by `---` — [lib/remote.js:280-290](lib/remote.js:280); tested at [test/remote.test.js](test/remote.test.js) (commit 88cd06a diff)
- Hub session reset: `IDLE = 3600_000` ms, `FULL = 100_000` tokens; checked before sending a user message to an idle aiguilleur; acts like `/clear` (`A.forget`) — [lib/remote.js:292-300](lib/remote.js:292); [server.js:433](server.js:433); [lib/agent.js:414-421](lib/agent.js:414)
- Rationale and measured effect claimed in commit 88cd06a: "it only relays, what lasts is in its notes, and each request re-read the whole day (simulated on a full day of relaying: ~31 $ -> ~14 $ API-equivalent, +8 % -> +3.5 % on top of the agents)" — commit 88cd06a. (Simulation method not in the repo.)
- Context fill per session read from the CLI with `get_context_usage` after each turn, displayed as "X % until auto-compact" — [lib/agent.js:211-215](lib/agent.js:211); [lib/agent.js:330-338](lib/agent.js:330)
- Stored logs are slimmed for the UI (no thinking, tool output cut at 8,000 chars, images as `[image]`); this affects what the aiguilleur sees through `GET …/log`, not what the worker model sees — [lib/agent.js:111-131](lib/agent.js:111); one-shot migration noted "132 MB → 3 MB" in commit e2f23b3
- Continuity across hub resets is via files: CLAUDE.md (auto-loaded by Claude Code in its cwd) and `projects/*.md` with Haiku-written journal — [lib/remote.js:90-94](lib/remote.js:90); [lib/remote.js:327-351](lib/remote.js:327)

### Inferences
- This is a "summary-by-construction" protocol: the worker's last message serves as its summary (no dedicated summarizer for reports), plus a separate Haiku distillation for long-term memory. It relies on Claude Code agents ending turns with a good recap.
- Hub context is treated as disposable cache; durable knowledge is externalized (MemGPT-like file memory, but curated by the hub itself and a Haiku appender).

### Gaps
- Truncation at 2,000 chars may drop the end of a long report (cut is at the tail: `slice(0, 2000)`), not measured.

## 6. Verification and quality control

### Takeaway
Aiguillage itself performs no automated verification of agent work: no test run, no review agent, no CI gate, no pre-merge conflict detection between parallel branches. Quality relies on the human reviewing the diff, optional Run scripts, and whatever the worker agent chooses to do (e.g. run tests on its own).

### Cited Findings
- Worker briefing mentions only that "The user reviews your diff … and merges from there"; no instruction to test or self-verify — [lib/agent.js:103](lib/agent.js:103)
- Merge conflict handling: `git merge --no-ff`; on failure `git merge --abort` and error `errors.mergeConflict` with git's output; no automatic rebase/resolution — [server.js:210-213](server.js:210)
- Checkpointing refuses during merge/rebase/cherry-pick/conflicts (`G.busy`) and sending is refused with `errors.gitBusy` → caught, the message still goes without a checkpoint — [lib/agent.js:251-255](lib/agent.js:251); [lib/git.js:89-98](lib/git.js:89)
- Workspaces branch from fresh `origin/<base>` at creation, but are not rebased afterwards — [server.js:130-136](server.js:130)
- Run tab: user-launched dev server/scripts with output logged to a file the agent is told to read — [server.js:56-87](server.js:56); [lib/agent.js:102](lib/agent.js:102)
- The project's own test suite uses a fake CLI (`test/fake-claude.mjs`) and never calls Claude: ~190 `test(` occurrences across unit/integration/e2e files (e.g. integration telegram 16, chat 16, permissions 13, repos-workspaces 20; approximate grep count, not a test-runner total) — [CONTRIBUTING.md:18](CONTRIBUTING.md:18); [README.md:253](README.md:253); `grep -c "test("` over `test/`

### Inferences
- In the taxonomy of MAS failure modes (e.g. inter-agent misalignment, task verification), Aiguillage delegates *all* verification to the human; there is no verifier/critic role.
- Parallel branches touching the same files are only discovered at merge time (or not at all if merged sequentially with fast-forward failures).

### Gaps
- No data on how often merges conflict in practice.

## 7. Observability, cost/usage tracking, failure handling

### Takeaway
Observability is UI-centric: live streaming per workspace, JSONL logs, per-turn duration/turn counts, context fill, plan usage (session/week %) from the CLI, a Telegram board, desktop notifications. Failure handling is minimal and reactive: crashed process → error event + failed flag + ❌ report; interrupt with a 5 s kill fallback; no turn timeouts, no stuck-agent detection beyond elapsed time on the board, no automatic retry.

### Cited Findings
- `result` events keep `duration_ms, total_cost_usd, num_turns, is_error` in the log — [lib/agent.js:114-117](lib/agent.js:114); UI shows duration and turns (not cost) — [public/app.js:617](public/app.js:617)
- Plan usage: throwaway `claude -p` answering a `get_usage` control request without a model call, cached 60 s, refreshed every 3 min and after each turn; parsed as `{plan, limits:[{kind, model, pct, resetsAt}]}` — [lib/agent.js:307-346](lib/agent.js:307); [server.js:561-562](server.js:561); shown in sidebar and board — [lib/remote.js:390-391](lib/remote.js:390)
- Process crash mid-turn: `close` handler sets `failed = true`, logs `cg_error` "agentExited" with exit code and last 4,000 chars of stderr — [lib/agent.js:150-162](lib/agent.js:150); this becomes a ❌ report to the aiguilleur — [lib/remote.js:256-262](lib/remote.js:256)
- `failed` = CLI result `is_error` unless the user interrupted — [lib/agent.js:209](lib/agent.js:209)
- Interrupt: `control_request interrupt`, then SIGTERM after 5 s if still busy; stop = SIGTERM then SIGKILL after 3 s — [lib/agent.js:354-361](lib/agent.js:354); [lib/agent.js:403-412](lib/agent.js:403)
- Deleted worktree → clear error instead of `spawn ENOENT` — [lib/agent.js:247-248](lib/agent.js:247)
- Restart resilience: conversations resume with `--resume <sessionId>`; running Run scripts are re-launched after an app update; update is held while agents are working — [lib/agent.js:145-148](lib/agent.js:145); [server.js:532-548](server.js:532)
- Timeouts exist only on auxiliary calls: Haiku naming 60 s, Haiku journal 120 s, usage probe 30 s, Telegram calls 70 s / uploads 300 s / downloads 120 s — [lib/agent.js:298](lib/agent.js:298); [lib/remote.js:335](lib/remote.js:335); [lib/agent.js:317](lib/agent.js:317); [lib/remote.js:119](lib/remote.js:119); [lib/remote.js:485](lib/remote.js:485)
- Board shows elapsed time per working agent (`took(since)`), the only "stuck" signal — [lib/remote.js:387](lib/remote.js:387)
- Logs robust to half-written lines after a crash — [lib/store.js:30-34](lib/store.js:30)

### Inferences
- No watchdog: an agent looping or hung inside a tool call stays "working" indefinitely until the human interrupts.
- Cost is tracked in quota terms (subscription %), not per-task dollars, consistent with "billing goes through the user's Claude account" ([PRODUCT.md:26](PRODUCT.md:26)).

### Gaps
- `total_cost_usd` is stored but not aggregated or displayed anywhere I found.

## 8. Timeline of the aiguilleur / Telegram features (git history)

### Takeaway
The whole project is 73 commits over five days (2026-11-01 → 2026-11-05). Parallel worktree agents shipped first (v0.1–v0.8, 1–5 Nov); the aiguilleur and Telegram arrived in a burst on 2026-11-05 (v0.9.0 → v0.14.0), evolving from "remote control with notifications" to "single interlocutor hub with lazy report injection, session reset policy, board, media and long-message handling".

### Cited Findings
- c63f008 (2026-11-01): "Aiguillage: run several Claude Code agents in parallel, each in its own git worktree" (initial) — `git log`
- Dogfooding: merges of `aig/tokyo`, `aig/lima`, `aig/lagos`, `aig/cairo`, `aig/delhi` branches (c27d4a5, c4c87d8, 89574ae, 1e8e515, 75232fe), i.e. the tool was built with its own workspaces — `git log`
- v0.4.0 (41a06ac, 11-01): context fill "X% until auto-compact"; a91ecbe: plan usage in sidebar — `git log`
- v0.5.0 (89c32bb, 0106e69, 11-02): running subagents listed and stoppable; every Claude Code slash command — `git log`
- v0.7.x (11-03/04): background shells listed; working indicator follows CLI turns; logs trimmed 132 MB → 3 MB (e2f23b3) — `git log`
- v0.8.0 (802f9bf, 11-05): chat shows media — `git log`
- **v0.9.0 (d35e878, 11-05)**: "Aiguilleur: an agent above every workspace … reports on them and relays your instructions (never decides), with a memory of each project (… a journal Haiku appends after each agent turn); Telegram remote control (opt-in, outbound polling): turn reports, replies to an agent, Allow/Deny buttons, /status, /mute" (13 files, +509) — commit d35e878
- **v0.9.1 (cb9bcb2)**: Telegram configured in Settings with one-time link; Remote mode switch (/remote, /local) replaces /mute; catch-up on enable; keep Mac awake — commit cb9bcb2
- **v0.10.0 (499cc48)**: "The aiguilleur is the one interlocutor": each finished turn lands as a report in its conversation; it reads unseen reports at the top of the next message; all Telegram input goes to it; one mirrored conversation — commit 499cc48
- **v0.11.0 (c97ee2c)**: sessions tied to no project, reported to the aiguilleur as « Session / … » — commit c97ee2c
- **v0.11.1 (88cd06a)**: aiguilleur session reset after 1 h idle or >100k tokens; claimed ~31 $ → ~14 $ API-equivalent per simulated day, overhead +8 % → +3.5 % — commit 88cd06a
- **v0.12.0 (ab57f87)**: pinned live board, rich Markdown messages, colored Allow/Deny — commit ab57f87
- **v0.13.0 (3fb6aff, 4714b85)**: media both ways (20 MB in, 50 MB out, albums gathered); long texts split instead of cut — commits 3fb6aff, 4714b85
- **v0.14.0 (5b3c456)**: plan usage on the board, per-repo grouping, short titles — commit 5b3c456

### Inferences
- Design trajectory: from push-notification bridge (v0.9.0) to a hub whose context cost became a concern within hours (v0.11.1), solved by lazy report injection + periodic reset + external notes — the classic orchestrator context-growth problem.

### Gaps
- Commit dates are the only timing evidence; no changelog beyond commit messages and GitHub releases.

## 9. Gaps and limitations (my observations, not claims from the repo)

### Takeaway
Aiguillage is a human-centric "parallel workspaces + LLM switchboard" rather than an autonomous multi-agent system: decomposition, verification, conflict management and inter-agent coordination are all left to the human.

### Cited Findings (evidence for each observation)
- No task decomposition / planning by the hub: prompt forbids adding "tasks, steps or choices of your own" and any initiative — [lib/remote.js:75-79](lib/remote.js:75)
- No automated verification (tests, critic/review agent, CI gate) before merge — [server.js:204-220](server.js:204); [lib/agent.js:90-107](lib/agent.js:90)
- No inter-agent conflict detection: workers isolated in worktrees, no overlap analysis of diffs; conflicts surface only on `git merge` (aborted) — [server.js:210-213](server.js:210)
- No inter-agent communication or shared blackboard; workers unaware of each other's tasks — [lib/agent.js:98](lib/agent.js:98)
- Soft guardrails: "never decide", "never edit repos" for the aiguilleur are prompt-only; it runs in Auto with unrestricted Bash — [lib/remote.js:536](lib/remote.js:536); [docs/DNA.md:34](docs/DNA.md:34)
- Shell commands of workers are not sandboxed (only edit tools are path-checked) — [docs/DNA.md:34](docs/DNA.md:34); [lib/agent.js:170-173](lib/agent.js:170)
- No concurrency limit or quota-aware scheduling; usage is displayed, not acted on — [server.js:157-162](server.js:157); [lib/agent.js:307-329](lib/agent.js:307)
- No watchdog/timeout on agent turns, no automatic retry — [lib/agent.js:354-361](lib/agent.js:354)
- Reports are unstructured last words truncated to 2,000 chars; no status schema (done/blocked/needs-input) beyond ✅/❌ = `is_error` — [lib/remote.js:256-262](lib/remote.js:256); [lib/remote.js:281-284](lib/remote.js:281)
- Hub memory journal is append-only and depends on the hub to tidy it ("ponytail: append-only, the aiguilleur tidies the notes when it reads them") — [lib/remote.js:326](lib/remote.js:326)
- Local API has no authentication beyond Host/Origin checks (fine against browsers, not against local processes, including the agents themselves) — [server.js:465-469](server.js:465)
- Single user, single Telegram chat; no multi-user collaboration by design — [docs/DNA.md:29-31](docs/DNA.md:29)

### Inferences
- Positioning for the report: Aiguillage = "manager–worker with a human manager and an LLM secretary". Its strengths vs. research MAS: strong isolation by git worktrees, deterministic non-LLM control plane, cheap hub (lazy, truncated, resettable), complete human approval. Its missing pieces vs. industry/academic patterns: planner/decomposer, verifier/critic, merge-conflict prediction, structured inter-agent protocol, autonomous error recovery.

### Gaps
- No usage data, benchmarks or user studies exist in the repo ("No users, testimonials or benchmarks yet; do not invent any" — [PRODUCT.md:33](PRODUCT.md:33)). The only quantitative claim is the cost simulation in commit 88cd06a, whose method is not documented.
