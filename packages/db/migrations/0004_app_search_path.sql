-- pg_trgm lives in the extensions schema. This sets the default path for direct and
-- session-mode connections; the transaction pooler overrides search_path per
-- session, which is why the search SQL also schema-qualifies its trigram calls.
ALTER ROLE rawr_app SET search_path = "$user", public, extensions;
