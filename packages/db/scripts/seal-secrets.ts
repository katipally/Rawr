import './local-only.ts'
import postgres from 'postgres'
import { sealSteps, type AutomationStep } from '../src/dal/automations.ts'
import { sealSecret } from '../src/internal/crypto.ts'

/** Seals the signing keys that were stored before they were sealed: every
 *  `webhook_endpoint.secret`, and the `secret` of every webhook step inside an
 *  `automation`. Reading already tolerates a plaintext row, so nothing breaks
 *  while this has not been run; it exists so a database copy stops holding keys
 *  that can forge a delivery.
 *
 *  Idempotent: a value already sealed is left alone, so it is safe to run twice
 *  and after every deploy. Needs TOKEN_ENCRYPTION_KEY, the same one the app uses,
 *  or what it seals the app cannot open.
 *
 *  Nothing is written without `--confirm`. Without it this counts what it would
 *  seal. Neither mode prints a secret.
 *
 *    node scripts/seal-secrets.ts
 *    node scripts/seal-secrets.ts --confirm
 */

const confirmed = process.argv.includes('--confirm')
const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')
const owner = postgres(url, { max: 1, onnotice: () => {} })

try {
  const endpoints = await owner<{ id: string; secret: string }[]>`select id, secret from webhook_endpoint`
  const unsealedEndpoints = endpoints.filter((row) => sealSecret(row.secret) !== row.secret)

  const rules = await owner<{ id: string; steps: AutomationStep[] }[]>`select id, steps from automation`
  const changedRules = rules.flatMap((row) => {
    const sealed = sealSteps(row.steps)
    return JSON.stringify(sealed) === JSON.stringify(row.steps) ? [] : [{ id: row.id, sealed }]
  })

  console.log(`\n  webhook endpoints to seal  ${String(unsealedEndpoints.length).padStart(6)}  of ${endpoints.length}`)
  console.log(`  automations to seal        ${String(changedRules.length).padStart(6)}  of ${rules.length}\n`)

  if (!confirmed) {
    console.log('  Nothing was changed. Add --confirm to seal them.\n')
  } else {
    await owner.begin(async (tx) => {
      for (const row of unsealedEndpoints) {
        await tx`update webhook_endpoint set secret = ${sealSecret(row.secret)} where id = ${row.id}`
      }
      for (const { id, sealed } of changedRules) {
        await tx`update automation set steps = ${tx.json(sealed as never)} where id = ${id}`
      }
    })
    console.log('  Sealed.\n')
  }
} finally {
  await owner.end()
}
