import { fileURLToPath, pathToFileURL } from 'node:url'

/** `~/` is a tsconfig path alias, which Next resolves and plain Node does not.
 *  The unit tests run under plain Node on purpose: no bundler, no dev server, no
 *  database. This is the one thing they need it to understand. */
const SRC = new URL('../src/', import.meta.url)

export const resolve = (specifier, context, next) =>
  specifier.startsWith('~/')
    ? next(pathToFileURL(fileURLToPath(new URL(specifier.slice(2), SRC))).href, context)
    : next(specifier, context)
