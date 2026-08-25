import { sql, type SQL } from 'drizzle-orm'
import { recordActivity } from './activity.ts'
import { sourceFrom, type Attribution } from './attribution.ts'
import type { WorkspaceContext } from './context.ts'
import { employerDomainFromEmail } from './domains.ts'
import type { FormField } from './form-schema.ts'
import type { Tx } from './index.ts'

/** The one path by which a stranger becomes a contact.
 *
 *  A form fill and a booking are the same act from the CRM's point of view: an
 *  email address arrives with some facts attached, and it either matches somebody
 *  or it does not. Two implementations of that would drift on the rules that
 *  matter, and the rules that matter are subtle, so there is one.
 *
 *  The rule that matters most: an empty incoming value never overwrites an
 *  existing non-empty one. A booking form asking only for a name and an email must
 *  not blank out the job title a longer form collected last month. */

export type PersonCapture = {
  email: string
  /** Contact columns to set, already resolved to real column names. */
  contact: Record<string, unknown>
  /** Company columns, used only when the address implies an employer. */
  company: Record<string, unknown>
  attribution: Attribution
  /** Applied if the workspace has a stage by that name, ignored otherwise. */
  lifecycleStage?: string | null | undefined
  /** What the timeline says did this: 'form', 'booking'. */
  source: string
}

export type CapturedPerson = { contactId: string | null; companyId: string | null }

export const upsertCapturedPerson = async (
  tx: Tx,
  ctx: WorkspaceContext,
  input: PersonCapture,
): Promise<CapturedPerson> => {
  if (!input.email) return { contactId: null, companyId: null }

  const contactValues = { ...input.contact, email: input.email }

  const [existing] = await tx.execute<{ id: string; company_id: string | null }>(
    sql`select id, company_id from contact where lower(email) = lower(${input.email}) and deleted_at is null limit 1`,
  )

  const source = sourceFrom(input.attribution)
  const domain = employerDomainFromEmail(input.email)
  const companyId = domain ? await upsertCompany(tx, ctx, domain, input.company, source) : null

  if (existing) {
    const columnNames = Object.keys(contactValues)
    // Which of the columns this capture carries are currently empty. Read inside
    // the same transaction as the write, so "never blank an existing answer" holds
    // without casting every column through text to fake it in one statement.
    const [current] = columnNames.length
      ? await tx.execute<Record<string, unknown>>(
          sql`select ${sql.join(columnNames.map((c) => sql.raw(`"${c}"`)), sql`, `)}
                from contact where id = ${existing.id} limit 1`,
        )
      : [undefined]

    const assignments: SQL[] = []
    for (const [column, value] of Object.entries(contactValues)) {
      if (value === null || value === undefined || value === '') continue
      const held = current?.[column]
      if (held !== null && held !== undefined && held !== '') continue
      assignments.push(sql`${sql.raw(`"${column}"`)} = ${value as string}`)
    }
    assignments.push(sql`"latest_source" = ${JSON.stringify(source)}::jsonb`)
    assignments.push(sql`"original_source" = coalesce("original_source", ${JSON.stringify(source)}::jsonb)`)
    if (companyId && !existing.company_id) assignments.push(sql`"company_id" = ${companyId}`)
    assignments.push(sql`"updated_at" = now()`)

    await tx.execute(
      sql`update contact set ${sql.join(assignments, sql`, `)} where id = ${existing.id}`,
    )
    if (input.lifecycleStage) {
      await applyLifecycle(tx, ctx, existing.id, input.lifecycleStage, input.source)
    }
    return { contactId: existing.id, companyId: companyId ?? existing.company_id }
  }

  const columns: Record<string, unknown> = {
    ...contactValues,
    workspace_id: ctx.workspaceId,
    company_id: companyId,
    lead_source: source.channel,
    original_source: source,
    latest_source: source,
  }

  const names = Object.keys(columns).map((c) => sql.raw(`"${c}"`))
  const values = Object.values(columns).map((v) =>
    v !== null && typeof v === 'object' ? sql`${JSON.stringify(v)}::jsonb` : sql`${v}`,
  )

  const [created] = await tx.execute<{ id: string }>(sql`
    insert into contact (${sql.join(names, sql`, `)})
    values (${sql.join(values, sql`, `)})
    on conflict do nothing
    returning id`)

  if (!created) {
    // Lost a race with a concurrent capture of the same address. The winner's row
    // is the answer; the lead is not duplicated and not lost.
    const [raced] = await tx.execute<{ id: string }>(
      sql`select id from contact where lower(email) = lower(${input.email}) and deleted_at is null limit 1`,
    )
    return { contactId: raced?.id ?? null, companyId }
  }

  if (input.lifecycleStage) {
    await applyLifecycle(tx, ctx, created.id, input.lifecycleStage, input.source)
  }
  return { contactId: created.id, companyId }
}

