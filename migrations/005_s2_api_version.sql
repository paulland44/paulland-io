-- Migration: Add S2 API version support to MIS connections
-- Date: 2026-04-11
-- Description: Adds api_version and base_url columns to mis_connections table
--              to support the new Esko S2 Public MIS API alongside legacy WCP endpoints.

-- Add api_version column (legacy = old WCP API, s2 = new S2 MIS API)
ALTER TABLE mis_connections
ADD COLUMN IF NOT EXISTS api_version text DEFAULT 'legacy'
CHECK (api_version IN ('legacy', 's2'));

-- Add base_url column for S2 connections (full base URL e.g. https://ae.org.esko.cloud)
ALTER TABLE mis_connections
ADD COLUMN IF NOT EXISTS base_url text;

-- Add project_node_id to mis_jobs for tracking S2 project references
ALTER TABLE mis_jobs
ADD COLUMN IF NOT EXISTS project_node_id text;

-- Add workflow_instance_id to mis_jobs for tracking launched workflow instances
ALTER TABLE mis_jobs
ADD COLUMN IF NOT EXISTS workflow_instance_id text;
