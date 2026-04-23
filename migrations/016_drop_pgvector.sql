-- Drop the unused pgvector extension
-- Embeddings migrated from Supabase to Cloudflare Vectorize on 2026-04-23
-- (commit 074584f). Code verified: embeddings.ts only writes `embedded_at`
-- (timestamp); the vector payload goes to Vectorize via replaceSourceVectors().
-- Two `vector` columns remained on content + wcr_pack_opportunities — both
-- dead weight. Dropping them lets us drop the extension and clear the
-- "Extension in Public" lint warning.

ALTER TABLE content DROP COLUMN IF EXISTS embedding;
ALTER TABLE wcr_pack_opportunities DROP COLUMN IF EXISTS embedding;

DROP EXTENSION IF EXISTS vector;
