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
                │       └── Cloudflare AI (embeddings)
                │
                ├── index.html          (public homepage)
                └── admin/index.html    (admin dashboard SPA, ~8900 lines)
```

- **Hosting**: Cloudflare Pages — deploy with `npx wrangler pages deploy . --project-name=paulland-io --commit-dirty=true`
- **Auth**: Cloudflare Access JWT validation on all API routes
- **Database**: Supabase with RLS enabled on all tables. Service key bypasses RLS.
- **Companion service**: `capture-bot` (Python, Railway) handles background sync — see that repo's CLAUDE.md

## Database Schema (Supabase)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `content` | Articles, thoughts, reflections, signals, summaries | type, title, body, url, source, tags[], status, metadata, embedding |
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

## API Routes (`functions/api/[[path]].js`)

**GET:**
| Route | Handler | Purpose |
|-------|---------|---------|
| `calendar-events` | `handleCalendarEvents` | Fetch from Outlook ICS feed |
| `assets/r2-list` | `handleR2List` | List R2 bucket objects |
| `assets/file/:key` | `handleAssetServe` | Serve file from R2 |

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

**Sidebar Nav Groups**: Content (Articles, Thoughts, Signals, Reflections, Summaries), Sources (Feed Items, Feeds), Library (Assets, Tags), Knowledge (People, Companies, Products, Projects, Competition), Tools (Ask AI)

**Views**: Overview, Articles, Thoughts, Signals, Reflections, Summaries, Feed Items, Feeds, Assets, People, Companies, Products, Projects, Competition, Ask AI

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

## Security

- **RLS**: Enabled on all Supabase tables with no public policies. Only the service key has access.
- **Auth**: Cloudflare Access JWT validated on every API request.
- **No secrets in code**: All API keys in environment variables.

## Deployment

```bash
# Deploy to Cloudflare Pages
npx wrangler pages deploy . --project-name=paulland-io --commit-dirty=true
```

No build step required — static HTML files + Pages Functions are deployed directly.

## Pending / Future Work

- Vertex logo integration (homepage, admin, favicon)
- PDF signal extraction (extract text from PDFs in asset library → extract signals)
- Signal auto-clustering (AI-assisted grouping of related signals)
- RAG chat history / multi-turn conversations
- AI auto-tagging on content capture
- Embedding versioning (track model versions, support re-embedding on model change)
