import { notFound } from 'next/navigation'

/** An address under the app that no page claims. The shell stays, and the nearest
 *  not-found page says so. */
const Unknown = () => notFound()

export default Unknown
