import {
  ForbiddenError,
  listDeadLetters,
  promoteFieldToHot,
  replayDeadLetter,
  schema,
  withWorkspace,
} from '@rawr/db'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { adminProcedure, protectedProcedure, publicProcedure, router } from '../trpc.ts'

const PAGE_MAX = 200

/** Keyset, never offset: OFFSET 80000 over 88,270 contacts is a table scan. */
const cursor = z.object({ createdAt: z.coerce.date(), id: z.uuid() })

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true as const })),

  me: protectedProcedure.query(({ ctx }) => ({
    email: ctx.session.email,
    displayName: ctx.session.displayName,
    role: ctx.session.role,
    workspaceName: ctx.session.workspaceName,
  })),

  jobs: router({
    deadLetters: adminProcedure.query(({ ctx }) => listDeadLetters(ctx.workspace)),

    replay: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        try {
          await replayDeadLetter(ctx.workspace, input.id)
          return { replayed: true as const }
        } catch (cause) {
          if (cause instanceof ForbiddenError) {
            throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause })
          }
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          })
        }
      }),
  }),

  fields: router({
    /** Admin only, enforced in the data access layer rather than by hiding the
     *  button. The index itself is built by the worker, because CREATE INDEX
     *  CONCURRENTLY cannot run inside a request. */
    promoteToHot: protectedProcedure
      .input(z.object({ fieldId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await promoteFieldToHot(ctx.workspace, input.fieldId)
        } catch (cause) {
          if (cause instanceof ForbiddenError) {
            throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause })
          }
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          })
        }
      }),
  }),

  contacts: router({
    list: protectedProcedure
      .input(
        z.object({
          search: z.string().trim().max(200).optional(),
          limit: z.number().int().min(1).max(PAGE_MAX).default(50),
          cursor: cursor.optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await withWorkspace(ctx.workspace, (tx) =>
          tx
            .select({
              id: schema.contact.id,
              firstName: schema.contact.firstName,
              lastName: schema.contact.lastName,
              email: schema.contact.email,
              title: schema.contact.title,
              companyName: schema.company.name,
              createdAt: schema.contact.createdAt,
            })
            .from(schema.contact)
            .leftJoin(schema.company, eq(schema.company.id, schema.contact.companyId))
            .where(
              and(
                input.search
                  ? sql`${schema.contact.search} @@ plainto_tsquery('simple', ${input.search})`
                  : undefined,
                input.cursor
                  ? or(
                      lt(schema.contact.createdAt, input.cursor.createdAt),
                      and(
                        eq(schema.contact.createdAt, input.cursor.createdAt),
                        lt(schema.contact.id, input.cursor.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(schema.contact.createdAt), desc(schema.contact.id))
            .limit(input.limit + 1),
        )

        const page = rows.slice(0, input.limit)
        const next = rows.length > input.limit ? page.at(-1) : undefined
        return {
          rows: page,
          nextCursor: next ? { createdAt: next.createdAt, id: next.id } : null,
        }
      }),
  }),
})

export type AppRouter = typeof appRouter
