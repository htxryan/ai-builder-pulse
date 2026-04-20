# AI Builder Pulse

## What This Is

A fully automated daily newsletter for software engineers building AI-powered tools and workflows. Scans Hacker News, Twitter/X, GitHub Trending, Reddit, and key AI blogs every day, uses Claude API to filter and curate for builder relevance, and publishes directly to Buttondown with zero human intervention. Daily issues are committed to the repo as files, and a weekly digest rolls up the best items.

## Core Value

Practitioners building with AI get a comprehensive, trustworthy daily briefing of everything relevant — tools, models, techniques, infrastructure — without having to scan dozens of sources themselves.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Automated daily scan of HN (300-500 stories via API)
- [ ] Automated daily scan of Twitter/X for AI builder content
- [ ] Automated daily scan of GitHub Trending AI repos
- [ ] Automated daily scan of Reddit AI communities (r/LocalLLaMA, r/MachineLearning, etc.)
- [ ] Automated daily scan of key AI blogs/RSS feeds (Simon Willison, etc.)
- [ ] Arxiv scanning for practically relevant papers (deprioritized — builder focus, not research focus)
- [ ] Claude API integration for filtering, relevance scoring, and curation
- [ ] Structured output with categories: Tools & Launches, Model Releases, Techniques & Patterns, Infrastructure & Deployment, Notable Discussions, Think Pieces & Analysis, News in Brief
- [ ] Link verification — no fabricated links, no bare domains, no duplicate HN IDs, no GitHub user-profile links
- [ ] Freshness enforcement — only content from last 24 hours
- [ ] 20-40+ items per daily issue (err on side of inclusion)
- [ ] 1-2 sentence descriptions per item (brevity)
- [ ] Buttondown API integration for automated publishing
- [ ] GitHub Actions workflow for daily scheduled runs
- [ ] Daily issues committed to repo as markdown/JSON files
- [ ] Weekly best-of digest auto-generated from daily issue files
- [ ] Weekly digest published to Buttondown on a separate schedule

### Out of Scope

- Substack integration — no public API, switched to Buttondown
- Human editorial review — fully automated pipeline
- Subscriber growth tools — focus on content automation first
- Paid tier / monetization — not for v1
- Mobile app — web/email only
- AI researcher-focused content (academic papers, pure theory) — audience is builders
- Custom web frontend — Buttondown handles the reader experience

## Context

- The user has been running a version of this manually using a Claude prompt with Chrome browser tools and Gmail drafts
- The manual prompt scans HN comprehensively, extracts story data from the DOM, filters for AI builder relevance, and outputs an HTML email
- Moving to GitHub Actions means the data gathering approach must shift from Chrome browser automation to API-based scraping (HN Firebase API, GitHub API, Reddit API, RSS parsing)
- Claude API will replace the interactive Claude conversation for AI-powered curation
- Buttondown is markdown-native, which simplifies formatting
- The original prompt has strict link verification rules that should carry over to the automated pipeline
- Target audience: practitioners who care about new tools/libraries, emerging patterns, technical blog posts, architecture approaches, dev experience insights, open-source releases, model releases, infrastructure, benchmarks, developer tools

## Constraints

- **Platform**: Buttondown — chosen for its publish API and markdown-native support
- **Runtime**: GitHub Actions — cron-scheduled, no persistent server
- **AI**: Claude API — for content filtering, relevance scoring, and formatting
- **Data**: Must use APIs and RSS, not browser automation (GitHub Actions environment)
- **Quality**: Every link must be verified from actual source data — no hallucinated URLs
- **Freshness**: Content must be from last 24 hours only

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Buttondown over Substack | Substack has no publish API; Buttondown has a developer-friendly API | — Pending |
| GitHub Actions over Claude /schedule | More portable, transparent, and configurable | — Pending |
| Git repo for daily data persistence | Simple, version-controlled, free — enables weekly rollup from committed files | — Pending |
| Claude API for curation | Same AI quality as manual prompt, works in headless CI environment | — Pending |
| Arxiv deprioritized | Audience is builders, not researchers — occasional practical papers only | — Pending |
| Daily + weekly cadence | Daily for comprehensive coverage, weekly for best-of digest | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-13 after initialization*
