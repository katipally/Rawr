import {
  attachContactToMail,
  addBlocklistEntry,
  beginMailAttachment,
  canWrite,
  changeThread,
  DEV_ACCESS_TOKEN,
  bodyProgress,
  disconnectMailbox,
  listBlocklist,
  listInboxThreads,
  listMailboxes,
  markThreadRead,
  readThread,
  removeBlocklistEntry,
  saveMailbox,
  setMailboxOpenAlert,
  setMailboxSending,
  setMailboxVisibility,
  threadsForContact,
} from '@rawr/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { devGmailEnabled } from '~/lib/env.ts'
import { MAX_MESSAGE_BYTES, SEND_REFUSED } from '~/lib/mail-compose.ts'
import { call } from '../errors.ts'
import { hydrateMailboxBodies, syncMailbox } from '../gmail.ts'
import { compose, discardMailAttachment, templateForCompose } from '../sequences/compose.ts'
import { storageConfigured } from '../storage.ts'
import { protectedProcedure, router } from '../trpc.ts'

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const sendWindowInput = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: z.string().regex(CLOCK),
    end: z.string().regex(CLOCK),
    timezone: z.string().min(1).max(64),
  })
  .refine((window) => window.start < window.end, 'The sending window has to end after it starts.')
  .refine((window) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: window.timezone })
      return true
    } catch {
      return false
    }
  }, 'That is not a timezone this system knows.')

/** Reading is open to anybody signed in, because a thread on a record is the
 *  record's history. Which threads that means is decided by the mailbox's own
 *  visibility, in SQL, not by what the client asks for; connecting, disconnecting
 *  and sharing are per person, enforced in the data access layer. */
