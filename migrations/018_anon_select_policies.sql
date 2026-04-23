-- Add anon SELECT policies on three tables the admin reads directly
-- After migration 017 dropped the overly-permissive {public} FOR ALL
-- policies, these tables ended up with RLS enabled but no policies, so
-- anon reads silently return []. The admin dashboard reads them via the
-- anon key (behind Cloudflare Access) for persona history and product
-- detail pages — mirrors the pattern in migrations 009 and 014.
--
-- Not included here (intentionally locked down, service-key only):
--   mis_connections, mis_jobs  — accessed via /api/mis/* handlers
--   research_log                — not read from the admin via anon
--   sync_state                  — worker-only state

CREATE POLICY "Allow anon read access on persona_log"
  ON persona_log FOR SELECT
  USING (true);

CREATE POLICY "Allow anon read access on product_content"
  ON product_content FOR SELECT
  USING (true);

CREATE POLICY "Allow anon read access on product_assets"
  ON product_assets FOR SELECT
  USING (true);
