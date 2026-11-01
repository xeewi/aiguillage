# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Open-source developers who run several Claude Code agents at once and want that loop on their own machine, with no account and no cloud. They sit at a desktop, often for hours, switching between 3–5 agents, reading streams, approving permissions, reviewing diffs.

## Product Purpose
A 100% local orchestrator for parallel Claude Code agents: one workspace = one git worktree = one branch, all driven from one window (the Electron Mac app, or a browser tab) served on 127.0.0.1. Success: the developer launches, supervises, reviews and merges several agents' work without leaving the window and without the main repo ever being touched.

## Positioning
It drives the user's real `claude` CLI (their login, subscription, models, MCP, hooks, skills) instead of reimplementing Claude Code or calling the API, and it runs entirely locally with no account, sync or telemetry.

## Operating Context
User loop: add a local repo → `+ Workspace` (worktree + `aig/<name>` branch, setup script) → chat with the agent (streaming, tool calls shown, interrupt, permission and plan approval) → review the Diff tab, test in the Terminal tab or with Run scripts → PR via `gh` or local merge → archive. State lives in `~/.aiguillage/`. Interface copy is English by default, translated with i18next (`public/locales/`; French ships too).

## Capabilities and Constraints
- Node + vanilla JS, no build step, a handful of files (`public/index.html`, `app.js`, `style.css`). Must stay readable in an evening.
- No dependency loaded from a CDN; everything served locally (fonts included).
- Listens on 127.0.0.1 only.
- Desktop only (narrow windows down to ~820px); no phone layout.
- Billing goes through the user's Claude account via the CLI; API keys are stripped from the agent env.
- Existing features: workspaces list, chat stream, permissions, checkpoints, diff, xterm terminals, run scripts, commit/merge/PR, archive, plan usage (session and week limits).

## Brand Commitments
Name: Aiguillage. Voice: plain, direct; short labels, in every language.

## Evidence on Hand
README.md, docs/DNA.md. No users, testimonials or benchmarks yet; do not invent any.

## Product Principles
1. Local first: nothing leaves the machine except what `claude` already sends.
2. Isolation is visible: which workspace/branch an agent writes to is never ambiguous.
3. Review before merge: the diff is always one click away.
4. Simple to read: no framework, no build, no cleverness.
