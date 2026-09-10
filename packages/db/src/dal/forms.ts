import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { consentRecord, form, formFolder, formSubmission, formUpload } from '../schema/forms.ts'
import { recordActivity } from './activity.ts'
import { readAttribution, type Attribution, type AttributionInput } from './attribution.ts'
import { assertCanWrite, type AccountContext } from './context.ts'
import {
  assertSchemaIsUsable,
  FORM_SLUG,
  readPropertyRules,
  readSchema,
  readSettings,
  type FormField,
  type FormSettings,
  type PropertyRules,
} from './form-schema.ts'
import { emailFrom, validateAnswers, type FieldError } from './form-validate.ts'
import { mapAnswersToColumns, upsertCapturedPerson, type CapturedPerson } from './people.ts'
import { isUuid, mutate, withAccount, writeAudit, type Tx } from './index.ts'
import { answersFingerprint, applyChallenge, scoreSubmission, type SpamVerdict } from './spam.ts'
import { notify, resolveNotifications } from './notifications.ts'
import { aliasVisitor } from './stitch.ts'
import { listSubscriptionTypes, requestOptIn } from './subscriptions.ts'

/** The public edge acts with marketing's ceiling: it may create and update
 *  contacts and companies, and it may not touch deals, pipelines, the field
 *  registry or anything else. That is exactly the authority a form fill needs.
 *
 *  Built here and nowhere else, so no route can hand itself a wider role. The
 *  actor kind is 'public' rather than 'integration', so the audit log reads as
 *  what it is: a stranger on the internet, not a named third party. */
/** A stranger on the public edge writes what a form capture needs and nothing
 *  else: contacts and marketing, never the account itself. */
export const publicEdgeContext = (accountId: string): AccountContext => ({
  accountId,
  actorId: null,
  actorKind: 'public',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: ['contacts', 'marketing'],
  criticalGrants: [],
})

export type PublicForm = {
  accountId: string
  /** Needed wherever the edge builds a link back into the CRM, which addresses
   *  its tenant in the path. Resolved with the form, not looked up after. */
  accountSlug: string
  formId: string
  name: string
  slug: string
  fields: FormField[]
  settings: FormSettings
  isActive: boolean
  /** Conditional logic on the properties this form writes to, resolved with the
   *  form because the edge holds no account scope of its own and cannot read the
   *  registry itself. */
  rules: PropertyRules
}

type PublicFormRow = {
  account_id: string
  account_slug: string
  form_id: string
  name: string
  slug: string
  schema: unknown
  settings: unknown
  is_active: boolean
  rules: unknown
}

const toPublicForm = (row: PublicFormRow): PublicForm => ({
  accountId: row.account_id,
  accountSlug: row.account_slug,
  formId: row.form_id,
  name: row.name,
  slug: row.slug,
  fields: readSchema(row.schema),
  settings: readSettings(row.settings),
  isActive: row.is_active,
  rules: readPropertyRules(row.rules),
})

/** The one question the public edge has to ask before it has an account. Goes
 *  through a security-definer function that takes a form id and returns nothing
 *  but that form's public shape, so there is no path from here to a record. */
export const publicFormById = async (formId: string): Promise<PublicForm | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(formId)) return null
  const rows = await appDb.execute<PublicFormRow>(sql`select * from rawr.public_form(${formId})`)
  const row = rows[0]
  return row ? toPublicForm(row) : null
}

export const publicFormBySlug = async (
  accountSlug: string,
  slug: string,
): Promise<PublicForm | null> => {
  const rows = await appDb.execute<PublicFormRow>(
    sql`select * from rawr.public_form_by_slug(${accountSlug}, ${slug})`,
  )
  const row = rows[0]
  return row ? toPublicForm(row) : null
}

export type SubmitInput = {
  form: PublicForm
  /** The posted body, before the allowlist. Honeypot and timing live here. */
  body: Record<string, unknown>
  attribution: AttributionInput
  ipHash: string | null
  userAgent: string | null
  visitorId: string | null
  /** True for the no-JS hosted page and the Webflow webhook, where the honeypot
   *  and timing token cannot exist. */
  degradedSignals: boolean
  /** Resolved by the caller, because reaching Turnstile is a network call and the
   *  data access layer makes none. */
  challenge: 'passed' | 'failed' | 'unavailable' | 'not-required'
  idempotencyKey?: string | null | undefined
  /** Set when a quarantined submission is released later. The activity keeps the
   *  original timestamp so the timeline does not claim the lead arrived today. */
  occurredAt?: Date | undefined
}

export type SubmitResult = {
  submissionId: string
  state: SpamVerdict['state'] | 'released'
  contactId: string | null
  companyId: string | null
  /** Present only when validation failed. Nothing is written in that case. */
  errors?: FieldError[] | undefined
  /** True when an idempotency key matched an existing row and nothing was written. */
  duplicate?: boolean | undefined
  /** What the caller should show, resolved from settings. */
  success?: { mode: 'message' | 'redirect'; value: string } | undefined
  /** Set when the caller must render a challenge and re-post. */
  challengeRequired?: boolean | undefined
  /** Opt-ins on types that ask for confirmation, for the caller to mail. Outside
   *  this transaction for the reason the Slack notice is: nothing here talks to a
   *  provider, and a form fill must not fail because Gmail was slow. */
  confirmations?:
    | { token: string; typeName: string; contactEmail: string; contactFirstName: string | null }[]
    | undefined
  /** For the Slack job, which runs outside this transaction. */
  notify?:
    | {
        formName: string
        contactId: string
        values: Record<string, unknown>
        attribution: Attribution
        /** The channel this form names, if it names one. A bot token can post
         *  anywhere; a webhook is bound to the channel it was created for and
         *  ignores it. */
        channel: string | null
      }
    | undefined
}

/** How long two identical submissions count as the same one. F3 §5. */
const DUPLICATE_WINDOW_SECONDS = 60

