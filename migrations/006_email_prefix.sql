-- Migration: Add email_prefix to MIS connections for email routing
-- Date: 2026-04-12
-- Description: Allows each connection to have an optional email subject prefix
--              (e.g. "QA", "DEV", "PROD") that routes inbound emails to that connection.

ALTER TABLE mis_connections ADD COLUMN IF NOT EXISTS email_prefix text;

-- Set initial prefixes for existing connections
UPDATE mis_connections SET email_prefix = 'QA' WHERE id = '09aadee2-a7f7-4ff5-a4c2-8859338a6823';
UPDATE mis_connections SET email_prefix = 'DEV' WHERE id = '9b83adf4-346b-4942-a802-a63c46e2e77e';
UPDATE mis_connections SET email_prefix = 'PROD' WHERE id = '49178064-6e4e-45b3-b7eb-f066b445d323';
