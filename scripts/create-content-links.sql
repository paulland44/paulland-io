-- Content Links: junction table for linking content items to each other
-- Enables: signal→problem, article→problem, problem→problem, etc.

CREATE TABLE IF NOT EXISTS content_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'related',
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_id, target_id, link_type)
);

-- Indexes for efficient lookups in both directions
CREATE INDEX IF NOT EXISTS idx_content_links_source ON content_links(source_id);
CREATE INDEX IF NOT EXISTS idx_content_links_target ON content_links(target_id);
CREATE INDEX IF NOT EXISTS idx_content_links_type ON content_links(link_type);

-- RLS: service key only (matches other tables)
ALTER TABLE content_links ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE content_links IS 'Links between content items (signals→problems, articles→problems, problem→problem)';
COMMENT ON COLUMN content_links.link_type IS 'Type of relationship: evidence, related, derived_from, supports';
COMMENT ON COLUMN content_links.context IS 'Brief description of why these items are linked';
