import {
  clearOverride,
  disconnectGrant,
  FORM_FIELD_TYPES,
  listBookingPages,
  listBookings,
  listGrants,
  pagesHostedBy,
  readBooking,
  readBookingPage,
  readPageHostList,
  readSchedule,
  saveBookingPage,
  saveGrant,
  setGrantCalendar,
  saveOverride,
  saveSchedule,
  setPageActive,
} from '@rawr/db'
import { z } from 'zod'
import { devCalendarEnabled } from '~/lib/env.ts'
import { cancelWithProviders, rescheduleWithProviders } from '../booking.ts'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'
import { TRPCError } from '@trpc/server'

/** Shape gate only. Every rule that matters, including who may change which page,
 *  is checked again in the data access layer, so calling these directly is refused
 *  the same way the UI is. */
const questionSchema = z.object({
  key: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  visibleIf: z.object({ field: z.string(), equals: z.string() }).optional(),
  mapsTo: z.string().nullable().optional(),
})

const timeRange = z.tuple([
  z.string().regex(/^\d{1,2}:\d{2}$/, 'A time looks like 09:00.'),
  z.string().regex(/^\d{1,2}:\d{2}$/, 'A time looks like 09:00.'),
])

/** Partial, not exhaustive: a person who does not work Saturdays has no key for
 *  Saturday, and requiring all seven would force the client to send empty lists. */
const weeklySchema = z.partialRecord(
  z.enum(['1', '2', '3', '4', '5', '6', '7']),
  z.array(timeRange),
)

