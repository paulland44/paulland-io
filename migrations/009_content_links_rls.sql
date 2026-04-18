-- Allow anon read access on content_links and company_content
-- Both tables have RLS enabled but no SELECT policy for anon; the admin
-- dashboard uses the anon key (behind Cloudflare Access), so anon reads
-- were silently returning empty result sets, making links invisible in
-- the Pipeline dashboard even though the service-role writes succeeded.
-- Mirrors migration 004 for prompts.

CREATE POLICY "Allow anon read access on content_links"
  ON content_links FOR SELECT
  USING (true);

CREATE POLICY "Allow anon read access on company_content"
  ON company_content FOR SELECT
  USING (true);
