-- Migration: APNS device tokens for paulland-mis push notifications
-- Date: 2026-05-16
-- Description:
--   The paulland-mis iOS / macOS app registers its APNS device token here so
--   the capture-worker enrichment poller can fire pushes on AE → WCP status
--   transitions. Tokens are stored per (token, bundle_id) — `bundle_id` lets
--   future apps (e.g. PaullandApp) share the table without collision.
--
--   environment column distinguishes Xcode-debug builds (development) from
--   TestFlight / App Store builds (production), so the worker can pick the
--   right APNS host (api.development.push.apple.com vs api.push.apple.com).

CREATE TABLE IF NOT EXISTS device_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL,
  platform    text NOT NULL,                 -- 'ios' | 'macos'
  bundle_id   text NOT NULL,                 -- e.g. 'io.paulland.misapp'
  environment text NOT NULL DEFAULT 'development', -- 'development' | 'production'
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per token. A token belongs to exactly one bundle on one device.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_token ON device_tokens (token);

-- Quick lookup by bundle when fanning out a push.
CREATE INDEX IF NOT EXISTS idx_device_tokens_bundle ON device_tokens (bundle_id);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- No public policy. The service-role key (used by the API and capture-worker)
-- bypasses RLS; everyone else gets no rows.
