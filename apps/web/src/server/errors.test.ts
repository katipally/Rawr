import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConflictError, ForbiddenError, UnknownFieldError, ValueError, type RegistryField } from '@rawr/db'
import { FormSchemaError } from '@rawr/db/forms'
import { initTRPC, TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { DrizzleQueryError } from 'drizzle-orm'
import { RevokedError } from './gmail.ts'
import { asTrpcError, call, digestOf, formatError, isReadable, serverFaultMessage } from './errors.ts'
import superjson from 'superjson'
import { z } from 'zod'

/** A person sees a sentence they can act on for what they did, and a reference
 *  for what the server did. Nothing the driver wrote reaches the response. */

const driver = () => new DrizzleQueryError('select secret from t where k = $1', ['hunter2'], new Error('duplicate key'))

test('a refusal keeps its code and its sentence', () => {
  assert.equal(asTrpcError(new ForbiddenError('contacts', 'change contacts')).code, 'FORBIDDEN')
  assert.equal(asTrpcError(new ConflictError(new Date())).code, 'CONFLICT')
  const value = asTrpcError(new ValueError({ key: 'close_date', label: 'Close date' } as RegistryField, 'That is not a date.'))
  assert.equal(value.code, 'BAD_REQUEST')
  assert.equal(value.message, 'Close date: That is not a date.')
  assert.equal(asTrpcError(new FormSchemaError('A form needs an email field.')).code, 'BAD_REQUEST')
  assert.equal(asTrpcError(new RevokedError('Access to this mailbox has been withdrawn.')).code, 'BAD_REQUEST')
})

test('a plain Error is a sentence the data layer wrote for a person', () => {
  const error = asTrpcError(new Error('That file is empty.'))
  assert.equal(error.code, 'BAD_REQUEST')
  assert.equal(error.message, 'That file is empty.')
})

test('a driver or runtime failure is a server fault, whatever it says', () => {
  const dropped = Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' })
  for (const cause of [driver(), dropped, new TypeError('x is undefined'), 'a string', undefined]) {
    const error = asTrpcError(cause)
    assert.equal(error.code, 'INTERNAL_SERVER_ERROR', String(cause))
    assert.doesNotMatch(error.message, /hunter2|secret|ECONNREFUSED|undefined/)
  }
})

test('a page may print a sentence or a refused value, never a driver error', () => {
  const dropped = Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' })
  assert.equal(isReadable(new Error('That file is empty.')), true)
  assert.equal(isReadable(new UnknownFieldError('deal', 'zzz')), true)
  assert.equal(isReadable(new ValueError({ key: 'close_date', label: 'Close date' } as RegistryField, 'That is not a date.')), true)
  for (const cause of [driver(), dropped, new TypeError('x is undefined'), 'a string', undefined]) {
    assert.equal(isReadable(cause), false, String(cause))
  }
})

test('an error that is already a TRPCError passes through', () => {
  const original = new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' })
  assert.equal(asTrpcError(original), original)
})

test('one error has one reference, and two errors have two', () => {
  const a = asTrpcError(driver())
  assert.equal(digestOf(a), digestOf(a))
  assert.notEqual(digestOf(a), digestOf(asTrpcError(driver())))
  assert.match(digestOf(a), /^[0-9a-f]{8}$/)
})

const t = initTRPC.create({ transformer: superjson, errorFormatter: formatError })
const publicProcedure = t.procedure

const probe = t.router({
  wrapped: publicProcedure.query(() => call(async () => { throw driver() })),
  bare: publicProcedure.query(() => { throw driver() }),
  sentence: publicProcedure.query(() => call(async () => { throw new Error('That file is empty.') })),
})

const ask = async (procedure: string) => {
  const logged: string[] = []
  const response = await fetchRequestHandler({
    endpoint: '/t',
    req: new Request(`http://localhost/t/${procedure}`),
    router: probe,
    createContext: async () => ({ session: null, account: null }),
    onError: ({ error }) => logged.push(digestOf(error)),
  })
  return { status: response.status, body: await response.text(), logged }
}

test('the response to a fault carries the reference and none of the driver text', async () => {
  for (const procedure of ['wrapped', 'bare']) {
    const { status, body, logged } = await ask(procedure)
    assert.equal(status, 500, procedure)
    assert.doesNotMatch(body, /hunter2|select secret|duplicate key|Failed query/, procedure)
    assert.equal(logged.length, 1)
    assert.ok(body.includes(serverFaultMessage(logged[0] as string)), procedure)
  }
})

test('the response to a sentence is a 400 that says it', async () => {
  const { status, body } = await ask('sentence')
  assert.equal(status, 400)
  assert.match(body, /That file is empty\./)
})

const dated = t.router({
  when: t.procedure.input(z.object({ at: z.coerce.date() })).query(() => 'ok'),
})

test('a rejected input is answered with its first sentence, never the issue list', async () => {
  const input = encodeURIComponent(JSON.stringify({ json: { at: 'garbage' } }))
  const response = await fetchRequestHandler({
    endpoint: '/t',
    req: new Request(`http://localhost/t/when?input=${input}`),
    router: dated,
    createContext: async () => ({ session: null, account: null }),
    onError: () => {},
  })
  assert.equal(response.status, 400)
  const { error } = (await response.json()) as { error: { json: { message: string } } }
  assert.equal(error.json.message, 'Invalid input: expected date, received Date')
})

const counted = t.router({
  seats: t.procedure.input(z.object({ seats: z.coerce.number() })).query(() => 'ok'),
})

test('a number field that does not parse says so in plain words', async () => {
  const input = encodeURIComponent(JSON.stringify({ json: { seats: 'many' } }))
  const response = await fetchRequestHandler({
    endpoint: '/t',
    req: new Request(`http://localhost/t/seats?input=${input}`),
    router: counted,
    createContext: async () => ({ session: null, account: null }),
    onError: () => {},
  })
  assert.equal(response.status, 400)
  const { error } = (await response.json()) as { error: { json: { message: string } } }
  assert.equal(error.json.message, 'That needs to be a number.')
})
