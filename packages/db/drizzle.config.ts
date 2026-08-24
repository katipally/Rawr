import { defineConfig } from 'drizzle-kit'

// Migrations run as the table owner. The app never uses this connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL_OWNER! },
  strict: true,
  verbose: true,
})