/** Bigger than this is not something a stranger attaches to a web form, and every
 *  storage service bills for what it holds. */
export const MAX_FORM_UPLOAD_BYTES = 10 * 1024 * 1024

/** What a form accepts. An allowlist rather than a blocklist: the danger is not
 *  the extensions somebody thought of, it is the one they did not. */
export const FORM_UPLOAD_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
])

const fileIdsIn = (fields: FormField[], answers: Record<string, unknown>): string[] =>
  fields.flatMap((field) => {
    if (field.type !== 'file') return []
    const id = String(answers[field.key] ?? '')
    return id ? [id] : []
  })

/** Which of these ids this form issued and nothing has claimed yet. */
const unclaimedUploads = async (
  tx: Tx,
  formId: string,
  ids: string[],
): Promise<string[]> => {
  const rows = await tx
    .select({ id: formUpload.id })
    .from(formUpload)
    .where(
      and(
        eq(formUpload.formId, formId),
        inArray(formUpload.id, ids),
        isNull(formUpload.submissionId),
      ),
    )
  return rows.map((row) => row.id)
}

/** Records an upload the public edge is about to sign a URL for.
 *
 *  The row exists before the bytes do: the browser is handed this id and the
 *  signed URL together, and a PUT that never happens leaves an unclaimed row the
 *  sweep collects. The alternative, trusting the browser to tell us afterwards,
 *  is a table anyone can write to. */
export const beginFormUpload = async (
  form: PublicForm,
  input: { storageKey: string; filename: string; bytes: number; mime: string },
): Promise<string> =>
  withAccount(publicEdgeContext(form.accountId), async (tx) => {
    const [row] = await tx
      .insert(formUpload)
      .values({ accountId: form.accountId, formId: form.formId, ...input })
      .returning({ id: formUpload.id })
    if (!row) throw new Error('That file could not be accepted.')
    return row.id
  })

export type FormUploadRow = {
  id: string
  storageKey: string
  filename: string
  bytes: number
  mime: string
}

/** The files a submission carries, for the reviewer looking at it. */
export const uploadsForSubmission = async (
  ctx: AccountContext,
  submissionId: string,
): Promise<FormUploadRow[]> =>
  withAccount(ctx, async (tx) =>
    tx
      .select({
        id: formUpload.id,
        storageKey: formUpload.storageKey,
        filename: formUpload.filename,
        bytes: formUpload.bytes,
        mime: formUpload.mime,
      })
      .from(formUpload)
      .where(eq(formUpload.submissionId, submissionId)),
  )

/** The whole capture path, steps 2 to 8 of F3 §4, in one transaction.
 *
 *  Ordering is the point. Validation refuses unknown keys before anything is
 *  scored, scoring happens before a contact exists, and a quarantined submission
 *  is stored with its reasons but creates no contact at all. Nothing is ever
 *  silently dropped: even confirmed spam is a row somebody can look at. */
