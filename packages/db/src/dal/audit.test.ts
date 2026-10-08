import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CORE_OBJECTS } from '../registry/core.ts'
import { AUDIT_TARGETS } from './audit-targets.ts'

/** Every entity the DAL writes into the audit log. Read from the source, so a new
 *  entity fails here until it has a target rather than being named by nothing: the
 *  literal `entity` of an audit entry, the literal first argument of a `mutate` call,
 *  and the three core objects, which records write under their own key. */
const writtenEntities = (): Set<string> => {
  const found = new Set<string>(CORE_OBJECTS.map((object) => object.key))
  const dir = new URL('.', import.meta.url)
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const match of source.matchAll(/entity: '([a-z_]+)'|mutate(?:Registry)?\(ctx, '([a-z_]+)'/g)) {
      found.add(match[1] ?? match[2]!)
    }
  }
  return found
}

test('every entity the DAL writes has a target entry, and every entry is written by the DAL', () => {
  assert.deepEqual([...writtenEntities()].sort(), Object.keys(AUDIT_TARGETS).sort())
})
