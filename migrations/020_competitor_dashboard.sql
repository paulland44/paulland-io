-- Migration: Competitor dashboard schema
-- Date: 2026-05-03
-- Description:
--   Adds the fields the competitor dashboard needs:
--
--   1. companies.competitor_status — softens the existing is_competitor
--      boolean into a tri-state. The dashboard surfaces both 'active' and
--      'prospective' competitors; 'former' rows are kept for history but
--      excluded from default views. NULL means "not a competitor".
--
--      Values: 'active' | 'prospective' | 'former' | NULL
--
--      Backfilled from is_competitor — every row currently flagged as a
--      competitor becomes 'active'. The is_competitor boolean is kept for
--      backwards compatibility with anything that reads it.
--
--   2. companies.battle_card — structured JSONB for competitive battle
--      card content. Each subsection is independently editable from the
--      dashboard. Schema (all keys optional, all string arrays):
--
--        {
--          "positioning":       "One-line positioning vs us",
--          "our_advantages":    ["..."],
--          "their_advantages":  ["..."],
--          "common_objections": [{ "objection": "...", "response": "..." }],
--          "win_themes":        ["..."],
--          "loss_themes":       ["..."],
--          "pricing_notes":     "...",
--          "talking_points":    ["..."],
--          "do_not_say":        ["..."],
--          "last_reviewed":     "YYYY-MM-DD",
--          "reviewed_by":       "..."
--        }
--
--   3. Convention (no schema change): signals carry a category tag in
--      content.metadata.category, one of:
--        'product' | 'people' | 'gtm' | 'financial' | 'tech' | 'customer'
--      The competitor-watch agent sets this when it writes signals; the
--      dashboard groups by it.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS competitor_status text;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS battle_card jsonb DEFAULT '{}'::jsonb;

-- Backfill: every existing competitor becomes 'active'.
UPDATE companies
   SET competitor_status = 'active'
 WHERE is_competitor = true
   AND competitor_status IS NULL;

-- Constraint on allowed values. NULL is permitted (= not a competitor).
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_competitor_status_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_competitor_status_check
  CHECK (competitor_status IS NULL OR competitor_status IN ('active', 'prospective', 'former'));

-- Partial index so the Competition list view can cheaply pull active +
-- prospective rows without scanning the full companies table.
CREATE INDEX IF NOT EXISTS idx_companies_competitor_status
  ON companies (competitor_status)
  WHERE competitor_status IS NOT NULL;
