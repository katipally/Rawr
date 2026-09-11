-- The entity type enum goes.
--
-- 0046 moved every record pointer to text and 0066 took the last column,
-- import_run.object_type, with it. 0066 left the type in place on the argument
-- that keeping it costs nothing. It does cost something: a type in the schema
-- that nothing can use reads like a choice still open, and the drizzle export
-- for it kept showing up in searches for how a record pointer is stored.
--
-- Safe to run because no column holds it. If one somehow does, the drop fails
-- rather than cascading, which is the outcome to want.

DROP TYPE IF EXISTS rawr_entity_type;
