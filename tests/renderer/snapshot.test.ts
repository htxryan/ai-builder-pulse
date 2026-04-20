// Golden-file snapshot for the daily renderer. The fixture exercises the
// full craft surface: TOC (≥10 items), Top Pick (≥0.85), metadata badges
// for HN/GitHub/Reddit/RSS, bracket-escaping, and multi-category ordering.
//
// Regenerating: run `pnpm test -- -u` (vitest `--update`) after intentional
// renderer changes, then hand-review `fixtures/rendered/sample-daily.md`
// in the PR. The file is checked in so reviewers see subscriber-facing
// output change without running the suite.

import { describe, it, expect } from "vitest";
import { renderIssue } from "../../src/renderer/index.js";
import type { ScoredItem } from "../../src/types.js";

const FIXTURE: ScoredItem[] = [
  {
    id: "hn-top",
    source: "hn",
    title: "LangGraph 0.3 ships durable agent state",
    url: "https://example.com/langgraph-0-3",
    score: 450,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 452, numComments: 187 },
    category: "Tools & Launches",
    relevanceScore: 0.94,
    keep: true,
    description:
      "LangGraph 0.3 introduces durable checkpointing so long-running agent workflows survive process restarts. Includes a new Postgres-backed state store.",
  },
  {
    id: "hn-tool-2",
    source: "hn",
    title: "A tiny CLI for testing Claude prompts locally",
    url: "https://example.com/claude-cli",
    score: 210,
    publishedAt: "2026-04-18T04:00:00.000Z",
    metadata: { source: "hn", points: 214 },
    category: "Tools & Launches",
    relevanceScore: 0.82,
    keep: true,
    description:
      "Stream a prompt through multiple Claude models with a single command. Outputs JSON diffs for regression tracking.",
  },
  {
    id: "gh-trending-1",
    source: "github-trending",
    title: "acme/rag-lab — experiment harness for retrieval pipelines",
    url: "https://github.com/acme/rag-lab",
    score: 412,
    publishedAt: "2026-04-18T03:00:00.000Z",
    metadata: {
      source: "github-trending",
      repoFullName: "acme/rag-lab",
      stars: 4810,
      starsToday: 412,
      language: "Python",
    },
    category: "Tools & Launches",
    relevanceScore: 0.78,
    keep: true,
    description:
      "Reproducible retrieval pipeline benchmarking with pluggable retrievers and rerankers. Ships evaluation harness on MTEB and BEIR.",
  },
  {
    id: "model-claude-4-8",
    source: "hn",
    title: "Claude 4.8 preview with extended reasoning mode",
    url: "https://example.com/claude-4-8",
    score: 600,
    publishedAt: "2026-04-18T02:00:00.000Z",
    metadata: { source: "hn", points: 602 },
    category: "Model Releases",
    relevanceScore: 0.89,
    keep: true,
    description:
      "Anthropic previews Claude 4.8 with a new 'extended reasoning' mode that allocates a separate thinking budget per tool call.",
  },
  {
    id: "model-local-1",
    source: "reddit",
    title: "Qwen 3 14B quantized variants benchmarked",
    url: "https://example.com/qwen3-bench",
    score: 891,
    publishedAt: "2026-04-18T01:30:00.000Z",
    metadata: {
      source: "reddit",
      subreddit: "LocalLLaMA",
      upvotes: 891,
      numComments: 142,
    },
    category: "Model Releases",
    relevanceScore: 0.76,
    keep: true,
    description:
      "Community benchmarks for Q4_K_M and Q5_K_M quantizations against GPT-4o on coding tasks. 14B Q5 reaches 62% HumanEval.",
  },
  {
    id: "tech-pattern-1",
    source: "rss",
    title: "Building a faithful structured-output chain",
    url: "https://simonwillison.net/2026/Apr/18/structured-chains/",
    score: 1,
    publishedAt: "2026-04-18T00:30:00.000Z",
    metadata: {
      source: "rss",
      feedUrl: "https://simonwillison.net/atom/everything/",
      author: "Simon Willison",
    },
    category: "Techniques & Patterns",
    relevanceScore: 0.74,
    keep: true,
    description:
      "A walkthrough of validating intermediate JSON steps, short-circuiting on schema errors, and handling the 'partial refusal' case.",
  },
  {
    id: "tech-pattern-2",
    source: "hn",
    title: "Evaluating agents with rubric-based grading [paper]",
    url: "https://example.com/rubric-eval",
    score: 180,
    publishedAt: "2026-04-18T00:20:00.000Z",
    metadata: { source: "hn", points: 180 },
    category: "Techniques & Patterns",
    relevanceScore: 0.65,
    keep: true,
    description:
      "Paper proposes a rubric-first evaluation loop that separates task success from style adherence. Open-sources the rubric dataset.",
  },
  {
    id: "infra-1",
    source: "github-trending",
    title: "vllm-project/vllm — high-throughput LLM inference",
    url: "https://github.com/vllm-project/vllm",
    score: 96,
    publishedAt: "2026-04-18T00:10:00.000Z",
    metadata: {
      source: "github-trending",
      repoFullName: "vllm-project/vllm",
      stars: 38210,
      starsToday: 96,
      language: "Python",
    },
    category: "Infrastructure & Deployment",
    relevanceScore: 0.71,
    keep: true,
    description:
      "PagedAttention-based serving library hits a new throughput record on H100 for Llama 3 70B, per maintainers' benchmarks.",
  },
  {
    id: "disc-1",
    source: "reddit",
    title: "Why does every agent framework reinvent tool calling?",
    url: "https://example.com/reddit-tool-calling",
    score: 412,
    publishedAt: "2026-04-17T23:00:00.000Z",
    metadata: {
      source: "reddit",
      subreddit: "r/MachineLearning",
      upvotes: 412,
    },
    category: "Notable Discussions",
    relevanceScore: 0.58,
    keep: true,
    description:
      "Long thread comparing tool-call interfaces across LangChain, LlamaIndex, CrewAI, and direct SDK usage. Consensus leans direct.",
  },
  {
    id: "analysis-1",
    source: "rss",
    title: "The agent reliability plateau",
    url: "https://example.com/agent-reliability",
    score: 1,
    publishedAt: "2026-04-17T22:00:00.000Z",
    metadata: {
      source: "rss",
      feedUrl: "https://example.com/blog/atom.xml",
      author: "Jane Doe",
    },
    category: "Think Pieces & Analysis",
    relevanceScore: 0.67,
    keep: true,
    description:
      "Essay argues that agent reliability has plateaued not from model ceilings but from undersupplied eval investment.",
  },
  {
    id: "news-1",
    source: "hn",
    title: "OpenAI and Anthropic partner on safety eval standards",
    url: "https://example.com/safety-standards",
    score: 300,
    publishedAt: "2026-04-17T21:00:00.000Z",
    metadata: { source: "hn", points: 302 },
    category: "News in Brief",
    relevanceScore: 0.55,
    keep: true,
    description:
      "Short joint statement outlines common reporting format for dangerous-capability evals across frontier labs.",
  },
  {
    id: "news-2",
    source: "rss",
    title: "EU AI Act second implementing act draft released",
    url: "https://example.com/eu-ai-act",
    score: 1,
    publishedAt: "2026-04-17T20:00:00.000Z",
    metadata: {
      source: "rss",
      feedUrl: "https://example.com/policy/atom.xml",
    },
    category: "News in Brief",
    relevanceScore: 0.5,
    keep: true,
    description:
      "Commission released draft 2 of the implementing act for general-purpose AI obligations. Public comment window closes in 30 days.",
  },
];

