import type { Hub } from '@rawr/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { appRouter } from '~/server/routers/_app.ts'
import type { Session } from '~/server/session.ts'
import type { ToolDefinition, ToolResult } from './tools.ts'

/** F5 §2, the other half: every screen in Rawr, reachable from an assistant.
 *
 *  The ten hand-written tools answer the way a person talks: names, not ids, and
 *  dates as said. Everything else the app can do is a tRPC procedure with a zod
 *  input, and each one becomes a tool here with no per-procedure code. The tool
 *  calls the same procedure the screen calls, under the same session shape, so a
 *  feature added to the app is a tool the moment it has a procedure. One
 *  mechanism, the whole surface: O(procedures) at boot, O(1) per call. */

type Procedure = {
  _def: { type: 'query' | 'mutation' | 'subscription'; inputs: unknown[] }
}

/** What each router is for, in the words a model needs to pick the right one. */
const GROUPS: Record<string, string> = {
  crm: 'Records of every object including ones an admin invented, views, board, calendar, timeline, tasks, associations, files, imports and exports.',
  segments: 'Saved audiences built from filters, and who is in them.',
  booking: 'Meeting pages, availability, calendars and booked meetings.',
  forms: 'Lead forms, their submissions and the review queue.',
  analytics: 'Website page views, events and tracked sites.',
  mail: 'Connected Gmail mailboxes and the email threads on a contact.',
  integrations: 'Brevo, Apollo, Clay, Lusha, Woodpecker, Slack, GA4 and Zoom, and reading a HubSpot export: connection, health, enrichment and replay. Also outbound webhooks: the endpoints Rawr posts to, what they subscribe to and their signing secrets.',
  admin: 'Account settings: objects an admin invents, fields, pipelines, stages, lifecycle, subscription types, members, and automation rules with their run log.',
  mcp: 'Agent access tokens.',
  sequences: 'Multi-step outreach sent from a member\'s own Gmail, or handed to a Woodpecker campaign: the sequences, their steps, and who is in them.',
  notifications: 'What is waiting on the signed-in person: overdue tasks, held submissions, and, for an admin, what is broken.',
  teams: 'Named groups inside this account, used to rotate assignment within a team.',
  jobs: 'Failed jobs and dead letters.',
  account: 'The signed-in person\'s own sessions.',
  reporting: 'Six reports over a date range: the pipeline, forms, sequences, email, the website, and which channels the contacts who buy first arrived through.',
}

const DESTRUCTIVE = /delete|remove|merge|purge|revoke|disconnect|erase|bulk|dismiss|signOut|roll/i

const words = (camel: string): string =>
  camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()

const toolName = (path: string): string =>
  path
    .split('.')
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
    .join('_')
    .slice(0, 64)

type InputShape = { schema: Record<string, unknown>; wrapped: boolean }

const inputSchemaFor = (inputs: unknown[]): InputShape => {
  const schema = inputs.find((input) => input instanceof z.ZodType) as z.ZodType | undefined
  if (!schema) return { schema: { type: 'object', properties: {}, additionalProperties: false }, wrapped: false }
  try {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-7' }) as Record<string, unknown>
    delete json.$schema
    if (json.type === 'object' || json.properties) return { schema: json, wrapped: false }
    // A procedure whose input is not an object is wrapped so the tool still takes
    // a JSON object, under one key the model can see.
    return { schema: { type: 'object', properties: { input: json }, required: ['input'] }, wrapped: true }
  } catch {
    return { schema: { type: 'object', properties: {}, additionalProperties: true }, wrapped: false }
  }
}

/** Maps and Sets come out of the data layer; a tool result is JSON. Dates keep
 *  their ISO form through JSON.stringify on their own. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value ?? null, (_key, entry: unknown) => {
      if (entry instanceof Map) return Object.fromEntries(entry)
      if (entry instanceof Set) return [...entry]
      if (typeof entry === 'bigint') return entry.toString()
      return entry
    }),
  )

const summarise = (path: string, type: string, data: unknown): string => {
  if (Array.isArray(data)) return `${path}: ${data.length} row${data.length === 1 ? '' : 's'}.`
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const rows = Array.isArray(record.rows) ? record.rows.length : Array.isArray(record.items) ? record.items.length : null
    if (rows !== null) return `${path}: ${rows} row${rows === 1 ? '' : 's'}${record.nextCursor || record.cursor ? ', more available with the cursor' : ''}.`
    return `${path} ${type === 'query' ? 'answered' : 'done'}. See structuredContent.`
  }
  return `${path}: ${String(data)}`
}

export const sessionFor = (caller: {
  userId: string
  userEmail: string
  userName: string
  accountSlug: string
  accountName: string
  ctx: { accountId: string; isSuperAdmin: boolean; viewHubs: readonly Hub[]; editHubs: readonly Hub[] }
}): Session => ({
  userId: caller.userId,
  email: caller.userEmail,
  displayName: caller.userName,
  avatarUrl: null,
  accountId: caller.ctx.accountId,
  accountSlug: caller.accountSlug,
  accountName: caller.accountName,
  hostedDomain: caller.userEmail.split('@')[1] ?? '',
  isSuperAdmin: caller.ctx.isSuperAdmin,
  viewHubs: [...caller.ctx.viewHubs],
  editHubs: [...caller.ctx.editHubs],
})

const SKIPPED = new Set(['health', 'me'])

const generatedTool = (path: string, procedure: Procedure): ToolDefinition => {
  const [group = '', ...rest] = path.split('.')
  const leaf = rest.join(' ')
  const writes = procedure._def.type === 'mutation'
  const { schema, wrapped } = inputSchemaFor(procedure._def.inputs)
  const title = `${group}: ${words(leaf)}`
  const description = [
    `${writes ? 'Changes' : 'Reads'} ${words(leaf)} in ${group}. ${GROUPS[group] ?? ''}`.trim(),
    'Takes ids, not names: find them with search_records or a list tool first.',
    writes && DESTRUCTIVE.test(path) ? 'This is hard to undo. Confirm with the person before calling it.' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    name: toolName(path),
    title,
    description: () => description,
    inputSchema: () => schema,
    writes,
    run: async (context, args): Promise<ToolResult> => {
      const caller = appRouter.createCaller({
        session: sessionFor(context.caller),
        // Through the token's own context, so the audit row says "mcp" and names
        // the person, exactly as the hand-written tools do.
        account: context.caller.ctx,
      })
      const target = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (
        input: unknown,
      ) => Promise<unknown>
      const input = wrapped ? args.input : Object.keys(args).length === 0 && procedure._def.inputs.length === 0 ? undefined : args
      try {
        const result = await target(input)
        const data = plain(result)
        // structuredContent is an object by spec; a list answer is wrapped so the
        // count in the sentence and the rows in the data agree.
        return {
          text: summarise(path, procedure._def.type, data),
          data: data === null ? undefined : Array.isArray(data) ? { rows: data } : (data as object),
        }
      } catch (cause) {
        if (cause instanceof TRPCError) return { text: cause.message, isError: true }
        throw cause
      }
    },
  }
}

export const GENERATED_TOOLS: ToolDefinition[] = Object.entries(
  appRouter._def.procedures as unknown as Record<string, Procedure>,
)
  .filter(([path, procedure]) => !SKIPPED.has(path) && procedure._def.type !== 'subscription')
  .map(([path, procedure]) => generatedTool(path, procedure))
