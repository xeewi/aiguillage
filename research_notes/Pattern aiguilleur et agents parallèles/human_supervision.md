# Human supervision of several AI agents through one mediating agent (human factors and HCI evidence)

Scope: what the evidence says about one developer supervising several parallel AI coding agents through a single orchestrator (the "aiguilleur"), which is the developer's only interlocutor, in a desktop app and on Telegram (asynchronous, mobile). Classic human-factors references are given for theory; recent (2025–2026) evidence is given for AI agents. Every number below was read in the primary source unless marked "secondary".

---

## 1. Supervisory control and span of control: how many agents can one human handle?

### Takeaway
The robotics and UAV literature models capacity as **fan-out = activity time / interaction time**: one person can run more agents when each agent works longer on its own between check-ins and each check-in costs less. Classic models overestimate capacity because they leave out the human's wait times: the time to re-orient, the queue of agents waiting for attention, and lost situation awareness. The first study of parallel AI coding (ParallelPilot, 2026) finds that tooling which lowers tracking effort lets a developer supervise about one more concurrent agent at peak. It does not report an absolute ceiling.

### Cited Findings
- Olsen & Wood (CHI 2004) define fan-out (FO) as "the number of robots a human can control simultaneously" and propose **FO = AT / IT**. AT (activity time) is "the time that a robot is actively effective after receiving commands from a user". IT (interaction time) is "the time that it takes for a human to interact with a given robot". "Robots that have high neglect tolerance and lower interaction time will achieve higher fan-out." The authors also use the equation to compute "interaction effort" as a metric for comparing HRI designs. — [Olsen & Wood, "Fan-out: Measuring Human Control of Multiple Robots", CHI 2004](https://hci.rwth-aachen.de/materials/conferences/CHI2004/1p231.pdf)
- The same paper concludes that the equation "does model many of the effects of human interaction with multiple robots", but that "fan-out has more underlying complexity than the equation would indicate. This is particularly true with very low fan-out." The experiments used fleets of up to 18 robots. — [Olsen & Wood 2004](https://hci.rwth-aachen.de/materials/conferences/CHI2004/1p231.pdf)
- Olsen & Goodrich (PerMIS 2003) define **neglect tolerance**, a measure of how an agent's task effectiveness declines over time while the user attends elsewhere. — [Olsen & Goodrich 2003, "Metrics for evaluating human-robot interactions"](https://faculty.cs.byu.edu/~mike/mikeg/papers/OlsenGoodrichPERMIS2003.pdf)
- Crandall, Goodrich, Olsen & Nielsen (IEEE SMC-A 2005) use neglect tolerance, measured with a secondary-task method, to find the maximum number of robots one person can manage and which multi-robot team configurations are feasible. — [BYU ScholarsArchive record](https://scholarsarchive.byu.edu/facpub/1286) (bibliographic/abstract level)
- Goodrich, Crandall & Stimpson argue that neglect tolerance limits how many robots one person can manage, so the agents must coordinate with each other rather than all going through the human. — [Goodrich et al., AAAI](https://faculty.cs.byu.edu/~mike/mikeg/papers/AAAI-PD.pdf) (abstract level)
- "Fan-Out Revisited" finds that "fan-out is often overestimated" because classic neglect-time models conflate the human's ability with the robot's. — [Fan-Out Revisited (UWF)](https://ircommons.uwf.edu/esploro/outputs/conferenceProceeding/Fan-Out-Revisited/99381474081806600) (abstract level)
- Cummings & Mitchell (IEEE SMC-A 2008, vol. 38(2), pp. 451–460) add three human **wait times** to the capacity model: interaction wait (cognitive reorientation), queueing wait when several vehicles need the operator at once, and wait due to loss of situation awareness (SA). Including them lowered the predicted number of vehicles by **up to 67%**, and **loss of SA was the main source of delay**. Even in a highly automated management-by-exception setup, SA wait time **cut capacity by 36%** compared with the model without wait times. — [MIT DSpace](https://dspace.mit.edu/handle/1721.1/90280); [PDF](https://dttlab.edublogs.org/files/2014/04/Predicting-Controller-Capacity-in-Supervisory-Control-of-Mulitple-UAVs-25vk1sg.pdf) (abstract-level figures, via search snippets)
- Cummings & Guerlain (Human Factors 2007, 49(1):1–15): **42 U.S. Navy personnel** used high-level replanning to supervise **8, 12 or 16** autonomous in-flight missiles retargeted to time-sensitive targets, while doing secondary tasks of varying complexity. — [dblp](https://dblp.org/rec/journals/hf/CummingsG07.html); [DTIC](https://apps.dtic.mil/sti/pdfs/ADA478338.pdf)
- **ParallelPilot (Long, Shi, Mozannar, Murad, Hosn; arXiv 2609.33113, Sept 2026, cs.HC)** is the closest direct analogue:
  - "As coding assistants become increasingly autonomous, developers run multiple sessions in parallel, shifting the challenge from code generation alone to coordinating and monitoring concurrent agent work."
  - A formative study (N=14) found five supervisory practices, named **PILOT: Planning, Isolating, Logging, Observing, Triaging**.
  - The probe combined a planning interface, a run-logger and an ambient dashboard.
  - In a within-subjects study (N=16) it raised ticket throughput by **63% on short tasks** and let participants supervise **about one more concurrent agent at peak**. It lowered tracking effort and context switching, and **14/16** participants preferred it.
  - **Perceived control and perceived success at redirecting agents did not improve significantly.**
  - The authors recommend pairing "high-level awareness with low-cost access to implementation evidence". — [arXiv 2609.33113](https://arxiv.org/abs/2609.33113)
- Practitioner claims of a "3–5 parallel agents" limit are anecdotal. — [DEV Community](https://dev.to/battyterm/how-to-supervise-ai-coding-agents-without-losing-your-mind-53m4) (no empirical basis)

### Inferences
- In the aiguilleur's terms:
  - **AT** is how long a coding agent works productively without input (minutes to tens of minutes).
  - **IT** is the cost of one human touchpoint: reading a report, answering a question, approving an action.
  - Leverage grows by raising AT (good task specs, auto-approval of safe actions, letting agents verify their own work) and by shrinking IT (compact reports that stand on their own, one-tap decisions).
- The aiguilleur is in effect the "agents coordinate among themselves" layer Goodrich recommends. It can also take over the queueing problem from Cummings & Mitchell: when several agents need the human at once, it serializes and prioritizes their requests so the human never juggles them.
- **Loss of situation awareness is the biggest capacity limiter** in Cummings & Mitchell. Every handback to the human should therefore re-establish context: which repo or workspace, what the agent was asked to do, what changed, what decision is needed. A bare "Agent 3 needs input" is not enough.
- ParallelPilot suggests dashboards help throughput but not the feeling of control. The human also needs cheap drill-down to evidence (diffs, test output, screenshots), not only summaries.

### Gaps
- I found no study that gives an absolute "N agents per developer" ceiling for coding agents.
- I could not confirm, from the primary text, the often-cited Cummings rule that operator performance degrades above about **70% utilization**. It is my recollection, not a verified finding.
- I found no study of supervision mediated by an LLM orchestrator, where the human talks to only one agent. ParallelPilot has the human watch several sessions directly.

---

## 2. Interruptions and attention: cost of agent notifications, permission prompts and Telegram pings

### Takeaway
Interruptions are expensive, but the cost is time to resume and stress more than errors.
- In a field study, alert-driven switches cost about 10 minutes, plus another 10–15 minutes before people returned to focused work on the interrupted task. 27% of suspensions lasted more than 2 hours.
- In the lab, interrupted people work faster but with significantly more stress and frustration after only 20 minutes.
- Batching notifications at predictable times improves attention and well-being; batching every hour does little.

### Cited Findings
- **Iqbal & Horvitz (CHI 2007)** logged 27 users at work for two weeks (2,267 hours, 974 sessions). They found:
  - Participants "spent on average nearly 10 minutes on switches caused by alerts, and spent on average another 10 to 15 minutes (depending on the type of interruption) before returning to focused activity on the disrupted task."
  - "27% of task suspensions resulted in more than two hours of time until resumption."
  - After an immediate response to an email alert, the resumption phase averaged **16 min 33 s**; after IM alerts it averaged **10 min 58 s**. Delayed responses were not significantly different.
  - Tasks worked on for less than 5 minutes before suspension had a **10% chance of not being resumed within 2 hours**.
  - Users blamed long delays on "loss of context". Keeping the suspended window visible was associated with faster resumption, which suggests "visual cues may serve as reminders". — [Iqbal & Horvitz 2007, "Disruption and Recovery of Computing Tasks"](https://www.erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf)
- **Mark, Gudith & Klocke (CHI 2008)** found:
  - "people completed interrupted tasks in less time with no difference in quality… people compensate for interruptions by working faster, but this comes at a price: experiencing more stress, higher frustration, time pressure and effort."
  - "After only 20 minutes of interrupted performance people reported significantly higher stress, frustration, workload, effort, and pressure." Stress differed across conditions at F(2,92)=12.15, p<.001.
  - Whether the interruption shared the task's context or not made no difference to time.
  - Openness to experience and need for structure predicted disruption cost.
  - The interruption interval was 2 minutes.
  - The authors suggest technology "keep track of and control interruptions over a long period of time so as not to overload people". — [Mark et al. 2008](https://www.ics.uci.edu/~gmark/chi08-mark.pdf)
- The popular "23 minutes to refocus" figure attributed to Mark is **not** in this CHI 2008 paper. — [Mark et al. 2008](https://www.ics.uci.edu/~gmark/chi08-mark.pdf) (I checked the text). Do not cite it from this paper.
- **Fitz, Kushlev et al. (Computers in Human Behavior, 2019, vol. 101, pp. 84–94)** ran a two-week field experiment with N=237. Notifications were delivered as usual, batched **3×/day (9am, 3pm, 9pm)**, or never.
  - The 3×/day batching group reported more attention, productivity, well-being and control, and less stress.
  - The same group reported more fear of missing out.
  - **Hourly batching showed few benefits.**
  - Caveats: participants were in India, and some co-authors have financial ties to the app (Daywise). — [Springer Nature community summary](https://communities.springernature.com/posts/batching-notifications-can-improve-attention-well-being-and-productivity); [PDF](https://static1.squarespace.com/static/57a40c19414fb54f51f8095f/t/614a55faa7b89e25f4e48ad1/1632261627146/2019+Fitz+Batching.pdf) (secondary for some details)
- **Horvitz, "Principles of Mixed-Initiative User Interfaces" (CHI 1999)** lists 12 critical factors. Among them:
  - considering "the status of a user's attention in the timing of services";
  - when uncertain, engaging "in an efficient dialog with the user, considering the costs of potentially bothering a user needlessly". — [Horvitz 1999](https://www.erichorvitz.com/chi99horvitz.pdf) (factor list partially verified)
- In Claude Code, the median agent turn is about **45 seconds** (range 40–55 s), while the 99.9th percentile grew from under 25 to over 45 minutes between Oct 2025 and Jan 2026. — [Anthropic, "Measuring AI agent autonomy in practice", Feb 2026](https://www.anthropic.com/research/measuring-agent-autonomy)

### Inferences
- A permission prompt or "agent finished" ping that pulls the developer out of their own task can cost **10–25 minutes of effective focus**. With N agents each pinging independently, the cost adds up quickly. Agent turns are short (median ~45 s), so unbatched per-agent notifications would generate interruptions faster than a human can absorb them.
- Design implications for the aiguilleur:
  - Use **one channel, triaged**.
  - Interrupt immediately only for blocking decisions or high-risk actions.
  - Batch everything else into digests at predictable times or at natural breakpoints. Hourly batching did little in Fitz et al.; a few fixed times a day worked.
  - Let the user pull status on demand (a "board").
- Each handback should carry its own context so the human can resume quickly. The aiguilleur can do what Iqbal & Horvitz call "visual cues as reminders": keep suspended threads visible and resumable.
- Mark et al. imply the human may *feel* productive under constant pings while paying in stress. Self-reports are not a good measure of a notification policy.

### Gaps
- I found no controlled study of notification policies specifically for AI coding agents.
- I found no study of Telegram or chat interruptions for developers in particular.

---

## 3. Automation bias, complacency, trust calibration, ironies of automation, permission-prompt fatigue

### Takeaway
Humans approve almost everything they are asked to approve: 93% of Claude Code permission prompts are accepted, and Anthropic itself names "approval fatigue". Per-action approval is therefore a weak safety net. The human-factors literature predicts exactly this: complacency under multi-task load that practice does not remove, and Bainbridge's irony that the less the operator does, the worse they are at stepping in. Experienced Claude Code users move from approving each action in advance to monitoring and interrupting, and the human-factors view supports that shift.

### Cited Findings
- **Permission prompts and approval fatigue:** "in practice users accept 93% of them anyway". "Over time that leads to approval fatigue, where people stop paying close attention to what they're approving." — [Anthropic Engineering, Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
  - Some press reports say **97%** ([The Register](https://www.theregister.com/a/5285326); [Business Today](https://www.businesstoday.in/technology/news/story/anthropic-is-making-claude-code-more-autonomous-auto-mode-coming-as-default-for-paid-users-548281-2026-08-10)). The primary Anthropic engineering post says 93%. Treat 97% as a possibly later or different figure that I could not verify.
- **Auto-mode classifier as a delegated approver** (same post):
  - Stage 1 alone: **8.5% false-positive rate** on real traffic (n=10,000), **6.6% false-negative rate** on real overeager actions (n=52), 1.8% FNR on synthetic exfiltration.
  - Full two-stage pipeline: **0.4% FPR**, **17% FNR** on real overeager actions, 5.7% FNR on synthetic exfiltration.
  - Blocked actions go back to the agent with a reason ("a false positive costs a single retry"). The session escalates to a human after **3 consecutive or 20 total denials**.
  - Most misses come from the classifier misjudging whether the user's earlier approval covers an action's full blast radius. — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode)
- **Sandboxing** reportedly cut permission prompts by **84%** in Anthropic's internal use. — [secondary guide](https://inventivehq.com/knowledge-base/claude/how-to-manage-permissions-and-sandboxing) (not verified on an Anthropic page)
- **How users actually supervise (Anthropic, Feb 2026):**
  - New users (<50 sessions) fully auto-approve in about **20%** of sessions, rising to **over 40%** by about 750 sessions.
  - Interrupt rates *also* rise with experience, from about **5%** of turns at about 10 sessions to about **9%** for experienced users. Anthropic reads this as beginners pre-approving each action while experienced users monitor and step in.
  - On the most complex tasks, Claude stops to ask for clarification **more than twice as often** as on minimal tasks, and Claude-initiated stops grow faster with complexity than human-initiated ones.
  - Only **0.8%** of API actions appear irreversible.
  - Recommendation: "effective oversight doesn't require approving every action but being in a position to intervene when it matters". Anthropic also warns against mandating approve-every-action patterns that "add friction without clear safety benefit". — [Anthropic, Measuring AI agent autonomy in practice](https://www.anthropic.com/research/measuring-agent-autonomy)
- **Parasuraman & Manzey (Human Factors 2010, 52(3):381–410):**
  - Complacency and automation bias are "different manifestations of overlapping automation-induced phenomena, with attention playing a central role".
  - Complacency appears "under conditions of multiple-task load, when manual tasks compete with the automated task for the operator's attention".
  - It occurs in naive and expert users alike and "cannot be overcome with simple practice".
  - Automation bias produces both omission errors (missing a problem the aid did not flag) and commission errors (following a wrong recommendation). — [PubMed 21077562](https://pubmed.ncbi.nlm.nih.gov/21077562/); [full text, TU Berlin](https://depositonce.tu-berlin.de/items/0c787d91-6021-480b-a333-009e0d1d0092/full)
- **Lee & See (Human Factors 2004, 46(1):50–80):** trust guides reliance when complexity and unanticipated situations make full understanding of the automation impractical. The goal is *appropriate* reliance (calibrated trust), and the conceptual model covers trust dynamics, context and how the automation is displayed. — [Lee & See 2004 PDF](https://csel.eng.ohio-state.edu/productions/intel/research/trust/Lee%20%26%20See%20Trust%20Review.pdf)
- **Bainbridge, "Ironies of Automation" (Automatica 19(6):775–779, 1983):** automating most of the work leaves the human with the hardest, rarest tasks: monitoring and taking over in abnormal situations. Yet the human's skills and understanding decay because they no longer do the work. — [ferd.ca notes on the paper](https://ferd.ca/notes/paper-ironies-of-automation.html); [IEEE Spectrum](https://spectrum.ieee.org/are-we-automating-ourselves-into-a-corner) (secondary summaries; original DOI 10.1016/0005-1098(83)90046-8)
- **Parasuraman & Riley (Human Factors 1997, 39(2):230–253), "Humans and automation: use, misuse, disuse, abuse":** the standard taxonomy. Misuse is over-reliance, disuse is under-use after false alarms, and abuse is automating without regard to the human's role. — [summary page](https://zerca.tail8f5ad8.ts.net/wiki/remote-operations-kb/use-misuse-disuse-abuse-of-automation) (secondary; citation from my knowledge, not fetched)
- **Perception gap:** METR's developers expected a 24% speedup and, *after* being measured 19% slower, still believed AI had sped them up by 20%. Self-assessment of AI help is unreliable. — [METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)

### Inferences
- Per-action approval forwarded to the human, for example a Telegram button for every `rm` or `git push`, will be rubber-stamped after a few days. That is the 93% figure, predicted by Parasuraman & Manzey under multi-agent load.
- Better design for the aiguilleur:
  1. Auto-handle the safe majority with policies, sandboxes or a classifier.
  2. Escalate only rare, high-stakes or irreversible actions, which are about 0.8% of actions per Anthropic. Their rarity keeps each one salient.
  3. Show blast radius and reversibility in the request.
  4. Prefer review of outcomes (diffs, tests, PRs) over approval of actions.
- To calibrate trust (Lee & See), the aiguilleur should report agent uncertainty and failure honestly, without smoothing it away. Show "what I'm not sure about" and "what I didn't verify", not only success summaries. An LLM orchestrator that paraphrases reports adds a layer where a confident summary can hide errors; this is a known risk of mediated supervision.
- Bainbridge applied: if the human never touches the code, their ability to judge it decays. Keeping the human in the planning and decision role helps, since people make about 70% of planning decisions (§4). So does an occasional deep dive.

### Gaps
- The 84% sandboxing figure and the 97% approval figure are not verified in primary sources.
- I found no study that measures how often humans catch dangerous agent commands. One aggregator claims 13.6%, which I could not verify, so it is not used.

---

## 4. Empirical studies of developers using AI agents: productivity, PR acceptance, review burden, trust

### Takeaway
The evidence is mixed and depends on context. Controlled tasks and enterprise field experiments show 21–56% speedups. The METR RCT on experienced developers in their own large repos showed a 19% *slowdown*, and the developers did not perceive it. On GitHub, PRs written by agents are accepted less often than human PRs in most datasets, and oversized multi-purpose PRs get rejected. At the organization level, the bottleneck moves to human review: PR review time rose 91% in high-AI-adoption teams.

### Cited Findings
- **METR RCT (July 2025):**
  - 16 experienced OSS developers worked in their own repositories (averaging 22k+ stars and 1M+ lines of code), mostly with Cursor Pro and Claude 3.5/3.7 Sonnet.
  - Tasks were randomly assigned AI-allowed or AI-disallowed. With AI they took **19% longer**.
  - They forecast a 24% speedup and afterwards believed in a 20% speedup.
  - Contributing factors include time spent prompting and waiting for the AI, and the difficulty of large, complex codebases.
  - METR warns the sample is not representative and that learning effects may appear only after hundreds of hours. — [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); [arXiv 2507.09089](https://arxiv.org/abs/2507.09089)
- **Google enterprise RCT:** about **21%** less time on a complex enterprise task. — via the [METR study search context](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); original: Paradis et al., arXiv 2410.12944 (not fetched)
- **GitHub Copilot RCT (Peng et al. 2023):** 95 professional developers wrote an HTTP server in JavaScript, and Copilot users finished **55.8% faster**. — secondary via [search summary](https://www.aeaweb.org/conference/2025/program/1916); original arXiv 2302.06590 (not fetched)
- **Cui, Demirer, Jaffe, Musolff, Peng, Salz (field experiments at Microsoft, Accenture and a Fortune 100 company; N=4,867):**
  - **+26.08%** (SE 10.3%) completed tasks.
  - Microsoft: +12.92% to +21.83% PRs per week. Accenture: +7.51% to +8.69%.
  - Compliance at Microsoft was low. — [SSRN 4945566](https://papers.ssrn.com/abstract=4945566); [MIT draft](https://economics.mit.edu/sites/default/files/inline-files/draft_copilot_experiments.pdf)
- **Faros AI "AI Productivity Paradox" 2025 (about 10,000 developers, within-organization comparison):**
  - High-adoption teams completed about **21% more tasks** and merged **98% more PRs**.
  - **PR review time rose 91%.**
  - Secondary sources add PR size **+154%** and bugs per developer **+9%**. — [Faros AI](https://www.faros.ai/blog/ai-productivity-paradox-report-2025); [Augment summary](https://www.augmentcode.com/guides/ai-productivity-paradox-engineering-delivery) (the full report requires registration)
- **AIDev dataset (Li, Zhang, Hassan; arXiv 2507.15003, July 2025):**
  - 456,535 agentic PRs in 61,453 repos (v1). A later version has 932,791 PRs from Codex, Devin, Copilot, Cursor and Claude Code.
  - In repos with more than 500 stars, acceptance was: humans **76.8%**, Codex **65.3%**, Claude Code **52.5%**, Cursor **51.4%**, Devin **48.9%**, Copilot **38.2%**.
  - Accepted Codex PRs close in a median **0.3 h** versus **3.9 h** for human PRs. The authors suggest this may reflect superficial review, but do not test it.
  - "PR acceptance rates consistently lag behind human performance." — [arXiv 2507.15003](https://arxiv.org/html/2507.15003v1); [AIDev paper 2602.09185](https://arxiv.org/pdf/2602.09185)
- **Nakashima et al., "Why Agentic-PRs Get Rejected" (arXiv 2602.04226, Feb 2026; repos with at least 100 stars):**
  - Acceptance: Codex 85.8% (n=20,993), Cursor 74.6%, Claude Code 71.3% (n=380), Devin 55.5%, Copilot 55.0%, Human 82.6%.
  - In the coded sample, 69.0% of agentic rejections had no stated reason, versus 62.4% for human PRs.
  - Seven rejection categories occur *only* for agentic PRs.
  - Every PR rejected as "too large" (1.5%) was agentic. The authors say oversized, multi-purpose agentic PRs are hard to review.
  - 32.1% of Devin's rejections were for inactivity. — [arXiv 2602.04226](https://arxiv.org/html/2602.04226v1)
- **Comparing AI coding agents (arXiv 2602.08915):** across 7,156 PRs, overall acceptance was **69.3%**: Codex 77.9%, Cursor 74.5%, Claude Code 71.9%, Copilot 68.0%, Devin 61.6%. No agent wins on every task type. — [arXiv 2602.08915](https://arxiv.org/abs/2602.08915) (via search snippet)
- **Ehsani et al., "Where Do AI Coding Agents Fail?" (MSR 2026, about 33k PRs):**
  - Documentation, CI and build tasks merge best; performance and bug-fix tasks merge worst.
  - PRs that are not merged are larger and touch more files.
  - Failure categories include "wrong task description", "unwanted feature" and "duplicate". — [arXiv 2601.15195](https://arxiv.org/pdf/2601.15195) (via secondary review; figures not verified)
- **Pham & Ghaleb (MSR '26):** more commits in a PR is associated with lower merge success. — [arXiv 2601.17627](https://arxiv.org/html/2601.17627v1) (snippet level)
- **Anthropic, "Agentic coding and persistent returns to expertise" (June 16, 2026; about 400,000 Claude Code sessions from about 235,000 people):**
  - People made about **70% of planning decisions** and about **20% of execution decisions**: "people decide what to build, and the agent decides how to build it".
  - Each prompt triggered about 10 agent actions on average: about 12 for experts versus about 5 for novices.
  - Verified success: novices 15%, intermediate or above 28–33%.
  - In sessions that hit trouble, verified recovery rose from **4% for novices to 15% for experts**. Novices abandoned **19%** of sessions versus 5–7% for others. — [Anthropic Research](https://www.anthropic.com/research/claude-code-expertise)
- **Anthropic internal use, Aug–Dec 2025:** success on the hardest tasks doubled, and human interventions per session fell from **5.4 to 3.3**. — [Anthropic, Measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)

### Inferences
- The human's limited resource is **review and verification capacity**, not generation. Running more agents in parallel without more review capacity mainly grows the review queue: +91% review time, larger PRs, and "too large" rejections that are agentic only.
- The aiguilleur should push agents toward **small, single-purpose, self-verified changes**. It should send review-ready evidence such as tests run and screenshots, not just "done".
- Acceptance varies widely by task type. Routing docs, CI and build work to agents with little supervision, and keeping closer supervision for bug fixes and performance work, is supported by Ehsani et al.
- Because of the METR perception gap, the system should measure outcomes (merged, reverted, time to done) instead of relying on how productive the user feels.

### Gaps
- Agentic PR acceptance figures conflict across papers (Claude Code ranges from 52.5% to 71.9%) because of different snapshots, star thresholds and filters. No single figure is authoritative.
- I found no RCT of *parallel multi-agent* workflows against a single agent. ParallelPilot is the only controlled study, and it compares tooling, not number of agents.
- METR follow-up studies after 2025, with newer tools, were not checked in this pass.

---

## 5. Delegation and handoff: task specs, mixed initiative, "chief of staff" intermediaries

### Takeaway
The evidence on delegation points to a clear split: the human owns *what* (planning, specs, verification criteria) and the agent owns *how*. Expertise shows up as more precise direction, explicit verification requests and better recovery. Mixed-initiative principles (Horvitz 1999) call for agents that weigh the cost of bothering the user and ask efficient clarifying questions when uncertain. Current agents already ask for clarification more on complex tasks.

### Cited Findings
- People make about 70% of planning decisions and the agent about 80% of execution decisions. The expertise classifier rated "how precisely users framed directions, what they asked Claude to verify, and whether users corrected Claude". Experts got about 2.4× more actions per prompt and about 5× more output, and recovered better. — [Anthropic, Claude Code expertise, June 2026](https://www.anthropic.com/research/claude-code-expertise)
- Claude stops to ask for clarification more than twice as often on the most complex tasks as on minimal ones, and more often than humans interrupt it. Anthropic recommends training models to "recognize their own uncertainty and surface issues to humans proactively". — [Anthropic, Measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)
- Horvitz's mixed-initiative principles:
  - couple automated services with direct manipulation;
  - consider uncertainty about user goals and the user's attention when deciding whether and when to act;
  - engage in efficient dialog when uncertain;
  - allow efficient invocation and termination, and minimize the cost of poor guesses. — [Horvitz 1999](https://www.erichorvitz.com/chi99horvitz.pdf); [MSR page](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/)
- ParallelPilot's PILOT practices (Planning, Isolating, Logging, Observing, Triaging) and its planning interface clarified execution plans, task dependencies and intervention cues. — [arXiv 2609.33113](https://arxiv.org/abs/2609.33113)
- "Wrong task description", "unwanted feature" and "duplicate" are PR-level failure categories for agentic PRs. — [Ehsani et al. 2601.15195](https://arxiv.org/pdf/2601.15195) (secondary review)

### Inferences
- The aiguilleur's main lever is **spec quality at dispatch**. When it turns a terse human request into a task, it should state the goal, scope boundaries, acceptance or verification criteria (tests to run, what to screenshot) and what to escalate. This mirrors what separates expert from novice sessions.
- Clarifying questions belong **up front**, batched at dispatch, rather than trickling in mid-run. Front-loading raises activity time (§1) and avoids interruptions (§2).
- "Isolating" (separate worktrees or workspaces per agent) is an empirically found supervisory practice. It lowers interference and makes each agent's evidence easy to inspect.

### Gaps
- I found no controlled study of conversational intermediary or "chief of staff" agents that relay between one human and several worker agents, and none on the information loss such relaying introduces.
- I found no controlled experiment that varies spec quality for coding agents. The evidence is correlational: expertise classifiers and failure taxonomies.

---

## 6. Mobile and asynchronous supervision (ChatOps, review on the phone, approvals)

### Takeaway
The evidence base here is thin. Nothing I found measures the quality of code review or approvals done on a phone. Indirect evidence points to three things:
- **Predictable batching** helps; hourly does not (Fitz et al.).
- **Pre-approval of individual actions** degrades into rubber-stamping (93% approval).
- Experienced users prefer "run autonomously, step in when something goes wrong".

Together these suggest that mobile is good for *triage and decisions* (go or no-go, choose between options, unblock) and poor for *verifying* code.

### Cited Findings
- Batching smartphone notifications 3×/day improved attention, productivity and well-being in a 2-week RCT (N=237), while hourly batching did not. — [Fitz et al. 2019](https://communities.springernature.com/posts/batching-notifications-can-improve-attention-well-being-and-productivity)
- Experienced agent users shift to "active monitoring" with more interruptions (about 9% of turns) and more auto-approval (over 40% of sessions). — [Anthropic, Feb 2026](https://www.anthropic.com/research/measuring-agent-autonomy)
- "Effective oversight doesn't require approving every action but being in a position to intervene when it matters"; product developers should provide "simple ways to intervene and redirect the agent". — [Anthropic, Feb 2026](https://www.anthropic.com/research/measuring-agent-autonomy)
- Fast acceptance of agentic PRs (median 0.3 h for Codex) may reflect superficial review. This is the authors' speculation, not tested. — [Li et al. 2507.15003](https://arxiv.org/html/2507.15003v1)
- ParallelPilot's recommendation to pair high-level awareness with low-cost access to implementation evidence. — [arXiv 2609.33113](https://arxiv.org/abs/2609.33113)

### Inferences
- On Telegram, the aiguilleur should send **decision-shaped** messages: what is needed, the options, a recommendation, and the risk or reversibility, answerable with one tap or a one-line reply. Each message should carry enough context to stand on its own, given the loss-of-SA findings.
- Code acceptance that needs real verification should be deferred to the desktop, or backed by agent-produced evidence (test results, screenshots) rather than raw diffs.
- Routine "done" messages should go into digests; only blocking or high-risk items should be pushed.

### Gaps
- I found no peer-reviewed study on ChatOps approvals, on code review quality on mobile, or on Slack or Telegram bots supervising coding agents. Recommendations here are extrapolated from the interruption, automation-bias and agent-autonomy evidence above.

---

## Cross-cutting design principles (evidence-backed synthesis for the report writer)

1. **Maximize activity time between touches.** Use good specs, front-loaded clarification, sandboxes or auto-approval for safe actions, and self-verification (FO = AT/IT; [Olsen & Wood 2004](https://hci.rwth-aachen.de/materials/conferences/CHI2004/1p231.pdf)).
2. **Minimize the cost of each touch.** Make every handback stand on its own: who, what was asked, what changed, the evidence, the decision needed. Loss of SA is the largest capacity drain ([Cummings & Mitchell 2008](https://dspace.mit.edu/handle/1721.1/90280)).
3. **The orchestrator owns the queue.** Serialize and prioritize simultaneous requests so the human never faces N concurrent pings ([Cummings & Mitchell 2008](https://dspace.mit.edu/handle/1721.1/90280)).
4. **Interrupt sparingly; batch predictably.** Push only blocking or high-risk items, and digest the rest at a few fixed times ([Iqbal & Horvitz 2007](https://www.erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf); [Mark et al. 2008](https://www.ics.uci.edu/~gmark/chi08-mark.pdf); [Fitz et al. 2019](https://communities.springernature.com/posts/batching-notifications-can-improve-attention-well-being-and-productivity)).
5. **Don't forward every permission prompt.** 93% are approved anyway and approval fatigue sets in. Delegate safe actions to policies or classifiers and escalate the rare irreversible ones with their blast radius shown ([Anthropic auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode); [Parasuraman & Manzey 2010](https://pubmed.ncbi.nlm.nih.gov/21077562/)).
6. **Calibrate trust and avoid masking failures.** Relay uncertainty, what was not verified, and failures faithfully ([Lee & See 2004](https://csel.eng.ohio-state.edu/productions/intel/research/trust/Lee%20%26%20See%20Trust%20Review.pdf)). Don't trust felt productivity ([METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)).
7. **Keep changes small and single-purpose.** Review is the bottleneck: +91% review time ([Faros](https://www.faros.ai/blog/ai-productivity-paradox-report-2025)), and only agentic PRs were rejected as "too large" ([Nakashima et al.](https://arxiv.org/html/2602.04226v1)).
8. **The human plans and verifies; the agents execute** ([Anthropic expertise study](https://www.anthropic.com/research/claude-code-expertise)). Keep the human's grip on the code to counter Bainbridge's ironies ([summary](https://ferd.ca/notes/paper-ironies-of-automation.html)).
9. **Pair a dashboard or board with cheap drill-down to evidence.** Awareness tools alone did not improve perceived control ([ParallelPilot](https://arxiv.org/abs/2609.33113)).
