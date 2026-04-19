-- First-class tasks. daily_notes.tasks remains in place but becomes
-- deprecated/read-only once 012_tasks_backfill.sql has run — see
-- /api/tasks/backfill-from-daily-notes.

CREATE TABLE IF NOT EXISTS tasks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text        NOT NULL,
  description   text,
  status        text        NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo', 'doing', 'done', 'blocked')),
  priority      text        CHECK (priority IN ('high', 'medium', 'low') OR priority IS NULL),
  due_date      date,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Optional link back to where the task originated
  source_table  text,
  source_id     uuid,
  source_ref    text,         -- free-form, e.g. "Stand-up 2026-04-20"
  tags          text[]        DEFAULT '{}'::text[],
  metadata      jsonb         DEFAULT '{}'::jsonb,
  embedded_at   timestamptz
);

-- Queries the app hits most often
CREATE INDEX IF NOT EXISTS tasks_open_idx
  ON tasks (due_date NULLS LAST, priority)
  WHERE status <> 'done';

CREATE INDEX IF NOT EXISTS tasks_source_idx
  ON tasks (source_table, source_id);

CREATE INDEX IF NOT EXISTS tasks_completed_idx
  ON tasks (completed_at DESC)
  WHERE status = 'done';

CREATE INDEX IF NOT EXISTS tasks_due_date_idx
  ON tasks (due_date)
  WHERE status <> 'done';

-- Automatically bump updated_at on any change
CREATE OR REPLACE FUNCTION tasks_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  -- Keep completed_at in sync with status
  IF NEW.status = 'done' AND NEW.completed_at IS NULL THEN
    NEW.completed_at = now();
  ELSIF NEW.status <> 'done' AND OLD.status = 'done' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_set_updated_at_trg ON tasks;
CREATE TRIGGER tasks_set_updated_at_trg
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_set_updated_at();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Admin dashboard reads via the anon key behind Cloudflare Access.
CREATE POLICY "Allow anon read on tasks"
  ON tasks FOR SELECT
  USING (true);
