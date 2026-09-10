-- A custom object can be imported into.
--
-- 0046 turned every entity_type into text and left this one column on the enum
-- on purpose, saying so out loud: importing into a custom object was not built,
-- so the column genuinely held one of three. It is built now, and the column
-- follows the same trade the rest made. `object_def` is what says which keys
-- exist, and the data access layer resolves the object through the registry
-- before it writes anything.
--
-- `rawr_entity_type` has no columns left after this. It is left in place rather
-- than dropped: nothing costs anything to keep, and dropping a type is not a
-- migration anybody can undo in a hurry.

ALTER TABLE "import_run" ALTER COLUMN "object_type" TYPE text USING "object_type"::text;