const upsertCompany = async (
  tx: Tx,
  ctx: WorkspaceContext,
  domain: string,
  values: Record<string, unknown>,
  source: { channel: string; detail: Attribution },
): Promise<string | null> => {
  const [existing] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  if (existing) return existing.id

  const name = typeof values.name === 'string' && values.name ? values.name : null
  const [created] = await tx.execute<{ id: string }>(sql`
    insert into company (workspace_id, name, domain, original_source, latest_source)
    values (${ctx.workspaceId},
            ${name ?? domain.split('.')[0]},
            ${domain},
            ${JSON.stringify(source)}::jsonb,
            ${JSON.stringify(source)}::jsonb)
    on conflict do nothing
    returning id`)
  if (created) return created.id

  const [raced] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  return raced?.id ?? null
}

const applyLifecycle = async (
  tx: Tx,
  ctx: WorkspaceContext,
  contactId: string,
  stageName: string,
  source: string,
): Promise<void> => {
  const [stage] = await tx.execute<{ id: string; name: string }>(
    sql`select id, name from lifecycle_stage where name = ${stageName} limit 1`,
  )
  if (!stage) return

  const [before] = await tx.execute<{ lifecycle_stage_id: string | null; label: string }>(
    sql`select lifecycle_stage_id, coalesce(first_name || ' ' || last_name, email, 'Contact') as label
          from contact where id = ${contactId} limit 1`,
  )
  if (before?.lifecycle_stage_id === stage.id) return

  await tx.execute(
    sql`update contact set lifecycle_stage_id = ${stage.id}, updated_at = now() where id = ${contactId}`,
  )
  await recordActivity(tx, ctx, {
    type: 'lifecycle_change',
    subject: `moved ${before?.label ?? 'Contact'} to ${stage.name}`,
    source,
    payload: { to: stage.id, toLabel: stage.name },
    links: [{ entityType: 'contact', entityId: contactId }],
  })
}

/** Splits answers into the contact and company columns their mapping names. An
 *  unmapped answer is not lost: it is already stored verbatim on the submission or
 *  the booking that carried it.
 *
 *  Shared by forms and booking because both ask a stranger questions whose answers
 *  become record columns, and the mapping syntax is the same on both. */
export const mapAnswersToColumns = (
  fields: FormField[],
  answers: Record<string, unknown>,
): { contact: Record<string, unknown>; company: Record<string, unknown> } => {
  const contact: Record<string, unknown> = {}
  const company: Record<string, unknown> = {}
  for (const field of fields) {
    if (!field.mapsTo) continue
    const [object, key] = field.mapsTo.split('.')
    const value = answers[field.key]
    if (value === undefined || value === null || value === '') continue
    const target = object === 'company' ? company : object === 'contact' ? contact : null
    if (!target || !key) continue
    target[key] = Array.isArray(value) ? value.join('; ') : value
  }
  return { contact, company }
}
