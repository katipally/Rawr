-- A stored message can now keep its Bcc and Reply-To addresses. Until this release
-- neither was kept: Bcc was written into the MIME for delivery and then forgotten, and
-- Reply-To was never read. Both are kept now, in the same shape as to and cc.
--
-- Rows stored before this release keep an empty list, which is the same as a message
-- that had no Bcc or Reply-To header. A Gmail re-sync of an old row does not fill them in.
ALTER TABLE public.message ADD COLUMN IF NOT EXISTS bcc_addrs text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.message ADD COLUMN IF NOT EXISTS reply_to_addrs text[] NOT NULL DEFAULT '{}';
