-- Hybrid search — step 3 of the Ask Jasper roadmap.
-- Adds Postgres full-text search as a second retrieval channel alongside
-- Cloudflare Vectorize. Pure semantic embedding misses exact-match queries
-- (product codes, partner names, problem IDs like "P3"). BM25-style FTS
-- picks those up; RRF fusion on the Pages side combines them with the
-- vector channel.
--
-- Pattern per table: a plain `search_tsv tsvector` column maintained by
-- a BEFORE INSERT/UPDATE trigger + a GIN index. Triggers sidestep the
-- generated-column immutability check that rejects to_tsvector (which
-- PostgreSQL treats as STABLE because the text→regconfig resolution
-- depends on search_path). Functionally identical for our purposes.
--
-- Idempotent: DROP COLUMN IF EXISTS / DROP TRIGGER IF EXISTS / CREATE
-- INDEX IF NOT EXISTS guards throughout. Safe to re-run.
--
-- After ALTER TABLE, a no-op UPDATE forces the trigger to run across
-- existing rows (backfill). On personal-scale volumes this completes
-- in seconds.

-- ─── content ────────────────────────────────────────────────
ALTER TABLE content DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE content ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.content_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.title, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.body, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_search_tsv_trg ON content;
CREATE TRIGGER content_search_tsv_trg BEFORE INSERT OR UPDATE ON content
  FOR EACH ROW EXECUTE FUNCTION content_update_search_tsv();

UPDATE content SET title = title;
CREATE INDEX IF NOT EXISTS content_search_tsv_idx ON content USING gin (search_tsv);

-- ─── daily_notes ────────────────────────────────────────────
ALTER TABLE daily_notes DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE daily_notes ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.daily_notes_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.notes, ''), 500000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.tasks, ''), 500000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.meetings, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daily_notes_search_tsv_trg ON daily_notes;
CREATE TRIGGER daily_notes_search_tsv_trg BEFORE INSERT OR UPDATE ON daily_notes
  FOR EACH ROW EXECUTE FUNCTION daily_notes_update_search_tsv();

UPDATE daily_notes SET note_date = note_date;
CREATE INDEX IF NOT EXISTS daily_notes_search_tsv_idx ON daily_notes USING gin (search_tsv);

