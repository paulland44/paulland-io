# paulland.io — Cowork + Live Artifacts Migration Plan

**Branch:** `claude/review-knowledge-base-KvEs7`
**Status:** Phase 1 — in progress
**Last updated:** 2026-04-28

---

## Vision

Move the interaction layer from a 22k-LOC self-hosted admin app to:

- **Claude Cowork desktop** — Live Artifacts for rich dashboards, chat for capture
- **Claude mobile + Cowork Dispatch** — capture and trigger work on the go
- **Slim mobile admin** (~2.5k LOC, responsive web) — visual fallback for phone
- **Backend unchanged** — Supabase, R2, Vectorize, AI Search, MCP server, capture-worker, email-to-mis-job, mcp-worker
- **New continuous-learning loops** — 6 agents (4 Cowork Scheduled, 2 Cloudflare Worker) + `usage_events` cost tracking + `proposals` approval inbox

**Goal:** ~90% admin LOC reduction, no data migration, retain MIS pipeline + ontology + MCP surface.

---

## Architecture decisions (locked)

| Decision | Choice |
|---|---|
| Slim admin hosting | Same Cloudflare Pages project, shrunk in place |
| Approvals shape | `proposals` table + slim admin view (mobile-friendly) |
| Agents hosting | Cloudflare Worker for DB Janitor + Capture Triage (always-on); Cowork Scheduled for the rest |
| Cost tracking | Token + estimated $ + per-prompt `quality_flag` |
| MIS form | Keep fully functional in admin; chat-based path works in parallel via existing MCP MIS tools |
| Local repo for Cowork project | Existing `paulland-io` (this repo) |

---

## What we're building

| Category | Count | Items |
|---|---|---|
| **Live Artifacts** | 11 | Today, Tasks Kanban, Reflections, Bookings, Revenue, Pipeline (WCR), Support, MIS Job Monitor, Competition, Signals Canvas, Approvals (optional) |
| **New MCP tools** | 6 | `add_meeting_note`, `list_wcr_pack_opps`, `upload_asset_from_attachment`, `append_log`, `unlink_entity`, `delete_asset` |
| **New tables** | 2 | `usage_events`, `proposals` |
| **New worker** | 1 | `agents-worker` (DB Janitor + Capture Triage) |
| **Cowork Scheduled tasks** | 4 | EOD Reviewer, Weekly Synthesiser, Memory Curator, Skill Auditor |
| **Retire** | — | ~17,000 LOC from admin; 3 dead API endpoints |

---

## Phase 1 — Foundation (Weekend 1)

**Goal:** Cost visibility, de-risked spikes, design system in place.

- [x] Pre-flight: git tag `pre-cowork-migration` created ✓ (Supabase `pg_dump` + R2 inventory + Vectorize sample to be run by Paul on his side — no data is being touched in Phase 1, so not blocking)
- [x] Create `usage_events` table migration (`migrations/019_usage_events.sql`) — *to be applied in Supabase*
- [x] Add cost/token logging to API handlers: `handleAsk`, `handleAskStream`, `handleSignalSynthesis`, `handleReflectionSynthesis`, `handleCompetitorResearch`, `handleDailyReview`, `handleGenerateSummary` (plus bonus: `handleSummarizeToNote`, `handleExtractSignals`). Wired at the `callLLM` / `streamLLMToWriter` chokepoint, so all 9 handlers covered with one helper + 9 call-site updates.
- [x] ~~Add cost/token logging to MCP server workflow tools (extract/write pairs)~~ **Deferred to Phase 5.** MCP `*_extract` / `*_write` tools return data+prompts to Claude rather than calling Anthropic themselves; the LLM tokens are billed on Claude.ai/Cowork's side, not in the MCP Worker. Real MCP-equivalent cost tracking arrives with `agents-worker` (Phase 5+), which does call the Anthropic SDK directly.
- [x] Build small cost panel — first **Live Artifact** prototype (read-only, calls a new `list_usage_events` MCP tool) ✓ — `cowork/artifacts/cost-panel.html`, period picker, empty state, refresh-on-visibility
- [x] Cowork MCP auth spike — `list_tasks` returns real data ✓ (validated 2026-04-28)
- [x] Screenshot upload spike — bytes via inline-base64-as-tool-arg costs ~$0.45 per 100KB screenshot in Sonnet output tokens; ~$4.50+ for typical PDFs; hard-capped by model output limit at a few hundred KB. **Decision:** Phase 7 redesigns to a two-tool presigned-URL flow (`mint_asset_upload_url` + `register_asset`) instead of inline-base64. Bytes never enter LLM context; works for any file size; ~$0.01 per upload regardless. See decisions log entry.
- [x] Delete 3 dead endpoints: `assets/r2-list`, `embed`, `tasks/backfill-from-daily-notes` (plus removed the `Backfill from daily notes` button + handler from admin)
- [x] Create `docs/artifact-design-system.md` v0
- [x] Create `cowork/instructions/project-system-prompt.md`
- [x] Seed `prompts` table with `artifact-base` slug (`scripts/seed-artifact-base-prompt.sql` ready to apply alongside the migration)

