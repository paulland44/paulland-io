-- Migration: Workflow instance status polling
-- Date: 2026-05-06
-- Description:
--   Adds two columns to mis_jobs to support polling and persisting the
--   live state of S2 workflow instances launched against MIS jobs:
--
--     workflow_instance_status      — last-known S2 state (Running, Completed, Failed, Cancelled)
--     workflow_instance_checked_at  — timestamp of last successful poll
--
--   These let the admin monitor render a workflow status pill alongside
--   the existing job status badge without waiting for the next poll on
--   page load. The partial index keeps the polling lookup cheap as the
--   table grows: only rows that are still actively pollable (have an
--   instance ID and aren't in a terminal state) are indexed.

ALTER TABLE mis_jobs
  ADD COLUMN IF NOT EXISTS workflow_instance_status text,
  ADD COLUMN IF NOT EXISTS workflow_instance_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mis_jobs_workflow_polling
  ON mis_jobs (workflow_instance_id)
  WHERE workflow_instance_id IS NOT NULL
    AND workflow_instance_status IS DISTINCT FROM 'Completed'
    AND workflow_instance_status IS DISTINCT FROM 'Failed'
    AND workflow_instance_status IS DISTINCT FROM 'Cancelled';
