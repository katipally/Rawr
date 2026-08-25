-- Without USAGE the app role cannot call extensions.similarity() at all, whatever
-- its search_path says. Read only: no CREATE, so the app cannot add an extension.
GRANT USAGE ON SCHEMA extensions TO rawr_app;