export const submitForm = async (input: SubmitInput): Promise<SubmitResult> => {
  const ctx = publicEdgeContext(input.form.accountId)
  // The ceiling above is only real if it is checked. A form fill writes contacts
  // and companies, so those are asserted here; a change that widened the edge to
  // deals would fail this rather than silently succeed.
  assertCanWrite(ctx, 'contact')
  assertCanWrite(ctx, 'company')
  const { fields, settings } = input.form

  const { answers, errors } = validateAnswers(fields, input.body, input.form.rules)
  if (errors.length > 0) {
    return { submissionId: '', state: 'clean', contactId: null, companyId: null, errors }
  }

  const email = emailFrom(fields, answers)
  const attribution = readAttribution({ ...input.attribution, userAgent: input.userAgent })

  return withAccount(ctx, async (tx) => {
    // A file answer is an id, and an id is a claim. Settled here, before anything
    // is scored, because an upload that belongs to another form or was already
    // claimed is bad input rather than something to discover after the insert.
    const claiming = fileIdsIn(fields, answers)
    const claimable = claiming.length > 0 ? await unclaimedUploads(tx, input.form.formId, claiming) : []
    if (claimable.length !== claiming.length) {
      return {
        submissionId: '',
        state: 'clean' as const,
        contactId: null,
        companyId: null,
        errors: fields
          .filter((f) => f.type === 'file' && answers[f.key] && !claimable.includes(String(answers[f.key])))
          .map((f) => ({ key: f.key, message: `${f.label} was not uploaded successfully. Attach it again.` })),
      }
    }

    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: formSubmission.id, contactId: formSubmission.contactId, state: formSubmission.spamState })
        .from(formSubmission)
        .where(
          and(
            eq(formSubmission.formId, input.form.formId),
            eq(formSubmission.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
      if (seen) {
        return {
          submissionId: seen.id,
          state: seen.state,
          contactId: seen.contactId,
          companyId: null,
          duplicate: true,
          success: { mode: settings.successMode, value: settings.successValue },
        }
      }
    }

    const fingerprint = answersFingerprint(answers)
    const duplicateWithin60s = await hasRecentTwin(tx, input.form.formId, fingerprint)

    let verdict = scoreSubmission({
      raw: input.body,
      answers,
      email,
      fillSeconds: fillSecondsFrom(input.body),
      degradedSignals: input.degradedSignals,
      duplicateWithin60s,
    })

    if (input.challenge !== 'not-required') verdict = applyChallenge(verdict, input.challenge)
    if (verdict.needsChallenge && input.challenge === 'not-required') {
      return {
        submissionId: '',
        state: verdict.state,
        contactId: null,
        companyId: null,
        challengeRequired: true,
      }
    }

    const occurredAt = input.occurredAt ?? new Date()
    const linked =
      verdict.state === 'clean'
        ? await capturePerson(tx, ctx, { fields, answers, email, attribution, settings })
        : { contactId: null, companyId: null }

    const [row] = await tx
      .insert(formSubmission)
      .values({
        accountId: ctx.accountId,
        formId: input.form.formId,
        values: answers,
        attribution,
        contactId: linked.contactId,
        companyId: linked.companyId,
        visitorId: input.visitorId,
        spamScore: verdict.score,
        spamState: verdict.state,
        spamReasons: verdict.reasons,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
        idempotencyKey: input.idempotencyKey ?? null,
        at: occurredAt,
      })
      .returning({ id: formSubmission.id })

    if (!row) throw new Error('The submission could not be saved.')

    // In the same transaction as the submission: a file that is claimed by a row
    // that then rolls back is a file the sweep would delete out from under a lead.
    if (claimable.length > 0) {
      await tx
        .update(formUpload)
        .set({ submissionId: row.id })
        .where(and(eq(formUpload.formId, input.form.formId), inArray(formUpload.id, claimable)))
    }

    // Written in the same transaction as the submission: a lead that saves and
    // then fails to notify is a lead nobody is told about.
    await notify(tx, ctx, {
      kind: verdict.state === 'clean' ? 'form_submission' : 'form_quarantined',
      dedupeKey: `form:${verdict.state === 'clean' ? 'new' : 'quarantined'}:${row.id}`,
      title:
        verdict.state === 'clean'
          ? `${input.form.name}: a new submission`
          : `${input.form.name}: a submission is held for review`,
      body: email,
      to: { hubs: ['contacts', 'sales', 'marketing'] },
    })

    let confirmations: SubmitResult['confirmations'] = []
    if (linked.contactId) {
      confirmations = await applyOptIns(ctx, linked.contactId, settings.subscriptionOptIns ?? [])

      // F4 §3, T1. Written here, inside the transaction that created the contact,
      // and nothing more: a visitor with 5,000 views must not make a form response
      // wait for a back-fill. The worker claims this row.
      if (input.visitorId) {
        await aliasVisitor(tx, ctx, {
          visitorId: input.visitorId,
          contactId: linked.contactId,
          via: 'form_submission',
        })
      }

      await recordActivity(tx, ctx, {
        type: 'form_submission',
        subject: `submitted ${input.form.name}`,
        occurredAt,
        source: 'form',
        payload: { formId: input.form.formId, submissionId: row.id, values: answers, attribution },
        links: [
          { entityType: 'contact', entityId: linked.contactId },
          ...(linked.companyId ? [{ entityType: 'company' as const, entityId: linked.companyId }] : []),
        ],
      })
    }

    await writeAudit(tx, ctx, {
      entity: 'form_submission',
      entityId: row.id,
      action: 'submit',
      before: null,
      after: {
        formId: input.form.formId,
        spamState: verdict.state,
        spamScore: verdict.score,
        contactId: linked.contactId,
      },
    })

    return {
      submissionId: row.id,
      state: verdict.state,
      contactId: linked.contactId,
      companyId: linked.companyId,
      confirmations,
      success: { mode: settings.successMode, value: settings.successValue },
      notify:
        verdict.state === 'clean' && settings.notifySlack && linked.contactId
          ? {
              formName: input.form.name,
              contactId: linked.contactId,
              values: answers,
              attribution,
              channel: settings.slackChannel ?? null,
            }
          : undefined,
    }
  })
}

const fillSecondsFrom = (body: Record<string, unknown>): number | null => {
  const raw = body.rawr_t
  const started = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN)
  if (!Number.isFinite(started) || started <= 0) return null
  return (Date.now() - started) / 1000
}

const hasRecentTwin = async (tx: Tx, formId: string, fingerprint: string): Promise<boolean> => {
  // Fingerprinting in SQL would need the same canonicalisation in two languages.
  // The window is sixty seconds and the index is (account, form, at desc), so
  // this reads a handful of rows even on a busy form.
  const recent = await tx
    .select({ values: formSubmission.values })
    .from(formSubmission)
    .where(
      and(
        eq(formSubmission.formId, formId),
        sql`${formSubmission.at} > now() - make_interval(secs => ${DUPLICATE_WINDOW_SECONDS})`,
      ),
    )
    .orderBy(desc(formSubmission.at))
    .limit(20)

  return recent.some(
    (r) => answersFingerprint((r.values ?? {}) as Record<string, unknown>) === fingerprint,
  )
}

type UpsertInput = {
  fields: FormField[]
  answers: Record<string, unknown>
  email: string | null
  attribution: Attribution
  settings: FormSettings
}

/** Step 6 and 7 of §4. The upsert itself is shared with booking, because a form
 *  fill and a booking are the same act to the CRM. What is specific to a form is
 *  the mapping: which answer means which column. */
const capturePerson = async (
  tx: Tx,
  ctx: AccountContext,
  input: UpsertInput,
): Promise<CapturedPerson> => {
  if (!input.email) return { contactId: null, companyId: null }
  const mapped = mapAnswersToColumns(input.fields, input.answers)
  return upsertCapturedPerson(tx, ctx, {
    email: input.email,
    contact: mapped.contact,
    company: mapped.company,
    attribution: input.attribution,
    lifecycleStage: input.settings.lifecycleStageOnSubmit,
    source: 'form',
    assignOwner: input.settings.assignOwner,
  })
}

/** The subscription types a form opts its submitter into, by name, because that
 *  is what the builder shows and what a seeded form names.
 *
 *  Opt-in only, never opt-out: a form is somebody asking to hear from us, and an
 *  unticked box on one form must not silently cancel a choice made on another.
 *  An unsubscribed contact who fills the form again is resubscribing, which is
 *  what the act means. Types the account does not have are skipped rather than
 *  refused, so a renamed type never costs a lead. */
