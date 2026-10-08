/** Mail a machine sends, which is not a person answering. One definition, read by
 *  the sequence engine (stop on reply, bounce detection) and by every count of
 *  replies in a thread, so the two cannot disagree.
 *
 *  Patterns are plain regex source, usable both in JS and as a Postgres `~*`
 *  operand passed as a parameter. */
export const MACHINE_SENDER_PATTERN = '^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[s-]?)@'

export const MACHINE_SUBJECT_PATTERN =
  'auto:|undeliverable|delivery status notification|mail delivery failed|out of office|automatic reply|autoreply'

const SENDER = new RegExp(MACHINE_SENDER_PATTERN, 'i')
const SUBJECT = new RegExp(MACHINE_SUBJECT_PATTERN, 'i')

export const isMachineSender = (fromAddr: string): boolean => SENDER.test(fromAddr)

export const isMachineSubject = (subject: string | null | undefined): boolean => SUBJECT.test(subject ?? '')

/** Headers an autoresponder sets (RFC 3834, plus the vendor headers Exchange,
 *  Postfix-style autoreplies and mailing software use). Keys are lower-cased. */
export const isAutoReplyHeaders = (headers: Record<string, string | undefined>): boolean => {
  const submitted = headers['auto-submitted']
  if (submitted && submitted.toLowerCase() !== 'no') return true
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-auto-response-suppress']) return true
  const precedence = headers.precedence?.toLowerCase()
  return precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'junk'
}

/** Stored on the message as is_auto_reply. A holiday reply from a person's own
 *  address is not a reply, and only its headers or its subject say so. */
export const isAutoReplyMail = (
  subject: string | null | undefined,
  headers?: Record<string, string | undefined>,
): boolean => isMachineSubject(subject) || (headers !== undefined && isAutoReplyHeaders(headers))
