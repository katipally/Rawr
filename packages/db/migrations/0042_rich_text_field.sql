-- A long text field that can have a shape.
--
-- `long_text` is a textarea and renders as one paragraph of plain characters,
-- which is right for an address and wrong for the note somebody writes about an
-- account: a list of three things, a bolded name, a link to the contract.
--
-- Stored as Markdown rather than HTML, and that is the whole security design.
-- Nothing in Rawr has ever put user text through dangerouslySetInnerHTML — the
-- only uses are our own stylesheets — and storing HTML would mean either
-- sanitising on the way in, on the way out, or trusting it. Markdown rendered to
-- React elements has no injection surface at all: an angle bracket a person types
-- is a character, because it never becomes markup on any path.
--
-- Alone in this file: Postgres will not use an enum value in the transaction that
-- added it, and the migrator runs one transaction per file.

ALTER TYPE "rawr_field_type" ADD VALUE IF NOT EXISTS 'rich_text' AFTER 'long_text';
