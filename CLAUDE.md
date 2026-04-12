# paulland.io — Knowledge Management System

Personal "second brain" for capturing, organising, and analysing articles, notes, competitive intelligence, and assets.

## Architecture

```
Browser ──→ Cloudflare Pages (static HTML + Pages Functions)
                │
                ├── functions/api/[[path]].js  (single catch-all API handler)
                │       │
                │       ├── Supabase (PostgreSQL + pgvector)
                │       ├── Cloudflare R2 (asset storage, bucket: knowledge-capture)
                │       ├── Claude API (summaries, reviews, research, RAG)
                │       ├── Cloudflare AI (embeddings)
                │       └── WebCenter Pack / Automation Engine APIs (MIS proxy)
                │
                ├── index.html          (public homepage)
                └── admin/index.html    (admin dashboard SPA, ~9200 lines, includes MIS management)

Claude ──→ Cloudflare Worker (MCP Remote Server)
  (web/mobile/       │
   desktop/CLI)      ├── mcp-worker/src/index.ts  (OAuth 2.0 + MCP Streamable HTTP)
                     │       │
                     │       └── imports mcp-server/src/index.ts (shared tool implementation)
                     │               │
                     │               ├── Supabase (all KB read/write)
                     │               ├── Cloudflare AI (embeddings)
                     │               └── Pages API proxy (R2 uploads, MIS)
                     │
                     └── https://paulland-mcp.paul-land.workers.dev
```

- **Hosting**: Cloudflare Pages — deploy with `npx wrangler pages deploy . --project-name=paulland-io --commit-dirty=true`
- **MCP Server**: Cloudflare Worker — deploy with `cd mcp-worker && npx wrangler deploy`
- **Auth**: Cloudflare Access JWT on API routes; OAuth 2.0 + Bearer token on MCP endpoint
- **Database**: Supabase with RLS enabled on all tables. Service key bypasses RLS.
- **Companion service**: `capture-bot` (Python, Railway) handles background sync — see that repo's CLAUDE.md

## Database Schema (Supabase)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `content` | Articles, thoughts, reflections, signals, problems, summaries | type, title, body, url, source, tags[], status, metadata, embedding |
| `companies` | Companies & competitors | name, website, industry, notes, is_competitor, is_internal |
| `people` | Contacts | name, company_id, role, notes |
| `products` | Products linked to companies | name, description, company_id, url |
| `projects` | Internal projects | name, description, status |
| `assets` | Files in R2 | filename, r2_key, mime_type, tags[], metadata |
| `feeds` | RSS feed sources | url, name, mode, active |
| `feed_items` | RSS triage queue (from Readwise Reader) | item_title, item_url, item_summary, captured, dismissed, feed_id |
| `daily_notes` | Daily journal by date | date, meetings, notes, tasks, review |
| `sync_state` | Key-value sync cursors | key, value |
| `company_content` | Junction: companies ↔ content | company_id, content_id |
| `product_assets` | Junction: products ↔ assets | product_id, asset_id |
| `product_content` | Junction: products ↔ content | product_id, content_id |
| `content_links` | Junction: content ↔ content (signals→problems, articles→problems, etc.) | source_id, target_id, link_type, context |
| `mis_connections` | MIS connection profiles (WCP/AE) | name, type, cluster, ecan, repo_id, server_url, encrypted_token, token_iv, is_active |
| `mis_jobs` | MIS job tracking | job_id, job_name, customer_code, customer_name, status, phase, due_date, connection_id, solution, cluster, payload, wcp_response |
| `bookings` | Weekly bookings order-line data | week, year, order_number, end_user, customer_name, subsegment, booking_type, product_code, region, subregion, country, channel, order_type, sales_rep, sales_org, value_2023, value_2024, value_2025, value_2026, source_file |
| `revenue` | Monthly revenue by product and type | period, year, month, product_code, product_name, revenue_type, actual, prior_year, two_year_back, growth_dollar, growth_pct, fc, fc_gap, source_file |
| `persona_log` | Incremental updates to personas | content_id, log_date, entry, source, source_ref, section_updated |
| `research_log` | Incremental updates to research docs | content_id, log_date, entry, source, source_ref, section_updated |

