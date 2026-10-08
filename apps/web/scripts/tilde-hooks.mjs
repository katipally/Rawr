import { fileURLToPath, pathToFileURL } from 'node:url'

/** `~/` is a tsconfig path alias, which Next resolves and plain Node does not.
 *  The unit tests run under plain Node on purpose: no bundler, no dev server, no
 *  database. This is the one thing they need it to understand.
 *
 *  Next's subpath exports (`next/headers`, `next/server`) are written for the
 *  bundler and have no entry without the extension, so plain Node retries with it. */
const SRC = new URL('../src/', import.meta.url)

export const resolve = async (specifier, context, next) => {
  if (specifier.startsWith('~/')) return next(pathToFileURL(fileURLToPath(new URL(specifier.slice(2), SRC))).href, context)
  if (!specifier.startsWith('next/')) return next(specifier, context)
  try {
    return await next(specifier, context)
  } catch {
    return next(`${specifier}.js`, context)
  }
}