**Gate:** Cost data flowing ✓ (verified 2026-04-28). Cost panel Live Artifact pinned in Cowork ✓ (2026-04-29). Screenshot path validated and Phase 7 redesigned to presigned-URL flow ✓ (2026-04-29). Design system v0 in repo ✓. **Phase 1 complete.**

---

## Phase 2 — Today Live Artifact (Weekend 2)

**Goal:** Prove the chat-as-capture + Live-Artifact-as-ambient-dashboard pattern.

- [ ] New MCP tool `add_meeting_note` (params: `meeting_id`, `text` → appends to today's daily note, tags attendees)
- [ ] Real `list_calendar_events` and `list_tasks` calls inspected first (the article's discipline)
- [ ] Build **Today** Live Artifact:
  - [ ] Header: date + period nav (yesterday/today/tomorrow)
  - [ ] Meetings strip (calendar events for the day, with inline "add note" textarea per meeting)
  - [ ] Tasks strip (open + due-today)
  - [ ] Daily-note body (read view + "open in chat" link)
  - [ ] Today's attachments strip (call `list_assets` filtered to today)
  - [ ] **Reflection Corner placeholder** (skeleton; populated in Phase 4 + Phase 9)
- [ ] Save artifact source to `cowork/artifacts/today.html`
- [ ] Pin in Cowork project

---

## Phase 3 — Tasks Kanban + live-with (Weekend 3)

**Goal:** Standalone Tasks management; reality-check the artifact pattern.

- [ ] Build **Tasks Kanban** Live Artifact:
  - [ ] Status columns (open / in-progress / done / cancelled)
  - [ ] DnD between columns (calls `update_task`)
  - [ ] Bulk complete action
  - [ ] Filter by date range, source (daily note / direct), tag
  - [ ] Inline "create task" input
- [ ] Save artifact source to `cowork/artifacts/tasks-kanban.html`
- [ ] **Live with Today + Tasks for the rest of the week**

**Gate:** Does chat-as-capture + Today + Tasks feel like "one place to write and see what's on"?
If yes → continue. If no → course-correct before reflections/dashboards.

---

## Phase 4 — Reflections, both modes (Weekend 4)

**Goal:** Direct + exploratory reflection capture; daily flagging.

- [ ] Schema: add `metadata.status` field convention to reflections (`draft | exploring | concluded`)
- [ ] Build **Reflections** Live Artifact:
  - [ ] Write panel (long-form textarea, optional tags + linked entities)
  - [ ] Card browse (filterable by date, tag, status)
  - [ ] Multi-select → "Synthesise" button → calls `/api/reflection-synthesis` (streaming SSE)
- [ ] Add exploratory-reflection prompt template to `prompts` table (slug `reflection-explore`) — used when user starts an exploratory chat
- [ ] Wire up Reflection Corner in Today artifact: most recent reflection + open explorations + (placeholder for) agent-generated prompts
- [ ] Save artifact source to `cowork/artifacts/reflections.html`

---

## Phase 5 — Agents foundation + EOD Reviewer (Weekends 5–6)

**Goal:** First agent live; approval flow validated.

### Weekend 5
- [ ] `proposals` table migration: `id, ts, agent, type, target_entity, target_id, payload, status, decided_at, decision_note`
- [ ] Slim admin **Approvals Inbox** view (mobile-friendly, tap to accept/reject) — replaces a chunk of the old admin sidebar
- [ ] EOD Reviewer skill prompt (in `prompts` table, slug `eod-reviewer`)

### Weekend 6
- [ ] EOD Reviewer agent live as **Cowork Scheduled task** — daily 18:00
- [ ] Reads today's daily note + calendar
- [ ] Appends `## End-of-day review` section
- [ ] Appends entity log entries (people / company / product `_log` tables)
- [ ] Creates tasks
- [ ] Substantive proposals → `proposals` table → Approvals Inbox

**Gate:** Approval flow ergonomic? EOD outputs useful? If yes → ship more agents in Phase 9.

---

## Phase 6 — The four dashboards (Weekends 7–9)

### Weekend 7
- [ ] **Bookings Dashboard** Live Artifact (KPIs + sparklines + period picker, calls `list_bookings` or query helpers)
- [ ] **Revenue Dashboard** Live Artifact (same chart family, period picker shape)
- [ ] Save sources to `cowork/artifacts/bookings-dashboard.html`, `revenue-dashboard.html`

### Weekend 8
- [ ] New MCP tool `list_wcr_pack_opps` (current snapshot per opp + history range option)
- [ ] **Pipeline (WCR Pack) Dashboard** Live Artifact (stage Kanban + weekly trend chart + click-through to opp history)
- [ ] Save source to `cowork/artifacts/pipeline-wcr.html`

### Weekend 9
- [ ] **Support Dashboard** Live Artifact
- [ ] Dashboard family polish: consistent period picker, drill-downs, export, mobile breakpoint review
- [ ] Save source to `cowork/artifacts/support-dashboard.html`

---

## Phase 7 — Asset attachments + remaining read artifacts (Weekend 10)

- [ ] **Two MCP tools** for the asset upload flow (replaces the originally-planned `upload_asset_from_attachment` after the Phase 1 spike showed inline-base64 was the wrong primitive):
  - `mint_asset_upload_url(filename?, mime_type?, size_bytes?)` → `{ upload_url, asset_id, expires_at }` — Pages handler signs an R2 PUT URL with 10-min expiry; reserves an `assets` row in `pending` state
  - `register_asset(asset_id, filename, mime_type, tags?, linked_to?)` — finalises the row after Cowork's bash uploads via the URL; triggers embedding via existing `embedItem`
- [ ] Cowork pattern: `mint_asset_upload_url` → bash `curl -X PUT "$upload_url" --data-binary @path` → `register_asset`. Bytes never enter LLM context.
- [ ] **MIS Job Monitor** Live Artifact (read-only — admin form stays for create/edit)
- [ ] **Competition Dashboard** Live Artifact (cards + research trigger button)
- [ ] Save sources to `cowork/artifacts/mis-monitor.html`, `competition.html`

---

## Phase 8 — Signals canvas + synthesis polish (Weekend 11)

- [ ] **Signals Canvas** Live Artifact (card grid, multi-select synthesise, status filters)
- [ ] Tune signal extraction prompt + reflection-synthesis prompt based on `usage_events` data
- [ ] Save source to `cowork/artifacts/signals-canvas.html`

---

## Phase 9 — Remaining agents (Weekends 12–13)

### Weekend 12 — Additive agents (low risk)
- [ ] Weekly Synthesiser (Cowork Scheduled, Sundays) — proposes reflection prompts → `proposals`
- [ ] Memory Curator (Cowork Scheduled, Sundays) — proposes memory entries → `proposals`
- [ ] DB Janitor (Cloudflare Worker, nightly 03:00) — auto-fix trivial; report rest

### Weekend 13 — Higher-effort agents
- [ ] Skill Auditor (Cowork Scheduled, Sundays) — reads `usage_events.quality_flag`, proposes prompt edits → `proposals`
- [ ] Capture Triage upgrade (Cloudflare Worker, event-driven) — propose tags + entity links for new captures

---

## Phase 10 — Admin shrink + slim mobile views (Weekend 14)

- [ ] Mobile slim views (responsive, read-heavy):
  - [ ] Today (mobile)
  - [ ] Tasks (mobile, with tap-to-complete)
  - [ ] Pipeline (mobile, read-only)
  - [ ] MIS Monitor (mobile, read-only)
- [ ] Delete retired admin views: Articles, Thoughts, Reflections, Signals, Problems, Strategies, Personas, Research segments, People, Companies, Products, Projects, Competition, Sales subviews × 5, Support, Summaries, Ask Home, MCP Overview, Settings → Appearance
- [ ] Keep fully functional: **MIS form + monitor**, Settings → Connections, Settings → System, Prompts editor, Approvals Inbox, mobile slim views, Errors panel
- [ ] Target: ~2,500–3,500 LOC in `admin/index.html` (down from 22,300)

---

## Phase 11 — Validation & cleanup (Weekend 15)

- [ ] 1-week parallel run, monitoring `usage_events`
- [ ] Cost review (real data now)
- [ ] Update CLAUDE.md to reflect end-state architecture
- [ ] `pg_dump` snapshot, tagged `post-cowork-migration`
- [ ] Final cleanup: remove unused imports, dead helper functions, obsolete CSS

---

## End-state architecture

```
DESKTOP — Cowork
  Live Artifacts:
    Today, Tasks Kanban, Reflections,
    Bookings, Revenue, Pipeline (WCR), Support,
    MIS Job Monitor, Competition, Signals Canvas,
    (optional) Approvals Inbox

MOBILE — slim admin (responsive Cloudflare Pages)
  Today (read), Tasks (read+complete),
  Pipeline (read), MIS Monitor (read),
  Approvals Inbox, Settings, Errors panel,
  MIS form (full)

CHAT — Cowork (desktop) + Claude mobile app + Cowork Dispatch
  Direct capture, exploratory reflection,
  multi-step MIS job creation, Q&A (Jasper),
  Imports (drag XLSX → "import this"),
  Mobile-triggered work via Dispatch

BACKEND — unchanged
  Supabase, R2, Vectorize, AI Search,
  MCP server, capture-worker, email-to-mis-job, mcp-worker
  + new: agents-worker, usage_events, proposals,
    6 new MCP tools, 4 Cowork Scheduled tasks
```

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-28 | Cowork project points at existing `paulland-io` repo, not a new one | Single source of truth; migration plan + design system + artifact source live alongside backend code |
| 2026-04-28 | Live Artifact source copies committed to `cowork/artifacts/` | Cowork stores artifacts in cloud metadata; local source gives version control + recovery |
| 2026-04-28 | 4 of 6 agents on Cowork Scheduled, 2 on Cloudflare Worker | Reflective agents tolerate desktop-on dependency; always-on agents (DB Janitor, Capture Triage) need Cloudflare reliability |
| 2026-04-28 | MIS form stays fully functional in admin | User decision — complex form, want safety net; chat-based path is additive |
| 2026-04-28 | Cost logging wired at the `callLLM` / `streamLLMToWriter` chokepoint, not per-handler | One-place instrumentation covers all 9 LLM-using API handlers, plus future ones automatically. Threading `feature` + `ctx` through is the only per-handler change. |
| 2026-04-28 | MCP-side cost logging deferred to Phase 5 | The MCP server's `*_extract` / `*_write` tools don't call Anthropic themselves — they return prompts/accept results. LLM tokens for those flows are billed on Claude.ai/Cowork's side, not the Worker's, so server-side instrumentation would always show zero. Real MCP-equivalent cost tracking happens when `agents-worker` (Phase 5+) makes Anthropic SDK calls directly. |
| 2026-04-28 | Pricing table for `cost_est` lives inline in `functions/api/[[path]].js` (`USAGE_PRICING`) | Updates when Anthropic prices change. Cloudflare AI rows are zero-cost (Workers AI free tier covers our embedding volume). |
| 2026-04-28 | `logUsageEvent` awaits the Supabase insert directly rather than using `ctx.waitUntil` | First version used `ctx.waitUntil(writeRow())`. In streaming handlers (`handleAskStream` etc.), the IIFE pattern returns the `Response` immediately and runs the LLM call in the background. When `writer.close()` later finalises the response body, `waitUntil` tasks scheduled from that background flow can be reaped before the Supabase fetch completes — silently, since the helper swallows errors. Fix: await the insert directly. ~50–100ms cost, negligible compared to the LLM call. The same pattern as `logAiError` (which has always worked correctly). |
| 2026-04-29 | Phase 7 asset upload uses a presigned-URL flow, not inline base64 | Spike result: Cowork sees images as multimodal context, but to pass bytes to an MCP tool the bytes must travel through the model's *output* as a tool_use parameter. At Sonnet rates that's ~$0.45 per 100KB and ~$4.50+ per typical PDF, plus a hard cap at the model's output-token limit (~few hundred KB). Two-tool flow (`mint_asset_upload_url` + `register_asset`) keeps bytes out of the LLM context, scales to any file size, and costs ~$0.01 per upload regardless of size. Architecturally cleaner; ~half a day extra implementation vs. inline base64. |

---

## Open items / parking lot

- Verify Cowork's mobile app rendering of artifacts as it evolves (currently desktop-only)
- VOC interview processing — design when first batch arrives; will reactivate `problem_extract` / `strategy_extract`
- Conversational reflection synthesis — sharper after Skill Auditor has run for a few weeks
- Memory store choice — Anthropic Memory tool vs `memory/*.md` files vs both (deferred until Phase 5 is live)