## API Routes (`functions/api/[[path]].js`)

**GET:**
| Route | Handler | Purpose |
|-------|---------|---------|
| `calendar-events` | `handleCalendarEvents` | Fetch from Outlook ICS feed |
| `assets/r2-list` | `handleR2List` | List R2 bucket objects |
| `assets/file/:key` | `handleAssetServe` | Serve file from R2 |
| `assets/:id/content` | `handleAssetContent` | Fetch asset content (text or base64) |

**POST:**
| Route | Handler | Purpose |
|-------|---------|---------|
| `content/tags` | `handleUpdateTags` | Update tags + trigger embedding |
| `daily-notes` | `handleUpsertDailyNote` | Create/update daily note by date |
| `daily-review` | `handleDailyReview` | AI end-of-day review (Claude) |
| `entity-update` | `handleEntityUpdate` | Generic PATCH for any table |
| `entity-log` | `handleEntityLog` | Generic INSERT for any table |
| `generate-summary` | `handleGenerateSummary` | AI weekly/monthly summary |
| `assets/upload` | `handleAssetUpload` | Upload file to R2 + create metadata |
| `embed` | `handleEmbed` | Generate embedding for single item |
| `embed-batch` | `handleEmbedBatch` | Batch embed unembedded content |
| `search` | `handleSearch` | Vector similarity search (pgvector) |
| `ask` | `handleAsk` | RAG: vector search + Claude answer |
| `feed-items/capture` | `handleFeedItemCapture` | Promote feed item → content (extracts full article) |
| `competitor-research` | `handleCompetitorResearch` | **Streaming** Claude + web_search SSE |
| `extract-signals` | `handleExtractSignals` | AI signal extraction from articles (Claude) |
| `signal-synthesis` | `handleSignalSynthesis` | **Streaming** multi-signal synthesis (Claude SSE) |

**DELETE:**
| Route | Handler | Purpose |
|-------|---------|---------|
| `product-link` / `entity-link` | `handleProductUnlink` | Remove junction table entries |
| `assets/:id` | `handleAssetDelete` | Delete from R2 + Supabase |

**MIS Routes (`/api/mis/*`):**

Connection Management:
| Method | Route | Handler | Purpose |
|--------|-------|---------|---------|
| GET | `mis/connections` | `handleMisConnections` | List all connections (tokens excluded) |
| GET | `mis/connections/:id` | `handleMisConnections` | Get single connection |
| POST | `mis/connections` | `handleMisConnections` | Create connection (encrypts token) |
| PATCH | `mis/connections/:id` | `handleMisConnections` | Update connection |
| DELETE | `mis/connections/:id` | `handleMisConnections` | Delete connection |

Job Management:
| Method | Route | Handler | Purpose |
|--------|-------|---------|---------|
| GET | `mis/jobs` | `handleMisJobs` | List all jobs |
| GET | `mis/jobs/:id` | `handleMisJobs` | Get single job |
| POST | `mis/jobs` | `handleMisJobs` | Create job record |
| PATCH | `mis/jobs/:id` | `handleMisJobs` | Update job (status, phase, etc.) |
| DELETE | `mis/jobs/:id` | `handleMisJobs` | Delete job from monitor |

WCP Proxy Routes (legacy connections, proxied to Esko APIs with server-side token):
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `mis/customers` | Fetch partners from IAM API |
| GET | `mis/task-templates` | Fetch task templates from W2P API |
| GET | `mis/product-templates` | Fetch product templates from W2P API |
| GET | `mis/preflight-profiles` | Fetch preflight profiles from W2P API |
| GET | `mis/job-details/:jobId` | Fetch job details from W2P API |
| PUT | `mis/create-job` | Create job in WCP via W2P API |
| POST | `mis/edit-job` | Update job status/phase in WCP |
| GET | `mis/debug` | Debug endpoint for WCP connectivity |

