-- Add read access policy for prompts table
-- The admin dashboard uses the anon key for reads, so prompts need a SELECT policy
CREATE POLICY "Allow anon read access on prompts"
  ON prompts FOR SELECT
  USING (true);
