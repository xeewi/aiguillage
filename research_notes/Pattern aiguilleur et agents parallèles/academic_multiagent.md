# Academic literature on LLM multi-agent architectures (orchestrator–worker, hierarchical, supervisor): what works, what fails

Scope note: what each source is, peer-reviewed or not, is marked as [PEER-REVIEWED: venue], [PREPRINT] or [INDUSTRY]. A venue is marked peer-reviewed only when the arXiv comment field or the conference site says so. Each number below was read in the paper's abstract or HTML full text, or in the cited page. Papers named in the brief whose text I did not open (AgentVerse, ChatDev, AutoGen, HuggingGPT, "Agents of change") are listed as gaps, not cited.

## 1. Taxonomies of multi-agent topologies (centralized / decentralized / hierarchical / blackboard), with reference systems

### Takeaway
The surveys sort systems by **structure**: peer-to-peer, centralized or distributed, sometimes layered, sometimes a shared message pool. Among the reference systems, the one closest to an "aiguilleur" is Magentic-One: a central Orchestrator holding a task ledger and a progress ledger, with a stall counter that triggers re-planning. Its ablations are the clearest evidence that a structured orchestrator beats a plain group chat (−31% when it is replaced by a GroupChat-style orchestrator).

### Cited Findings
- **Tran et al., "Multi-Agent Collaboration Mechanisms: A Survey of LLMs"** (Tran, Dao, Nguyen, Pham, O'Sullivan, Nguyen; arXiv:2501.06322, Jan 2025) [PREPRINT]. Describes collaboration along five dimensions: **actors**; **types** (cooperation, competition, coopetition); **structures** (peer-to-peer, centralized, distributed); **strategies** (role-based or model-based); **coordination protocols** — [arXiv 2501.06322](https://arxiv.org/abs/2501.06322)
- **Guo et al., "Large Language Model based Multi-Agents: A Survey of Progress and Challenges"** (Guo, Chen, Wang, Chang, Pei, Chawla, Wiest, Zhang; arXiv:2402.01680, v2 Apr 2024) [PREPRINT on arXiv; I did not confirm the IJCAI 2024 venue]. Asks "how are these agents profiled and how do they communicate?" The abstract page does not give the detail of the communication structures — [arXiv 2402.01680](https://arxiv.org/abs/2402.01680)
- **Magentic-One** (Fourney, Bansal, Mozannar, … Amershi; Microsoft; arXiv:2411.04468, Nov 2024) [PREPRINT]. Hub-and-spoke architecture: one Orchestrator and four workers (WebSurfer, FileSurfer, Coder, ComputerTerminal) — [arXiv 2411.04468](https://arxiv.org/abs/2411.04468)
  - **Outer loop**: the Orchestrator writes a **task ledger** (facts given or verified, facts to look up, facts to derive, educated guesses) and then a step-by-step plan. **All agents reset their contexts after each plan update** — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
  - **Inner loop**: each iteration updates a **progress ledger** by answering five questions: is the task complete? is the team looping? is progress being made? which agent speaks next? what should that agent be asked? — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
  - **Stall counter**: it goes up on each detected loop or lack of progress. The threshold is **2** in the experiments. Past it comes a reflection step and a re-plan through the outer loop — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
  - Results: GAIA test **32.33 ± 5.3** (GPT-4o) and **38.00 ± 5.5** (GPT-4o + o1); AssistantBench **11.0 EM / 25.3 acc** (GPT-4o) and **13.3 / 27.7** (GPT-4o + o1); WebArena **32.8 ± 3.2**. These are "statistically competitive" with the state of the art on GAIA and AssistantBench, but below WebPilot (37.2) and Jace.AI (57.1) on WebArena. Humans score 92.00 on GAIA and 78.2 on WebArena — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
  - **Ablations (GAIA validation)**: replacing the ledger-based Orchestrator with a GroupChat-style orchestrator costs **−31%**. Removing any single worker costs **−21%** (Coder, ComputerTerminal) to **−39%** (FileSurfer). Agents can be added or removed "without additional prompt tuning" — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
- **MacNet, "Scaling Large-Language-Model-based Multi-Agent Collaboration"** (Qian, Xie, Wang, Liu, Zhu, Xia, Dang, Du, Chen, Yang, Liu, Sun; arXiv:2406.07155) [PEER-REVIEWED: ICLR 2025, per the arXiv comment]. Agents are organized as directed acyclic graphs and the system scales past **1,000 agents**. **Irregular topologies outperform regular ones** — [arXiv 2406.07155](https://arxiv.org/abs/2406.07155)
- **MetaGPT** (Hong, Zhuge, Chen, … Schmidhuber; arXiv:2308.00352, v7 Nov 2024) [PREPRINT on the arXiv page; I did not confirm the venue]. Encodes **Standardized Operating Procedures (SOPs)** into prompt sequences, in an "assembly line" of roles. Generates "more coherent solutions than previous chat-based multi-agent systems" — [arXiv 2308.00352](https://arxiv.org/abs/2308.00352)
- **Kim et al., "Towards a Science of Scaling Agent Systems"** (Google Research, Google DeepMind, MIT; arXiv:2512.08296, Dec 2025, v3 Apr 2026) [PREPRINT]. Uses a five-class operational taxonomy: **Single-Agent (SAS), Independent, Centralized, Decentralized, Hybrid** — [arXiv HTML 2512.08296](https://arxiv.org/html/2512.08296v2)

### Inferences
- The "aiguilleur + N Claude Code agents" pattern is a **Centralized** topology in Kim et al.'s sense, or hub-and-spoke in Magentic-One's. One difference matters a lot: the workers never talk to each other. That is close to "Independent" for execution, with a centralized point of validation and synthesis.
- Magentic-One's ledgers are directly reusable patterns for an aiguilleur: an explicit log of facts and plan per task, a loop and stall detector, re-planning after a threshold.

### Gaps
- I did not open the full texts of AgentVerse, ChatDev, AutoGen, HuggingGPT or "Agents of change", so I give no numbers for them.
- The full Guo et al. taxonomy (layered, decentralized, centralized, shared message pool) appears neither on the abstract page nor in what I read. It needs checking in the PDF.

## 2. Failure modes: MAST (Cemri et al. 2025) and coding-specific studies

### Takeaway
Most multi-agent failures come from **system design and specification** (≈44%) and **inter-agent misalignment** (≈32%), not from the base model alone. Verification fails in ≈24% of cases, and having a verifier does not guarantee a correct result. In parallel coding, CooperBench measures a "curse of coordination": pooled across models, **~41% of solo capability is lost** when two agents share a repo.

### Cited Findings
- **Cemri et al., "Why Do Multi-Agent LLM Systems Fail?"** (Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia, Gonzalez, Stoica; UC Berkeley; arXiv:2503.13657, v3 Oct 2025) [PREPRINT on arXiv]. **1,600+ annotated traces** (MAST-Data), **7 frameworks** (MetaGPT, ChatDev, HyperAgent, AppWorld, AG2/MathChat, Magentic-One, OpenManus). **14 failure modes in 3 categories**, built from 150 traces. Human inter-annotator agreement **κ = 0.88** — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- MAST frequencies by mode — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657):
  - FC1 System design: FM-1.1 disobey task spec **11.8%**; FM-1.2 disobey role spec **1.5%**; FM-1.3 step repetition **15.7%**; FM-1.4 loss of conversation history **2.8%**; FM-1.5 unaware of termination conditions **12.4%**.
  - FC2 Inter-agent misalignment: FM-2.1 conversation reset **2.2%**; FM-2.2 fail to ask for clarification **6.8%**; FM-2.3 task derailment **7.4%**; FM-2.4 information withholding **0.85%**; FM-2.5 ignored other agent's input **1.9%**; FM-2.6 reasoning-action mismatch **13.2%**.
  - FC3 Task verification: FM-3.1 premature termination **6.2%**; FM-3.2 no or incomplete verification **8.2%**; FM-3.3 incorrect verification **9.1%**.
  - Category sums (my calculation, not the paper's): FC1 ≈ 44.2%, FC2 ≈ 32.4%, FC3 ≈ 23.5%.
- MAST: overall failure rates range from **41% to 86.7%** across the systems studied — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- MAST LLM-as-judge (o1): zero-shot accuracy 0.89 and **κ 0.58**; few-shot accuracy **0.94** and **κ 0.77**; out-of-domain (OpenManus, Magentic-One) **κ 0.79** — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- MAST interventions on ChatDev (GPT-4o): a better role specification, or the "CEO has the final say" change, gives **+9.4%** success (the paper credits this +9.4% to two different interventions in two sections). Adding a high-level verification step gives **+15.6%** on ProgramDev. The authors judge such tactical fixes "limited" and inconsistent — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- MAST on verification: "the presence of a verifier is not a silver bullet". Many verifiers only check superficially, for example whether the code compiles. The paper calls for **multi-level** verification, covering both low-level correctness and high-level objectives — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- MAST comparisons: MetaGPT vs ChatDev on ProgramDev, MetaGPT has **60–68% fewer** FC1 and FC2 failures but **1.56× more** FC3 failures. In MetaGPT, GPT-4o has **39% fewer** FC1 failures than Claude 3.7 Sonnet — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- **Magentic-One error analysis**: the most frequent error codes are (1) **persistent-inefficient-actions** (repeating unproductive actions), (2) **insufficient-verification-steps** (task declared done without validation), (3) inefficient-navigation-attempts. **Underutilized-resource-options** are also prevalent — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
- **CooperBench, "Why Coding Agents Cannot be Your Teammates Yet"** (Khatua, Zhu, Tran, … Yang; Stanford & SAP Labs; arXiv:2601.13295, Jan 2026) [PREPRINT on arXiv; an ICLR 2026 listing exists under the title "CooperBench: Benchmarking Cooperation in Coding Agents", so peer review is likely but not confirmed in the text]. **652 tasks**, 12 libraries, 4 languages. Two agents each implement a feature from the same repo state. The abstract says success is "on average 30% lower" in cooperation — [arXiv 2601.13295](https://www.arxiv.org/abs/2601.13295); [ICLR 2026 listing](https://iclr.cc/virtual/2026/10018462)
  - Solo vs cooperative successes (Table 5): GPT-5 315 vs 183 (retention **0.64**); Claude (Sonnet 4.5) 307 vs 168 (**0.60**); MiniMax M2 236 vs 91 (**0.46**); Qwen Coder 141 vs 87 (**0.63**); pooled 1039 vs 558 (**0.59**, i.e. ~41% lost). GPT-5 and Claude Sonnet 4.5 reach about **25%** in cooperation, a gap "as large as 50%" — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
  - **More agents on the same codebase**: success falls from **68.6%** with 2 agents to **46.5%** with 3 and **30.0%** with 4 (on 46 tasks) — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
  - Symptoms in failed cooperative trajectories: **work overlap 33.2%**, **divergent architecture 29.7%**, repetition 14.7%, unresponsiveness 8.7%, unverifiable claims 4.3%, broken commitment 3.7%, and the rest ≤1.7%. Root causes (50 traces reviewed by hand): **expectation 42%**, commitment 32%, communication 26% — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
- **"Passes Alone, Fails Together"** (Xia, Wu, Park; arXiv:2609.25396, Sep 2026) [PEER-REVIEWED, workshop: EXPRESS 2026, 6 pages]. On 417 pairs of real merged Django PRs (834 runs), **only 1 run** showed semantic interference once grading was corrected. On constructed tasks (12 Django helpers), interference appears in **97%** of runs. A message describing the concurrent change already made recovers **82%** of runs — [arXiv 2609.25396](https://arxiv.org/abs/2609.25396)

### Inferences
- For an aiguilleur, the most frequent MAST failures (task spec not followed, step repetition, unknown termination conditions, reasoning-action mismatch) are mostly **orchestrator** responsibilities: precise briefs, explicit "done" criteria, loop detection.
- CooperBench and "Passes Alone" suggest that the real risk of parallel worktrees is **semantic**: overlapping work, divergent architectures, broken implicit dependencies. Git conflicts are a smaller part of it. On real, naturally independent tasks interference is rare. It explodes when tasks touch the same helpers. Partitioning tasks by disjoint area, and telling an agent which concurrent changes are already merged, are the levers backed by data.

### Gaps
- MAST per-framework failure rates exist only in a figure (Fig. 5) I could not read. The AG2 and topology-change interventions sit in the part of the text I did not read.
- The exact solo and cooperative success rates per model in CooperBench are in Figure 3, not in the text.

## 3. Scaling: when more agents help vs. hurt; coordination overhead; error amplification

### Takeaway
More agents help in two cases. The first is **independent sampling with voting**, more so on hard tasks and weak models. The second is **parallelizable, decomposable tasks**, with a centralized orchestrator that validates. They hurt on **sequential** tasks, on tool-heavy tasks, and once the single agent already exceeds **~45%**. A central orchestrator contains error amplification (**4.4×** vs **17.2×** for independent agents) but costs the most turns.

### Cited Findings
- **Kim et al., "Towards a Science of Scaling Agent Systems"** (arXiv:2512.08296) [PREPRINT]. **180 configurations**, 3 model families, 4 benchmarks (Finance-Agent, BrowseComp-Plus, PlanCraft, Workbench). Relative change vs a single agent ranges from **+80.8%** on decomposable financial reasoning to **−70.0%** on sequential planning — [arXiv 2512.08296](https://arxiv.org/abs/2512.08296)
  - **Error amplification**: Independent **17.2×**, Decentralized **7.8×**, Hybrid **5.1×**, **Centralized 4.4×**. Centralized validation "contains" errors — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
  - **Overhead**: Independent 58%, Decentralized 263%, **Centralized 285%**, Hybrid 515%. **Turns**: SAS 7.2, Independent 11.4, Decentralized 26.1, **Centralized 27.7**, Hybrid 44.3. **Efficiency Ec**: SAS 0.466, Independent 0.234, Decentralized 0.132, Centralized 0.120, Hybrid 0.074 — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
  - **Capability saturation**: β = −0.404 (p < 0.001). Returns are diminishing or negative once the single agent exceeds **~45%**. **Tool–coordination trade-off**: β = −0.267 (p < 0.001), so tool-heavy tasks suffer more from overhead — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
  - By benchmark: Finance-Agent Centralized **+80.8%**, Decentralized +74.5%, Hybrid +73.1%. BrowseComp-Plus Decentralized +9.2%, Centralized +0.2%, Independent ≈ −35%. **PlanCraft (sequential): every MAS degrades**, Centralized −50.3%, Independent −70.1%. Workbench Decentralized +5.7%, Centralized −1.2% — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
  - Quote: "coordination overhead becomes counterproductive when coordination complexity exceeds task complexity". The predictive model has cross-validated **R² = 0.524** and picks the best strategy in **87%** of held-out configurations — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
- **Li et al., "More Agents Is All You Need"** (Li, Zhang, Yu, Fu, Ye; arXiv:2402.05120) [PEER-REVIEWED: TMLR, per the abstract]. Sampling-and-voting ("Agent Forest"). The gain correlates with task difficulty — [arXiv 2402.05120](https://arxiv.org/abs/2402.05120)
  - A Llama2-13B ensemble reaches **0.59** on GSM8K vs **0.54** for a single Llama2-70B, matching it from ensemble size 15. A GPT-3.5 ensemble (N=40) vs a single GPT-4: GSM8K 0.85 vs 0.88; MATH 0.39 vs 0.40; **HumanEval 0.73 vs 0.88**; MMLU 0.70 vs 0.77 — [arXiv HTML 2402.05120](https://arxiv.org/html/2402.05120)
  - Relative gain is higher on hard tasks and weak models: Llama2-13B gains 69% on GSM8K vs **200%** on MATH; GPT-3.5 gains 16% vs 34%. Gains grow with the number of steps (16–48% at {I=100, K=4}) but **taper off** at very high inherent difficulty (I=400) — [arXiv HTML 2402.05120](https://arxiv.org/html/2402.05120)
- **MacNet** [PEER-REVIEWED: ICLR 2025]: a **logistic "collaborative scaling law"**. Performance grows and then saturates with the number of agents, and "collaborative emergence" appears earlier than neural emergence — [arXiv 2406.07155](https://arxiv.org/abs/2406.07155)
- **CooperBench**: on a shared codebase, success falls steadily with the number of agents (68.6% → 46.5% → 30.0% for 2 → 3 → 4) — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
- **Anthropic, "How we built our multi-agent research system"** (2025) [INDUSTRY, not peer-reviewed]. Opus 4 lead with Sonnet 4 subagents beats single-agent Opus 4 by **+90.2%** on an internal research eval. **Token usage explains ~80%** of the variance on BrowseComp. Agents use ~**4×** the tokens of a chat, and multi-agent systems ~**15×**. Parallelization cuts time by **up to 90%** on complex queries — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

### Inferences
- Read through Kim et al., the aiguilleur suits **decomposable** work (several independent features or bugs, each in its own worktree) and is a poor fit for splitting **one sequential task** across several agents. The central orchestrator is the topology that best contains error amplification, provided it actually **validates** results instead of relaying them.
- The ~45% threshold suggests that with very strong coding agents (Claude Code), the value of parallelism comes from **throughput** (several independent tasks at once), not from the quality of any single task.

### Gaps
- No study I found measures an orchestrator over parallel coding agents that work on **separate tasks**, each in its own worktree, against one agent doing them in sequence. CooperBench measures shared tasks, and Claim Plane reaches no conclusion on speedup.
- MacNet's exact numbers (which topologies, emergence threshold) are not in the abstract.

## 4. Single agent vs. multi-agent

### Takeaway
Several controlled studies find that a strong single agent with good prompts matches multi-agent discussion. The MAS advantage **shrinks as models improve**. MAS wins clearly only when the work parallelizes.

### Cited Findings
- **Wang et al., "Rethinking the Bounds of LLM Reasoning: Are Multi-Agent Discussions the Key?"** (Wang, Wang, Su, Tong, Song; arXiv:2402.18272, Feb 2024) [PREPRINT on the arXiv page; ACL 2024 not confirmed]. A single agent with strong prompts reaches "almost the same performance as the best existing discussion approach". Multi-agent discussion wins **only when the prompt contains no demonstrations** — [arXiv 2402.18272](https://arxiv.org/abs/2402.18272)
- **Gao et al., "Single-agent or Multi-agent Systems? Why Not Both?"** (Gao, Li, Liu, Yu, Wang, Lin, Lai; arXiv:2505.18286, May 2025) [PREPRINT]. The MAS advantage over a single agent **shrinks as LLM capabilities improve**. Their hybrid "request cascading" between SAS and MAS improves accuracy by **1.1–12%** and cuts deployment cost by **up to 20%** — [arXiv 2505.18286](https://arxiv.org/abs/2505.18286)
- **Kim et al.**: the single agent has the best efficiency (Ec **0.466** vs 0.120 for centralized). With a strong single-agent baseline (>~45%), coordination brings diminishing or negative returns — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
- **Huang et al.** (see §5): multi-agent debate **does not beat self-consistency** at an equal number of responses — [arXiv HTML 2310.01798v2](https://arxiv.org/html/2310.01798v2)
- **Anthropic** [INDUSTRY]: multi-agent fits poorly when "all agents share the same context", when there are many dependencies between agents, or when tasks have few parallelizable steps, "such as most coding work" — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

### Inferences
- What favors an aiguilleur architecture is **not** "several brains are better than one on a single problem". It is: (a) parallel throughput on independent tasks, (b) isolating contexts so each worker keeps a clean window, (c) a single conversation point for the user. The design should be justified on those grounds, not on reasoning quality.
- The Gao et al. cascade (single agent by default, multi-agent only when needed) is a defensible routing rule for an aiguilleur: send one agent by default, and parallelize only when the decomposition is clear.

### Gaps
- I did not get the detailed numbers from Wang et al. 2024 or Gao et al. 2025 (only the abstracts).

## 5. Verification and self-correction (LLM-as-judge, verifiers, debate, best-of-N with tests)

### Takeaway
**Without external feedback**, LLMs do not reliably self-correct, and can get worse. Debate amounts to consistency (voting), not correction. Verification only adds value when it relies on **external signals** (tests, execution, oracle) or a well-calibrated judge working from a rubric. For code, tests and execution are the natural verifier.

### Cited Findings
- **Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet"** (Huang, Chen, Mishra, Zheng, Yu, Song, Zhou; Google DeepMind; arXiv:2310.01798) [PEER-REVIEWED: ICLR 2024] — [arXiv 2310.01798](https://arxiv.org/abs/2310.01798)
  - **Intrinsic** self-correction (no labels): GPT-3.5 CommonSenseQA **75.8 → 38.1** (round 1) → 41.8 (round 2); GSM8K 75.9 → 75.1 → 74.7. GPT-4 GSM8K **95.5 → 91.5 → 89.0**; HotpotQA 49.0 → 49.0 → 43.0 — [arXiv HTML 2310.01798v2](https://arxiv.org/html/2310.01798v2)
  - With **oracle labels** the gains do appear (GPT-3.5 GSM8K 75.9 → 84.3; CSQA 75.8 → 89.7), but the paper argues the label tells the model when to stop, so this is not real self-correction — [arXiv HTML 2310.01798v2](https://arxiv.org/html/2310.01798v2)
  - **Debate vs self-consistency (GSM8K)**: with 6 responses, debate **83.2** vs self-consistency **85.3**; with 9 responses, **83.0 vs 88.2** (standard prompting 76.7) — [arXiv HTML 2310.01798v2](https://arxiv.org/html/2310.01798v2)
- **Du et al., "Improving Factuality and Reasoning in Language Models through Multiagent Debate"** (Du, Li, Torralba, Tenenbaum, Mordatch; arXiv:2305.14325, May 2023) [PREPRINT on the arXiv page; I did not confirm ICML 2024]. Several instances propose and debate over several rounds. The paper claims gains in reasoning and factuality — [arXiv 2305.14325](https://arxiv.org/abs/2305.14325)
- **MAST**: in ChatDev, a high-level verification step gives **+15.6%**. Still, "the presence of a verifier is not a silver bullet". Verification modes FM-3.2 and FM-3.3 together account for **17.3%** of failures — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- **MAST LLM-as-judge**: o1 few-shot reaches κ **0.77** against human annotators (vs κ 0.88 between humans) — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- **More Agents Is All You Need**: best-of-N by voting gives **+4 to +9 points** on HumanEval — [arXiv HTML 2402.05120](https://arxiv.org/html/2402.05120)
- **Anthropic** [INDUSTRY]: an LLM judge with **a single call and a rubric** (factual accuracy, citations, completeness, source quality, tool efficiency → 0.0–1.0 score plus pass/fail) is the most consistent with human judgment. Human testing still catches edge cases — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Magentic-One**: "insufficient-verification-steps" is the **2nd** most frequent error code — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)

### Inferences
- For an aiguilleur, verification should rest on **objective signals** produced in the worktree (tests, build, lint, screenshots) and not on the orchestrator re-reading and judging the code "intrinsically". Huang et al. predict that review without an external signal adds little and can hurt.
- When several agents tackle the **same** task, the empirically strongest selection is sampling plus selection by tests or votes. Debate between agents is not.

### Gaps
- I did not find in the papers read a figure for "best-of-N with test execution" on SWE-bench-type tasks. The coding gains above (HumanEval) come from majority voting.
- Du et al.'s exact numbers were not read (abstract only).

## 6. Communication and context: summary vs full context, relay-chain loss, structured messages, shared memory

### Takeaway
The data favor **structured, specific messages** (plan announced first, file paths, line numbers) and **artifacts written to disk and passed by reference** rather than re-summarized. Free-form chat between agents eats steps without improving success. Information placed in the middle of a long context is used poorly ("lost in the middle"). I found **no** peer-reviewed study that measures summary vs full context head to head in a handoff.

### Cited Findings
- **CooperBench**: communication between agents makes **no statistically significant** difference to cooperative success (average final merge 17.64 without vs 17.14 with). It reduces naive merge conflicts but takes **up to ~20%** of steps — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
- **CooperBench**: a **Plan message in the first turn** cuts the conflict rate from **51.5% to 29.4%**. Conflict-free trajectories have a Plan:Question ratio of **2.04** vs 1.31. Successful trajectories cite more **line numbers (32.6 vs 22.5)** and **file paths (13.1 vs 10.0)**. The authors read many questions as a symptom of trouble, not a cause of success — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
- **"Passes Alone, Fails Together"** [EXPRESS 2026 workshop]: a message describing the concurrent change already completed recovers **82%** of runs that suffered semantic interference — [arXiv 2609.25396](https://arxiv.org/abs/2609.25396)
- **MAST**: FM-1.4 loss of conversation history **2.8%**; FM-2.4 information withholding **0.85%**; FM-2.2 fail to ask for clarification **6.8%**; FM-2.3 task derailment **7.4%** — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)
- **Magentic-One**: workers' contexts are **reset at each plan update**, and the task ledger acts as structured shared memory held by the orchestrator — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
- **MetaGPT**: SOPs encoded as prompt sequences in a chain of roles. The abstract claims more coherent solutions than chat-based MAS — [arXiv 2308.00352](https://arxiv.org/abs/2308.00352)
- **Liu et al., "Lost in the Middle: How Language Models Use Long Contexts"** (Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang; arXiv:2307.03172) [PEER-REVIEWED: TACL]. Performance is best when the relevant information sits at the **start or end** of the context, and drops significantly when it sits **in the middle**, even for long-context models — [arXiv 2307.03172](https://arxiv.org/abs/2307.03172)
- **Anthropic** [INDUSTRY]: subagents write their results to a **filesystem or external store** and pass back **light references**, which avoids information loss (the "telephone game") and cuts tokens. Past 200k tokens of context, the lead agent saves its plan to memory. Each subagent needs an **objective, output format, guidance on tools and sources, and clear task boundaries**. Vague instructions led to duplicated work and gaps — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Microsoft training material [INDUSTRY, secondary]: re-summarizing in a chain loses critical details **by the third hop**. Guidance: pass the full history when possible and **cap chain depth** — [Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/aaai-apply-task-decomposition-multi-agent-azure/5-ensure-handoff-reliability-context-preservation)

### Inferences
- For an aiguilleur, this argues for a **single relay hop** (user → aiguilleur → agent) with: a structured, specific brief (goal, files concerned, done criteria, boundaries); results returned as **artifacts** (diff, branch, test report, screenshots) referenced by path instead of re-summarized; and, at dispatch time, a short notice of concurrent changes already merged that touch the same area.
- Direct chat between workers is not backed by the data (CooperBench). The hub-and-spoke model, where workers talk only to the orchestrator, plus artifacts in git, matches the evidence.

### Gaps
- No study read compares, with numbers, handoff by summary vs full context vs structured state. Statements on multi-hop loss come from industry sources.

## 7. Planning and decomposition (plan-and-execute, ADaPT, re-planning)

### Takeaway
Decomposing **as needed** (recursively, only when the executor fails) beats fixed upfront plans. Explicit re-planning triggered by stall detection is the mechanism that best separates Magentic-One from a plain group chat.

### Cited Findings
- **Prasad et al., "ADaPT: As-Needed Decomposition and Planning with Language Models"** (Prasad, Koller, Hartmann, Clark, Sabharwal, Bansal, Khot; arXiv:2311.05772) [PEER-REVIEWED: NAACL 2024 Findings]. Recursive decomposition only when the sub-task fails for the executor, adapting to task complexity and the executor's capability. Success **+28.3%** on ALFWorld, **+27%** on WebShop and **+33%** on TextCraft against strong baselines — [arXiv 2311.05772](https://arxiv.org/abs/2311.05772)
- **Magentic-One**: re-plan after **2** stalls, with a reflection step. Replacing the ledger orchestrator costs **−31%** — [arXiv HTML 2411.04468](https://arxiv.org/html/2411.04468)
- **Kim et al.**: on sequential tasks (PlanCraft), centralized decomposition **adds redundant steps** and every MAS degrades (Centralized −50.3%) — [arXiv HTML 2512.08296v2](https://arxiv.org/html/2512.08296v2)
- **Anthropic** [INDUSTRY]: explicit effort scaling rules in the prompt. Simple fact-finding gets 1 agent and 3–10 tool calls; comparisons get 2–4 subagents with 10–15 calls each; complex research gets >10 subagents. The first versions spawned **50 subagents** for simple queries — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **MAST**: FM-1.5 unaware of termination conditions is **12.4%** and FM-3.1 premature termination **6.2%**. Both point to "done" criteria left unspecified at decomposition time — [arXiv HTML 2503.13657](https://arxiv.org/html/2503.13657)

### Inferences
- An aiguilleur should decompose **coarsely** (one task = one agent = one worktree, with a dense brief) and let each Claude Code agent plan inside its task. It should re-plan only when an agent stalls or fails, following ADaPT. Splitting a sequential task across several agents goes against Kim et al.'s evidence.

### Gaps
- I did not find a study measuring how decomposition quality (task granularity) affects parallel coding success.

## 8. 2025–2026 work on orchestrating parallel coding agents and agentic software engineering

### Takeaway
The 2026 literature on parallel coding agents is young and mostly preprints or workshop papers. It converges on one point: worktree isolation solves textual conflicts, but not **semantic coordination**. Reliability gains so far mostly come from **serialization** of conflicting work, which cancels the parallelism.

### Cited Findings
- **Hassan et al., "Agentic Software Engineering: Foundational Pillars and a Research Roadmap"** (Hassan, Li, Lin, Adams, Chen, Kashiwa, Qiu; arXiv:2509.06216, Sep 2025, v4 Nov 2026) [PREPRINT, conceptual]. Proposes Structured Agentic SE (SASE) with two modalities, "SE for Humans" and "SE for Agents". Introduces the **Agent Command Environment (ACE)**, where humans direct agent teams and receive **Merge-Readiness Packs (MRPs)** and **Consultation Request Packs (CRPs)**, and the **Agent Execution Environment (AEE)**, where agents work and can call on a human when facing ambiguity or trade-offs — [arXiv 2509.06216](https://arxiv.org/abs/2509.06216)
- **CooperBench** (Jan 2026): see §2 and §6. Pooled retention **0.59** in cooperation, success **68.6 → 46.5 → 30.0%** for 2 → 3 → 4 agents, overlapping work **33.2%** and divergent architecture **29.7%** of failures — [arXiv HTML 2601.13295v2](https://arxiv.org/html/2601.13295v2)
- **Nikolaev, "Claim Plane: Reliability Gains and the Limits of Selective Concurrency for Parallel Coding Agents"** (arXiv:2608.00947, Aug 2026) [PREPRINT, single author]. 30 CooperBench pairs (15 conflicting, 15 clean), 3 seeds, 4 coordination arms, 360 runs. "Static" pre-write admission takes pair pass from **23.3% to 50.0%** (+26.7 pts, 95% CI 9.6–60.0) and integration success from **65.6% to 96.7%**. On conflicting pairs, pass goes **6.7% → 60.0%**. But **96.7%** of runs were serialized, **93.3%** of clean cases included. Dynamic admission blocked 46/90 runs for undeclared scope, with pass at 22.2%. **No useful wall-clock speedup** was shown — [arXiv 2608.00947](https://arxiv.org/abs/2608.00947)
- **"Passes Alone, Fails Together"** (Sep 2026, EXPRESS workshop): interference is rare on real independent PRs (**1/834** runs) and massive on tasks that touch the same helpers (**97%**). Informing an agent of the concurrent change recovers **82%** — [arXiv 2609.25396](https://arxiv.org/abs/2609.25396)
- Search results also surfaced, **unverified** (only titles or snippets read): "Effective Harness Engineering for Algorithm Discovery with Coding Agents" (arXiv:2605.15221; the snippet mentions 4 agents in parallel worktrees with a ~3.2–3.9× speedup); "Glite ARF: Verifier-Driven Research with Parallel LLM Coding Agents" (arXiv:2606.27416; worktree per task, verifier gates, merge rules); "EvoGit" (arXiv:2506.02049; decentralized, git-based collaboration with no central coordinator); "AgenticFlict" (arXiv:2604.03551; a dataset of merge conflicts in AI coding agent PRs). Check these before citing — [search: arXiv 2605.15221](https://arxiv.org/pdf/2605.15221); [arXiv 2606.27416](https://arxiv.org/pdf/2606.27416); [arXiv 2506.02049](https://arxiv.org/pdf/2506.02049)

### Inferences
- Hassan et al.'s ACE/AEE model (human ↔ command environment ↔ execution environments) is conceptually very close to "user ↔ aiguilleur ↔ Claude Code in worktrees". MRPs map onto the agent's final report (diff, tests, evidence), and CRPs onto permission requests and questions passed up to the user.
- The 2026 data suggest the aiguilleur's main lever is **assigning tasks with disjoint scope**. When overlap can't be avoided, it should serialize them or inform agents of changes already merged, since fine-grained admission control mostly comes down to serializing.

### Gaps
- I did not find the "SE 3.0" paper (AI-native software engineering) in this pass. I found no peer-reviewed evaluation of an LLM orchestrator conversing with the user and dispatching **independent** tasks to N coding agents in worktrees, with throughput and quality measured against one agent working sequentially.
- Papers 2605.15221, 2606.27416, 2506.02049 and 2604.03551 were not read and their numbers are not verified.