const applyOptIns = async (
  ctx: AccountContext,
  contactId: string,
  names: string[],
): Promise<SubmitResult['confirmations']> => {
  if (names.length === 0) return []
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()).filter((name) => name !== ''))
  if (wanted.size === 0) return []
  const types = await listSubscriptionTypes(ctx)
  const asked: NonNullable<SubmitResult['confirmations']> = []
  for (const type of types) {
    if (!wanted.has(type.name.trim().toLowerCase())) continue
    // Which of the two this is, subscribing or only asking, is the type's to
    // decide and not the form's.
    const outcome = await requestOptIn(ctx, { contactId, typeId: type.id, source: 'form' })
    if (outcome.pending) {
      asked.push({
        token: outcome.token,
        typeName: outcome.typeName,
        contactEmail: outcome.contactEmail,
        contactFirstName: outcome.contactFirstName,
      })
    }
  }
  return asked
}

/** A consent choice, appended never updated: prior data stays under the consent
 *  that was in force when it was collected, so overwriting the row would destroy
 *  the only evidence of what was lawful at the time.
 *
 *  Reached from the public edge, which has no session, so the account is
 *  resolved by the caller from a site key and never from the request body. */
export const recordConsent = async (
  accountId: string,
  input: {
    visitorId: string
    categories: { necessary: true; analytics: boolean; advertisement: boolean }
    policyVersion: string
    ipHash: string | null
    userAgent: string | null
  },
): Promise<string> => {
  const ctx = publicEdgeContext(accountId)
  return withAccount(ctx, async (tx) => {
    const [row] = await tx
      .insert(consentRecord)
      .values({
        accountId,
        visitorId: input.visitorId,
        categories: input.categories,
        policyVersion: input.policyVersion,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      })
      .returning({ id: consentRecord.id })
    if (!row) throw new Error('The consent choice could not be recorded.')
    return row.id
  })
}

/** This visitor's latest choice, or null if they have never made one.
 *
 *  The banner stops the collector client-side, so an event arriving at all
 *  implies analytics consent — but "the script should not have sent it" is not
 *  the same as "we may forward it to Google", and a beacon can be replayed by
 *  anything that can read a site key. Read from the newest row over
 *  consent_record_visitor_idx, which is on (account_id, visitor_id, at desc)
 *  for exactly this. */
export const latestConsent = async (
  accountId: string,
  visitorId: string,
): Promise<{ analytics: boolean; advertisement: boolean } | null> => {
  const ctx = publicEdgeContext(accountId)
  return withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select({ categories: consentRecord.categories })
      .from(consentRecord)
      .where(and(eq(consentRecord.accountId, accountId), eq(consentRecord.visitorId, visitorId)))
      .orderBy(desc(consentRecord.at))
      .limit(1)
    if (!row) return null
    const categories = row.categories as { analytics?: unknown; advertisement?: unknown }
    return { analytics: categories.analytics === true, advertisement: categories.advertisement === true }
  })
}

/** The account a public site key belongs to, resolved through the same
 *  security-definer path as a form so the edge never reads the account table
 *  unscoped.
 *
 *  Migration path: a real F4 site key wins, and an account slug is still accepted
 *  for any embed placed before sites existed. Once every embed on datasaur.ai
 *  carries a site key, the slug branch in rawr.account_for_site can go. */
