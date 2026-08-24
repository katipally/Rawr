const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. The worker cannot start without it.`)
  return value
}

/** Session-mode pooler. pg-boss owns its schema, so it connects as the table owner;
 *  job handlers that touch tenant data go through the data access layer instead and
 *  are subject to row level security like everything else. */
export const OWNER_URL = required('DATABASE_URL_OWNER')
