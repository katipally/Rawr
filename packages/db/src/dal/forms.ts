import { and, desc, eq, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { consentRecord, form, formSubmission } from '../schema/forms.ts'
import { recordActivity } from './activity.ts'
import { readAttribution, type Attribution, type AttributionInput } from './attribution.ts'
import { assertCanWrite, type Role, type WorkspaceContext } from './context.ts'
import {
  assertSchemaIsUsable,
  readSchema,
  readSettings,
  type FormField,
  type FormSettings,
} from './form-schema.ts'
import { emailFrom, validateAnswers, type FieldError } from './form-validate.ts'
import { mapAnswersToColumns, upsertCapturedPerson, type CapturedPerson } from './people.ts'
import { isUuid, mutate, withWorkspace, writeAudit, type Tx } from './index.ts'
import { answersFingerprint, applyChallenge, scoreSubmission, type SpamVerdict } from './spam.ts'
import { aliasVisitor } from './stitch.ts'

/** The public edge acts with marketing's ceiling: it may create and update
 *  contacts and companies, and it may not touch deals, pipelines, the field
 *  registry or anything else. That is exactly the authority a form fill needs.
 *
 *  Built here and nowhere else, so no route can hand itself a wider role. The
 *  actor kind is 'public' rather than 'integration', so the audit log reads as
 *  what it is: a stranger on the internet, not a named third party. */
const EDGE_ROLE: Role = 'marketing'

export const publicEdgeContext = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  actorId: null,
  actorKind: 'public',
  role: EDGE_ROLE,
})

export type PublicForm = {
  workspaceId: string
  /** Needed wherever the edge builds a link back into the CRM, which addresses
   *  its tenant in the path. Resolved with the form, not looked up after. */
  workspaceSlug: string
  formId: string
  name: string
  slug: string
  fields: FormField[]
  settings: FormSettings
  isActive: boolean
}

type PublicFormRow = {
  workspace_id: string
  workspace_slug: string
  form_id: string
  name: string
  slug: string
  schema: unknown
  settings: unknown
  is_active: boolean
}

const toPublicForm = (row: PublicFormRow): PublicForm => ({
  workspaceId: row.workspace_id,
  workspaceSlug: row.workspace_slug,
  formId: row.form_id,
  name: row.name,
  slug: row.slug,
  fields: readSchema(row.schema),
  settings: readSettings(row.settings),
  isActive: row.is_active,
})

/** The one question the public edge has to ask before it has a workspace. Goes
 *  through a security-definer function that takes a form id and returns nothing
 *  but that form's public shape, so there is no path from here to a record. */
export const publicFormById = async (formId: string): Promise<PublicForm | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(formId)) return null
  const rows = await appDb.execute<PublicFormRow>(sql`select * from rawr.public_form(${formId})`)
  const row = rows[0]
  return row ? toPublicForm(row) : null
}

