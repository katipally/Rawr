import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, workspaceId } from './columns.ts'
import { userAccount, workspace } from './identity.ts'

/** B11. Reports somebody assembled, rather than the six Rawr ships.
 *
 *  The six reports each answer one question well and none of them answers the
 *  question a particular person has on a particular Monday, which is usually four
 *  numbers from three of them. HubSpot's answer is a dashboard of cards, and this
 *  is the same idea with a fixed catalogue: every card is a figure one of the six
 *  reports already computes, so nothing here can ask the database something the
 *  reports cannot.
 *
 *  A dashboard holds card keys and an order and nothing else. No layout, no sizes,
 *  no per-card date range: the range lives in the URL exactly as it does on the
 *  reports, so a dashboard link carries the period it was read over. */
export const reportDashboard = pgTable(
  'report_dashboard',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Whoever made it. A dashboard outlives the person who leaves, so this is
     *  set null rather than cascade, and a shared one keeps working. */
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    /** Off means only the owner sees it in the list. Nothing on a dashboard is a
     *  secret: every card reads a report the viewer's role already allows, so this
     *  is about clutter rather than about permission. */
    isShared: boolean('is_shared').notNull().default(false),
    /** Ordered card keys from the catalogue. A key that no longer exists is
     *  dropped when the dashboard is read rather than failing it, so removing a
     *  card from the catalogue cannot break somebody's screen. */
    cards: jsonb('cards').notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('report_dashboard_owner_idx').on(t.workspaceId, t.ownerId)],
)
