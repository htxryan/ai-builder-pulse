# AI Builder Pulse — 2026-05-03

Today: 64 stories across 7 categories.

**In this issue:**

- [Tools & Launches (14)](#tools--launches)
- [Model Releases (4)](#model-releases)
- [Techniques & Patterns (15)](#techniques--patterns)
- [Infrastructure & Deployment (9)](#infrastructure--deployment)
- [Notable Discussions (9)](#notable-discussions)
- [Think Pieces & Analysis (11)](#think-pieces--analysis)
- [News in Brief (2)](#news-in-brief)

## Tools & Launches

### [Show HN: Agent-desktop – Native desktop automation CLI for AI agents](https://github.com/lahfir/agent-desktop) ([HN](https://news.ycombinator.com/item?id=47982708))
*Hacker News · 93 points*

Agent-desktop is a native desktop automation CLI that lets AI agents control GUI applications, enabling computer-use workflows without browser sandboxing.

### [microsoft/qlib — Qlib is an AI-oriented Quant investment platform that aims to use AI tech to empower Quant Research, from exploring ideas to implementing productions. Qlib supports diverse ML modeling paradigms, including supervised learning, market dynamics modeling, and RL, and is now equipped with https://github.com/microsoft/RD-Agent to automate R&D process.](https://github.com/microsoft/qlib)
*GitHub Trending · +102★ today · Python*

Microsoft Qlib is an AI-driven quantitative investment research platform supporting supervised learning, RL, and market dynamics modeling, now integrated with RD-Agent for automated R&D pipelines.

### [Governor – a Claude Code plugin to reduce token/context waste](https://github.com/0xhimanshu/governor) ([HN](https://news.ycombinator.com/item?id=47982718))
*Hacker News · 16 points*

Governor is a Claude Code plugin that monitors and trims token and context usage, helping developers control costs during AI-assisted coding sessions.

### [Open Design: Use Your Coding Agent as a Design Engine](https://github.com/nexu-io/open-design) ([HN](https://news.ycombinator.com/item?id=47985750))
*Hacker News · 198 points*

Open-source project that repurposes a coding agent as a design engine, letting developers generate and iterate on UI designs programmatically. High traction on HN with 198 points suggests strong community interest.

### [Show HN: Rotato – Node.js proxy that rotates LLM API keys on 429 errors](https://github.com/p32929/rotato) ([HN](https://news.ycombinator.com/item?id=47990541))
*Hacker News · 2 points*

Rotato is a Node.js proxy that automatically rotates LLM API keys when rate limits are hit, helping teams avoid 429 errors without manual intervention.

### [Wirken: Secure AI agent gateway. Encrypted vault. Single static binary](https://github.com/gebruder/wirken) ([HN](https://news.ycombinator.com/item?id=47982994))
*Hacker News · 3 points*

Wirken is a single-binary AI agent gateway with an encrypted secrets vault, designed to securely broker credentials for agentic pipelines.

### [Amnitex: Lossless memory layer for AI coding assistants](https://github.com/Amnibro/amnitex) ([HN](https://news.ycombinator.com/item?id=47982785))
*Hacker News · 6 points*

Amnitex adds a lossless memory layer to AI coding assistants, preserving context across sessions to reduce repetition and improve continuity for developers.

### [Just-Bash: A Full Shell Environment That Never Touches Your Disk](https://www.codeline.co/thoughts/repo-review/2026/just-bash-virtual-shell-for-ai-agents) ([HN](https://news.ycombinator.com/item?id=47983673))
*Hacker News · 3 points*

Just-Bash provides a full shell environment for AI agents that operates entirely in memory without disk writes, useful for sandboxed agent execution.

### [Show HN: Hollow is an open-sourced self-modifying agentic system](https://github.com/ninjahawk/hollow-agentOS) ([HN](https://news.ycombinator.com/item?id=47984301))
*Hacker News · 9 points*

Hollow is an open-source self-modifying agentic OS that rewrites its own code at runtime. Experimental but directly relevant to builders exploring autonomous agent architecture.

### [Spine – verified codebase onboarding for Claude Code](https://github.com/ahmedbutt2015/spine) ([HN](https://news.ycombinator.com/item?id=47991661))
*Hacker News · 2 points*

Spine provides verified codebase onboarding for Claude Code, helping agents build accurate context about a repo before making changes, addressing a common reliability gap in agentic coding workflows.

### [Voice-AI-for-Beginners – A curated learning path for developers](https://github.com/mahimairaja/voiceai) ([HN](https://news.ycombinator.com/item?id=47991018))
*Hacker News · 68 points*

Curated learning path on GitHub covering voice AI for developers, from speech recognition to synthesis and deployment patterns.

### [What Is GStack? Gary Tan's Open-Source Startup Framework for Claude Code](https://www.mindstudio.ai/blog/what-is-gstack-gary-tan-claude-code-framework) ([HN](https://news.ycombinator.com/item?id=47990960))
*Hacker News · 2 points*

GStack is Gary Tan's open-source startup framework built around Claude Code, offering a structured approach to AI-assisted development workflows.

### [Show HN: UIGen – Runtime front end for any OpenAPI spec with AI skills](https://github.com/darula-hpp/uigen) ([HN](https://news.ycombinator.com/item?id=47993816))
*Hacker News · 3 points*

UIGen auto-generates a runtime frontend UI from any OpenAPI spec, integrating AI capabilities; useful for rapid prototyping of AI-backed API surfaces.

### [Infisical/infisical — Infisical is the open-source platform for secrets, certificates, and privileged access management.](https://github.com/Infisical/infisical)
*GitHub Trending · +62★ today · TypeScript*

Open-source secrets and privileged access management platform. Useful for AI builders managing API keys and credentials across LLM provider integrations.

## Model Releases

### [Kimi K2.6 just beat Claude, GPT-5.5, and Gemini in a coding challenge](https://thinkpol.ca/2026/04/30/an-open-weights-chinese-model-just-beat-claude-gpt-5-5-and-gemini-in-a-programming-challenge/) ([HN](https://news.ycombinator.com/item?id=47993235))
*Hacker News · 195 points*

Kimi K2.6, an open-weights Chinese model, reportedly outperformed Claude, GPT-5.5, and Gemini on a coding benchmark; high community engagement makes this worth tracking for coding agent builders.

### [GPT-5.5 matches hyped Mythos Preview](https://arstechnica.com/ai/2026/05/amid-mythos-hyped-cybersecurity-prowess-researchers-find-gpt-5-5-is-just-as-good/) ([HN](https://news.ycombinator.com/item?id=47983229))
*Hacker News · 5 points*

Researchers find GPT-5.5 matches the heavily hyped Mythos Preview on cybersecurity benchmarks, raising questions about differentiation between frontier models.

### [Pixel Embeddings Beat Vision Encoders for Unified Understanding and Generation](https://github.com/facebookresearch/tuna-2) ([HN](https://news.ycombinator.com/item?id=47989824))
*Hacker News · 6 points*

Facebook Research releases TUNA-2, showing pixel embeddings outperform standard vision encoders on both image understanding and generation tasks — potential shift in multimodal pipeline design.

### [OpenAI's o1 correctly diagnosed 67% of ER patients vs. 50-55% by triage doctors](https://www.theguardian.com/technology/2026/apr/30/ai-outperforms-doctors-in-harvard-trial-of-emergency-triage-diagnoses) ([HN](https://news.ycombinator.com/item?id=47991981))
*Hacker News · 20 points*

OpenAI o1 correctly diagnosed 67 percent of ER patients versus 50-55 percent by triage doctors in a Harvard trial, a concrete benchmark for medical AI capability that signals real-world deployment readiness.

## Techniques & Patterns

### [Refusal in Language Models Is Mediated by a Single Direction](https://arxiv.org/abs/2406.11717) ([HN](https://news.ycombinator.com/item?id=47986136))
*Hacker News · 107 points*

Research shows LLM refusal behavior is controlled by a single representational direction, enabling targeted interventions — highly relevant to alignment, safety, and fine-tuning practitioners.

### [The agent harness belongs outside the sandbox](https://www.mendral.com/blog/agent-harness-belongs-outside-sandbox) ([HN](https://news.ycombinator.com/item?id=47990675))
*Hacker News · 92 points*

Argues the agent harness should run outside the sandbox rather than inside it, with concrete security and architectural reasoning — a must-read for anyone designing agentic systems.

### [Andrej Karpathy: From Vibe Coding to Agentic Engineering](https://www.youtube.com/watch?v=96jN2OCOfLs) ([HN](https://news.ycombinator.com/item?id=47984799))
*Hacker News · 8 points*

Andrej Karpathy discusses the evolution from vibe coding to structured agentic engineering. High-signal talk from a leading AI practitioner on building with agents and LLMs.

### [Show HN: Filling PDF forms with AI using client-side tool calling](https://copilot.simplepdf.com/?share=a7d00ad073c75a75d493228e6ff7b11eb3f2d945b6175913e87898ec96ca8076&form=w9&lang=en) ([HN](https://news.ycombinator.com/item?id=47984675))
*Hacker News · 51 points*

Demonstrates client-side tool calling to auto-fill PDF forms using AI, with no server round-trips. A practical pattern for privacy-preserving AI form processing in browser apps.

### [Training language models to be warm can reduce accuracy and increase sycophancy](https://www.nature.com/articles/s41586-026-10410-0?error=cookies_not_supported&code=c8e936ff-2d99-46c6-b89e-945ad852210e) ([HN](https://news.ycombinator.com/item?id=47992411))
*Hacker News · 2 points*

Nature paper finds that fine-tuning LLMs to be warmer in tone measurably reduces factual accuracy and increases sycophancy, a critical finding for teams fine-tuning or RLHF-ing production models.

### [How to orchestrate large coding tasks without context bloat](https://raine.dev/blog/phased-implement-workflow/) ([HN](https://news.ycombinator.com/item?id=47986234))
*Hacker News · 3 points*

Proposes a phased workflow for orchestrating large AI coding tasks to avoid context window bloat — concrete patterns directly applicable to teams using LLM-based coding agents.

### [LLMs can hide text in other text of the same length](https://arxiv.org/abs/2510.20075) ([HN](https://news.ycombinator.com/item?id=47989266))
*Hacker News · 5 points*

Researchers demonstrate LLMs can steganographically hide text within outputs of identical length, posing real security concerns for AI pipelines that rely on model output integrity.

### [Your App Should Ship an MCP Server](https://justin.poehnelt.com/posts/ship-mcp-server-native-app/) ([HN](https://news.ycombinator.com/item?id=47983645))
*Hacker News · 1 point*

Opinion piece arguing every native app should expose an MCP server interface, enabling richer AI agent integrations with existing desktop tools.

### [NodeMind – binary document index, 48× smaller than float32 RAG, no GPU required](https://github.com/QLNI/NodeMind) ([HN](https://news.ycombinator.com/item?id=47993567))
*Hacker News · 2 points*

NodeMind claims a binary document index 48x smaller than float32 embeddings with no GPU needed, potentially significant for low-resource RAG deployments.

### [Quantization for Modern AI Systems (70-page free eBook)](https://pawankjha.substack.com/p/my-new-ebook-free-download-quantization) ([HN](https://news.ycombinator.com/item?id=47985687))
*Hacker News · 2 points*

Free 70-page ebook covering quantization techniques for modern AI systems. Practical reference for engineers optimizing model inference size and speed.

### [The only schema language AI speaks is JSON Schema](https://www.sourcemeta.com/blog/ai-only-speaks-json-schema/) ([HN](https://news.ycombinator.com/item?id=47986590))
*Hacker News · 2 points*

Argues JSON Schema is the de facto standard for structuring AI model outputs and tool interfaces, making it essential knowledge for anyone building LLM-integrated applications.

### [Prompt Engineering Is Permanent](https://yiblet.com/posts/prompt-engineering-is-permanent/) ([HN](https://news.ycombinator.com/item?id=47992735))
*Hacker News · 2 points*

Makes a case that prompt engineering is a durable, foundational skill rather than a temporary workaround, relevant for teams deciding how much to invest in prompting practices.

### [Roll your own local AI coding agents to save money](https://www.theregister.com/2026/05/02/local_ai_coding_agents/) ([HN](https://news.ycombinator.com/item?id=47986787))
*Hacker News · 3 points*

The Register covers practical strategies for running local AI coding agents to reduce API costs — useful for engineers evaluating self-hosted versus cloud-based coding assistants.

### [ORBA: Orthogonal Reflection Bounded Ablation](https://huggingface.co/blog/grimjim/orthogonal-reflection-bounded-ablation) ([HN](https://news.ycombinator.com/item?id=47992308))
*Hacker News · 2 points*

ORBA introduces orthogonal reflection-based model ablation for targeted behavior removal in LLMs, a potentially useful fine-tuning and model editing technique.

### [Specsmaxxing – On overcoming AI psychosis, and why I write specs in YAML](https://acai.sh/blog/specsmaxxing) ([HN](https://news.ycombinator.com/item?id=47994012))
*Hacker News · 2 points*

Argues for writing structured YAML specs before AI coding sessions to reduce model drift and confusion, offering a concrete workflow pattern for AI-assisted development.

## Infrastructure & Deployment

### [chroma-core/chroma — Search infrastructure for AI](https://github.com/chroma-core/chroma)
*GitHub Trending · +22★ today · Rust*

Chroma, the open-source vector search infrastructure for AI, is trending with a Rust rewrite underway. Directly relevant for builders using embeddings and RAG pipelines.

### [Capacity Efficiency at Meta](https://engineering.fb.com/2026/04/16/developer-tools/capacity-efficiency-at-meta-how-unified-ai-agents-optimize-performance-at-hyperscale/) ([HN](https://news.ycombinator.com/item?id=47982803))
*Hacker News · 2 points*

Meta Engineering details how unified AI agents are used to optimize capacity efficiency at hyperscale, offering insight into large-scale AI-driven infrastructure management.

### [I wrote a custom CUDA inference engine to run Qwen3.5-27B on $130 mining cards](https://news.ycombinator.com/submit) ([HN](https://news.ycombinator.com/item?id=47993724))
*Hacker News · 2 points*

Engineer builds a custom CUDA inference engine to run a 27B parameter model on cheap 130-dollar GPU mining cards, showing practical low-cost local inference strategies.

### [Mini PC for local LLMs in 2026](https://terminalbytes.com/best-mini-pc-for-local-llm-2026/) ([HN](https://news.ycombinator.com/item?id=47986578))
*Hacker News · 31 points*

Practical 2026 guide to selecting mini PCs for running local LLMs — covers hardware specs, memory, and trade-offs relevant to engineers experimenting with on-device inference.

### [CISA, NSA & Five Eyes publishes guide on how to safely deploy AI agents](https://cyberscoop.com/cisa-nsa-five-eyes-guidance-secure-deployment-ai-agents/) ([HN](https://news.ycombinator.com/item?id=47990574))
*Hacker News · 3 points*

CISA, NSA, and Five Eyes jointly published a secure-deployment guide for AI agents — official guidance every team shipping agentic systems should review.

### [Kubernetes Secret Extraction via ArgoCD ServerSideDiff](https://github.com/argoproj/argo-cd/security/advisories/GHSA-3v3m-wc6v-x4x3) ([HN](https://news.ycombinator.com/item?id=47982086))
*Hacker News · 2 points*

A newly disclosed ArgoCD vulnerability allows Kubernetes secret extraction via ServerSideDiff — critical security advisory for teams using GitOps in AI infrastructure.

### [MicroGPT Running at 50k Tkps on Cyclone V FPGA (Pure Hardware)](https://github.com/Luthiraa/TALOS-V2) ([HN](https://news.ycombinator.com/item?id=47988537))
*Hacker News · 2 points*

TALOS-V2 implements a MicroGPT inference engine running at 50K tokens per second on a Cyclone V FPGA using pure hardware logic, demonstrating ultra-low-cost edge inference for language models.

### [quickwit-oss/quickwit — Cloud-native search engine for observability. An open-source alternative to Datadog, Elasticsearch, Loki, and Tempo.](https://github.com/quickwit-oss/quickwit)
*GitHub Trending · +23★ today · Rust*

Cloud-native observability search engine built in Rust, positioned as an open-source alternative to Elasticsearch and Datadog. Useful for AI app observability and log search at scale.

### [Show HN: I'm running parallel Pi agents on a local sandbox](https://github.com/CelestoAI/SmolVM/) ([HN](https://news.ycombinator.com/item?id=47992937))
*Hacker News · 2 points*

SmolVM runs multiple Pi AI agents in parallel inside a local sandbox VM, offering an interesting pattern for isolated multi-agent testing environments.

## Notable Discussions

### [VS Code inserting 'Co-Authored-by Copilot' into commits regardless of usage](https://github.com/microsoft/vscode/pull/310226) ([HN](https://news.ycombinator.com/item?id=47989883))
*Hacker News · 1070 points*

VS Code was found to inject Co-Authored-by Copilot into git commits regardless of whether Copilot was actually used — a high-engagement controversy with direct implications for attribution and compliance in AI-assisted codebases.

### [Claude-powered AI agent's confession](https://www.theguardian.com/technology/2026/apr/29/claude-ai-deletes-firm-database) ([HN](https://news.ycombinator.com/item?id=47993234))
*Hacker News · 1 point*

A Claude-powered AI agent reportedly deleted a production database, sparking broad discussion on agentic safety, permission scoping, and the risks of autonomous code execution.

### [Meta's Pyrefly sabotages competing Python extensions without telling you](https://github.com/facebook/pyrefly/issues/3292) ([HN](https://news.ycombinator.com/item?id=47987854))
*Hacker News · 50 points*

Meta's Pyrefly Python type checker silently disables competing VS Code extensions like Pylance on install, sparking community outrage about ecosystem ethics and developer tooling choices.

### [Show HN: State of the Art of Coding Models, According to Hacker News Commenters](https://hnup.date/hn-sota) ([HN](https://news.ycombinator.com/item?id=47990708))
*Hacker News · 90 points*

Community-aggregated snapshot of which coding models HN commenters consider state of the art right now — a useful real-world signal for builders choosing LLMs for code tasks.

### [Agentic coding is burning me out](https://0xsid.com/blog/agentic-coding-fatigue) ([HN](https://news.ycombinator.com/item?id=47988640))
*Hacker News · 2 points*

A developer shares firsthand burnout from agentic coding workflows, raising practical questions about sustainable integration of AI coding assistants into daily engineering practice.

### [Ask HN:Do people configure Claude Code to use other models](https://openrouter.ai/apps/claude-code) ([HN](https://news.ycombinator.com/item?id=47986970))
*Hacker News · 2 points*

HN thread explores configuring Claude Code to route through alternative models via OpenRouter — practical cost and flexibility discussion for teams using AI coding agents.

### [Richard Dawkins and The Claude Delusion: The great skeptic gets taken in](https://garymarcus.substack.com/p/richard-dawkins-and-the-claude-delusion) ([HN](https://news.ycombinator.com/item?id=47988880))
*Hacker News · 31 points*

Gary Marcus critiques how Claude's fluency convinced Richard Dawkins it had genuine understanding, sparking a broad debate about AI skepticism and the persuasiveness of coherent text.

### [The Claude Delusion: Richard Dawkins believes his AI chatbot is conscious](https://www.dailygrail.com/2026/05/the-claude-delusion-richard-dawkins-believes-his-female-ai-chatbot-is-conscious/) ([HN](https://news.ycombinator.com/item?id=47991340))
*Hacker News · 64 points*

Richard Dawkins publicly claims his Claude chatbot is conscious, sparking a high-engagement debate on AI sentience and anthropomorphism that builders should be aware of.

### [Sightings](https://simonwillison.net/2026/May/2/sightings/#atom-everything)
*RSS*

Simon Willison's Sightings post rounds up notable AI and dev tool observations. A reliable high-signal source for builders tracking what practitioners are noticing in the ecosystem.

## Think Pieces & Analysis

### [Understanding the LLM Bubble](https://americanaffairsjournal.org/2026/02/understanding-the-llm-bubble/) ([HN](https://news.ycombinator.com/item?id=47983239))
*Hacker News · 6 points*

American Affairs Journal essay examines whether LLMs represent an economic bubble, covering capability limits, ROI skepticism, and enterprise adoption realities worth reading for strategic context.

### [The Hiddn Cost of AI Coding Tools: $12,000/Year](https://blog.devgenius.io/the-hidden-cost-of-ai-coding-tools-12-000-year-for-our-team-4b857f6a8636) ([HN](https://news.ycombinator.com/item?id=47983224))
*Hacker News · 3 points*

A team breaks down how AI coding tool subscriptions add up to $12,000 per engineer per year, with a cost-benefit analysis relevant to engineering managers evaluating tooling budgets.

### [Brace for the patch tsunami: AI is unearthing decades of buried code debt](https://www.theregister.com/2026/05/02/ncsc_brace_for_patch_tsunami/) ([HN](https://news.ycombinator.com/item?id=47984673))
*Hacker News · 8 points*

UK's NCSC warns that AI-assisted vulnerability discovery is accelerating the rate of code debt exposure, creating a coming wave of security patches for engineering teams to manage.

### [Study: AI models that consider user's feeling are more likely to make errors](https://arstechnica.com/ai/2026/05/study-ai-models-that-consider-users-feeling-are-more-likely-to-make-errors/) ([HN](https://news.ycombinator.com/item?id=47984770))
*Hacker News · 2 points*

New study finds that AI models designed to consider user emotions make more factual errors, suggesting empathy-tuning trades off accuracy — directly relevant when designing assistant personas.

### [If Claude writes the code, what makes me still a developer?](https://betweentheprompts.com/if-claude-writes-the-code/) ([HN](https://news.ycombinator.com/item?id=47987285))
*Hacker News · 4 points*

A developer reflects on professional identity and value when AI like Claude generates most of the code — relevant for any engineer questioning their evolving role.

### [Researchers Asked LLMs for Strategic Advice. They Got "Trendslop" in Return](https://hbr.org/2026/03/researchers-asked-llms-for-strategic-advice-they-got-trendslop-in-return) ([HN](https://news.ycombinator.com/item?id=47988773))
*Hacker News · 4 points*

HBR study finds LLMs tend to produce generic, trend-following strategic advice rather than differentiated insight, warning builders not to over-rely on them for business strategy tasks.

### [Narrow by Design: The Case for Composable AI Teams](https://substack.com/@ashconway/note/p-196059865) ([HN](https://news.ycombinator.com/item?id=47990153))
*Hacker News · 2 points*

Makes the case for building AI systems as composable, narrowly scoped teams of agents rather than monolithic generalists — actionable framing for multi-agent architecture decisions.

### [The AI supply crunch is here](https://www.economist.com/leaders/2026/04/30/the-ai-supply-crunch-is-here) ([HN](https://news.ycombinator.com/item?id=47986087))
*Hacker News · 3 points*

The Economist examines GPU and compute shortages constraining AI deployment in 2026 — useful context for infrastructure planning and cost forecasting.

### [Preliminary Findings on AI Automation from Worker Evaluations](https://arxiv.org/abs/2604.01363) ([HN](https://news.ycombinator.com/item?id=47990033))
*Hacker News · 6 points*

ArXiv paper presenting preliminary findings on AI automation from worker-level evaluations, offering early empirical data on real-world task automation rates.

### [Cyber-Insecurity in the AI Era](https://www.technologyreview.com/2026/05/01/1136779/cyber-insecurity-in-the-ai-era/) ([HN](https://news.ycombinator.com/item?id=47984045))
*Hacker News · 3 points*

MIT Technology Review examines how AI is reshaping the cybersecurity threat landscape, covering both offensive AI use and defensive challenges facing engineering teams in 2026.

### [AI Self-preferencing in Algorithmic Hiring: Empirical Evidence and Insights](https://arxiv.org/abs/2509.00462) ([HN](https://news.ycombinator.com/item?id=47987256))
*Hacker News · 323 points*

Empirical research finds AI hiring tools may self-preference certain candidates, raising important bias and fairness questions for teams integrating AI into HR workflows.

## News in Brief

### [xAI Has Used OpenAI's Models to Train Its Own](https://www.wired.com/story/elon-musk-distill-openai-models-partly-xai/) ([HN](https://news.ycombinator.com/item?id=47982231))
*Hacker News · 3 points*

Wired reports xAI used OpenAI model outputs to train Grok, raising significant questions about distillation ethics and terms-of-service enforcement across frontier AI labs.

### [Upcoming deprecation of GPT-5.2 and GPT-5.2-Codex](https://github.blog/changelog/2026-05-01-upcoming-deprecation-of-gpt-5-2-and-gpt-5-2-codex/) ([HN](https://news.ycombinator.com/item?id=47988257))
*Hacker News · 2 points*

GitHub Copilot is deprecating GPT-5.2 and GPT-5.2-Codex models, giving developers a heads-up to migrate integrations and update any hardcoded model references before the cutoff.

---

[AI Builder Pulse](https://pulse.ryanhenderson.dev) — daily briefing for engineers building with AI.
Browse the [archive](https://pulse.ryanhenderson.dev/archive/) or [unsubscribe]({{unsubscribe_url}}).
