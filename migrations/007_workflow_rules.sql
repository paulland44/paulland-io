-- Migration: Add workflow_rules to MIS connections
-- Date: 2026-04-17
-- Description: Stores per-connection rules mapping extracted email request_type
--              (change_request, new_artwork, reprint, new_job) to S2 workflow
--              template IDs, plus an optional default_template_id fallback.
--              Shape: { rules: [{ request_type, template_id, template_name }], default_template_id }

ALTER TABLE mis_connections ADD COLUMN IF NOT EXISTS workflow_rules JSONB;
