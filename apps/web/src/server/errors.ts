import { ConflictError, DuplicateError, ForbiddenError, UnknownFieldError, ValueError } from '@rawr/db'
import { TRPCError } from '@trpc/server'

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
  if (cause instanceof ValueError || cause instanceof UnknownFieldError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause })
  }
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

/** Wraps a data access call so no procedure can leak a raw driver error. */
export const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (cause) {
    throw asTrpcError(cause)
  }
}
