-- Pin search_path on trigger functions
-- Supabase lint flagged these as "Function Search Path Mutable" — without
-- an explicit search_path, a malicious role could shadow builtins by
-- creating objects in a schema higher on the resolution path. Low severity
-- since writes go through the service key, but trivial to harden.

ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.tasks_set_updated_at() SET search_path = public, pg_temp;
