-- Migration: Email → AE → WCP enrichment pipeline
-- Date: 2026-04-22
-- Description:
--   Adds the fields required for the two-stage AE job lifecycle. The email
--   worker submits a minimal job to Automation Engine; AE provisions the
--   corresponding WCP project (preserving our jobId/jobPartId); the
--   capture-worker's enrichment poller then sweeps rows in AE-Submitted
--   state, searches WCP via S2, and upserts the full property set (plus
--   uploads any staged R2 attachments) via S2's POST /projects upsert.
--
--   Status lifecycle for AE-path rows:
--     AE-Submitted  → WCP-Enriched  (success)
--                   → Enrichment-Failed  (poller exhausted retries)
--                   → AE-Failed          (AE itself rejected the create)

-- Payload the poller will POST to S2 once the WCP project appears.
-- Stored up-front by the email worker so the poller doesn't need any
-- context from the original extraction.
ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS enrichment_payload jsonb;

-- Retry tracking for the enrichment poller.
ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS enrichment_attempts int DEFAULT 0;
ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS enrichment_next_at timestamptz;
ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

-- R2 keys for attachments staged during email processing — uploaded to
-- the WCP project during enrichment, then deleted from R2. Shape:
--   [{ key, filename, mime, category }]
ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS pending_attachments jsonb;

-- Partial index so the poller can cheaply find due rows without scanning
-- the full table. Only covers AE-Submitted because WCP-Enriched and
-- Enrichment-Failed rows are terminal.
CREATE INDEX IF NOT EXISTS idx_mis_jobs_enrichment_due
  ON mis_jobs (enrichment_next_at)
  WHERE status = 'AE-Submitted';

-- Pointer from an AE connection to the S2 connection used for reads and
-- enrichment writes. The poller falls back to matching by cluster if
-- this is NULL, but setting it explicitly is strongly recommended.
ALTER TABLE mis_connections
  ADD COLUMN IF NOT EXISTS enrichment_connection_id uuid REFERENCES mis_connections(id);
