import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** A server module reaching into a 'use client' module for something it means to
 *  run.
 *
 *  React gives a server module a client reference, not the function: an opaque
 *  object carrying the module id, which throws or quietly does nothing when it is
 *  called. Nothing fails to compile, the types line up, and the bug surfaces as a
 *  page that renders with a value missing. It has been shipped twice.
 *
 *  Importing a client *component* into a server one is the whole point of the
 *  boundary, so a PascalCase binding is left alone: it is rendered, not called.
 *  Anything else -- a helper, a constant, a map -- is what this refuses. A type
 *  is erased before it reaches the boundary and is always fine.
 *
 *  Static on purpose: it reads the source, so it covers a route nobody has
 *  opened as well as one on every page. */

const ROOT = resolve(import.meta.dirname, '..', 'src')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })

/** The directive has to be the first statement, but comments and a shebang may
 *  sit above it, and either quote is legal. */
const isClientModule = (text: string): boolean => {
  const head = text
    .replace(/^#!.*\n/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trimStart()
  return head.startsWith("'use client'") || head.startsWith('"use client"')
}

/** Written extension-first because every import in this app names one. */
const resolveImport = (from: string, specifier: string): string | null => {
  const path = specifier.startsWith('~/')
    ? join(ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null
  if (!path) return null
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/** One binding of an import statement, as written. `type` in front of a
 *  specifier, or in front of the whole clause, means it is erased. */
type Binding = { name: string; isType: boolean }

const bindings = (clause: string): Binding[] => {
  const trimmed = clause.trim()
  if (trimmed.startsWith('type ')) return []
  const named = trimmed.match(/\{([\s\S]*)\}/)
  const out: Binding[] = []
  const before = named ? trimmed.slice(0, named.index) : trimmed
  // Default and namespace imports, which sit before any braces.
  for (const part of before.split(',')) {
    const name = part.replace(/\*\s+as\s+/, '').trim()
    if (name && name !== 'type') out.push({ name, isType: false })
  }
  for (const part of named?.[1]?.split(',') ?? []) {
    const piece = part.trim()
    if (!piece) continue
    const isType = piece.startsWith('type ')
    const name = (piece.split(/\s+as\s+/).pop() ?? piece).replace(/^type\s+/, '').trim()
    if (name) out.push({ name, isType })
  }
  return out
}

const IMPORT = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm

const client = new Map<string, boolean>()
const isClient = (path: string): boolean => {
  const known = client.get(path)
  if (known !== undefined) return known
  const answer = isClientModule(readFileSync(path, 'utf8'))
  client.set(path, answer)
  return answer
}

const files = sources(ROOT)
const failures: string[] = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (isClientModule(text)) continue
  for (const match of text.matchAll(IMPORT)) {
    const target = resolveImport(file, match[2]!)
    if (!target || !isClient(target)) continue
    const runtime = bindings(match[1]!).filter(
      (binding) => !binding.isType && !/^[A-Z]/.test(binding.name),
    )
    if (runtime.length === 0) continue
    const line = text.slice(0, match.index).split('\n').length
    const where = `${relative(ROOT, file)}:${line}`
    console.log(
      `FAIL  ${where}  ${runtime.map((binding) => binding.name).join(', ')} from '${match[2]}', a 'use client' module`,
    )
    failures.push(where)
  }
}

console.log(`\nread ${files.length} modules under apps/web/src.`)
if (failures.length) {
  console.error(
    `\n${failures.length} server module(s) import a runtime value across the client boundary. Move the value into a module with no 'use client' directive, or import it as a type.`,
  )
  process.exit(1)
}
console.log('no server module imports a runtime value from a client module.')
