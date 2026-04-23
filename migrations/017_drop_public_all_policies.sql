-- Drop overly-permissive RLS policies scoped to {public}
-- Supabase lint flagged 17 policies named "Service role full access" (or
-- similar) that were intended for service_role but declared without a
-- `TO service_role` clause — so they applied to the `public` role, which
-- in Postgres includes `anon`. Combined with `USING (true)` and
-- `WITH CHECK (true)` for `FOR ALL`, this silently granted the anon key
-- full insert/update/delete on 17 tables. The anon key is embedded in
-- admin/index.html behind Cloudflare Access — not a secret.
--
-- service_role bypasses RLS by default, so these policies were pure
-- redundancy on the service side while opening a hole on the anon side.
-- Two admin writes that relied on them (content update, products insert)
-- have been rerouted through Pages API handlers that use the service key.
-- Remaining anon read access is preserved by the separate "Anon read access"
-- SELECT policies (cmd = SELECT, USING true) — those are intentional.

DROP POLICY IF EXISTS "Service role full access" ON ai_reviews;
DROP POLICY IF EXISTS "Service role full access" ON calendar_events;
DROP POLICY IF EXISTS "Service role full access" ON content;
DROP POLICY IF EXISTS "Service role full access" ON daily_notes;
DROP POLICY IF EXISTS "Service role full access" ON explore_sessions;
DROP POLICY IF EXISTS "Service role full access" ON people;
DROP POLICY IF EXISTS "Service role full access" ON people_log;
DROP POLICY IF EXISTS "Service key full access"  ON persona_log;
DROP POLICY IF EXISTS "Service role full access" ON product_decisions;
DROP POLICY IF EXISTS "Service role full access" ON product_evidence;
DROP POLICY IF EXISTS "Service role full access" ON products;
DROP POLICY IF EXISTS "Service role full access" ON project_updates;
DROP POLICY IF EXISTS "Service role full access" ON projects;
DROP POLICY IF EXISTS "Service role full access" ON reflections_log;
DROP POLICY IF EXISTS "Service key full access"  ON research_log;
DROP POLICY IF EXISTS "Service role full access" ON summaries;
DROP POLICY IF EXISTS "Service role full access" ON sync_state;
