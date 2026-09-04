import {
  acceptInvitation,
  createWorkspace,
  deactivateMember,
  invite,
  listInvitations,
  listOrgAudit,
  listOrgMembers,
  listOrgWorkspaces,
  reactivateMember,
  readOrganisation,
  renameWorkspace,
  resendInvitation,
  revokeInvitation,
  saveOrganisation,
  setOrgRole,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { orgAdminProcedure, protectedProcedure, router } from '../trpc.ts'

/** The company, above any one workspace: which workspaces exist, who is in it,
 *  what they may administer, and the history of those decisions.
 *
 *  Reads are open to any member, because knowing who your colleagues are is not
 *  privileged; every write is an organisation admin's, checked again in the data
 *  access layer. */
export const orgRouter = router({
  get: protectedProcedure.query(({ ctx }) => call(() => readOrganisation(ctx.organisation))),

  save: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120).optional(),
        autoJoinHostedDomain: z.boolean().optional(),
        seatLimit: z.number().int().min(1).max(10_000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => saveOrganisation(ctx.organisation, input))),

  workspaces: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listOrgWorkspaces(ctx.organisation))),

    create: orgAdminProcedure
      .input(z.object({ name: z.string().min(1).max(120), slug: z.string().min(1).max(40) }))
      .mutation(({ ctx, input }) => call(() => createWorkspace(ctx.organisation, input))),

    rename: orgAdminProcedure
      .input(z.object({ workspaceId: z.string().uuid(), name: z.string().min(1).max(120) }))
      .mutation(({ ctx, input }) => call(() => renameWorkspace(ctx.organisation, input))),
  }),

  members: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listOrgMembers(ctx.organisation))),

    invitations: orgAdminProcedure.query(({ ctx }) => call(() => listInvitations(ctx.organisation))),

    /** Returns the link exactly once. Nothing stores it, so a lost link is
     *  resent rather than looked up. */
    invite: orgAdminProcedure
      .input(
        z.object({
          email: z.string().email(),
          orgRole: z.enum(['org_admin', 'member']).optional(),
          workspaceId: z.string().uuid().nullable().optional(),
          workspaceRole: z.enum(['admin', 'sales', 'marketing', 'viewer']).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => invite(ctx.organisation, input))),

    resend: orgAdminProcedure
      .input(z.object({ invitationId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => resendInvitation(ctx.organisation, input.invitationId))),

    revoke: orgAdminProcedure
      .input(z.object({ invitationId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => revokeInvitation(ctx.organisation, input.invitationId))),

    setOrgRole: orgAdminProcedure
      .input(z.object({ userId: z.string().uuid(), role: z.enum(['org_admin', 'member']) }))
      .mutation(({ ctx, input }) => call(() => setOrgRole(ctx.organisation, input))),

    deactivate: orgAdminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => deactivateMember(ctx.organisation, input.userId))),

    reactivate: orgAdminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => reactivateMember(ctx.organisation, input.userId))),
  }),

  audit: router({
    list: orgAdminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
      .query(({ ctx, input }) => call(() => listOrgAudit(ctx.organisation, input ?? {}))),
  }),

  /** Redeeming a link. Not an organisation-scoped call: the person has no session
   *  in that organisation yet, which is the whole point of the invitation. */
  accept: protectedProcedure
    .input(z.object({ token: z.string().min(20) }))
    .mutation(({ ctx, input }) => call(() => acceptInvitation(input.token, ctx.session.userId))),
})
