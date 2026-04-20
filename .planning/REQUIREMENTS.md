# Requirements: AI Builder Pulse

**Defined:** 2026-04-13
**Core Value:** Practitioners building with AI get a comprehensive, trustworthy daily briefing of everything relevant without scanning dozens of sources themselves.

## v1 Requirements

### Content Ingestion

- [ ] **INGEST-01**: System scans HN via Algolia API for stories from the last 24 hours (300-500 stories)
- [ ] **INGEST-02**: System scrapes GitHub Trending for AI-related repositories
- [ ] **INGEST-03**: System scans Reddit AI communities (r/LocalLLaMA, r/MachineLearning, etc.) for posts from last 24 hours
- [ ] **INGEST-04**: System parses RSS/Atom feeds from key AI blogs for new posts
- [ ] **INGEST-05**: System enforces 24-hour freshness on all ingested items
- [ ] **INGEST-06**: System performs cross-source URL normalization to deduplicate items

### AI Curation

- [ ] **CURATE-01**: Claude API filters items for AI builder relevance using structured JSON output
- [ ] **CURATE-02**: Claude categorizes items into fixed taxonomy (Tools & Launches, Model Releases, Techniques & Patterns, Infrastructure & Deployment, Notable Discussions, Think Pieces & Analysis, News in Brief)
- [ ] **CURATE-03**: Claude generates 1-2 sentence descriptions per item
- [ ] **CURATE-04**: System pre-filters items before Claude call to reduce cost (keyword/score thresholds)
- [ ] **CURATE-05**: System logs token counts and estimated API cost per run

### Link Integrity

- [ ] **LINK-01**: Every URL in output traces to source API data (never Claude-generated)
- [ ] **LINK-02**: Post-generation validation confirms all output URLs exist in input data
- [ ] **LINK-03**: No bare domain links, no duplicate source IDs, no GitHub user-profile links

### Publishing

- [ ] **PUB-01**: System publishes formatted markdown issue to Buttondown via API
- [ ] **PUB-02**: Idempotency guard prevents duplicate sends on retry
- [ ] **PUB-03**: Post-publish status verification confirms successful delivery
- [ ] **PUB-04**: Empty-issue guard skips publish if insufficient content found

### Automation

- [ ] **AUTO-01**: GitHub Actions cron workflow runs daily at scheduled time
- [ ] **AUTO-02**: Keepalive mechanism prevents GitHub Actions 60-day auto-disable
- [ ] **AUTO-03**: Pipeline failures trigger error alerting (GitHub Actions notifications)
- [ ] **AUTO-04**: API keys managed via GitHub Actions secrets

### Persistence

- [ ] **PERSIST-01**: Each daily issue committed to git as markdown and JSON files
- [ ] **PERSIST-02**: Files follow structured convention (issues/YYYY-MM-DD/)

## v2 Requirements

### Twitter/X Integration

- **TWITTER-01**: System scans Twitter/X for AI builder content
- **TWITTER-02**: Graceful degradation when Twitter source is unavailable

### Weekly Digest

- **WEEKLY-01**: Auto-generated weekly best-of from committed daily issue files
- **WEEKLY-02**: Weekly digest published to Buttondown on separate schedule

### Arxiv

- **ARXIV-01**: Scan Arxiv for papers with practical builder implications

### Analytics

- **ANALYTICS-01**: Per-source yield metrics and logging
- **ANALYTICS-02**: Subscriber growth tracking via Buttondown API

## Out of Scope

| Feature | Reason |
|---------|--------|
| Custom web frontend | Buttondown handles the reader experience |
| Per-subscriber personalization | Complexity too high for automated pipeline |
| Paid tier / monetization | Focus on content automation first |
| Social cross-posting | Not core to newsletter value |
| Mobile app | Email is the delivery mechanism |
| Human editorial review | Core bet is full automation |
| AI researcher-focused content | Audience is builders, not academics |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INGEST-01 | Phase 2 | Pending |
| INGEST-02 | Phase 2 | Pending |
| INGEST-03 | Phase 2 | Pending |
| INGEST-04 | Phase 2 | Pending |
| INGEST-05 | Phase 2 | Pending |
| INGEST-06 | Phase 2 | Pending |
| CURATE-01 | Phase 3 | Pending |
| CURATE-02 | Phase 3 | Pending |
| CURATE-03 | Phase 3 | Pending |
| CURATE-04 | Phase 3 | Pending |
| CURATE-05 | Phase 3 | Pending |
| LINK-01 | Phase 3 | Pending |
| LINK-02 | Phase 3 | Pending |
| LINK-03 | Phase 3 | Pending |
| PUB-01 | Phase 4 | Pending |
| PUB-02 | Phase 4 | Pending |
| PUB-03 | Phase 4 | Pending |
| PUB-04 | Phase 4 | Pending |
| AUTO-01 | Phase 1 | Pending |
| AUTO-02 | Phase 1 | Pending |
| AUTO-03 | Phase 1 | Pending |
| AUTO-04 | Phase 1 | Pending |
| PERSIST-01 | Phase 5 | Pending |
| PERSIST-02 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after roadmap creation*
