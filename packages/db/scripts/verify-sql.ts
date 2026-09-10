import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import postgres from 'postgres'
import { cleanup } from './fixture.ts'

/** Every table, column and function named in a raw SQL template, resolved
 *  against the live catalog.
 *
 *  Typecheck cannot see inside a template string, so a migration that renames a
 *  column leaves the SQL that reads it compiling and failing at run time — in
 *  front of whoever triggered it, and nowhere else. That is not hypothetical:
 *  0058 renamed `workspace_id` to `account_id` and dropped `organisation`, and
 *  four scheduled worker jobs went on naming both for a fortnight. The queue
 *  swallowed the errors into dead_letter and no suite noticed, because every
 *  other suite exercises the app and none of them exercises the worker.
 *
 *  A sweep by hand found them once. This is the same sweep, on every run.
 *
 *  It is deliberately static: it reads the source rather than executing it, so a
 *  job that needs a queue, an HTTP call or a tenant to run is covered exactly as
 *  well as a query the app makes on every page. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const fail = (where: string, what: string, line: string) => {
  console.log(`FAIL  ${where}  ${what}\n        ${line}`)
  failures.push(`${where} ${what}`)
}

/** Schemas the catalogue read above does not cover: Postgres's own, named by
 *  plenty of the admin queries here and never in `information_schema.columns`,
 *  and `pgboss`, which pg-boss creates on the worker's first boot and owns. */
const CATALOG = /^(pg_|information_schema|pgboss)/

/** SQL that reads like `<keyword> <identifier>` but is not naming a relation. */
const NOT_A_TABLE = new Set([
  'select', // `insert into t select ...`
  'lateral',
  'only',
  'values',
  'set', // `on conflict do update set`
  'skip', // `for update skip locked`
  'unnest',
  'generate_series',
  'jsonb_array_elements',
  'jsonb_array_elements_text',
  'jsonb_to_recordset',
  'json_array_elements',
  'regexp_split_to_table',
  'string_to_table',
])

const catalogue = async () => {
  const tables = await owner`
    select table_name as n from information_schema.tables
     where table_schema in ('public', 'rawr')
     union select table_name from information_schema.views where table_schema in ('public', 'rawr')`
  const columns = await owner`
    select table_name || '.' || column_name as n from information_schema.columns
     where table_schema in ('public', 'rawr')`
  const functions = await owner`
    select p.proname as n from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'rawr'`
  return {
    tables: new Set(tables.map((r) => r.n as string)),
    columns: new Set(columns.map((r) => r.n as string)),
    functions: new Set(functions.map((r) => r.n as string)),
  }
}

/** The body of every tagged template that carries SQL. The tags are the four
 *  handles this repo binds a connection to: `sql`, `owner` (the worker), `tx`
 *  and its `execute`. */
const TEMPLATES = /(?:\bsql|\bowner|\btx\.execute|\btx)\s*(?:<[^>]*>)?\s*`([\s\S]*?)`/g

/** `extract(day from x)` and its four siblings spell an argument separator with
 *  the same word that introduces a table. Blanking that one `from` is what stops
 *  the expression after it being read as a relation. Depth is tracked because
 *  the argument is routinely a subquery: `extract(day from now() - (select ...))`. */
const KEYWORD_ARGS = /\b(?:extract|substring|position|overlay|trim)\s*\(/gi
const blankKeywordFrom = (body: string): string => {
  const out = [...body]
  for (const open of body.matchAll(KEYWORD_ARGS)) {
    let depth = 1
    for (let i = open.index! + open[0].length; i < body.length && depth > 0; i++) {
      const ch = body[i]!
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (depth === 1 && /\s/.test(ch) && /^from\b/i.test(body.slice(i + 1))) {
        out.fill(' ', i + 1, i + 5)
        break
      }
    }
  }
  return out.join('')
}

/** Interpolations first: a `${...}` can hold a nested template, a comment, or an
 *  identifier that is not ours to resolve. Then SQL's two comment forms, so
 *  prose in a `--` line is not read as code, and last the string literals, whose
 *  prose reads as code just as easily: `'Imported from HubSpot'`. */
const strip = (body: string): string =>
  blankKeywordFrom(
    body
      .replace(/\$\{[^{}]*\}/g, ' ? ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''"),
  )

/** Names bound inside the statement itself: CTEs, derived tables and the alias
 *  on each. A reference to one of these resolves to nothing in the catalog and
 *  is correct all the same. */
const localNames = (body: string): Set<string> => {
  const names = new Set<string>()
  for (const m of body.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)) names.add(m[1]!.toLowerCase())
  for (const m of body.matchAll(/\)\s*(?:as\s+)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?/gi)) names.add(m[1]!.toLowerCase())
  return names
}

