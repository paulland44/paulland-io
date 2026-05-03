-- Tracks every LLM call made by paulland.io — Pages Functions API handlers,
-- MCP server workflow tools, and (later) agents-worker schedules. Drives:
--   • the cost dashboard (Live Artifact in Cowork, plus mobile slim panel)
--   • the Skill Auditor agent (reads quality_flag IS NOT NULL rows + recent
--     low-quality outputs to propose prompt edits)
--   • per-feature cost trend analysis
--
-- One row per call. Written by the service-role key (Pages handlers + MCP
-- worker) so RLS-bypass works automatically. Anon SELECT is granted so the
-- admin / artifact code can render aggregates without service-key exposure.

CREATE TABLE IF NOT EXISTS usage_events (
  id                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             timestamptz    NOT NULL DEFAULT now(),

  -- Where the call originated and what it did
  surface                text           NOT NULL,         -- 'api' | 'mcp' | 'agent'
  feature                text           NOT NULL,         -- 'ask' | 'ask_stream' | 'signal_synthesis' | 'daily_review_extract' | …
  prompt_id              text,                            -- slug from `prompts` table when the call uses a stored prompt
  prompt_version         integer,                         -- for future prompt-version tracking; NULL until that lands

  -- Model + tokens
  model                  text,                            -- 'claude-opus-4-7' | 'claude-sonnet-4-6' | '@cf/baai/bge-base-en-v1.5' | …
  tokens_in              integer        DEFAULT 0,
  tokens_out             integer        DEFAULT 0,
  cache_creation_tokens  integer        DEFAULT 0,        -- prompt-cache writes (Anthropic)
  cache_read_tokens      integer        DEFAULT 0,        -- prompt-cache hits (Anthropic)

  -- Estimated USD cost (computed at write-time from model + token counts)
  cost_est               numeric(10, 6) DEFAULT 0,

  -- Quality signal (set later by user / Skill Auditor; NULL means not yet reviewed)
  quality_flag           text,                            -- NULL | 'good' | 'bad' | 'needs_review'
  quality_note           text,

  -- Lightweight observability
  output_excerpt         text,                            -- first ~200 chars of model output for eyeballing
  duration_ms            integer,
  error                  text,                            -- non-NULL when the call failed mid-flight
  metadata               jsonb          DEFAULT '{}'::jsonb,

  -- Loose correlation with `ai_usage_errors` and any external request IDs
  request_id             text
);

-- Time-window queries: cost panel "last 7 days", agent triggers
CREATE INDEX IF NOT EXISTS usage_events_created_at_idx
  ON usage_events (created_at DESC);

-- Per-feature analysis: drill-down in cost panel, prompt audit
CREATE INDEX IF NOT EXISTS usage_events_feature_created_at_idx
  ON usage_events (feature, created_at DESC);

-- Skill Auditor lookups: only flagged rows
CREATE INDEX IF NOT EXISTS usage_events_quality_flag_idx
  ON usage_events (quality_flag, created_at DESC)
  WHERE quality_flag IS NOT NULL;

-- Per-prompt audit: the Skill Auditor groups by prompt_id
CREATE INDEX IF NOT EXISTS usage_events_prompt_id_idx
  ON usage_events (prompt_id, created_at DESC)
  WHERE prompt_id IS NOT NULL;

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- Anon read so the cost dashboard (Live Artifact + admin panel) can aggregate
-- without holding the service key in the client.  Service role bypasses RLS
-- for writes from Pages handlers, MCP server, and the future agents-worker.
CREATE POLICY "Allow anon read on usage_events"
  ON usage_events FOR SELECT
  USING (true);