S2 MIS API Routes (S2 connections, proxied to Esko S2 `/MISapi/v0/` endpoints):
| Method | Route | Purpose |
|--------|-------|---------|
| GET/POST | `mis/customers`, `mis/customers/:id` | List/create/update/get customers |
| GET/POST | `mis/projects`, `mis/projects/:id` | List/create/update/get projects (jobs) |
| POST | `mis/projects/:id/status` | Update project status |
| POST | `mis/projects/:id/products` | Link products to project |
| GET/POST | `mis/projects/:id/assets` | List/create project assets |
| GET/POST | `mis/products`, `mis/products/:id` | List/create/get products |
| POST | `mis/products/:id/status` | Update product status (per-part) |
| POST | `mis/products/:id/shapeAsset` | Attach shape asset to product |
| POST | `mis/products/:id/graphicAssets` | Attach graphic asset to product |
| GET | `mis/workflow-templates`, `mis/workflow-templates/:id` | List/get workflow templates |
| POST | `mis/workflow-templates/:id/launch` | Launch workflow on project |
| GET | `mis/workflow-instances`, `mis/workflow-instances/:id` | List/get workflow instances |
| POST | `mis/workflow-instances/:id/cancel` | Cancel running workflow |
| GET/POST | `mis/media`, `mis/media/:id` | List/create/get media (substrates) |
| GET | `mis/assets/:id`, `mis/assets/:id/thumbnail`, `mis/assets/:id/content` | Asset info/preview/download |
| POST | `mis/assets/:id/content` | Upload asset content |

## Frontend

### Homepage (`index.html`)
Canvas constellation animation, responsive design. Fonts: Cormorant Garamond (serif), Inconsolata (mono).

### Admin Dashboard (`admin/index.html`)
Single-page app, all inline (~8900 lines). No build step.

**Libraries** (CDN):
- Supabase JS (`@supabase/supabase-js@2`)
- Lucide icons
- Marked (markdown rendering)
- PDF.js (PDF preview)

**Sidebar Nav Groups**: Content (Articles, Thoughts, Signals, Reflections, Summaries), Knowledge (Problems, People, Companies, Products, Projects, Competition), Strategy (Overview, Core, Goals, Architecture, Thought Leadership, Feedback, Operational), Sources (Feed Items, Feeds), Tools (Ask AI), Sales (Dashboard), Support (Dashboard)

**Views**: Overview, Articles, Thoughts, Signals, Reflections, Summaries, Feed Items, Feeds, Assets, People, Companies, Products, Projects, Competition, Ask AI, Sales Dashboard, Support Dashboard

**Theme System**: Dark/light mode, accent colours (sage, amber, blue, rose, violet), font sizing. Stored in localStorage.

**Key JS Functions**:
- `loadView(view)` — switch statement dispatching to view loaders
- `navigateToView(view)` — update nav active state + load view
- `openContentModal(item)` — article/thought/reflection detail editor
- `openCompetitorDetail(id)` — full-page competitor management view
- `loadSignals()` — dedicated signals view with card layout, filters, multi-select
- `openSynthesisModal(signalIds)` — AI synthesis of selected signals (streaming)
- `loadCompetition()` — competition dashboard with smart content surfacing
- `captureFeedItem(btn, id)` — promote feed item to content
- `refreshIcons()` — re-initialise Lucide icons after DOM updates
- `renderBody(md)` — render markdown via Marked

## MCP Server (Cloud)

The MCP server runs as a **Cloudflare Worker** at `https://paulland-mcp.paul-land.workers.dev`. It is the primary interface for Claude (web, mobile, desktop, CLI) to interact with the knowledge base.