/** Which relation each alias stands for, so `w.organisation_id` can be resolved
 *  against the columns `w` actually has rather than against every column in the
 *  database. An alias bound to something this cannot name is left out, and its
 *  references are skipped rather than guessed at. */
const aliases = (body: string, tables: Set<string>): Map<string, string> => {
  const bound = new Map<string, string>()
  const re = /\b(?:from|join|update|into)\s+(?:public\.|rawr\.)?"?([a-z_][a-z0-9_]*)"?\s+(?:as\s+)?"?([a-z_][a-z0-9_]*)"?/gi
  for (const m of body.matchAll(re)) {
    const table = m[1]!.toLowerCase()
    const alias = m[2]!.toLowerCase()
    if (!tables.has(table)) continue
    if (['on', 'set', 'where', 'using', 'select', 'values', 'left', 'right', 'inner', 'full', 'cross', 'join', 'group', 'order', 'limit', 'returning'].includes(alias)) continue
    bound.set(alias, table)
  }
  return bound
}

try {
  const cat = await catalogue()
  // From the repository root, not the package this runs in: `git ls-files` is
  // relative to the working directory, and scoped to packages/db it read a
  // hundred files, found nothing, and said so — while the four broken worker
  // queries this exists to catch sat unscanned in apps/worker.
  const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  const files = execSync('git ls-files "*.ts" "*.tsx"', { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => !f.startsWith('packages/db/migrations/'))
    .map((f) => `${root}/${f}`)
    // `git ls-files` lists what is tracked, which includes a file deleted in the
    // working tree and not yet staged. Reading one throws, and the suite died on
    // the deletion rather than on any query.
    .filter((f) => existsSync(f))

  let templates = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // A temporary table is created and read in the same transaction, so it is
    // never in the catalog and is still correct. Collected per file, because the
    // create and the reads are separate templates.
    const temporary = new Set(
      [...text.matchAll(/create\s+temp(?:orary)?\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) =>
        m[1]!.toLowerCase(),
      ),
    )
    for (const match of text.matchAll(TEMPLATES)) {
      const body = strip(match[1]!)
      // A template with no SQL verb in it is a fragment or an unrelated tag.
      if (!/\b(select|insert|update|delete|with)\b/i.test(body)) continue
      templates++
      const where = file.slice(root.length + 1)
      const line = () => text.slice(0, match.index).split('\n').length
      const local = localNames(body)
      const bound = aliases(body, cat.tables)

      for (const r of body.matchAll(/(?<!\bdo\s)(?<!\bfor\s)\b(?:from|join|into|update|delete\s+from)\s+(?:public\.|rawr\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        const name = r[1]!.toLowerCase()
        if (NOT_A_TABLE.has(name) || CATALOG.test(name) || local.has(name) || temporary.has(name)) continue
        if (cat.tables.has(name) || cat.functions.has(name)) continue
        fail(`${where}:${line()}`, `no table or function named "${name}"`, r[0]!.trim())
      }

      for (const r of body.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const table = bound.get(r[1]!)
        if (!table || CATALOG.test(table)) continue
        if (cat.columns.has(`${table}.${r[2]}`)) continue
        fail(`${where}:${line()}`, `${table} has no column "${r[2]}"`, r[0]!)
      }

      for (const r of body.matchAll(/\brawr\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
        if (cat.functions.has(r[1]!.toLowerCase())) continue
        fail(`${where}:${line()}`, `no function rawr.${r[1]}()`, r[0]!)
      }
    }
  }
  console.log(`\nread ${templates} SQL templates across ${files.length} files.`)
} finally {
  await owner.end()
  await cleanup()
}

if (failures.length) {
  console.error(`\n${failures.length} SQL identifier(s) name something the database does not have.`)
  process.exit(1)
}
console.log('every table, column and function named in raw SQL exists.')
