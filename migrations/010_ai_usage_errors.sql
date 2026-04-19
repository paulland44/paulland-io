-- Tracks failures from AI providers (Anthropic, Cloudflare Workers AI) so the
-- admin UI can surface an amber badge when calls are failing. Written by the
-- service-role key from functions/api/[[path]].js — no anon access needed.

CREATE TABLE IF NOT EXISTS ai_usage_errors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text        NOT NULL,          -- anthropic | cloudflare_ai | cloudflare_ai_rest
  model       text,
  endpoint    text,                           -- ask | synthesis | summary | daily_review | extract | embed
  status      integer,
  message     text,
  resolved_at timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_errors_unresolved_idx
  ON ai_usage_errors (created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE ai_usage_errors ENABLE ROW LEVEL SECURITY;

-- Anon can read unresolved errors so the admin topbar badge query works via
-- the supabase JS client. Service role writes bypass RLS.
CREATE POLICY "Allow anon read on ai_usage_errors"
  ON ai_usage_errors FOR SELECT
  USING (true);