**IMPORTANT**: The MCP server runs in the cloud, NOT locally. All tools must work in a Cloudflare Worker environment (no filesystem access, no Node.js-specific APIs like `fs` or `child_process`). The `mcp-server/` directory contains the shared implementation; `mcp-worker/` contains the Worker entry point.

### Architecture

```
mcp-server/src/index.ts    ← Shared implementation (38 tools, resources, prompts)
    exports: createServer(), initMisProxy(), registerTools(), registerResources()

mcp-worker/src/index.ts    ← Cloudflare Worker entry point
    imports: createServer() from mcp-server
    implements: OAuth 2.0 + PKCE, MCP Streamable HTTP transport
    per-request: fresh McpServer + WebStandardStreamableHTTPServerTransport
```

### Deployment

```bash
# Build the shared implementation
cd mcp-server && npm run build

# Deploy the Worker (picks up built mcp-server code)
cd mcp-worker && npx wrangler deploy
```

Both steps are required when tools change. The Worker imports from `../../mcp-server/src/index.js`.

### Tool Groups (69 tools)

| Group | Tools | Count |
|-------|-------|-------|
| Content | list_content, get_content, get_summary, list_daily_notes, get_daily_note, list_entities, get_entity, list_feed_items | 8 |
| Search | search_knowledge_base | 1 |
| Write | create_content, update_content, update_tags, upsert_daily_note, create_entity, update_entity | 6 |
| Feed | capture_feed_item, dismiss_feed_item | 2 |
| AI Workflows | daily_review_extract/write, weekly_summary_extract/write, monthly_review_extract/write, show_and_tell_extract/write, support_review_extract/write, sales_report_extract/write, bookings_report_extract/write | 14 |
| Content Linking | link_content, get_content_links, link_content_to_entity | 3 |
| Problem Intelligence | problem_extract, problem_write | 2 |
| Strategy Intelligence | strategy_extract, strategy_write | 2 |
| Personas & Research | list_personas, get_persona, update_persona_section, update_research | 4 |
| Assets | list_assets, upload_asset, get_asset_content | 3 |
| Embeddings | generate_embedding, batch_embed | 2 |
| Prompts | list_prompts, get_prompt, update_prompt | 3 |
| MIS | list_mis_connections, list_mis_jobs, create_mis_job, submit_mis_job, list_customers, list_task_templates, list_projects, get_project_info, update_project_status, list_project_assets, launch_workflow, list_workflow_instances, get_workflow_instance, cancel_workflow, list_products, create_product | 16 |
| Bookings | import_bookings | 1 |
| Revenue | import_revenue | 1 |
| Utility | get_system_status | 1 |

### Content Types

| Type | Purpose | Metadata Fields |
|------|---------|-----------------|
| `article` | Captured articles from feeds or manual entry | source, author, image_url |
| `thought` | Quick thoughts and observations | — |
| `signal` | Strategic signals extracted from articles | source_content_id, source_ids |
| `reflection` | Leadership and coaching reflections | — |
| `problem` | Problem definitions (P1-P18 domain, PP1-PP10 Phoenix) | problem_id, problem_domain, priority, category, related_problems, affected_personas, is_index |
| `strategy` | Internal strategy docs (domain/product strategies, goals, architecture, customer feedback) | strategy_type, product_area, owner, version, doc_status |
| `reference` | Personas, segment workflows, market research, strategic research | reference_type (persona, segment-workflow, market-research, strategic), segment |

### Problem Metadata Schema

```json
{
  "problem_id": "P1",
  "problem_domain": "domain|phoenix|stack|index",
  "priority": "High|Medium-High|Medium|Lower",
  "category": "Operational Efficiency|Strategic/Competitive|Compliance & Risk|Foundational/Enabler",
  "related_problems": ["P3", "P5"],
  "affected_personas": ["CSR", "Estimator"],
  "is_index": false,
  "migrated_from": "brain/discovery/problems/P1 - Information Flow.md"
}
```

