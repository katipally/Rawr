import {
  CRITICAL_ACTIONS,
  HUBS,
  SCOPES,
  acceptInvitation,
  copyMemberGrants,
  deactivateMember,
  invite,
  listAudit,
  listInvitations,
  listMembers,
  reactivateMember,
  readAccount,
  removeMember,
  resendInvitation,
  revokeInvitation,
  saveAccount,
  setMemberGrants,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router, superAdminProcedure } from '../trpc.ts'

/** The account as a thing to administer: its name, its domain, its seats, who
 *  holds one, and the history of those decisions.
 *
 *  Reads are open to any member, because knowing who your colleagues are is not
 *  privileged; every write is a super admin's, checked again in the data access
 *  layer. */

const hub = z.enum(HUBS)
/** Partial rather than a full record: a hub reaching everything is absent, which
 *  is the same shape the data access layer stores. */
const scopes = z.partialRecord(hub, z.enum(SCOPES)).optional()
const grants = {
  isSuperAdmin: z.boolean().optional(),
  viewHubs: z.array(hub).optional(),
  editHubs: z.array(hub).optional(),
  viewScopes: scopes,
  editScopes: scopes,
  /** HubSpot's Critical column: delete, merge, bulk delete, import, export and
   *  permanently delete, each granted on its own rather than by holding a hub. */
  criticalGrants: z.array(z.enum(CRITICAL_ACTIONS)).optional(),
}

export const accountRouter = router({
  get: protectedProcedure.query(({ ctx }) => call(() => readAccount(ctx.account))),

  save: superAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120).optional(),
        autoJoinHostedDomain: z.boolean().optional(),
        defaultViewHubs: z.array(hub).optional(),
        seatLimit: z.number().int().min(1).max(10_000).nullable().optional(),
        activityRetentionMonths: z.number().int().min(1).max(120).optional(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => saveAccount(ctx.account, input))),

  members: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listMembers(ctx.account))),

    invitations: superAdminProcedure.query(({ ctx }) => call(() => listInvitations(ctx.account))),

    /** Returns the link exactly once. Nothing stores it, so a lost link is
     *  resent rather than looked up. */
    invite: superAdminProcedure
      .input(z.object({ email: z.string().email(), ...grants }))
      .mutation(({ ctx, input }) => call(() => invite(ctx.account, input))),

    resend: superAdminProcedure
      .input(z.object({ invitationId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => resendInvitation(ctx.account, input.invitationId))),

    revoke: superAdminProcedure
      .input(z.object({ invitationId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => revokeInvitation(ctx.account, input.invitationId))),

    /** HubSpot's "copy another user's permissions", as one audited act. */
    copyGrants: superAdminProcedure
      .input(z.object({ fromUserId: z.string().uuid(), toUserId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => copyMemberGrants(ctx.account, input))),

    setGrants: superAdminProcedure
      .input(z.object({ userId: z.string().uuid(), ...grants }))
      .mutation(({ ctx, input }) => call(() => setMemberGrants(ctx.account, input))),

    deactivate: superAdminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => deactivateMember(ctx.account, input.userId))),

    reactivate: superAdminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => reactivateMember(ctx.account, input.userId))),

    remove: superAdminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => removeMember(ctx.account, input.userId))),
  }),

  audit: router({
    list: superAdminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
      .query(({ ctx, input }) => call(() => listAudit(ctx.account, input ?? {}))),
  }),

  /** Redeeming a link. The person may hold no membership here yet, which is the
   *  whole point of the invitation. */
  accept: protectedProcedure
    .input(z.object({ token: z.string().min(20) }))
    .mutation(({ ctx, input }) => call(() => acceptInvitation(input.token, ctx.session.userId))),
})