-- ─── summaries ──────────────────────────────────────────────
ALTER TABLE summaries DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE summaries ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.summaries_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := setweight(to_tsvector('english', left(coalesce(NEW.content, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS summaries_search_tsv_trg ON summaries;
CREATE TRIGGER summaries_search_tsv_trg BEFORE INSERT OR UPDATE ON summaries
  FOR EACH ROW EXECUTE FUNCTION summaries_update_search_tsv();

UPDATE summaries SET type = type;
CREATE INDEX IF NOT EXISTS summaries_search_tsv_idx ON summaries USING gin (search_tsv);

-- ─── people ─────────────────────────────────────────────────
ALTER TABLE people DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE people ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.people_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.name, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(NEW.role, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.organization, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_search_tsv_trg ON people;
CREATE TRIGGER people_search_tsv_trg BEFORE INSERT OR UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION people_update_search_tsv();

UPDATE people SET name = name;
CREATE INDEX IF NOT EXISTS people_search_tsv_idx ON people USING gin (search_tsv);

-- ─── companies ──────────────────────────────────────────────
ALTER TABLE companies DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE companies ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.companies_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.name, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(NEW.type, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.industry, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.notes, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_search_tsv_trg ON companies;
CREATE TRIGGER companies_search_tsv_trg BEFORE INSERT OR UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_update_search_tsv();

UPDATE companies SET name = name;
CREATE INDEX IF NOT EXISTS companies_search_tsv_idx ON companies USING gin (search_tsv);

-- ─── products ───────────────────────────────────────────────
ALTER TABLE products DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE products ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.products_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.name, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.overview, ''), 500000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.description, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_search_tsv_trg ON products;
CREATE TRIGGER products_search_tsv_trg BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_update_search_tsv();

UPDATE products SET name = name;
CREATE INDEX IF NOT EXISTS products_search_tsv_idx ON products USING gin (search_tsv);

-- ─── projects ───────────────────────────────────────────────
ALTER TABLE projects DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE projects ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.projects_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.name, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(NEW.status, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.description, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_search_tsv_trg ON projects;
CREATE TRIGGER projects_search_tsv_trg BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_update_search_tsv();

UPDATE projects SET name = name;
CREATE INDEX IF NOT EXISTS projects_search_tsv_idx ON projects USING gin (search_tsv);

-- ─── people_log ─────────────────────────────────────────────
ALTER TABLE people_log DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE people_log ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.people_log_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := setweight(to_tsvector('english', left(coalesce(NEW.entry, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_log_search_tsv_trg ON people_log;
CREATE TRIGGER people_log_search_tsv_trg BEFORE INSERT OR UPDATE ON people_log
  FOR EACH ROW EXECUTE FUNCTION people_log_update_search_tsv();

UPDATE people_log SET note_date = note_date;
CREATE INDEX IF NOT EXISTS people_log_search_tsv_idx ON people_log USING gin (search_tsv);

-- ─── product_evidence ───────────────────────────────────────
ALTER TABLE product_evidence DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE product_evidence ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.product_evidence_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.evidence_type, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.evidence, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_evidence_search_tsv_trg ON product_evidence;
CREATE TRIGGER product_evidence_search_tsv_trg BEFORE INSERT OR UPDATE ON product_evidence
  FOR EACH ROW EXECUTE FUNCTION product_evidence_update_search_tsv();

UPDATE product_evidence SET note_date = note_date;
CREATE INDEX IF NOT EXISTS product_evidence_search_tsv_idx ON product_evidence USING gin (search_tsv);

-- ─── product_decisions ──────────────────────────────────────
ALTER TABLE product_decisions DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE product_decisions ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.product_decisions_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.decision, ''), 500000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.context, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_decisions_search_tsv_trg ON product_decisions;
CREATE TRIGGER product_decisions_search_tsv_trg BEFORE INSERT OR UPDATE ON product_decisions
  FOR EACH ROW EXECUTE FUNCTION product_decisions_update_search_tsv();

UPDATE product_decisions SET note_date = note_date;
CREATE INDEX IF NOT EXISTS product_decisions_search_tsv_idx ON product_decisions USING gin (search_tsv);

-- ─── reflections_log ────────────────────────────────────────
ALTER TABLE reflections_log DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE reflections_log ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.reflections_log_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.category, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.observation, ''), 500000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.coach_perspective, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reflections_log_search_tsv_trg ON reflections_log;
CREATE TRIGGER reflections_log_search_tsv_trg BEFORE INSERT OR UPDATE ON reflections_log
  FOR EACH ROW EXECUTE FUNCTION reflections_log_update_search_tsv();

UPDATE reflections_log SET note_date = note_date;
CREATE INDEX IF NOT EXISTS reflections_log_search_tsv_idx ON reflections_log USING gin (search_tsv);

-- ─── persona_log ────────────────────────────────────────────
ALTER TABLE persona_log DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE persona_log ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.persona_log_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.section_updated, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.entry, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persona_log_search_tsv_trg ON persona_log;
CREATE TRIGGER persona_log_search_tsv_trg BEFORE INSERT OR UPDATE ON persona_log
  FOR EACH ROW EXECUTE FUNCTION persona_log_update_search_tsv();

UPDATE persona_log SET log_date = log_date;
CREATE INDEX IF NOT EXISTS persona_log_search_tsv_idx ON persona_log USING gin (search_tsv);

-- ─── research_log ───────────────────────────────────────────
ALTER TABLE research_log DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE research_log ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.research_log_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.section_updated, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.entry, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_log_search_tsv_trg ON research_log;
CREATE TRIGGER research_log_search_tsv_trg BEFORE INSERT OR UPDATE ON research_log
  FOR EACH ROW EXECUTE FUNCTION research_log_update_search_tsv();

UPDATE research_log SET log_date = log_date;
CREATE INDEX IF NOT EXISTS research_log_search_tsv_idx ON research_log USING gin (search_tsv);

-- ─── tasks ──────────────────────────────────────────────────
ALTER TABLE tasks DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE tasks ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION public.tasks_update_search_tsv() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', left(coalesce(NEW.title, ''), 500000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(array_to_string(NEW.tags, ' '), ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.source_ref, ''), 500000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.description, ''), 500000)), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_search_tsv_trg ON tasks;
CREATE TRIGGER tasks_search_tsv_trg BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_update_search_tsv();

UPDATE tasks SET title = title;
CREATE INDEX IF NOT EXISTS tasks_search_tsv_idx ON tasks USING gin (search_tsv);

-- Drop the jasper_tsv helper from earlier attempts (no longer needed with triggers).
DROP FUNCTION IF EXISTS public.jasper_tsv(text);

-- ─── Unified search RPC ─────────────────────────────────────
-- One call, UNION ALL across every FTS-enabled table. Returns results in
-- the same shape searchVectorize produces so the Pages Function can merge
-- them via RRF without special-casing.
--
-- Uses websearch_to_tsquery for a natural-language-like query syntax
-- (quoted phrases, -negation, OR). ts_rank_cd supplies a relative score
-- — absolute value doesn't matter because RRF uses ranks, not scores.
-- ts_headline returns a snippet around the match for context-assembly
-- and UI preview.

CREATE OR REPLACE FUNCTION public.search_knowledge_fts(
  q TEXT,
  match_count INT DEFAULT 8,
  only_tables TEXT[] DEFAULT NULL
) RETURNS TABLE (
  source_table TEXT,
  source_id UUID,
  chunk_index INT,
  content_text TEXT,
  similarity REAL,
  title TEXT,
  item_type TEXT,
  item_date TEXT
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH tsq AS (SELECT websearch_to_tsquery('english', q) AS q),
  hits AS (
    SELECT 'content'::TEXT AS source_table, id AS source_id, 0 AS chunk_index,
           ts_headline('english', coalesce(title, '') || E'\n' || coalesce(body, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2') AS content_text,
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)) AS similarity,
           coalesce(title, '(untitled)') AS title,
           coalesce(type, '') AS item_type,
           coalesce(to_char(captured_at, 'YYYY-MM-DD'), '') AS item_date
    FROM content
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'content' = ANY(only_tables))
    UNION ALL
    SELECT 'daily_notes', id, 0,
           ts_headline('english', coalesce(notes, '') || E'\n' || coalesce(meetings, '') || E'\n' || coalesce(tasks, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'Daily Note ' || coalesce(to_char(note_date, 'YYYY-MM-DD'), ''),
           '',
           coalesce(to_char(note_date, 'YYYY-MM-DD'), '')
    FROM daily_notes
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'daily_notes' = ANY(only_tables))
    UNION ALL
    SELECT 'summaries', id, 0,
           ts_headline('english', coalesce(content, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(type, '') || ' Summary',
           coalesce(type, ''),
           coalesce(to_char(period_start, 'YYYY-MM-DD'), '')
    FROM summaries
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'summaries' = ANY(only_tables))
    UNION ALL
    SELECT 'people', id, 0,
           ts_headline('english', coalesce(name, '') || E'\n' || coalesce(role, '') || ' at ' || coalesce(organization, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=10, ShortWord=3, MaxFragments=1'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(name, 'Person'),
           '',
           ''
    FROM people
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'people' = ANY(only_tables))
    UNION ALL
    SELECT 'companies', id, 0,
           ts_headline('english', coalesce(name, '') || E'\n' || coalesce(notes, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=10, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(name, 'Company'),
           coalesce(type, ''),
           ''
    FROM companies
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'companies' = ANY(only_tables))
    UNION ALL
    SELECT 'products', id, 0,
           ts_headline('english', coalesce(name, '') || E'\n' || coalesce(overview, '') || E'\n' || coalesce(description, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(name, 'Product'),
           '',
           ''
    FROM products
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'products' = ANY(only_tables))
    UNION ALL
    SELECT 'projects', id, 0,
           ts_headline('english', coalesce(name, '') || E'\n' || coalesce(description, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(name, 'Project'),
           coalesce(status, ''),
           ''
    FROM projects
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'projects' = ANY(only_tables))
    UNION ALL
    SELECT 'people_log', id, 0,
           ts_headline('english', coalesce(entry, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=1'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'People Note ' || coalesce(to_char(note_date, 'YYYY-MM-DD'), ''),
           '',
           coalesce(to_char(note_date, 'YYYY-MM-DD'), '')
    FROM people_log
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'people_log' = ANY(only_tables))
    UNION ALL
    SELECT 'product_evidence', id, 0,
           ts_headline('english', coalesce(evidence, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=1'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(evidence_type, 'Product evidence'),
           coalesce(evidence_type, ''),
           coalesce(to_char(note_date, 'YYYY-MM-DD'), '')
    FROM product_evidence
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'product_evidence' = ANY(only_tables))
    UNION ALL
    SELECT 'product_decisions', id, 0,
           ts_headline('english', coalesce(decision, '') || E'\n' || coalesce(context, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'Decision ' || coalesce(to_char(note_date, 'YYYY-MM-DD'), ''),
           '',
           coalesce(to_char(note_date, 'YYYY-MM-DD'), '')
    FROM product_decisions
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'product_decisions' = ANY(only_tables))
    UNION ALL
    SELECT 'reflections_log', id, 0,
           ts_headline('english', coalesce(observation, '') || E'\n' || coalesce(coach_perspective, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'Reflection — ' || coalesce(category, 'leadership'),
           coalesce(category, ''),
           coalesce(to_char(note_date, 'YYYY-MM-DD'), '')
    FROM reflections_log
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'reflections_log' = ANY(only_tables))
    UNION ALL
    SELECT 'persona_log', id, 0,
           ts_headline('english', coalesce(entry, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=1'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'Persona — ' || coalesce(section_updated, 'general'),
           coalesce(section_updated, ''),
           coalesce(to_char(log_date, 'YYYY-MM-DD'), '')
    FROM persona_log
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'persona_log' = ANY(only_tables))
    UNION ALL
    SELECT 'research_log', id, 0,
           ts_headline('english', coalesce(entry, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=1'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           'Research — ' || coalesce(section_updated, 'general'),
           coalesce(section_updated, ''),
           coalesce(to_char(log_date, 'YYYY-MM-DD'), '')
    FROM research_log
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'research_log' = ANY(only_tables))
    UNION ALL
    SELECT 'tasks', id, 0,
           ts_headline('english', coalesce(title, '') || E'\n' || coalesce(description, ''), (SELECT q FROM tsq), 'MaxWords=35, MinWords=15, ShortWord=3, MaxFragments=2'),
           ts_rank_cd(search_tsv, (SELECT q FROM tsq)),
           coalesce(title, 'Task'),
           coalesce(status, ''),
           coalesce(to_char(due_date, 'YYYY-MM-DD'), '')
    FROM tasks
    WHERE search_tsv @@ (SELECT q FROM tsq)
      AND (only_tables IS NULL OR 'tasks' = ANY(only_tables))
  )
  SELECT source_table, source_id, chunk_index, content_text, similarity, title, item_type, item_date
  FROM hits
  ORDER BY similarity DESC
  LIMIT match_count
$$;

-- Allow the anon role (service key bypasses RLS; anon used by frontend)
-- to execute the RPC. No write side effects — read-only.
GRANT EXECUTE ON FUNCTION public.search_knowledge_fts(TEXT, INT, TEXT[]) TO anon, authenticated, service_role;