### Strategy Metadata Schema

```json
{
  "strategy_type": "core-strategy|product-strategy|goals|roadmap|thought-leadership|customer-feedback|ost|architecture|operational|reference",
  "product_area": "WCP|AE|Phoenix|Domain",
  "owner": "Paul Land",
  "version": "v0.10",
  "doc_status": "draft|active|archived|superseded"
}
```

### Content Links

The `content_links` table enables linking any content item to any other (signal→problem, article→problem, problem→problem). Link types: `evidence`, `related`, `derived_from`, `supports`.

### Skills (10 skills, defined in `.claude/skills/`)

| Skill | Prompt Slug | Tools Used |
|-------|-------------|------------|
| End-of-Day Review | `daily-review` | get_prompt, daily_review_extract, daily_review_write |
| Extract Signals | `extract-signals` | get_prompt, list_content, get_content, create_content, update_content |
| Weekly Summary | `weekly-summary` | get_prompt, weekly_summary_extract, weekly_summary_write |
| Monthly Review | `monthly-summary` | get_prompt, monthly_review_extract, monthly_review_write |
| Show & Tell Review | `show-and-tell` | get_prompt, show_and_tell_extract, show_and_tell_write |
| Extract Problems | `extract-problems` | get_prompt, problem_extract, problem_write, list_content, get_content, link_content |
| Extract Strategies | `extract-strategies` | get_prompt, strategy_extract, strategy_write, list_content, link_content |
| Support Review | `support-review` | get_prompt, support_review_extract, support_review_write |
| Sales Report | `sales-report` | get_prompt, sales_report_extract, sales_report_write |
| Bookings Report | `bookings-report` | get_prompt, bookings_report_extract, bookings_report_write |

### Prompt Templates (12 prompts, stored in Supabase `prompts` table)

Prompts are editable via the admin dashboard (Tools → Prompts). Extract tools fetch their prompt at runtime via `supabaseGet('prompts?slug=eq.{slug}')` and include `system_prompt` + `user_prompt_template` in responses.

Slugs: `daily-review`, `weekly-summary`, `monthly-summary`, `extract-signals`, `extract-problems`, `extract-strategies`, `signal-synthesis`, `ask`, `show-and-tell`, `support-review`, `sales-report`, `bookings-report`

### Worker Secrets (set via `wrangler secret put`)

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — Database access
- `CF_ACCOUNT_ID`, `CF_API_TOKEN` — Cloudflare AI (embeddings)
- `MCP_AUTH_TOKEN` — OAuth access token for MCP endpoint
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — CF Access (MIS proxy auth)
- `PAULLAND_API_URL` — Pages API base URL (default: `https://paulland.io/api`)
- `PAULLAND_INTERNAL_API_KEY` — Internal API key for Pages API proxy

### Cloud Constraints

Tools run inside a Cloudflare Worker. They **cannot**:
- Read local files (`fs` module unavailable)
- Spawn processes (`child_process` unavailable)
- Use Node.js-specific APIs not in the Workers runtime

Tools that need file content (e.g. `support_review_extract`) fetch it from the asset library via `GET /api/assets/:id/content`. Files should be uploaded to the asset library first, then referenced by asset ID.

## Key Patterns & Conventions

- **API Supabase access**: Raw REST calls via `supabaseGet()`, `supabasePost()`, `supabasePatch()` helpers — NOT the Supabase JS client. These take `(url, key, path)` or `(url, key, table, data)`.
- **Frontend Supabase access**: Supabase JS client (`db = supabase.createClient(...)`) for reads.
- **Streaming**: `TransformStream` pipes Anthropic SSE → client. Used for competitor research, signal synthesis, and daily review.
- **HTML→Markdown**: Regex-based inline conversion for captured content (no external lib).
- **Icons**: Lucide CDN, `lucide.createIcons()` init, `refreshIcons()` after DOM changes.
- **CSS Variables**: `--void`, `--accent`, `--border`, `--text-body`, `--text-muted`, `--radius-sm/md/lg/pill`, `--shadow-sm/md/lg`, `--sans` (Inter), `--mono` (Inconsolata).

