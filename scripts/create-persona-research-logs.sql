-- Migration: Create persona_log and research_log tables for tracking incremental
-- updates to personas and research content from daily reviews, VOC sessions,
-- support reviews, and manual edits.

-- ─── persona_log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS persona_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  log_date DATE NOT NULL DEFAULT CURRENT_DATE,
  entry TEXT NOT NULL,
  source TEXT,
  source_ref JSONB DEFAULT '{}',
  section_updated TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE persona_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service key full access" ON persona_log FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_persona_log_content ON persona_log(content_id);
CREATE INDEX IF NOT EXISTS idx_persona_log_date ON persona_log(log_date DESC);

-- ─── research_log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  log_date DATE NOT NULL DEFAULT CURRENT_DATE,
  entry TEXT NOT NULL,
  source TEXT,
  source_ref JSONB DEFAULT '{}',
  section_updated TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE research_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service key full access" ON research_log FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_research_log_content ON research_log(content_id);
CREATE INDEX IF NOT EXISTS idx_research_log_date ON research_log(log_date DESC);

-- ─── Metadata enrichment: tag personas ───────────────────────
-- Mark all persona content items with reference_type metadata
UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "persona"}'::jsonb
WHERE type = 'reference'
  AND (title LIKE 'Persona -%' OR title LIKE 'Persona –%' OR title LIKE 'Persona —%'
       OR title IN ('CSR', 'Estimator', 'Brand Owner', 'Buyer', 'Graphic Designer',
                    'Manager', 'Managing Director', 'New Staff', 'Trainer',
                    'Workflow Operator', 'Warehouse Operator', 'Shipping Coordinator',
                    'Materials Manager', 'Quality Control Inspector', 'Press Operator',
                    'Prepress Operator', 'Production Manager', 'Production Supervisor',
                    'Sales Representative', 'Structural Designer', 'Finishing Operator',
                    'Customer', 'Customer IT', 'Customer Service Manager',
                    'Packaging Engineer'))
  AND (metadata->>'reference_type' IS NULL OR metadata->>'reference_type' != 'persona');

-- ─── Metadata enrichment: tag segment workflows ─────────────
UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "segment-workflow", "segment": "Labels"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%labels%workflow%' OR title ILIKE '%labels segment%' OR title ILIKE 'stage%labels%')
  AND (metadata->>'reference_type' IS NULL);

UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "segment-workflow", "segment": "Folding Carton"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%folding carton%workflow%' OR title ILIKE '%folding carton segment%' OR title ILIKE 'stage%folding carton%')
  AND (metadata->>'reference_type' IS NULL);

UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "segment-workflow", "segment": "Flexibles"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%flexibles%workflow%' OR title ILIKE '%flexibles segment%' OR title ILIKE 'stage%flexibles%')
  AND (metadata->>'reference_type' IS NULL);

UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "segment-workflow", "segment": "Corrugated"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%corrugated%workflow%' OR title ILIKE '%corrugated segment%' OR title ILIKE 'stage%corrugated%')
  AND (metadata->>'reference_type' IS NULL);

-- ─── Metadata enrichment: tag market research ────────────────
UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "market-research"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%job volumes%' OR title ILIKE '%market research%' OR title ILIKE '%pricing model%'
       OR title ILIKE '%strategic analysis%global packaging%')
  AND (metadata->>'reference_type' IS NULL);

-- ─── Metadata enrichment: tag strategic research ─────────────
UPDATE content
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reference_type": "strategic"}'::jsonb
WHERE type = 'reference'
  AND (title ILIKE '%high-level problems%' OR title ILIKE '%esko internal%'
       OR title ILIKE '%domain strategy%' OR title ILIKE '%naming convention%')
  AND (metadata->>'reference_type' IS NULL);