export const publicFormBySlug = async (
  workspaceSlug: string,
  slug: string,
): Promise<PublicForm | null> => {
  const rows = await appDb.execute<PublicFormRow>(
    sql`select * from rawr.public_form_by_slug(${workspaceSlug}, ${slug})`,
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
  /** For the Slack job, which runs outside this transaction. */
  notify?:
    | { formName: string; contactId: string; values: Record<string, unknown>; attribution: Attribution }
    | undefined
}

/** How long two identical submissions count as the same one. F3 §5. */
const DUPLICATE_WINDOW_SECONDS = 60

/** The whole capture path, steps 2 to 8 of F3 §4, in one transaction.
 *
 *  Ordering is the point. Validation refuses unknown keys before anything is
 *  scored, scoring happens before a contact exists, and a quarantined submission
 *  is stored with its reasons but creates no contact at all. Nothing is ever
 *  silently dropped: even confirmed spam is a row somebody can look at. */
export const submitForm = async (input: SubmitInput): Promise<SubmitResult> => {
  const ctx = publicEdgeContext(input.form.workspaceId)
  // The ceiling above is only real if it is checked. A form fill writes contacts
  // and companies, so those are asserted here; a change that widened the edge to
  // deals would fail this rather than silently succeed.
  assertCanWrite(ctx, 'contact')
  assertCanWrite(ctx, 'company')
  const { fields, settings } = input.form

  const { answers, errors } = validateAnswers(fields, input.body)
  if (errors.length > 0) {
    return { submissionId: '', state: 'clean', contactId: null, companyId: null, errors }
  }

  const email = emailFrom(fields, answers)
  const attribution = readAttribution({ ...input.attribution, userAgent: input.userAgent })

  return withWorkspace(ctx, async (tx) => {
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
        workspaceId: ctx.workspaceId,
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

    if (linked.contactId) {
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
      success: { mode: settings.successMode, value: settings.successValue },
      notify:
        verdict.state === 'clean' && settings.notifySlack && linked.contactId
          ? { formName: input.form.name, contactId: linked.contactId, values: answers, attribution }
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
  // The window is sixty seconds and the index is (workspace, form, at desc), so
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
  ctx: WorkspaceContext,
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

/** A consent choice, appended never updated: prior data stays under the consent
 *  that was in force when it was collected, so overwriting the row would destroy
 *  the only evidence of what was lawful at the time.
 *
 *  Reached from the public edge, which has no session, so the workspace is
 *  resolved by the caller from a site key and never from the request body. */
export const recordConsent = async (
  workspaceId: string,
  input: {
    visitorId: string
    categories: { necessary: true; analytics: boolean; advertisement: boolean }
    policyVersion: string
    ipHash: string | null
    userAgent: string | null
  },
): Promise<string> => {
  const ctx = publicEdgeContext(workspaceId)
  return withWorkspace(ctx, async (tx) => {
    const [row] = await tx
      .insert(consentRecord)
      .values({
        workspaceId,
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

/** The workspace a public site key belongs to, resolved through the same
 *  security-definer path as a form so the edge never reads the workspace table
 *  unscoped.
 *
 *  Migration path: a real F4 site key wins, and a workspace slug is still accepted
 *  for any embed placed before sites existed. Once every embed on datasaur.ai
 *  carries a site key, the slug branch in rawr.workspace_for_site can go. */
export const workspaceIdForSite = async (siteKey: string): Promise<string | null> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.workspace_for_site(${siteKey})`,
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
  fieldCount: number
  submissions: number
  quarantined: number
  lastSubmissionAt: Date | null
}

export const listForms = async (ctx: WorkspaceContext): Promise<FormSummary[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      slug: string
      is_active: boolean
      schema: unknown
      submissions: string
      quarantined: string
      last_at: string | Date | null
    }>(sql`
      select f.id, f.name, f.slug, f.is_active, f.schema,
             count(s.id) filter (where s.spam_state in ('clean','released')) as submissions,
             count(s.id) filter (where s.spam_state = 'quarantined') as quarantined,
             max(s.at) as last_at
        from form f
        left join form_submission s on s.form_id = f.id
       group by f.id
       order by f.name`)

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.is_active,
      fieldCount: readSchema(row.schema).length,
      submissions: Number(row.submissions),
      quarantined: Number(row.quarantined),
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

export const getForm = async (ctx: WorkspaceContext, id: string): Promise<FormDetail | null> => {
  if (!isUuid(id)) return null
  return withWorkspace(ctx, async (tx) => {
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

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

export const saveForm = async (ctx: WorkspaceContext, input: SaveFormInput): Promise<string> =>
  mutate(ctx, 'form', async (tx) => {
    if (!input.name.trim()) throw new Error('A form needs a name.')
    if (!SLUG.test(input.slug)) {
      throw new Error(
        `"${input.slug}" is not a usable address. Use lowercase letters, numbers and hyphens.`,
      )
    }
    assertSchemaIsUsable(input.fields)

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
      .values({ workspaceId: ctx.workspaceId, ...values })
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
}

/** Refused while any submission exists: those are leads, and the form's schema
 *  is what makes them readable. Turn the form off instead, or delete it once its
 *  history has been dealt with. */
export const deleteForm = async (ctx: WorkspaceContext, id: string): Promise<void> => {
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
  ctx: WorkspaceContext,
  input: {
    state?: SubmissionRow['spamState'] | undefined
    formId?: string | undefined
    limit?: number | undefined
  } = {},
): Promise<SubmissionRow[]> =>
  withWorkspace(ctx, async (tx) => {
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
        ),
      )
      .orderBy(desc(formSubmission.at))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))

    return rows as SubmissionRow[]
  })

/** Releasing runs the full capture path from step 5, with the original timestamp
 *  preserved, so the timeline does not claim a week-old lead arrived today. */
export const releaseSubmission = async (
  ctx: WorkspaceContext,
  id: string,
): Promise<{ contactId: string | null }> => {
  const held = await withWorkspace(ctx, async (tx) => {
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

export const confirmSpam = async (ctx: WorkspaceContext, id: string): Promise<void> =>
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