export const mailRouter = router({
  mailboxes: protectedProcedure.query(({ ctx }) => call(() => listMailboxes(ctx.account))),

  /** The development mailbox, so the whole path is exercisable before the Google
   *  consent screen exists. Refused outright anywhere it is not enabled, rather
   *  than quietly storing a token that is not one. */
  connectDev: protectedProcedure.mutation(({ ctx }) =>
    call(async () => {
      if (!devGmailEnabled) {
        throw new Error('The development mailbox is not enabled here. Connect a real one with Google.')
      }
      return saveMailbox(ctx.account, {
        userId: ctx.session.userId,
        email: ctx.session.email,
        accessToken: DEV_ACCESS_TOKEN,
        refreshToken: 'dev-refresh',
        accessTokenExpiresAt: null,
        // The development mailbox can send, because the send goes nowhere: the
        // whole engine below it is otherwise unexercisable without Google.
        canSend: true,
        canModify: true,
      })
    }),
  ),

  /** Hangs the conversation a new contact is already on onto their record, so the
   *  history starts where it happened rather than today. */
  attachContact: protectedProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => attachContactToMail(ctx.account, input.contactId))),

  disconnect: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => disconnectMailbox(ctx.account, input.id))),

  /** Who may read what this mailbox brought in. Team by default: continuity is
   *  the point. Private is for a mailbox carrying personal mail. */
  setVisibility: protectedProcedure
    .input(z.object({ mailboxId: z.uuid(), visibility: z.enum(['team', 'private']) }))
    .mutation(({ ctx, input }) => call(() => setMailboxVisibility(ctx.account, input))),

  /** What this mailbox sends and how fast. Validated here rather than in the
   *  browser as well: a window that never opens would queue every enrollment on
   *  it for ever. */
  setSending: protectedProcedure
    .input(
      z.object({
        mailboxId: z.uuid(),
        dailyCap: z.number().int().min(1).max(2000),
        minGapSeconds: z.number().int().min(0).max(86_400),
        sendWindow: sendWindowInput.nullable(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => setMailboxSending(ctx.account, input))),

  /** Opt in, per mailbox, to a bell entry when a mail this mailbox sent is
   *  opened. One notice per message however many times the pixel is fetched. */
  setOpenAlert: protectedProcedure
    .input(z.object({ mailboxId: z.uuid(), alertOnOpen: z.boolean() }))
    .mutation(({ ctx, input }) => call(() => setMailboxOpenAlert(ctx.account, input))),

  /** How much of the back-fill has had its body stored, so a long run is visible
   *  rather than mysterious. */
  bodyProgress: protectedProcedure.query(({ ctx }) => call(() => bodyProgress(ctx.account))),

  /** One hydrate pass by hand, the way `sync` is. The worker runs the same
   *  function on a schedule. */
  hydrate: protectedProcedure
    .input(z.object({ id: z.uuid(), limit: z.number().int().min(1).max(200).optional() }))
    .mutation(({ ctx, input }) => call(() => hydrateMailboxBodies(ctx.account, input.id, input.limit ?? 50))),

  /** One pass, run by hand. The worker runs the same function on a schedule; this
   *  is for somebody who has just connected and wants to see history appear. */
  sync: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      call(() => syncMailbox(ctx.account, input.id)),
    ),

  blocklist: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listBlocklist(ctx.account))),

    add: protectedProcedure
      .input(
        z.object({
          pattern: z.string().trim().min(3).max(200),
          note: z.string().max(200).nullish(),
          scope: z.enum(['account', 'mine']),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          addBlocklistEntry(ctx.account, {
            pattern: input.pattern,
            ...(input.note !== undefined ? { note: input.note } : {}),
            scope: input.scope,
          }),
        ),
      ),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => removeBlocklistEntry(ctx.account, input.id))),
  }),

  threadsFor: protectedProcedure
    .input(z.object({ contactId: z.uuid(), limit: z.number().int().min(1).max(100).optional() }))
    .query(({ ctx, input }) =>
      call(() => threadsForContact(ctx.account, input.contactId, input.limit ?? 20)),
    ),

  thread: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => readThread(ctx.account, input.id))),

  /** The shared inbox. Keyset paged; the filters are all on the thread, so page
   *  fifty costs what page one costs. */
  inbox: protectedProcedure
    .input(
      z
        .object({
          scope: z.enum(['mine', 'all']).optional(),
          mailboxId: z.uuid().nullable().optional(),
          unreplied: z.boolean().optional(),
          unread: z.boolean().optional(),
          assignedToMe: z.boolean().optional(),
          folder: z.enum(['inbox', 'archived', 'trash']).optional(),
          q: z.string().trim().max(200).nullable().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.object({ lastAt: z.string(), id: z.uuid() }).nullable().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => call(() => listInboxThreads(ctx.account, input ?? {}))),

  /** One email, by hand, from the caller's own mailbox. Tracked only when it is
   *  addressed to a contact who may be tracked; to a bare address it carries
   *  nothing. Never an unsubscribe footer: this is correspondence, not a
   *  campaign. The recipients are read as text here, the same way the composer
   *  reads them, so a pasted list arrives whole. */
  compose: protectedProcedure
    .input(
      z
        .object({
          mailboxId: z.uuid(),
          to: z.string().max(10_000),
          cc: z.string().max(10_000).default(''),
          bcc: z.string().max(10_000).default(''),
          replyTo: z.string().max(10_000).default(''),
          subject: z.string().trim().min(1).max(300),
          text: z.string().max(100_000).optional(),
          html: z.string().max(200_000).optional(),
          threadId: z.uuid().nullable().optional(),
          contactId: z.uuid().nullable().optional(),
          attachments: z
            .array(
              z.object({
                storageKey: z.string().min(1).max(500),
                filename: z.string().trim().min(1).max(255),
                mime: z.string().max(120),
              }),
            )
            .max(100)
            .default([]),
        })
        .refine((input) => input.text !== undefined || input.html !== undefined, 'Write the message before sending.'),
    )
    .mutation(({ ctx, input }) => {
      if (!canWrite(ctx.account, 'contact')) throw new TRPCError({ code: 'FORBIDDEN', message: SEND_REFUSED })
      return call(() => compose(ctx.account, input))
    }),

  /** A saved template, with its merge fields filled from one contact, for the
   *  composer to put into the message. */
  templateFor: protectedProcedure
    .input(z.object({ templateId: z.uuid(), mailboxId: z.uuid(), contactId: z.uuid().nullable().optional() }))
    .query(({ ctx, input }) =>
      call(() =>
        templateForCompose(ctx.account, {
          templateId: input.templateId,
          mailboxId: input.mailboxId,
          contactId: input.contactId ?? null,
        }),
      ),
    ),

  attachments: router({
    /** Names where a file for a message will be uploaded, and refuses one too big
     *  for any single file. The bytes then go to /api/attachments/upload with the key. */
    begin: protectedProcedure
      .input(
        z.object({
          filename: z.string().trim().min(1).max(255),
          bytes: z.number().int().positive().max(MAX_MESSAGE_BYTES),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          if (!storageConfigured) throw new Error('Attachments are not set up for this account yet.')
          return beginMailAttachment(ctx.account, input)
        }),
      ),

    discard: protectedProcedure
      .input(z.object({ storageKey: z.string().min(1).max(500) }))
      .mutation(({ ctx, input }) => call(() => discardMailAttachment(ctx.account, input.storageKey))),
  }),

  /** Marks a thread read up to now, for the caller alone. A separate call, so a
   *  background refresh cannot silently clear somebody's unread count. */
  markRead: protectedProcedure
    .input(z.object({ threadId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => markThreadRead(ctx.account, input.threadId))),

  /** Archive, Trash, assignment and unread, one change at a time. Recorded here at
   *  once; the worker sends it on to Gmail. */
  changeThread: protectedProcedure
    .input(
      z.object({
        threadId: z.uuid(),
        change: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('archived'), value: z.boolean() }),
          z.object({ kind: z.literal('trashed'), value: z.boolean() }),
          z.object({ kind: z.literal('assignee'), value: z.uuid().nullable() }),
          z.object({ kind: z.literal('unread'), value: z.boolean() }),
        ]),
      }),
    )
    .mutation(({ ctx, input }) => call(() => changeThread(ctx.account, input.threadId, input.change))),
})
