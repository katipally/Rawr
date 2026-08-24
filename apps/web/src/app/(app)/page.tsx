import { schema, withWorkspace } from '@rawr/db'
import { count } from 'drizzle-orm'
import { EmptyState } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'

const Home = async () => {
  const session = await readSession()
  if (!session) return null

  const [companies, contacts, deals] = await withWorkspace(contextFrom(session), (tx) =>
    Promise.all([
      tx.select({ n: count() }).from(schema.company),
      tx.select({ n: count() }).from(schema.contact),
      tx.select({ n: count() }).from(schema.deal),
    ]),
  )

  const tiles = [
    { label: 'Companies', value: companies[0]?.n ?? 0 },
    { label: 'Contacts', value: contacts[0]?.n ?? 0 },
    { label: 'Deals', value: deals[0]?.n ?? 0 },
  ]
  const total = tiles.reduce((sum, tile) => sum + tile.value, 0)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-base font-medium">{session.workspaceName}</h1>
        <p className="text-secondary">
          {session.email} · {session.role}
        </p>
      </div>

      {total === 0 ? (
        <EmptyState
          title="This workspace has no records yet"
          description="Nothing has been imported or created here. Seed data with pnpm db:seed, or wait for the CRM surfaces in feature 01."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => (
            <li
              key={tile.label}
              className="rounded-panel border border-line bg-surface p-4 shadow-panel"
            >
              <p className="text-small font-medium text-secondary uppercase">{tile.label}</p>
              <p className="mt-1 text-2xl tabular-nums">{tile.value.toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default Home