describe("renderIssue golden snapshot", () => {
  it("matches fixtures/rendered/sample-daily.md byte-for-byte", async () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    await expect(r.body).toMatchFileSnapshot(
      "../../fixtures/rendered/sample-daily.md",
    );
  });

  it("TOC is present (≥10 items) and lists every non-empty category with count", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    expect(r.body).toContain("**In this issue:**");
    expect(r.body).toContain("[Tools & Launches (3)](#tools--launches)");
    expect(r.body).toContain("[Model Releases (2)](#model-releases)");
    expect(r.body).toContain(
      "[Techniques & Patterns (2)](#techniques--patterns)",
    );
  });

  it("Top Pick block renders above category sections when max score ≥ 0.85", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    const topPickIdx = r.body.indexOf("## Today's Top Pick");
    const toolsIdx = r.body.indexOf("## Tools & Launches");
    expect(topPickIdx).toBeGreaterThan(-1);
    expect(topPickIdx).toBeLessThan(toolsIdx);
  });

  it("Top Pick item also appears inside its own category below (not moved)", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    // 3 occurrences: intro preview line, Top Pick block, category entry.
    const matches = r.body.match(/LangGraph 0\.3 ships durable agent state/g);
    expect(matches?.length).toBe(3);
  });

  it("intro line names the top pick for Gmail preview text", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    expect(r.body).toContain(
      'top pick, "LangGraph 0.3 ships durable agent state"',
    );
  });

  it("metadata badges render for HN/GitHub/Reddit/RSS", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    expect(r.body).toContain("*Hacker News · 452 points*");
    expect(r.body).toContain("*GitHub Trending · +412★ today · Python*");
    expect(r.body).toContain("*r/LocalLLaMA · 891 upvotes*");
    expect(r.body).toContain("*RSS*");
  });

  it("body stays under 50KB for a typical 12-item issue", () => {
    const r = renderIssue("2026-04-18", FIXTURE);
    expect(r.body.length).toBeLessThan(50_000);
  });
});

describe("renderIssue (small issue — no TOC, no top pick)", () => {
  it("omits TOC when fewer than 10 items", () => {
    const small = FIXTURE.slice(0, 3);
    const r = renderIssue("2026-04-18", small);
    expect(r.body).not.toContain("**In this issue:**");
  });

  it("omits Top Pick block when max score < 0.85", () => {
    // Clone and cap every score under threshold.
    const capped = FIXTURE.slice(0, 3).map((it) => ({
      ...it,
      relevanceScore: 0.6,
    }));
    const r = renderIssue("2026-04-18", capped);
    expect(r.body).not.toContain("## Today's Top Pick");
    // Intro should not mention "top pick" either.
    expect(r.body).not.toContain("top pick");
  });
});
