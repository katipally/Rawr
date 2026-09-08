import { asc, eq, isNull, or } from 'drizzle-orm'
import { reportDashboard } from '../schema/report-dashboard.ts'
import { userAccount } from '../schema/identity.ts'
import { isAdmin, type AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'

/** B11. Reports somebody assembled.
 *
 *  This file stores an ordered list of card keys and nothing more. It does not
 *  know what a card is: the catalogue lives in the web app beside the six report
 *  readers whose figures the cards are, because a card is a way of showing a
 *  number and not a way of getting one. That is also why there is no validation
 *  of a key here. An unknown key is dropped where the dashboard is drawn, so a
 *  card retired from the catalogue quietly disappears instead of failing a page
 *  somebody opens every morning. */

export type ReportDashboardRow = {
  id: string
  name: string
  ownerId: string | null
  ownerName: string | null
  isShared: boolean
  cards: string[]
  updatedAt: Date
}

const cardsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []

/** Everything this person may see: the shared ones, plus their own private ones.
 *
 *  Row level security already confines this to the account. The owner test on
 *  top of it is about clutter and not about secrecy: every card reads a report
 *  the viewer's role can already open. */
export const listReportDashboards = async (ctx: AccountContext): Promise<ReportDashboardRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: reportDashboard.id,
        name: reportDashboard.name,
        ownerId: reportDashboard.ownerId,
        ownerName: userAccount.name,
        isShared: reportDashboard.isShared,
        cards: reportDashboard.cards,
        updatedAt: reportDashboard.updatedAt,
      })
      .from(reportDashboard)
      .leftJoin(userAccount, eq(userAccount.id, reportDashboard.ownerId))
      .where(
        ctx.actorId
          ? or(eq(reportDashboard.isShared, true), eq(reportDashboard.ownerId, ctx.actorId), isNull(reportDashboard.ownerId))
          : eq(reportDashboard.isShared, true),
      )
      .orderBy(asc(reportDashboard.name))

    return rows.map((row) => ({ ...row, cards: cardsOf(row.cards) }))
  })

export const readReportDashboard = async (ctx: AccountContext, id: string): Promise<ReportDashboardRow | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: reportDashboard.id,
        name: reportDashboard.name,
        ownerId: reportDashboard.ownerId,
        ownerName: userAccount.name,
        isShared: reportDashboard.isShared,
        cards: reportDashboard.cards,
        updatedAt: reportDashboard.updatedAt,
      })
      .from(reportDashboard)
      .leftJoin(userAccount, eq(userAccount.id, reportDashboard.ownerId))
      .where(eq(reportDashboard.id, id))
      .limit(1)

    if (!row) return null
    // A private reportDashboard belongs to its owner. Not a permission boundary around
    // data, since the cards read reports this person can open anyway; it is so a
    // link to somebody's own working screen does not become everybody's.
    if (!row.isShared && row.ownerId && row.ownerId !== ctx.actorId && !isAdmin(ctx)) return null
    return { ...row, cards: cardsOf(row.cards) }
  })

export type SaveReportDashboardInput = {
  id?: string | null | undefined
  name: string
  cards: string[]
  isShared: boolean
}

export const saveReportDashboard = async (
  ctx: AccountContext,
  input: SaveReportDashboardInput,
): Promise<{ id: string }> =>
  mutate(ctx, 'report_dashboard', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('A reportDashboard needs a name.')
    if (input.cards.length === 0) throw new Error('A reportDashboard with no cards would be a blank page.')

    if (input.id) {
      const [before] = await tx
        .select({ name: reportDashboard.name, ownerId: reportDashboard.ownerId, cards: reportDashboard.cards })
        .from(reportDashboard)
        .where(eq(reportDashboard.id, input.id))
        .limit(1)
      if (!before) throw new Error('That reportDashboard no longer exists.')
      if (before.ownerId && before.ownerId !== ctx.actorId && !isAdmin(ctx)) {
        throw new Error('That reportDashboard belongs to somebody else. Copy it rather than editing it.')
      }

      await tx
        .update(reportDashboard)
        .set({ name, cards: input.cards, isShared: input.isShared, updatedAt: new Date() })
        .where(eq(reportDashboard.id, input.id))

      return {
        result: { id: input.id },
        audit: {
          entity: 'report_dashboard',
          entityId: input.id,
          action: 'update',
          before: { name: before.name, cards: cardsOf(before.cards) },
          after: { name, cards: input.cards },
        },
      }
    }

    const [created] = await tx
      .insert(reportDashboard)
      .values({
        accountId: ctx.accountId,
        name,
        ownerId: ctx.actorId,
        isShared: input.isShared,
        cards: input.cards,
      })
      .returning({ id: reportDashboard.id })
    if (!created) throw new Error('The reportDashboard could not be created.')

    return {
      result: { id: created.id },
      audit: {
        entity: 'report_dashboard',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { name, cards: input.cards },
      },
    }
  })

export const deleteReportDashboard = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'report_dashboard', async (tx) => {
    const [found] = await tx
      .select({ name: reportDashboard.name, ownerId: reportDashboard.ownerId })
      .from(reportDashboard)
      .where(eq(reportDashboard.id, id))
      .limit(1)
    if (!found) throw new Error('That reportDashboard no longer exists.')
    if (found.ownerId && found.ownerId !== ctx.actorId && !isAdmin(ctx)) {
      throw new Error('That reportDashboard belongs to somebody else.')
    }

    await tx.delete(reportDashboard).where(eq(reportDashboard.id, id))
    return {
      result: undefined,
      audit: { entity: 'report_dashboard', entityId: id, action: 'delete', before: found, after: null },
    }
  })
