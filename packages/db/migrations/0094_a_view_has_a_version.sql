-- A shared view is edited by whoever has it open, and a save overwrote the last one
-- without saying so. The version is what the editor read; a save that is not
-- carrying the current one is refused.
ALTER TABLE public.saved_view ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
