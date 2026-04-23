-- Enable RLS on wcr_pack_opportunities + allow anon SELECT
-- Migration 008 declared ENABLE ROW LEVEL SECURITY but the Supabase linter
-- reports RLS still disabled on public.wcr_pack_opportunities — either the
-- ALTER never applied or the table was recreated without it. This migration
-- is idempotent and also adds the anon SELECT policy the admin dashboard
-- needs (reads via anon key behind Cloudflare Access, mirrors migration 009).

ALTER TABLE wcr_pack_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon read access on wcr_pack_opportunities" ON wcr_pack_opportunities;

CREATE POLICY "Allow anon read access on wcr_pack_opportunities"
  ON wcr_pack_opportunities FOR SELECT
  USING (true);