export const bookingRouter = router({
  pages: protectedProcedure.query(({ ctx }) => call(() => listBookingPages(ctx.account))),

  page: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => readBookingPage(ctx.account, input.id))),

  hosts: protectedProcedure
    .input(z.object({ pageId: z.uuid() }))
    .query(({ ctx, input }) => call(() => readPageHostList(ctx.account, input.pageId))),

  savePage: protectedProcedure
    .input(
      z.object({
        id: z.uuid().nullish(),
        slug: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        kind: z.enum(['one_on_one', 'round_robin', 'collective']),
        ownerId: z.uuid().nullish(),
        durationMinutes: z.number().int().min(5).max(1440),
        bufferBeforeMinutes: z.number().int().min(0).max(480),
        bufferAfterMinutes: z.number().int().min(0).max(480),
        minNoticeMinutes: z.number().int().min(0).max(43200),
        maxHorizonDays: z.number().int().min(1).max(365),
        granularityMinutes: z.number().int().min(5).max(1440),
        location: z.enum(['zoom', 'google_meet', 'phone', 'custom']),
        locationDetail: z.string().max(2000).nullish(),
        titleTpl: z.string().min(1).max(500),
        descriptionTpl: z.string().max(2000),
        companyFallback: z.string().min(1).max(200),
        questions: z.array(questionSchema),
        isActive: z.boolean(),
        redirectUrl: z.string().max(2000).nullish(),
        confirmationCopy: z.string().max(2000).nullish(),
        hosts: z
          .array(
            z.object({
              userId: z.uuid(),
              weight: z.number().int().min(1).max(100),
              isRequired: z.boolean().default(true),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => saveBookingPage(ctx.account, input))),

  setPageActive: protectedProcedure
    .input(z.object({ id: z.uuid(), isActive: z.boolean() }))
    .mutation(({ ctx, input }) =>
      call(() => setPageActive(ctx.account, input.id, input.isActive)),
    ),

  booked: protectedProcedure
    .input(
      z.object({
        pageId: z.uuid().nullish(),
        hostUserId: z.uuid().nullish(),
        state: z.enum(['confirmed', 'cancelled', 'rescheduled']).nullish(),
        when: z.enum(['upcoming', 'past']).default('upcoming'),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.object({ startsAt: z.coerce.date(), id: z.uuid() }).nullish(),
      }),
    )
    .query(({ ctx, input }) => call(() => listBookings(ctx.account, input))),

  /** Cancelling from inside the CRM. The provider side is the same code the
   *  attendee's own cancel link runs, so the two cannot drift. */
  cancel: protectedProcedure
    .input(z.object({ id: z.uuid(), reason: z.string().max(500).nullish() }))
    .mutation(({ ctx, input }) =>
      call(async () => {
        const booking = await readBooking(ctx.account, input.id)
        if (!booking) throw new TRPCError({ code: 'NOT_FOUND', message: 'That meeting no longer exists.' })
        return cancelWithProviders(booking, { reason: input.reason ?? null, by: 'host' })
      }),
    ),

  reschedule: protectedProcedure
    .input(z.object({ id: z.uuid(), startsAt: z.coerce.date() }))
    .mutation(({ ctx, input }) =>
      call(async () => {
        const booking = await readBooking(ctx.account, input.id)
        if (!booking) throw new TRPCError({ code: 'NOT_FOUND', message: 'That meeting no longer exists.' })
        const outcome = await rescheduleWithProviders({ booking, startsAt: input.startsAt })
        if (!outcome.ok) throw new TRPCError({ code: 'CONFLICT', message: outcome.message })
        return { bookingId: outcome.booking.bookingId, startsAt: outcome.booking.startsAt }
      }),
    ),

  schedule: protectedProcedure
    .input(z.object({ userId: z.uuid().nullish() }))
    .query(({ ctx, input }) =>
      call(() => readSchedule(ctx.account, input.userId ?? ctx.session.userId)),
    ),

  saveSchedule: protectedProcedure
    .input(
      z.object({
        userId: z.uuid().nullish(),
        timezone: z.string().min(1).max(64),
        weekly: weeklySchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        saveSchedule(ctx.account, {
          userId: input.userId ?? ctx.session.userId,
          timezone: input.timezone,
          weekly: input.weekly,
        }),
      ),
    ),

  saveOverride: protectedProcedure
    .input(
      z.object({
        userId: z.uuid().nullish(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        isUnavailable: z.boolean(),
        blocks: z.array(timeRange).default([]),
        note: z.string().max(200).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        saveOverride(ctx.account, { ...input, userId: input.userId ?? ctx.session.userId }),
      ),
    ),

  clearOverride: protectedProcedure
    .input(z.object({ userId: z.uuid().nullish(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .mutation(({ ctx, input }) =>
      call(() =>
        clearOverride(ctx.account, { userId: input.userId ?? ctx.session.userId, day: input.day }),
      ),
    ),

  grants: protectedProcedure.query(({ ctx }) => call(() => listGrants(ctx.account))),

  myPages: protectedProcedure.query(({ ctx }) =>
    call(() => pagesHostedBy(ctx.account, ctx.session.userId)),
  ),

  /** Open item 3 is outstanding, so there is no Google project to consent against.
   *  This connects the development provider instead: Rawr's own confirmed bookings
   *  become the only source of busy time, which is enough to exercise every rule in
   *  §2 and §3. It is refused outside development, where guessing at somebody's
   *  calendar would double book them. */
  connectDevCalendar: protectedProcedure
    .input(z.object({ userId: z.uuid().nullish() }))
    .mutation(({ ctx, input }) =>
      call(async () => {
        if (!devCalendarEnabled) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message:
              'The development calendar provider is not available here. Connect Google Calendar instead (open item 3).',
          })
        }
        await saveGrant(ctx.account, {
          userId: input.userId ?? ctx.session.userId,
          provider: 'dev',
          calendarId: 'primary',
        })
        return { connected: true as const }
      }),
    ),

  /** Which calendar the invitation is written to. Google hands a person several
   *  and "primary" is only right until somebody keeps their meetings elsewhere. */
  setCalendar: protectedProcedure
    .input(z.object({ userId: z.uuid().nullish(), calendarId: z.string().trim().min(1).max(320) }))
    .mutation(({ ctx, input }) =>
      call(() =>
        setGrantCalendar(ctx.account, {
          userId: input.userId ?? ctx.session.userId,
          calendarId: input.calendarId,
        }),
      ),
    ),

  disconnectCalendar: protectedProcedure
    .input(z.object({ userId: z.uuid().nullish() }))
    .mutation(({ ctx, input }) =>
      call(() => disconnectGrant(ctx.account, input.userId ?? ctx.session.userId)),
    ),
})
