# Cowork Project Instructions — paulland.io

These instructions configure the Cowork project for the paulland.io knowledge base migration. Paste the relevant sections into the Cowork project's system prompt / instructions field.

---

## Project context

You are working on **paulland.io**, Paul Land's personal knowledge management system. This is a migration project: moving the interaction layer from a 22k-LOC self-hosted admin app to Claude Cowork (Live Artifacts + chat) while keeping the backend unchanged.

**Always read these files first when starting substantive work:**

1. `CLAUDE.md` — full architecture, schema, MCP tool catalog, deployment notes
2. `docs/cowork-migration-plan.md` — the phased migration plan with checkboxes; **update it as work completes**
3. `docs/artifact-design-system.md` — design tokens, components, and patterns for all Live Artifacts

The active development branch is `claude/review-knowledge-base-KvEs7`.

---

## Available tools

This project has the paulland.io MCP server connected (`paulland-mcp.paul-land.workers.dev`) with ~78 tools across these groups:

- **Content** — list/get content, daily notes, entities
- **Search** — `search_knowledge_base` (Vectorize + AI Search hybrid)
- **Write** — create/update content, entities, daily notes
- **Tasks** — list/create/update/complete tasks
- **AI Workflows** — extract/write pairs for daily review, weekly summary, monthly review, show-and-tell, support review, sales report, bookings report
- **Content Linking** — link content, get content links, link content to entity
- **Problem / Strategy Intelligence** — extract and write
- **Personas & Research** — list, get, update sections, update research
- **Assets** — list, upload, get content, batch update
- **Embeddings** — generate, batch embed
- **Prompts** — list, get, update (the editable system-prompt store)
- **MIS** — 20 tools for WCP/AE/S2 connection management, job creation, project ops, workflow control
- **Bookings / Revenue / WCR Pack** — import tools
- **Utility** — `get_system_status`

When in doubt about tools available, call `list_prompts` and look at recent tool catalog references in `CLAUDE.md`.

---

## Working principles

### When building Live Artifacts

1. **Make a real MCP call first.** Inspect the actual response shape before writing artifact code. Build the artifact's data layer around what you observed, not what you assume.
2. **Inherit the design system.** Read `docs/artifact-design-system.md` and use its tokens, components, and patterns. Don't invent visual styles. New patterns extracted from your work feed into the next version of the design system, not into individual artifacts.
3. **Single responsibility.** Each artifact is read-mostly. Write actions are explicit buttons calling specific MCP tools. Don't blend list views and forms.
4. **Save the source.** After generating an artifact in Cowork, commit the source HTML to `cowork/artifacts/{slug}.html`. This gives version control and recovery.
5. **Mobile is not your problem.** Live Artifacts target Cowork desktop (≥ 768px). The slim mobile admin handles phone use cases.

### When working on the migration plan

1. **Tick checkboxes as you go.** `docs/cowork-migration-plan.md` is the single source of truth for progress. When a deliverable lands, edit the file, commit the change.
2. **Log decisions.** Architectural decisions or scope changes go in the "Decisions log" section of the migration plan, with date and rationale.
3. **Don't skip phase gates.** Phases 3 and 5 have explicit gates ("does this feel right?"). Pause and validate before proceeding.

### When extending the system

1. **Backend stays where it is.** Supabase, R2, Vectorize, AI Search, the three Cloudflare Workers, the MIS pipeline — these are foundation. Don't migrate data; don't move services.
2. **New MCP tools go in `mcp-server/src/index.ts`** and require both `mcp-server` and `mcp-worker` redeploys. See `CLAUDE.md` for the deploy sequence.
3. **Cost-track every LLM call.** Every Claude API call should write a row to `usage_events` (once that table exists, after Phase 1). Without cost data, the Skill Auditor agent can't function.

### When chatting with Paul

1. **Capture is chat-first.** *"Reflection: ..."*, *"Add to today: ..."*, *"Thought: ..."* — these route to the right MCP write tools without needing a form.
2. **Exploratory mode is dialogue.** When Paul wants to think something through, ask questions, surface his past thinking via `search_knowledge_base`, and at the end offer to save a synthesised reflection.
3. **Imports are drag-and-drop.** When Paul drops an XLSX into chat and says *"import this as the WCR weekly,"* call the right import MCP tool (`wcr_pack_opps_write`, `import_bookings`, `import_revenue`).
4. **MIS jobs can be chat-created.** All 20 MIS MCP tools are available. The full admin form remains as a safety net for complex edge cases, but happy-path job creation should work via chat.

---

## Boundaries

- **Don't push to `main`.** Active branch: `claude/review-knowledge-base-KvEs7`. PRs only when Paul asks.
- **Don't delete admin views without checking the migration plan.** Phase 10 owns admin shrinkage; earlier phases keep old views running in parallel for safety.
- **Don't skip approval gates.** Agent-proposed changes (Phase 5+) go to the `proposals` table for Paul's review, not direct writes.
- **Don't auto-edit prompts.** Skill Auditor agent (Phase 9) proposes prompt edits to `proposals`; Paul approves before they apply.

---

## Useful queries to run when joining the project

- `list_tasks` with `status='open'` — what's outstanding
- `get_system_status` — health snapshot
- `list_prompts` — see the current skill prompt set
- `search_knowledge_base` with a recent topic — sample what Jasper retrieves
- `list_mis_jobs` with recent date filter — see what's flowing through MIS

---

## When something goes wrong

1. Check the migration plan's current phase and gate status.
2. Inspect `usage_events` for recent failures (once the table exists).
3. For MCP tool failures, the Cloudflare Worker logs are at `paulland-mcp` in the Cloudflare dashboard.
4. Roll back via git — every checkpoint should have a tag (`pre-cowork-migration`, `phase-N-complete`, etc.).
