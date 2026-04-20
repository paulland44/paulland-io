-- Extend tasks.status to include 'cancelled' so the end-of-day review can
-- mark tasks as abandoned without overloading 'blocked' (which implies
-- stuck/waiting, not cancelled).

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo', 'doing', 'done', 'blocked', 'cancelled'));

-- Trigger already clears completed_at when status moves off 'done'. No
-- change needed: 'cancelled' rows naturally have completed_at = NULL.
