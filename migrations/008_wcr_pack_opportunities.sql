-- Migration 008: WCR Pack opportunities weekly snapshots
-- Stores Salesforce WebCenter Pack opportunity data, one snapshot per weekly report.
-- Same opportunity_id appears N times across N report_dates → enables stage-transition
-- and value-drift analysis over time.

CREATE TABLE IF NOT EXISTS wcr_pack_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL,
  opportunity_id TEXT NOT NULL,
  opportunity_name TEXT,
  account_name TEXT,
  regional_division TEXT,
  region TEXT,
  opportunity_owner TEXT,
  software TEXT,
  main_products TEXT[],
  amount_usd NUMERIC,
  amount_software_usd NUMERIC,
  stage TEXT,
  close_date DATE,
  close_reason TEXT,
  close_reason_detail TEXT,
  close_comment TEXT,
  next_action TEXT,
  created_date DATE,
  marketing_generated BOOLEAN,
  source_file TEXT,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (report_date, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_stage ON wcr_pack_opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_close_date ON wcr_pack_opportunities(close_date);
CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_report ON wcr_pack_opportunities(report_date);
CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_owner ON wcr_pack_opportunities(opportunity_owner);
CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_account ON wcr_pack_opportunities(account_name);
CREATE INDEX IF NOT EXISTS idx_wcrpack_opps_reason ON wcr_pack_opportunities(close_reason_detail);

ALTER TABLE wcr_pack_opportunities ENABLE ROW LEVEL SECURITY;
