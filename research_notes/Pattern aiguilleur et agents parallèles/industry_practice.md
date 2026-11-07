# Industry practice for orchestrating multiple AI agents (parallel coding agents)

Research date: 2026-11-06. Primary sources were fetched directly where marked "(primary, fetched)". Everything else comes from search summaries or secondary blogs and is flagged. Older claims are dated.

## 1. Vendor engineering guidance: what Anthropic, Cognition, OpenAI and LangChain recommend

### Takeaway
The vendors agree on a few points: start with one agent, use orchestrator-workers (a "manager" or "supervisor") when the subtasks can't be known in advance, and give each worker a tightly scoped brief. They also agree that parallel **writers** are the risky case. Anthropic says multi-agent setups fit coding less well than research. Cognition (April 2026) recommends that "writes stay single-threaded" while extra agents only add intelligence (review, advice). Claude Code's own docs now offer both subagents and experimental "agent teams" (a lead plus teammates, 3-5 recommended), with explicit warnings about token cost and file conflicts.

### Cited Findings
**Anthropic, "Building effective agents" (Dec 19, 2024; older, and the article itself says its tooling advice has since changed) (primary, fetched)**
- Workflows are "systems where LLMs and tools are orchestrated through predefined code paths". Agents are "systems where LLMs dynamically direct their own processes and tool usage." — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- "we recommend finding the simplest solution possible, and only increasing complexity when needed." — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- Orchestrator-workers: "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results". The suggested use is tasks whose subtasks can't be predicted, e.g. "Coding products that make complex changes to multiple files each time." — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- Evaluator-optimizer: "one LLM call generates a response while another provides evaluation and feedback in a loop." Parallelization comes in two forms: sectioning ("Breaking a task into independent subtasks run in parallel") and voting ("Running the same task multiple times to get diverse outputs"). — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- Three principles: "Maintain simplicity in your agent's design", "Prioritize transparency by explicitly showing the agent's planning steps", and "Carefully craft your agent-computer interface (ACI)". — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)

**Anthropic, "How we built our multi-agent research system" (June 13, 2025) (primary, fetched)**
- Lead Claude Opus 4 with Claude Sonnet 4 subagents "outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval." — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Agents use about 4× the tokens of chat interactions. "multi-agent systems use about 15× more tokens than chats". On BrowseComp, "token usage by itself explains 80% of the variance". — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Each subagent needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Effort scaling is written into the prompts: simple fact-finding gets 1 agent and 3-10 tool calls; complex research may get "more than 10 subagents with clearly divided responsibilities". Parallel tool calling "cut research time by up to 90% for complex queries". — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Poor fit for coding: "most coding tasks involve fewer truly parallelizable tasks than research." — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Subagents write outputs to external storage or the filesystem and pass "lightweight references" back to the coordinator ("artifact systems where specialized agents can create outputs that persist independently"). — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)

**Claude Code: agent teams and subagents (current docs, fetched 2026-11-06) (primary)**
- Agent teams are "experimental and disabled by default" (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). "One session acts as the team lead, coordinating work, assigning tasks, and synthesizing results. Teammates work independently, each in its own context window, and communicate directly with each other." — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- The architecture has four parts: team lead, teammates, a shared task list (pending, in progress, completed, with dependencies, and claiming protected by "file locking"), and a mailbox (JSON files under `~/.claude/teams/{team}/inboxes/`). — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Subagents vs teams: subagents return results to the caller and have "Lower" token cost because "results summarized back to main context". Teams are "Higher: each teammate is a separate Claude instance". — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Sizing: "Start with 3-5 teammates for most workflows"; "Three focused teammates often outperform five scattered ones"; "5-6 tasks per teammate". — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- File conflicts: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." Also: "Letting a team run unattended for too long increases the risk of wasted effort." — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Known failure: "Sometimes the lead starts implementing tasks itself instead of waiting for teammates". The lead "can stop early too". — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Limitations: no nested teams, one team per session, the lead is fixed, `/resume` does not restore in-process teammates, task status "can lag", and teams aren't available in headless `-p` / Agent SDK sessions ("Claude doesn't spawn teammates"). — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Trust model: an inter-agent message is flagged as "from another Claude session, not from you". "A teammate can't approve a permission prompt or supply consent on your behalf." Teammate permission prompts appear in the lead session. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Quality-gate hooks: `TeammateIdle`, `TaskCreated` and `TaskCompleted` (exit code 2 blocks the event and sends feedback). — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- The docs list "Git worktrees" as the option for running "multiple Claude Code sessions yourself without automated team coordination". — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)

