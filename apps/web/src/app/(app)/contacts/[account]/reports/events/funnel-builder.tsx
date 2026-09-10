'use client'

import { Button, Card, Field, IconButton, Select, useToast } from '@rawr/ui'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Funnel } from '~/components/reports/chart.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

type Step = { name: string; visitors: number; contacts: number }

const MIN_STEPS = 2
const MAX_STEPS = 5

/** Two to five event names, in the order somebody expects people to fire them.
 *
 *  Order is the whole point. Step two counts only visitors who fired it after
 *  they fired step one, so a funnel says where people stop rather than how often
 *  five unrelated things happened. */
export const FunnelBuilder = ({
  from,
  to,
  names,
}: {
  from: string
  to: string
  names: { name: string; label: string }[]
}) => {
  const toast = useToast()
  const [steps, setSteps] = useState<string[]>(() =>
    names.slice(0, MIN_STEPS).map((option) => option.name),
  )
  const [result, setResult] = useState<Step[] | null>(null)
  const [busy, setBusy] = useState(false)

  const chosen = steps.filter(Boolean)
  const ready = chosen.length >= MIN_STEPS

  const run = () => {
    setBusy(true)
    api.analytics.events.funnel
      .query({ from, to, steps: chosen })
      .then(setResult)
      .catch((cause) => toast('error', errorMessage(cause)))
      .finally(() => setBusy(false))
  }

  const labelOf = (name: string) => names.find((option) => option.name === name)?.label ?? name

  if (names.length < MIN_STEPS) {
    return (
      <Card title="Funnel">
        <p className="text-secondary">
          A funnel needs at least two event names. None have been collected yet, so there is nothing
          to put in one.
        </p>
      </Card>
    )
  }

  return (
    <Card title="Funnel">
      <div className="flex flex-col gap-3">
        <p className="max-w-prose text-small text-secondary">
          Pick between two and five events in the order you expect them. Each step counts only the
          people who reached the step above it first, so this says where they stop rather than how
          often each thing happened on its own.
        </p>

        <div className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label={`Step ${index + 1}`} id={`funnel-step-${index}`}>
                  <Select
                    id={`funnel-step-${index}`}
                    value={step}
                    onChange={(event) =>
                      setSteps((current) =>
                        current.map((each, at) => (at === index ? event.target.value : each)),
                      )
                    }
                  >
                    <option value="">Choose an event</option>
                    {names.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {steps.length > MIN_STEPS ? (
                <IconButton
                  label={`Remove step ${index + 1}`}
                  icon={<Trash2 aria-hidden="true" className="size-4" />}
                  onClick={() => setSteps((current) => current.filter((_each, at) => at !== index))}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {steps.length < MAX_STEPS ? (
            <Button variant="tertiary" onClick={() => setSteps((current) => [...current, ''])}>
              Add a step
            </Button>
          ) : null}
          <Button variant="primary" busy={busy} disabled={!ready} onClick={run}>
            Show the funnel
          </Button>
        </div>

        {result ? (
          <Funnel
            title="Visitors reaching each step, in order"
            steps={result.map((step, index) => ({
              id: `${index}-${step.name}`,
              label: labelOf(step.name),
              value: step.visitors,
              detail: `${step.contacts.toLocaleString()} known`,
            }))}
          />
        ) : null}
      </div>
    </Card>
  )
}
