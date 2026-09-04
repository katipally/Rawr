'use client'

/** The boundary above every route group. `(app)/error.tsx` sits inside the app
 *  layout, so it cannot catch that layout's own session read; this one can, and
 *  it is also the only boundary the public form and booking pages have. */
export { ErrorScreen as default } from '~/components/error-screen.tsx'