export const accountIdForSite = async (siteKey: string): Promise<string | null> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.account_for_site(${siteKey})`,
  )
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Admin surfaces
// ---------------------------------------------------------------------------

export type FormSummary = {
  id: string
  name: string
  slug: string
  isActive: boolean
  folderId: string | null
  fieldCount: number
  submissions: number
  quarantined: number
  /** Confirmed spam, kept apart from what is merely held: the first number is a
   *  judgement somebody made, the second is a queue waiting for one. */
  spam: number
  /** Times the form was painted, on any page. HubSpot calls this Page Views;
   *  what is actually countable is the form appearing, and a page that loaded
   *  without the form is not a view of the form. */
  pageViews: number
  /** Distinct page paths the form has rendered on. */
  appearsOn: number
  lastSubmissionAt: Date | null
}

export const listForms = async (ctx: AccountContext): Promise<FormSummary[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      slug: string
      is_active: boolean
      folder_id: string | null
      schema: unknown
      submissions: string
      quarantined: string
      spam: string
      last_at: string | Date | null
    }>(sql`
      select f.id, f.name, f.slug, f.is_active, f.folder_id, f.schema,
             count(s.id) filter (where s.spam_state in ('clean','released')) as submissions,
             count(s.id) filter (where s.spam_state = 'quarantined') as quarantined,
             count(s.id) filter (where s.spam_state = 'confirmed_spam') as spam,
             max(s.at) as last_at
        from form f
        left join form_submission s on s.form_id = f.id
       group by f.id
       order by f.name`)

    // Its own grouped scan rather than a join: joining a per-page counter to a
    // per-submission one multiplies both counts, which is how a conversion rate
    // ends up over a hundred percent.
    const counters = await tx.execute<{ form_id: string; views: string; pages: string }>(sql`
      select v.form_id, sum(v.renders) as views, count(*) filter (where v.renders > 0) as pages
        from (select form_id, page_path, sum(renders) as renders
                from form_view group by form_id, page_path) v
       group by v.form_id`)
    const seen = new Map(counters.map((row) => [row.form_id, row]))

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active,
      folderId: row.folder_id,
      fieldCount: readSchema(row.schema).length,
      submissions: Number(row.submissions),
      quarantined: Number(row.quarantined),
      spam: Number(row.spam),
      pageViews: Number(seen.get(row.id)?.views ?? 0),
      appearsOn: Number(seen.get(row.id)?.pages ?? 0),
      // max() comes back from the raw driver as a string, not a Date, so it is
      // coerced here rather than at each place that formats it.
      lastSubmissionAt: row.last_at ? new Date(row.last_at) : null,
    }))
  })

export type FormDetail = {
  id: string
  name: string
  slug: string
  isActive: boolean
  fields: FormField[]
  settings: FormSettings
}

export const getForm = async (ctx: AccountContext, id: string): Promise<FormDetail | null> => {
  if (!isUuid(id)) return null
  return withAccount(ctx, async (tx) => {
    const [row] = await tx.select().from(form).where(eq(form.id, id)).limit(1)
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      fields: readSchema(row.schema),
      settings: readSettings(row.settings),
    }
  })
}

export type SaveFormInput = {
  id?: string | null
  name: string
  slug: string
  fields: FormField[]
  settings: FormSettings
  isActive: boolean
}

export const saveForm = async (ctx: AccountContext, input: SaveFormInput): Promise<string> =>
  mutate(ctx, 'form', async (tx) => {
    if (!input.name.trim()) throw new Error('A form needs a name.')
    if (!FORM_SLUG.test(input.slug)) {
      throw new Error(
        `"${input.slug}" is not a usable address. Use lowercase letters, numbers and hyphens.`,
      )
    }
    assertSchemaIsUsable(input.fields)

    // The unique index would catch this, but as a constraint-violation stack
    // trace. The address is the one thing a person picks that another form may
    // already hold, so it is worth one query to say so in words.
    const [clash] = await tx
      .select({ id: form.id, name: form.name })
      .from(form)
      .where(and(eq(form.accountId, ctx.accountId), eq(form.slug, input.slug)))
      .limit(1)
    if (clash && clash.id !== input.id) {
      throw new Error(`"${clash.name}" already uses the address "${input.slug}". Pick another.`)
    }

    const values = {
      name: input.name.trim(),
      slug: input.slug,
      schema: input.fields,
      settings: input.settings,
      isActive: input.isActive,
    }

    if (input.id) {
      const [before] = await tx.select().from(form).where(eq(form.id, input.id)).limit(1)
      if (!before) throw new Error('That form no longer exists.')
      await tx
        .update(form)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(form.id, input.id))
      return {
        result: input.id,
        audit: {
          entity: 'form',
          entityId: input.id,
          action: 'update',
          before: { name: before.name, slug: before.slug, isActive: before.isActive },
          after: { name: values.name, slug: values.slug, isActive: values.isActive },
        },
      }
    }

    const [created] = await tx
      .insert(form)
      .values({ accountId: ctx.accountId, ...values })
      .returning({ id: form.id })
    if (!created) throw new Error('The form could not be created.')

    return {
      result: created.id,
      audit: {
        entity: 'form',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { name: values.name, slug: values.slug },
      },
    }
  })

export type SubmissionRow = {
  id: string
  formId: string
  formName: string
  values: Record<string, unknown>
  attribution: Attribution
  spamScore: number
  spamState: 'clean' | 'quarantined' | 'confirmed_spam' | 'released'
  spamReasons: { rule: string; points: number; detail: string }[]
  contactId: string | null
  at: Date
  /** Files this submission carries. The answer in `values` is the id; this is
   *  what a person reviewing it needs to see instead. */
  uploads: { id: string; filename: string; bytes: number }[]
}

/** Refused while any submission exists: those are leads, and the form's schema
 *  is what makes them readable. Turn the form off instead, or delete it once its
 *  history has been dealt with. */
export const deleteForm = async (ctx: AccountContext, id: string): Promise<void> => {
  await mutate(ctx, 'form', async (tx) => {
    const [row] = await tx.select({ id: form.id, name: form.name, slug: form.slug }).from(form).where(eq(form.id, id)).limit(1)
    if (!row) throw new Error('That form no longer exists.')
    const [held] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(formSubmission)
      .where(eq(formSubmission.formId, id))
    if (held && held.n > 0) {
      throw new Error(
        `"${row.name}" has ${held.n} submission${held.n === 1 ? '' : 's'}, which are leads. Turn it off instead; a form with history is not deleted.`,
      )
    }
    await tx.delete(form).where(eq(form.id, id))
    return {
      result: undefined,
      audit: { entity: 'form', entityId: id, action: 'delete', before: { name: row.name, slug: row.slug }, after: null },
    }
  })
}

export const listSubmissions = async (
  ctx: AccountContext,
  input: {
    state?: SubmissionRow['spamState'] | undefined
    formId?: string | undefined
    limit?: number | undefined
    /** Keyset, on the same (at desc, id desc) the list is ordered by, so the
     *  hundredth page costs what the first one costs. */
    cursor?: { at: Date; id: string } | undefined
  } = {},
): Promise<SubmissionRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: formSubmission.id,
        formId: formSubmission.formId,
        formName: form.name,
        values: formSubmission.values,
        attribution: formSubmission.attribution,
        spamScore: formSubmission.spamScore,
        spamState: formSubmission.spamState,
        spamReasons: formSubmission.spamReasons,
        contactId: formSubmission.contactId,
        at: formSubmission.at,
      })
      .from(formSubmission)
      .innerJoin(form, eq(form.id, formSubmission.formId))
      .where(
        and(
          input.state ? eq(formSubmission.spamState, input.state) : undefined,
          input.formId ? eq(formSubmission.formId, input.formId) : undefined,
          input.cursor
            ? sql`(${formSubmission.at}, ${formSubmission.id}) < (${input.cursor.at}, ${input.cursor.id})`
            : undefined,
        ),
      )
      .orderBy(desc(formSubmission.at), desc(formSubmission.id))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))

    // One query for the whole page rather than one per row: a submission's files
    // are a rare thing, and a hundred round trips to find that out is not free.
    const attached =
      rows.length > 0
        ? await tx
            .select({
              submissionId: formUpload.submissionId,
              id: formUpload.id,
              filename: formUpload.filename,
              bytes: formUpload.bytes,
            })
            .from(formUpload)
            .where(inArray(formUpload.submissionId, rows.map((row) => row.id)))
        : []

    const byRow = new Map<string, SubmissionRow['uploads']>()
    for (const file of attached) {
      if (!file.submissionId) continue
      const list = byRow.get(file.submissionId) ?? []
      list.push({ id: file.id, filename: file.filename, bytes: file.bytes })
      byRow.set(file.submissionId, list)
    }

    return rows.map((row) => ({ ...row, uploads: byRow.get(row.id) ?? [] })) as SubmissionRow[]
  })

/** Releasing runs the full capture path from step 5, with the original timestamp
 *  preserved, so the timeline does not claim a week-old lead arrived today. */
export const releaseSubmission = async (
  ctx: AccountContext,
  id: string,
): Promise<{ contactId: string | null }> => {
  const held = await withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: formSubmission.id,
        formId: formSubmission.formId,
        values: formSubmission.values,
        attribution: formSubmission.attribution,
        state: formSubmission.spamState,
        at: formSubmission.at,
        visitorId: formSubmission.visitorId,
      })
      .from(formSubmission)
      .where(eq(formSubmission.id, id))
      .limit(1)
    return row ?? null
  })

  if (!held) throw new Error('That submission no longer exists.')
  if (held.state !== 'quarantined') {
    throw new Error(`This submission is ${held.state.replace('_', ' ')}, so there is nothing to release.`)
  }

  const target = await publicFormById(held.formId)
  if (!target) throw new Error('The form this submission belongs to has been deleted.')

  return mutate(ctx, 'form_submission', async (tx) => {
    const attribution = held.attribution as Attribution
    const answers = (held.values ?? {}) as Record<string, unknown>
    const email = emailFrom(target.fields, answers)

    const linked = await capturePerson(tx, ctx, {
      fields: target.fields,
      answers,
      email,
      attribution,
      settings: target.settings,
    })

    await tx
      .update(formSubmission)
      .set({
        spamState: 'released',
        contactId: linked.contactId,
        companyId: linked.companyId,
        reviewedBy: ctx.actorId,
        reviewedAt: new Date(),
      })
      .where(eq(formSubmission.id, id))

    // The notice said this was waiting for a person. A person has now dealt with
    // it, so it stops being unread whether or not they opened the drawer.
    await resolveNotifications(tx, ctx, `form:quarantined:${id}`)

    if (linked.contactId) {
      // A released lead gets its browsing history too. Held for a week and then
      // released is still the same person who did the browsing.
      if (held.visitorId) {
        await aliasVisitor(tx, ctx, {
          visitorId: held.visitorId,
          contactId: linked.contactId,
          via: 'form_submission',
        })
      }

      await recordActivity(tx, ctx, {
        type: 'form_submission',
        subject: `submitted ${target.name}`,
        occurredAt: held.at,
        source: 'form',
        payload: { formId: target.formId, submissionId: id, values: answers, released: true },
        links: [
          { entityType: 'contact', entityId: linked.contactId },
          ...(linked.companyId ? [{ entityType: 'company' as const, entityId: linked.companyId }] : []),
        ],
      })
    }

    return {
      result: { contactId: linked.contactId },
      audit: {
        entity: 'form_submission',
        entityId: id,
        action: 'release',
        before: { spamState: 'quarantined', contactId: null },
        after: { spamState: 'released', contactId: linked.contactId },
      },
    }
  })
}

export const confirmSpam = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'form_submission', async (tx) => {
    const [before] = await tx
      .select({ state: formSubmission.spamState })
      .from(formSubmission)
      .where(eq(formSubmission.id, id))
      .limit(1)
    if (!before) throw new Error('That submission no longer exists.')

    await tx
      .update(formSubmission)
      .set({ spamState: 'confirmed_spam', reviewedBy: ctx.actorId, reviewedAt: new Date() })
      .where(eq(formSubmission.id, id))

    await resolveNotifications(tx, ctx, `form:quarantined:${id}`)

    return {
      result: undefined,
      audit: {
        entity: 'form_submission',
        entityId: id,
        action: 'confirm_spam',
        before: { spamState: before.state },
        after: { spamState: 'confirmed_spam' },
      },
    }
  })

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type FormFolderRow = { id: string; name: string; forms: number }

export const listFormFolders = async (ctx: AccountContext): Promise<FormFolderRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string; name: string; forms: string }>(sql`
      select d.id, d.name, count(f.id) as forms
        from form_folder d
        left join form f on f.folder_id = d.id
       group by d.id
       order by lower(d.name)`)
    return rows.map((row) => ({ id: row.id, name: row.name, forms: Number(row.forms) }))
  })

export const saveFormFolder = async (
  ctx: AccountContext,
  input: { id?: string | null; name: string },
): Promise<string> =>
  mutate(ctx, 'form', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('A folder needs a name.')

    // The unique index would catch this as a constraint violation. Two folders
    // called "Campaigns" is a mistake worth one query to say in words.
    const [clash] = await tx
      .select({ id: formFolder.id })
      .from(formFolder)
      .where(sql`lower(${formFolder.name}) = lower(${name})`)
      .limit(1)
    if (clash && clash.id !== input.id) throw new Error(`A folder called "${name}" already exists.`)

    if (input.id) {
      await tx
        .update(formFolder)
        .set({ name, updatedAt: new Date() })
        .where(eq(formFolder.id, input.id))
      return {
        result: input.id,
        audit: { entity: 'form_folder', entityId: input.id, action: 'update', before: null, after: { name } },
      }
    }

    const [created] = await tx
      .insert(formFolder)
      .values({ accountId: ctx.accountId, name })
      .returning({ id: formFolder.id })
    if (!created) throw new Error('The folder could not be created.')
    return {
      result: created.id,
      audit: { entity: 'form_folder', entityId: created.id, action: 'create', before: null, after: { name } },
    }
  })

/** Deleting a folder empties it. The forms inside are somebody's live capture
 *  path; a filing decision must never be able to take them down with it. */
export const deleteFormFolder = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'form', async (tx) => {
    const [row] = await tx
      .select({ name: formFolder.name })
      .from(formFolder)
      .where(eq(formFolder.id, id))
      .limit(1)
    if (!row) throw new Error('That folder no longer exists.')
    await tx.delete(formFolder).where(eq(formFolder.id, id))
    return {
      result: undefined,
      audit: { entity: 'form_folder', entityId: id, action: 'delete', before: { name: row.name }, after: null },
    }
  })

export const moveFormToFolder = async (
  ctx: AccountContext,
  input: { formId: string; folderId: string | null },
): Promise<void> =>
  mutate(ctx, 'form', async (tx) => {
    const [before] = await tx
      .select({ folderId: form.folderId })
      .from(form)
      .where(eq(form.id, input.formId))
      .limit(1)
    if (!before) throw new Error('That form no longer exists.')

    await tx
      .update(form)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(eq(form.id, input.formId))
    return {
      result: undefined,
      audit: {
        entity: 'form',
        entityId: input.formId,
        action: 'move',
        before: { folderId: before.folderId },
        after: { folderId: input.folderId },
      },
    }
  })

/** A copy of everything that makes the form, and none of what it collected.
 *
 *  The address cannot be copied: it is the identity somebody pasted into their
 *  site, so the clone takes the first free "<slug>-2". It starts turned off,
 *  because a second form answering the same address on the same page is how one
 *  campaign's leads end up split across two records nobody reconciles. */
export const cloneForm = async (ctx: AccountContext, id: string): Promise<string> =>
  mutate(ctx, 'form', async (tx) => {
    const [source] = await tx.select().from(form).where(eq(form.id, id)).limit(1)
    if (!source) throw new Error('That form no longer exists.')

    const taken = await tx
      .select({ slug: form.slug })
      .from(form)
      .where(sql`${form.slug} like ${`${source.slug}%`}`)
    const used = new Set(taken.map((row) => row.slug))
    let slug = ''
    for (let n = 2; ; n++) {
      const candidate = `${source.slug}-${n}`.slice(0, 63)
      if (!used.has(candidate)) {
        slug = candidate
        break
      }
    }

    const [created] = await tx
      .insert(form)
      .values({
        accountId: ctx.accountId,
        folderId: source.folderId,
        name: `${source.name} (copy)`.slice(0, 200),
        slug,
        schema: source.schema,
        settings: source.settings,
        isActive: false,
      })
      .returning({ id: form.id })
    if (!created) throw new Error('The form could not be copied.')

    return {
      result: created.id,
      audit: {
        entity: 'form',
        entityId: created.id,
        action: 'clone',
        before: { formId: id, slug: source.slug },
        after: { name: `${source.name} (copy)`, slug },
      },
    }
  })

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/** One beacon: a page carrying the form loaded, the form painted, or somebody
 *  touched it. Three counters on one row, upserted in a single statement so a
 *  beacon costs one round trip and never a read.
 *
 *  The day is UTC, like every other daily counter here. A window that starts on
 *  the reader's own today therefore includes a beacon their clock calls
 *  yesterday evening; the alternative is storing a timezone per beacon, which a
 *  counter cannot afford. */
export const countFormView = async (input: {
  accountId: string
  formId: string
  pagePath: string
  /** More than one where a caller settles more than one step at once: on the
   *  hosted page the load and the render are the same event, because the page is
   *  the form. */
  kinds: ('view' | 'render' | 'interaction')[]
}): Promise<void> => {
  const path = input.pagePath.slice(0, 500) || '/'
  const views = input.kinds.includes('view') ? 1 : 0
  const renders = input.kinds.includes('render') ? 1 : 0
  const interactions = input.kinds.includes('interaction') ? 1 : 0
  if (views + renders + interactions === 0) return
  await withAccount(publicEdgeContext(input.accountId), async (tx) => {
    await tx.execute(sql`
      insert into form_view (account_id, form_id, day, page_path, views, renders, interactions)
      values (${input.accountId}, ${input.formId}, current_date, ${path}, ${views}, ${renders}, ${interactions})
      on conflict (account_id, form_id, day, page_path) do update
         set views = form_view.views + excluded.views,
             renders = form_view.renders + excluded.renders,
             interactions = form_view.interactions + excluded.interactions`)
  })
}

export type FormPerformance = {
  /** Inclusive day bounds, as they were asked for. */
  from: string
  to: string
  totals: { views: number; renders: number; interactions: number; submissions: number; pageVisits: number }
  /** Views over the window of equal length immediately before this one, so the
   *  tile can say which way it went rather than only how big it is. */
  previousViews: number
  days: { day: string; views: number; submissions: number }[]
  contactType: { existing: number; created: number }
  pages: { path: string; views: number; submissions: number }[]
  sources: { channel: string; views: number; submissions: number }[]
  /** Distinct page paths the form rendered on in the window. */
  appearsOn: string[]
}

/** How many rows a breakdown table will show. A form on ten thousand paths is a
 *  tracking mistake, and rendering ten thousand rows would hide it rather than
 *  surface it: the top slice plus the totals above says the same thing. */
const PERFORMANCE_ROWS = 100

export const formPerformance = async (
  ctx: AccountContext,
  input: { formId: string; from: string; to: string },
): Promise<FormPerformance | null> => {
  if (!isUuid(input.formId)) return null
  const from = input.from
  const to = input.to
  return withAccount(ctx, async (tx) => {
    const [exists] = await tx
      .select({ id: form.id })
      .from(form)
      .where(eq(form.id, input.formId))
      .limit(1)
    if (!exists) return null

    const counters = await tx.execute<{
      day: string
      views: number
      renders: number
      interactions: number
      page_path: string
    }>(sql`
      select v.day::text as day, v.views, v.renders, v.interactions, v.page_path
        from form_view v
       where v.form_id = ${input.formId}
         and v.day between ${from}::date and ${to}::date`)

    const submissions = await tx.execute<{ day: string; path: string | null; state: string; created: boolean }>(sql`
      select s.at::date::text as day,
             s.attribution ->> 'pagePath' as path,
             s.spam_state::text as state,
             (c.id is not null and c.created_at >= s.at - interval '5 seconds') as created
        from form_submission s
        left join contact c on c.id = s.contact_id
       where s.form_id = ${input.formId}
         and s.at >= ${from}::date
         and s.at < (${to}::date + 1)`)

    // Page visits for an embedded form come from the collector, not from here:
    // the beacon knows the form painted, and the page view next to it is what
    // the page did. Counted over the paths this form actually rendered on, in
    // one grouped scan rather than a join, so a path seen by two forms is not
    // multiplied.
    const paths = [...new Set(counters.filter((row) => row.renders > 0).map((row) => row.page_path))]
    const visits = paths.length
      ? await tx.execute<{ path: string; visits: number; channel: string | null }>(sql`
          select p.path, count(*)::int as visits, e.channel
            from page_view p
            left join visitor_session e on e.id = p.session_id
           where p.path = any(array[${sql.join(paths.map((path) => sql`${path}::text`), sql`, `)}])
             and p.at >= ${from}::date
             and p.at < (${to}::date + 1)
           group by p.path, e.channel`)
      : []

    const submissionChannels = await tx.execute<{ channel: string | null; n: number }>(sql`
      select e.channel, count(*)::int as n
        from form_submission s
        left join lateral (
              select v.channel
                from visitor_session v
               where v.visitor_id = s.visitor_id and v.started_at <= s.at
               order by v.started_at desc
               limit 1
             ) e on true
       where s.form_id = ${input.formId}
         and s.spam_state in ('clean', 'released')
         and s.at >= ${from}::date
         and s.at < (${to}::date + 1)
       group by e.channel`)

    const [previous] = await tx.execute<{ views: number }>(sql`
      select coalesce(sum(v.renders), 0)::int as views
        from form_view v
       where v.form_id = ${input.formId}
         and v.day >= ${from}::date - (${to}::date - ${from}::date + 1)
         and v.day < ${from}::date`)

    const kept = submissions.filter((row) => row.state === 'clean' || row.state === 'released')

    const byDay = new Map<string, { views: number; submissions: number }>()
    for (const day of eachDay(from, to)) byDay.set(day, { views: 0, submissions: 0 })
    for (const row of counters) {
      const entry = byDay.get(row.day)
      if (entry) entry.views += Number(row.renders)
    }
    for (const row of kept) {
      const entry = byDay.get(row.day)
      if (entry) entry.submissions += 1
    }

    const pageViews = new Map<string, number>()
    for (const row of counters) {
      pageViews.set(row.page_path, (pageViews.get(row.page_path) ?? 0) + Number(row.renders))
    }
    const pageSubmissions = new Map<string, number>()
    for (const row of kept) {
      const path = row.path ?? 'Unknown'
      pageSubmissions.set(path, (pageSubmissions.get(path) ?? 0) + 1)
    }
    const pages = [...new Set([...pageViews.keys(), ...pageSubmissions.keys()])]
      .map((path) => ({
        path,
        views: pageViews.get(path) ?? 0,
        submissions: pageSubmissions.get(path) ?? 0,
      }))
      .sort((a, b) => b.views - a.views || b.submissions - a.submissions)
      .slice(0, PERFORMANCE_ROWS)

    const sourceViews = new Map<string, number>()
    for (const row of visits) {
      const channel = row.channel ?? UNKNOWN_CHANNEL
      sourceViews.set(channel, (sourceViews.get(channel) ?? 0) + Number(row.visits))
    }
    const sourceSubmissions = new Map<string, number>()
    for (const row of submissionChannels) {
      const channel = row.channel ?? UNKNOWN_CHANNEL
      sourceSubmissions.set(channel, (sourceSubmissions.get(channel) ?? 0) + Number(row.n))
    }
    const sources = [...new Set([...sourceViews.keys(), ...sourceSubmissions.keys()])]
      .map((channel) => ({
        channel,
        views: sourceViews.get(channel) ?? 0,
        submissions: sourceSubmissions.get(channel) ?? 0,
      }))
      .sort((a, b) => b.submissions - a.submissions || b.views - a.views)
      .slice(0, PERFORMANCE_ROWS)

    const sum = (pick: (row: (typeof counters)[number]) => number): number =>
      counters.reduce((total, row) => total + Number(pick(row)), 0)

    return {
      from,
      to,
      totals: {
        views: sum((row) => row.renders),
        renders: sum((row) => row.renders),
        interactions: sum((row) => row.interactions),
        submissions: kept.length,
        // The hosted page counts its own loads; an embedded page's are the
        // collector's. Neither counts the other, so they add rather than overlap.
        pageVisits:
          sum((row) => row.views) + visits.reduce((total, row) => total + Number(row.visits), 0),
      },
      previousViews: Number(previous?.views ?? 0),
      days: [...byDay.entries()].map(([day, entry]) => ({ day, ...entry })),
      contactType: {
        existing: kept.filter((row) => row.created === false).length,
        created: kept.filter((row) => row.created === true).length,
      },
      pages,
      sources,
      appearsOn: paths.sort(),
    }
  })
}

/** A submission whose visitor never had a session, because they declined
 *  analytics or arrived without the collector, has no channel. Named rather than
 *  folded into Direct traffic, which would be a claim nobody can support. */
const UNKNOWN_CHANNEL = 'Unknown'

/** Every day in an inclusive range, so a chart has a bar for a day nothing
 *  happened rather than closing the gap and implying it did. */
const eachDay = (from: string, to: string): string[] => {
  const days: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  // Bounded by the range the caller asked for, which the router caps.
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}