**Cognition, "Don't Build Multi-Agents" (Walden Yan, June 12, 2025; older) (primary, fetched)**
- Principle 1: "Share context, and share full agent traces, not just individual messages". Principle 2: "Actions carry implicit decisions, and conflicting decisions carry bad results". — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Flappy Bird example: a subagent asked for a background with green pipes built one "that looks like Super Mario Bros." — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- "The simplest way to follow the principles is to just use a single-threaded linear agent". For long tasks, the essay proposes a compression model that turns history "into key details, events, and decisions". It says Claude Code's subagent "never does work in parallel with the subtask agent". — [Cognition](https://cognition.com/blog/dont-build-multi-agents)

**Cognition, "Multi-Agents: What's Actually Working" (Walden Yan, April 22, 2026) (primary, fetched)**
- Multi-agent works best when "writes stay single-threaded and the additional agents contribute intelligence rather than actions." — [Cognition](https://cognition.com/blog/multi-agents-working)
- Clean-context review agent: Devin Review "catches an average of 2 bugs per PR", about 58% of them severe. It works best when it shares no prior context with the coding agent. — [Cognition](https://cognition.com/blog/multi-agents-working)
- "Managed Devins": a manager Devin splits a task and coordinates child Devins through an internal MCP ("map-reduce-and-manage"). Problems seen: managers tend to be "overly prescriptive", and agents wrongly assume they share state with their children. — [Cognition](https://cognition.com/blog/multi-agents-working)
- On parallel writers: "most of the sexy ideas in that space still don't see meaningful adoption". Arbitrary swarms are "mostly a distraction". Open problem: how to "transfer context between agents without drowning the receiver". The "80/20" answer is to share a fork of the primary agent's full context. — [Cognition](https://cognition.com/blog/multi-agents-working)
- Devin usage in the largest enterprise segment grew about 8x over the previous 6 months (vendor claim). — [Cognition](https://cognition.com/blog/multi-agents-working)

**OpenAI, "A practical guide to building agents" (2025) (secondary summaries only; the PDF wasn't fetched)**
- Manager pattern ("agents as tools"): a central agent calls specialists as tools and stays the only one talking to the user. Decentralized pattern: peers hand off control, and in the Agents SDK a handoff is implemented as a tool. Start with one agent and add more only when it falters. — [agentic-ai.readthedocs summary](https://agentic-ai.readthedocs.io/en/latest/DesignPatterns/openai-patterns/); original PDF: cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf (not verified)

**LangChain, "Benchmarking Multi-Agent Architectures" (June 10, 2025; older) (primary, fetched)**
- Setup: modified τ-bench retail (100 examples) plus 6 distractor domains, gpt-4o. Compared single agent, swarm and supervisor. The single agent "drops sharply" with 2 or more distractor domains. Swarm slightly beats supervisor because of the supervisor's "translation" errors, and the supervisor uses more tokens than swarm. — [LangChain](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)
- Supervisor fixes gave a "nearly 50% increase in performance": hide the handoff messages from sub-agents, add a `forward_message` tool that passes a sub-agent's answer through verbatim instead of paraphrasing it, and tune tool naming. — [LangChain](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)

### Inferences
- Aiguillage is an orchestrator-workers (manager/supervisor) system where only the orchestrator talks to the user. That matches OpenAI's "manager pattern" and LangChain's "supervisor". LangChain's finding applies directly: a supervisor that paraphrases sub-agent output loses accuracy, and passing it through verbatim (`forward_message`) helps. Aiguillage already passes agent reports and media through mostly untouched (per recent commits), which is in line with this.
- Each worker in Aiguillage writes to its own branch and worktree, and the human merges. This sidesteps Cognition's "conflicting implicit decisions" problem at the file level, but not at the design level: two branches can still conflict on semantics or style. The human merge step is the reconciliation point that Cognition's single-writer rule otherwise demands.
- Anthropic's delegation checklist (objective, output format, tools, boundaries) and Cognition's managers being "overly prescriptive" or assuming shared state give a concrete rubric for the aiguilleur's dispatch prompts.
- A clean-context reviewer agent (Cognition, Claude Code's parallel-review example) fits Aiguillage well as an extra step before human review.

### Gaps
- The OpenAI guide PDF wasn't fetched, so its wording above is paraphrased from secondary summaries.
- I didn't fetch Anthropic's context-engineering and long-running-harness posts, Claude Code best practices (worktrees, headless), or the Agent SDK docs this session. Exact quotes from them are missing.
- I didn't research Google ADK or Microsoft AutoGen/Magentic-One.

## 2. Products for parallel coding agents: isolation, dispatch, review, merge, notifications

### Takeaway
The market has settled on four ideas: (a) **one isolated workspace per task**, either a git worktree locally or a VM/container in the cloud; (b) **a control panel listing every agent** (GitHub Agent HQ "mission control", Cursor 3 Agents Window, Devin Desktop, Codex `/agents`); (c) **the PR or diff as the review unit**, with a human merging; (d) **starting tasks from chat or issue tools** (Slack, Linear, GitHub). Local worktree orchestrators (Conductor, Claude Squad, Vibe Kanban, Crystal) are Aiguillage's closest peers. None of them puts a conversational orchestrator *agent* in front of the user the way Aiguillage does; they are dashboards.

### Cited Findings
- **GitHub Agent HQ / mission control** (announced Oct 28, 2025): one place to "assign, steer, and track" agents from Copilot, with Anthropic, OpenAI, Google, Cognition and xAI agents announced. It is also available in VS Code. GitHub's own how-to warns that agents working in parallel "can create merge conflicts if they touch the same files" and recommends partitioning tasks and defining custom agents in agents.md files. — [GitHub blog, Agent HQ](https://github.blog/news-insights/product-news/welcome-home-agents/); [GitHub blog, mission control how-to](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/) (details via search summary); [SiliconANGLE](https://siliconangle.com/2025/10/28/github-tackles-vibe-coding-chaos-control-center-ai-coding-agents/)
- **Cursor** (secondary sources only): Cursor 3 (reported Apr 2, 2026) has an Agents Window listing local and cloud agents, including ones started from Slack, GitHub, Linear and mobile. Local agents can each get a git worktree; "cloud agents" (formerly Background Agents) run in isolated VMs, with up to 8 in parallel reported in 2.5. One source warns that Cursor's cleanup may delete worktrees it didn't create. — [digitalapplied guide](https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide); [businesstechnavigator](https://businesstechnavigator.com/blog/cursor-cloud-agents-multitask-parallel-worktrees-8-agents-2026). Not verified against cursor.com.
- **OpenAI Codex**: in Slack, "Mention `@Codex` with a prompt, and Codex creates a cloud task and replies with the results". Cloud tasks run in isolated sandboxes preloaded with the repo. GA with the Slack integration and SDK at DevDay, Oct 2025. — [OpenAI developers: Codex in Slack](https://developers.openai.com/codex/integrations/slack); [OpenAI: Codex GA](https://openai.com/index/codex-now-generally-available). A secondary report says DevDay 2026 (Sept) added a `/agents` command in the CLI for managing parallel work and "Codex Cloud" so agents keep running with the laptop closed — [Gigazine](https://www.gigazine.net/gsc_news/en/20260930-openai-codex-cli-cloud) (unverified).
- **Devin**: Managed Devins give each child a full Devin with its own VM, coordinated by a manager through an internal MCP — [Cognition](https://cognition.com/blog/multi-agents-working). Devin Desktop (Windsurf rebrand, June 2026) is reported as an "agent command center" that also runs Codex, Claude Agent, OpenCode and other ACP-compatible agents — [techedt](https://www.techedt.com/cognition-launches-devin-desktop-for-managing-ai-coding-agents-across-engineering-workflows); [chatgate](https://chatgate.ai/post/devin-desktop) (secondary; sources disagree on June 2 vs June 9).
- **Claude Code itself**: cloud sessions ("Run tasks in a fresh cloud sandbox, cloned from GitHub"), Claude in Slack (an `@Claude` mention spawns a cloud session), Remote Control (drive a local session from claude.ai or the mobile app), and Channels (see section 3). — [Claude Code docs, channels comparison table](https://code.claude.com/docs/en/channels)
- **Local worktree orchestrators** (secondary comparison blogs): Conductor (Melty Labs) is closed-source, macOS-first, and runs Claude Code and Codex in worktrees with review and PR flow. Claude Squad is a TUI on tmux plus worktrees (AGPL-3.0). Vibe Kanban is an open-source kanban board where each card is a worktree plus an agent; its company is reported shut down on April 10, 2026, and it is now community-maintained. Crystal (MIT) is listed as deprecated. — [nimbalyst comparison](https://nimbalyst-website.pages.dev/blog/best-multi-agent-coding-tools-2026/); [loopengineering](https://loopengineering-app.pages.dev/guides/worktree-orchestrators-compared/); [Conductor vs Claude Code](https://conductor.build/compare/claude-code)

### Inferences
- On isolation, Aiguillage (one worktree and branch per agent, human merge) matches the local standard used by Conductor, Claude Squad, Vibe Kanban and Cursor local agents. The cloud products use VMs/containers instead, which also isolate dependencies, ports and processes. That is a known weak spot of worktrees: each one is a fresh checkout that needs setup.
- What sets Aiguillage apart: competitors put a **dashboard or board** in front of the user, while Aiguillage puts a **conversational orchestrator agent**, reachable both in the app and on Telegram. The closest analogues are Managed Devins (manager agent plus child agents, though in the cloud) and Claude Code agent teams (lead plus teammates, but no worktree isolation per teammate, no mobile chat, and not usable headless).

### Gaps
- I didn't research Google Jules, Sculptor (Imbue), Terragon, Amp or Factory droids (no tool budget left).
- Cursor details are not confirmed from cursor.com. I found no reliable source for Codex "best-of-N".

## 3. Chat-ops interfaces and asynchronous supervision (Slack, Telegram, mobile)

### Takeaway
Driving agents from chat is now mainstream. Codex, Claude Code and Cursor support Slack; GitHub mission control works "from any device". Anthropic ships an official **Telegram** channel (research preview) that pushes chat messages into a *running local* Claude Code session and can relay permission prompts. That is very close to what the aiguilleur does over Telegram. The usual pattern: start a task from chat, have the agent work asynchronously, then get a result or PR link back and approve remotely.

### Cited Findings
- Claude Code Channels: "A channel is an MCP server that pushes events into your running Claude Code session". They "can be two-way". "Telegram, Discord, and iMessage are included in the research preview". Each channel is a plugin that requires Bun. — [Claude Code docs](https://code.claude.com/docs/en/channels)
- Security: "Every approved channel plugin maintains a sender allowlist". Telegram and Discord pair accounts with a code. On permission relay: "Anyone who can reply through the channel can approve or deny tool use in your session, so only allowlist senders you trust with that authority." — [Claude Code docs](https://code.claude.com/docs/en/channels)
- "Events only arrive while the session is open, so for an always-on setup you run Claude in a background process or persistent terminal." The `--channels` flag syntax "may change", and the feature is limited to an Anthropic-maintained allowlist during the preview. — [Claude Code docs](https://code.claude.com/docs/en/channels)
- Anthropic's comparison table: cloud sessions for "self-contained async work you check on later", Claude in Slack for starting tasks from team chat, Remote Control for "Steering an in-progress session while away from your desk". — [Claude Code docs](https://code.claude.com/docs/en/channels)
- Codex: start from Slack with `@Codex`, results come back in the thread. Slack-triggered tasks use usage credits on Business/Enterprise plans. — [OpenAI developers](https://developers.openai.com/codex/integrations/slack); [eesel](https://www.eesel.ai/blog/openai-codex-integrations-with-slack) (secondary)
- GitHub mission control: track agent progress "from any device" (via search summary). — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)

### Inferences
- Aiguillage's Telegram bridge to the aiguilleur (long messages split into parts, media both ways, permission requests, a board view) is a richer, multi-agent take on Anthropic's single-session Telegram channel. One aiguilleur fanning out to N worktree agents over a single Telegram identity is not something any surveyed vendor offers.
- Anthropic's allowlist and pairing model, plus its warning that whoever can reply through the channel can approve tool use, is the security baseline to compare Aiguillage's Telegram permission relay against.

### Gaps
- No metrics found on how usage of chat-driven agents compares with IDE-driven usage.

## 4. Reported metrics: token cost, success rates, PR merge rates

### Takeaway
Hard numbers are scarce and vendor-sourced. Anthropic's 15× tokens and +90.2% (research, not coding) is the most cited figure. Academic studies of agent PRs on GitHub (2026) report merge rates of roughly 43-87% depending on agent and dataset, and the rankings contradict each other across studies.

### Cited Findings
- Multi-agent systems use about 15× the tokens of chat (single agents about 4×). Multi-agent scored 90.2% better than single-agent on Anthropic's internal research eval. Token usage explains 80% of the variance on BrowseComp. — [Anthropic, June 2025](https://www.anthropic.com/engineering/multi-agent-research-system)
- Agent teams: "Token costs scale linearly" with teammates. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- LangChain supervisor: "nearly 50%" gain from architecture fixes, and the supervisor uses more tokens than swarm. — [LangChain, June 2025](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)
- Devin Review: about 2 bugs per PR, about 58% severe (vendor). — [Cognition, Apr 2026](https://cognition.com/blog/multi-agents-working)
- Merge rates (2026 academic preprints, figures taken from search summaries, not checked in the PDFs):
  - Mazloomzadeh, Morovati & Khomh: Claude 84.3%, Codex 73.5%, Devin 43.0% — [arXiv 2607.21832](https://arxiv.org/pdf/2607.21832); [alphaxiv overview](https://www.alphaxiv.org/overview/2607.21832)
  - Ehsani et al., 33,596 PRs from 5 agents: Codex highest at 82.59%, Copilot lowest at 43.04% — [Moonlight review](https://www.themoonlight.io/review/where-do-ai-coding-agents-fail-an-empirical-study-of-failed-agentic-pull-requests-in-github)
  - Security PRs: Codex 86.59%, Claude Code 58.62%, Devin 52.12%, Copilot 49.60% — [arXiv 2601.00477](https://arxiv.org/pdf/2601.00477)
  - Fix PRs: Codex 81.6%, Copilot and Devin about 42-43%, Claude Code sample only 115 PRs — [EmergentMind on 2602.00164](https://www.emergentmind.com/papers/2602.00164.md)
  - These studies contradict each other, and the merge-rate gaps between agents partly reflect who uses each agent and for what tasks, not only the agent's quality.

### Inferences
- With N parallel agents and an orchestrator that is itself a full Claude Code session, Aiguillage should expect token use close to (N+1)× a single session. Anthropic's guidance suggests this pays off only for work that truly parallelizes.

### Gaps
- No public, independent throughput numbers (such as PRs per developer-day) for parallel-agent setups were found.
- The merge-rate figures weren't checked against the paper PDFs.

## 5. Emerging standards: MCP, A2A, AGENTS.md, ACP

### Takeaway
The Linux Foundation's Agentic AI Foundation (Dec 9, 2025) now hosts MCP, AGENTS.md and goose. A2A is a separate Linux Foundation project. ACP is ambiguous: Zed's Agent Client Protocol and IBM's Agent Communication Protocol share the acronym. Inside a local orchestrator, MCP is the practical integration point (Cognition's managers use an "internal MCP"; Claude Code Channels are MCP servers). AGENTS.md is the shared way to feed project instructions to any agent.

### Cited Findings
- AAIF launched with MCP (Anthropic), goose (Block) and AGENTS.md (OpenAI). AGENTS.md is described as "a simple, universal standard that gives AI coding agents a consistent source of project-specific guidance". — [Linux Foundation press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- A2A joined the Linux Foundation on June 23, 2025 as its own project. MCP covers agent-to-tool, A2A covers agent-to-agent (secondary). — [DEV Community](https://dev.to/digitalapplied/agentic-ai-foundation-open-source-agent-standards-gl8)
- Devin Desktop reportedly hosts "ACP-compatible agents" (Codex, Claude Agent, OpenCode), i.e. an agent-to-editor protocol (secondary). — [techedt](https://www.techedt.com/cognition-launches-devin-desktop-for-managing-ai-coding-agents-across-engineering-workflows)
- Managed Devins coordinate children "through an internal MCP". — [Cognition](https://cognition.com/blog/multi-agents-working)
- Claude Code Channels are MCP servers that push events into a session. — [Claude Code docs](https://code.claude.com/docs/en/channels)
- GitHub recommends custom agents defined in agents.md files for persona and context. — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)

### Inferences
- An orchestrator like the aiguilleur could expose dispatch, status and merge as MCP tools, which is the same shape as Cognition's internal MCP. It could read or write AGENTS.md/CLAUDE.md so workers start from shared conventions. ACP would only matter if Aiguillage wanted to run agents other than Claude Code.

### Gaps
- Which "ACP" the Linux Foundation release refers to (OpenAI-contributed) is unclear, and the sources conflict. The 60,000+ AGENTS.md adoption figure is unverified.
- I didn't fetch the A2A spec to check how mature it is or whether coding tools have adopted it.
