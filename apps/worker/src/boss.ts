import { PgBoss } from 'pg-boss'
import { OWNER_URL } from './env.ts'

let instance: PgBoss | null = null

export const boss = (): PgBoss => {
  if (!instance) throw new Error('pg-boss has not been started yet.')
  return instance
}

export const startBoss = async (): Promise<PgBoss> => {
  const created = new PgBoss({
    connectionString: OWNER_URL,
    schema: 'pgboss',
    max: 2,
    // The transaction pooler cannot hold advisory locks across statements, so the
    // worker uses the session pooler and pg-boss polls rather than listens.
    supervise: true,
  })
  created.on('error', (error: unknown) => console.error('[pg-boss]', error))
  await created.start()
  instance = created
  return created
}

export const stopBoss = async (): Promise<void> => {
  if (!instance) return
  await instance.stop({ graceful: true, close: true })
  instance = null
}