## Environment Variables

**Cloudflare Pages (set in dashboard or wrangler.toml bindings):**
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Service role key (bypasses RLS)
- `ANTHROPIC_API_KEY` — Claude API key for AI features
- `READWISE_TOKEN` — Readwise Reader API token (for feed capture)
- `OUTLOOK_ICS_URL` — Outlook calendar ICS feed URL
- `ASSETS_BUCKET` — R2 binding (configured in wrangler.toml)
- `AI` — Cloudflare AI binding (configured in wrangler.toml)
- `MIS_ENCRYPTION_KEY` — AES-GCM key for encrypting MIS tokens at rest (32 chars recommended)

**MCP Worker (set via `wrangler secret put` in `mcp-worker/`):**
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Service role key
- `CF_ACCOUNT_ID` — Cloudflare account ID (for AI embeddings)
- `CF_API_TOKEN` — Cloudflare API token (for AI embeddings)
- `MCP_AUTH_TOKEN` — OAuth access token for MCP endpoint auth
- `PAULLAND_API_URL` — Base URL for paulland.io API (default: `https://paulland.io/api`)
- `PAULLAND_INTERNAL_API_KEY` — Internal API key for Pages API proxy calls
- `CF_ACCESS_CLIENT_ID` — Cloudflare Access Service Token client ID (for MIS proxy auth)
- `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access Service Token client secret

**Legacy MIS env vars (optional fallback, superseded by Supabase-backed connections):**
- `WCP_REGION` — WCP cluster region
- `WCP_ECAN` — Esko Cloud Account Number
- `WCP_REPOID` — Repository ID
- `WCP_EQUIPMENT_TOKEN` — Equipment Token

## Security

- **RLS**: Enabled on all Supabase tables with no public policies. Only the service key has access.
- **Auth**: Cloudflare Access JWT validated on every API request.
- **No secrets in code**: All API keys in environment variables.
- **MIS Token Encryption**: Equipment Tokens encrypted at rest using AES-GCM. Encryption key stored only in Cloudflare env vars (`MIS_ENCRYPTION_KEY`). Tokens decrypted on-demand server-side when proxying API calls. Browser never sees stored tokens.

## Deployment

```bash
# Deploy admin/API to Cloudflare Pages (no build step — static HTML + Pages Functions)
npx wrangler pages deploy . --project-name=paulland-io --commit-dirty=true

# Deploy MCP server to Cloudflare Workers (required when tools change)
cd mcp-server && npm run build
cd ../mcp-worker && npx wrangler deploy
```

Both deploys are needed when MCP tools change. Pages deploy is sufficient for admin UI or API-only changes.

## Pending / Future Work

- Vertex logo integration (homepage, admin, favicon)
- PDF signal extraction (extract text from PDFs in asset library → extract signals)
- Signal auto-clustering (AI-assisted grouping of related signals)
- RAG chat history / multi-turn conversations
- AI auto-tagging on content capture
- Embedding versioning (track model versions, support re-embedding on model change)
- **MIS: Automation Engine API integration** — AE connection config exists but job creation/monitoring not yet implemented (awaiting API docs)
- **MIS: WCP job refresh** — `getJobDetails` endpoint returns 404/session errors; may need alternative identifier or updated token handling
- **MIS: Unified settings** — Consider merging admin and MIS settings into single page with shared appearance settings
- **MIS: CF Access Service Token** — Create a Service Token in CF dashboard and add to paulland.io Access policy to enable MCP server proxy calls (`submit_mis_job`, `list_customers`, `list_task_templates`)
