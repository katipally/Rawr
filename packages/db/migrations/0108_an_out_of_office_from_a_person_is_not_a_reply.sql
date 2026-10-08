-- An out-of-office sent from a person's own address was counted as a reply on the
-- timeline, in the reply lag and on the deal score. Sender addresses alone cannot
-- catch it, and the subject and headers were never kept.
--
-- Ingest now classifies each message once, from its headers and subject, and stores
-- the answer here. Every reply count reads this flag.
--
-- Rows stored before this release keep false: their headers and subject were not
-- kept, so they cannot be classified now.

ALTER TABLE public.message ADD COLUMN IF NOT EXISTS is_auto_reply boolean NOT NULL DEFAULT false;
