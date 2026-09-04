import type { ClaimedRun, WorkspaceContext } from '@rawr/db'

/** What it takes to put one step on the wire.
 *
 *  One implementation: the member's own Gmail, which is the point of building
 *  this. Woodpecker deliberately does not appear here. It is not a transport Rawr
 *  drives step by step; its campaign owns the steps, the delays and the sending
 *  accounts, so a Woodpecker enrollment hands the prospect over once and the
 *  runner returns before it ever reaches a Sender. */

export type OutgoingStep = {
  subject: string
  text: string
  html: string | null
  /** Threading, when the sequence replies into the first message's conversation. */
  inReplyTo: string | null
  references: string[]
}

export type SentMessage = {
  providerMessageId: string | null
  internetMessageId: string | null
  /** The tokens the send rows are written from, so a click can be attributed. */
  links: { token: string; url: string }[]
  sendToken: string
}

export type Sender = {
  name: 'gmail'
  send: (ctx: WorkspaceContext, run: ClaimedRun, step: OutgoingStep) => Promise<SentMessage>
}
