import { randomBytes } from 'node:crypto'
import { ConflictError, DuplicateError, ForbiddenError, UnknownFieldError, ValueError } from '@rawr/db'
import { FormSchemaError } from '@rawr/db/forms'
import { TRPCError, type TRPCDefaultErrorShape } from '@trpc/server'
import { ZodError } from 'zod'
import { CalendarUnavailable } from './calendar.ts'
import { RevokedError } from './gmail.ts'

const digests = new WeakMap<object, string>()

/** The reference a person quotes and the line the log carries, minted once per
 *  error. Keyed on the TRPCError because tRPC hands the same instance to onError
 *  and to the formatter that writes the response. */
export const digestOf = (error: object): string => {
  let digest = digests.get(error)
  if (!digest) {
    digest = randomBytes(4).toString('hex')
    digests.set(error, digest)
  }
  return digest
}

export const serverFaultMessage = (digest: string): string =>
  `Something failed on the server. Try again, and if it keeps happening, tell whoever runs Rawr and quote reference ${digest}.`

/** The data access layer writes its own refusals as `new Error(sentence)`, so an
 *  error of exactly that class is a sentence for a person. A driver error is not:
 *  postgres.js sets `code` on a plain Error for a dropped connection, and every
 *  other failure is a subclass or a built-in (DrizzleQueryError, TypeError), whose
 *  message can hold the statement and its parameters. */
const isSentence = (cause: unknown): cause is Error =>
  cause instanceof Error &&
  Object.getPrototypeOf(cause) === Error.prototype &&
  typeof (cause as { code?: unknown }).code !== 'string'

/** What a page may print from a failed data read: a sentence, or the two refusals
 *  the data layer words for a person (a value that does not fit, a field that is
 *  not there). Anything else can hold a statement and its parameters. */
export const isReadable = (cause: unknown): cause is Error =>
  isSentence(cause) || cause instanceof ValueError || cause instanceof UnknownFieldError

/** Every failure a person can reach has a sentence they can act on, never
 *  "something went wrong". 03-build-order, FAILING. */
export const asTrpcError = (cause: unknown): TRPCError => {
  if (cause instanceof TRPCError) return cause

  if (cause instanceof ForbiddenError) {
    return new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause })
  }
  if (cause instanceof ConflictError) {
    return new TRPCError({ code: 'CONFLICT', message: cause.message, cause })
  }
  if (cause instanceof DuplicateError) {
    return new TRPCError({ code: 'CONFLICT', message: cause.message, cause })
  }
  if (
    cause instanceof FormSchemaError ||
    cause instanceof RevokedError ||
    cause instanceof CalendarUnavailable ||
    isReadable(cause)
  ) {
    return new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause })
  }
  // Anything else is a fault in the server, not something the person typed. The
  // formatter swaps the message for the reference; the cause stays on the server.
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The server failed.', cause })
}

export const formatError = ({
  shape,
  error,
}: {
  shape: TRPCDefaultErrorShape
  error: TRPCError
}): TRPCDefaultErrorShape => {
  // A refused grant is a 403 with a sentence a person can act on, never a
  // generic failure. 03-build-order, FAILING.
  if (error.cause instanceof ForbiddenError) {
    return { ...shape, message: error.cause.message, data: { ...shape.data, code: 'FORBIDDEN' } }
  }
  // tRPC turns anything thrown outside `call` into a 500 that carries the raw
  // message, and outside production it adds the stack, whose first line is that
  // message. The swap happens here, where every error passes.
  if (error.code === 'INTERNAL_SERVER_ERROR') {
    const { stack: _stack, ...data } = shape.data
    return { ...shape, message: serverFaultMessage(digestOf(error)), data }
  }
  // tRPC writes a rejected input as the JSON of every zod issue. The first issue is the sentence a person reads.
  // Only a request's own input is BAD_REQUEST here, so a zod failure inside the data layer never reaches this line.
  if (error.code === 'BAD_REQUEST' && error.cause instanceof ZodError) {
    const first = error.cause.issues[0]
    if (first?.code === 'invalid_type' && 'received' in first && first.received === 'NaN') return { ...shape, message: 'That needs to be a number.' }
    return { ...shape, message: first?.message ?? 'That value was not valid.' }
  }
  return shape
}

/** Wraps a data access call so no procedure can leak a raw driver error: the
 *  message a person sees for one is the reference, never the driver's text. */
export const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (cause) {
    throw asTrpcError(cause)
  }
}
