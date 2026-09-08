import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import { spamStateEnum } from './enums.ts'
import { account } from './identity.ts'
import { company, contact } from './records.ts'

export const form = pgTable(
  'form',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The public address is /f/:slug, so the slug is the identity a marketer
     *  pastes into Webflow, not the uuid. */
    slug: text('slug').notNull(),
    /** Ordered fields: {key, type, label, placeholder, required, options,
     *  validation, visible_if, maps_to}. */
    schema: jsonb('schema').notNull().default([]),
    settings: jsonb('settings').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('form_slug_key').on(t.accountId, t.slug)],
)

export const formSubmission = pgTable(
  'form_submission',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => form.id, { onDelete: 'cascade' }),
    /** Every submitted value, including fields mapped to nothing, so no data is
     *  lost while somebody decides what a field means. */
    values: jsonb('values').notNull().default({}),
    /** D17's SEM container. Raw query string, referrer, landing page and user
     *  agent verbatim, so a gclid a future ad platform invents needs no backfill. */
    attribution: jsonb('attribution').notNull().default({}),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => company.id, { onDelete: 'set null' }),
    /** F4 stitches this to a person once it exists. Null when consent was declined,
     *  which is the whole point of the gate. */
    visitorId: text('visitor_id'),
    spamScore: integer('spam_score').notNull().default(0),
    spamState: spamStateEnum('spam_state').notNull().default('clean'),
    /** Reasons behind the score, so a human reviewing a false positive can see
     *  exactly which rule fired rather than guessing at a number. */
    spamReasons: jsonb('spam_reasons').notNull().default([]),
    /** Hashed with a rotating salt, never stored raw. 02-foundation.md §6. */
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    /** From the Webflow webhook's own submission id. A redelivery is a no-op
     *  rather than a second lead. */
    idempotencyKey: text('idempotency_key'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('form_submission_form_idx').on(t.accountId, t.formId, t.at.desc()),
    /** The review queue's only query: open quarantine, newest first. */
    index('form_submission_state_idx').on(t.accountId, t.spamState, t.at.desc()),
    index('form_submission_contact_idx').on(t.accountId, t.contactId),
    uniqueIndex('form_submission_idempotency_key')
      .on(t.accountId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
)

/** A file a stranger attached, before there is a submission to hang it on.
 *
 *  The browser is handed this row's id and nothing else, so it never names a
 *  storage key. A submission posts the id back and the row is claimed; one that
 *  is never claimed is a closed tab, and gets swept. */
export const formUpload = pgTable(
  'form_upload',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => form.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    submissionId: uuid('submission_id').references(() => formSubmission.id, {
      onDelete: 'cascade',
    }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_upload_storage_key').on(t.accountId, t.storageKey),
    index('form_upload_unclaimed_idx')
      .on(t.accountId, t.at)
      .where(sql`${t.submissionId} is null`),
    index('form_upload_submission_idx').on(t.accountId, t.submissionId),
  ],
)

/** Written before any tracking exists, and it is what makes F4 lawful. A row here
 *  is the evidence of a choice: which categories, under which policy version, when.
 *  Prior data stays under the consent in force when it was collected, so these are
 *  appended, never updated. */
export const consentRecord = pgTable(
  'consent_record',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(),
    /** {necessary: true, analytics: bool, advertisement: bool} — the same three
     *  categories today's HubSpot banner uses, so a stored choice maps across
     *  without re-prompting. 00-context.md §6. */
    categories: jsonb('categories').notNull(),
    policyVersion: text('policy_version').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_record_visitor_idx').on(t.accountId, t.visitorId, t.at.desc())],
)
