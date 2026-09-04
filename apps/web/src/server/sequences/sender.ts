import type { ClaimedRun, WorkspaceContext } from '@rawr/db'

/** What it takes to put one step on the wire, whoever does it.
 *
 *  Two implementations: the member's own Gmail, which is the point of building
 *  this, and Woodpecker for volume Gmail's per-account caps cannot carry. The
 *  engine above them knows only this shape. */

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
  name: 'gmail' | 'woodpecker'
  send: (ctx: WorkspaceContext, run: ClaimedRun, step: OutgoingStep) => Promise<SentMessage>
}
