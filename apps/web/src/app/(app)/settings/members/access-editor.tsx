'use client'

import { Button, Checkbox, DiscardConfirm, Field, Select, TextInput, cn, useDismiss } from '@rawr/ui'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  CRITICAL_ACTIONS,
  CRITICAL_HINT,
  CRITICAL_LABEL,
  HUBS,
  HUBS_WITHOUT_SCREENS,
  HUBS_WITH_RECORDS,
  HUB_HINT,
  SCOPES,
  SCOPE_LABEL,
  type CriticalAction,
  type Hub,
  type Scope,
} from '~/lib/hubs.ts'

type HubScopes = Partial<Record<Hub, Scope>>

export type Grants = {
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  viewScopes: HubScopes
  editScopes: HubScopes
  criticalGrants: CriticalAction[]
}

/** The suggested sets, handed down from the data access layer so the client keeps
 *  no second copy of them. */
export type RoleTemplate = { key: string; label: string; description: string; grants: Grants }

type Level = 'none' | 'view' | 'edit'

export const EMPTY_GRANTS: Grants = { isSuperAdmin: false, viewHubs: [], editHubs: [], viewScopes: {}, editScopes: {}, criticalGrants: [] }

export const levelOf = (grants: Grants, hub: Hub): Level =>
  grants.editHubs.includes(hub) ? 'edit' : grants.viewHubs.includes(hub) ? 'view' : 'none'

export const scopeOf = (grants: Grants, hub: Hub): Scope => grants.viewScopes[hub] ?? 'everything'

/** A hub that reaches everything is absent from the map rather than stored as
 *  'everything', which is the shape the server keeps and the policy reads. */
const withScope = (map: HubScopes, hub: Hub, scope: Scope): HubScopes => {
  const next = { ...map }
  if (scope === 'everything') delete next[hub]
  else next[hub] = scope
  return next
}

const withLevel = (grants: Grants, hub: Hub, level: Level): Grants => ({
  ...grants,
  viewHubs: level === 'view' ? [...new Set([...grants.viewHubs, hub])] : grants.viewHubs.filter((h) => h !== hub),
  editHubs: level === 'edit' ? [...new Set([...grants.editHubs, hub])] : grants.editHubs.filter((h) => h !== hub),
  // Dropping a hub drops its scope with it, so granting it again starts open
  // rather than silently narrowed by a decision somebody made months ago.
  viewScopes: level === 'none' ? withScope(grants.viewScopes, hub, 'everything') : grants.viewScopes,
  editScopes: level === 'edit' ? grants.editScopes : withScope(grants.editScopes, hub, 'everything'),
})

/** One control, both maps. Reading and writing are narrowed together because a
 *  seat that may only edit its own records has no reason to read everybody's,
 *  and HubSpot's own grid moves them together too. */
const withRecordScope = (grants: Grants, hub: Hub, scope: Scope): Grants => ({
  ...grants,
  viewScopes: withScope(grants.viewScopes, hub, scope),
  editScopes: grants.editHubs.includes(hub) ? withScope(grants.editScopes, hub, scope) : grants.editScopes,
})

const withCritical = (grants: Grants, action: CriticalAction, on: boolean): Grants => ({
  ...grants,
  criticalGrants: on
    ? CRITICAL_ACTIONS.filter((key) => key === action || grants.criticalGrants.includes(key))
    : grants.criticalGrants.filter((key) => key !== action),
})

const hubName = (hub: Hub) => hub[0]!.toUpperCase() + hub.slice(1)

const REACH: Record<Scope, string> = {
  everything: 'every record in the account',
  team: 'records owned by anybody on their teams, and unassigned ones',
  own: 'only records they own, and unassigned ones',
}

/** HubSpot's card line under a permission: what is held, with how far it reaches. */
const hubLine = (grants: Grants, hub: Hub): string => {
  if (grants.isSuperAdmin) return 'View and Edit (All records), as a Super Admin'
  const level = levelOf(grants, hub)
  if (level === 'none') return 'No access'
  const reach = HUBS_WITH_RECORDS.has(hub) ? ` (${SCOPE_LABEL[scopeOf(grants, hub)]})` : ''
  return level === 'edit' ? `View${reach} and Edit${reach}` : `View${reach}`
}

/** The same grants, compared as a save would see them. */
const sameGrants = (a: Grants, b: Grants): boolean =>
  a.isSuperAdmin === b.isSuperAdmin &&
  HUBS.every((hub) => levelOf(a, hub) === levelOf(b, hub) && scopeOf(a, hub) === scopeOf(b, hub)) &&
  CRITICAL_ACTIONS.every((action) => a.criticalGrants.includes(action) === b.criticalGrants.includes(action))

/** HubSpot's ON and tick toggle on a permission card. */
const OnOff = ({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!on)}
    className={cn(
      'inline-flex h-10 shrink-0 items-stretch overflow-hidden rounded-hs border border-line-strong text-body font-semibold transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60',
      on ? 'flex-row' : 'flex-row-reverse',
    )}
  >
    <span className="flex w-14 items-center justify-center text-secondary">{on ? 'ON' : 'OFF'}</span>
    <span className={cn('flex w-10 items-center justify-center border-line-strong', on ? 'border-l bg-fill' : 'border-r bg-surface')}>
      {on ? <Check aria-hidden="true" className="size-4" /> : null}
    </span>
  </button>
)

/** One fold of HubSpot's editor: a 14/600 heading with its current answer on the right. */
const Section = ({ title, summary, open, onToggle, children }: { title: string; summary?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) => (
  <section className="border-b border-line last:border-b-0">
    <h3>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left font-semibold">
        {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {summary ? <span className="max-w-[50%] truncate">{summary}</span> : null}
      </button>
    </h3>
    {open ? <div className="border-t border-line px-4 py-4 sm:px-6">{children}</div> : null}
  </section>
)

type Category = 'hubs' | 'critical'
const CATEGORY_LABEL: Record<Category, string> = { hubs: 'Hubs', critical: 'Critical actions' }

export type AccessEditorProps = {
  /** Whose access, or null when the editor is seating somebody new by email. */
  name: string | null
  initial: Grants
  templates: RoleTemplate[]
  copyFrom: { userId: string; name: string; grants: Grants }[]
  busy: boolean
  onSave: (grants: Grants, email: string) => void
  onClose: () => void
}

/** HubSpot's full-window "Editing access for": a dark bar with Back, the title and
 *  Save, then Access and Review. Access folds into how to start (a suggested set
 *  or somebody else's) and the permissions themselves, a card per hub and per
 *  critical action, each with its switch and a detail that opens under it.
 *  Review lists what will change before anything is saved. */
export const AccessEditor = ({ name, initial, templates, copyFrom, busy, onSave, onClose }: AccessEditorProps) => {
  const inviting = name === null
  const [draft, setDraft] = useState(initial)
  const [email, setEmail] = useState('')
  const [tab, setTab] = useState<'access' | 'review'>('access')
  const [folds, setFolds] = useState({ email: true, start: false, permissions: !inviting })
  const [category, setCategory] = useState<Category>('hubs')
  const [needle, setNeedle] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [startedFrom, setStartedFrom] = useState<string | null>(null)

  const changed = !sameGrants(draft, initial)
  const dirty = changed || email.trim() !== ''
  const ready = inviting ? email.trim() !== '' : changed
  const { asking, dismiss, keep, discard } = useDismiss(true, dirty, onClose)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  const start = (label: string | null, grants: Grants) => {
    setStartedFrom(label)
    setDraft(grants)
    setFolds((current) => ({ ...current, permissions: true }))
  }
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const wanted = needle.trim().toLowerCase()
  const matches = (label: string, hint: string) => wanted === '' || `${label} ${hint}`.toLowerCase().includes(wanted)
  // A search reaches every category, as HubSpot's does; without one the list is the category picked.
  const hubs = HUBS.filter((hub) => (wanted ? true : category === 'hubs') && matches(hub, HUB_HINT[hub]))
  const critical = CRITICAL_ACTIONS.filter(
    (action) => (wanted ? true : category === 'critical') && matches(CRITICAL_LABEL[action], CRITICAL_HINT[action]),
  )
  const cardKeys = [...hubs, ...critical.map((action) => `critical:${action}`)]
  const allExpanded = cardKeys.length > 0 && cardKeys.every((key) => expanded.has(key))

  const changes: string[] = [
    ...(draft.isSuperAdmin !== initial.isSuperAdmin ? [`Super Admin: ${draft.isSuperAdmin ? 'on' : 'off'}`] : []),
    ...HUBS.filter((hub) => hubLine(draft, hub) !== hubLine(initial, hub)).map(
      (hub) => `${hubName(hub)}: ${hubLine(initial, hub)} → ${hubLine(draft, hub)}`,
    ),
    ...CRITICAL_ACTIONS.filter((action) => draft.criticalGrants.includes(action) !== initial.criticalGrants.includes(action)).map(
      (action) => `${CRITICAL_LABEL[action]}: ${draft.criticalGrants.includes(action) ? 'on' : 'off'}`,
    ),
  ]

  const card = (key: string, title: string, hint: string, line: string, toggleOn: boolean, onToggle: (on: boolean) => void, detail: ReactNode) => {
    const open = expanded.has(key)
    return (
      <li key={key} className="border-b border-line last:border-b-0">
        <div className="flex items-start gap-3 px-3 py-4 sm:px-4">
          <button type="button" aria-expanded={open} onClick={() => toggle(key)} className="flex min-w-0 flex-1 items-start gap-3 rounded-hs text-left">
            <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center">
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="font-semibold break-words">{title}</span>
              <span className="break-words">{hint}</span>
              <span className="font-semibold break-words">{line}</span>
            </span>
          </button>
          <OnOff on={toggleOn} label={title} disabled={draft.isSuperAdmin} onChange={onToggle} />
        </div>
        {open ? <div className="flex flex-col gap-3 border-t border-line bg-surface px-4 py-4 sm:pl-12">{detail}</div> : null}
      </li>
    )
  }

  const detailRow = (label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <p>{label}</p>
        {hint ? <p className="text-small text-secondary">{hint}</p> : null}
      </div>
      {control}
    </div>
  )

  return (
    <div role="dialog" aria-modal="true" aria-label={inviting ? 'Create user' : `Editing access for ${name}`} className="fixed inset-0 z-overlay flex animate-pop-in flex-col bg-surface text-body motion-reduce:animate-none">
      <div inert={asking} className="flex min-h-0 flex-1 flex-col">
        <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-nav px-2 text-nav-text sm:px-4">
          <button type="button" onClick={dismiss} className="flex items-center gap-1 justify-self-start font-semibold">
            <ChevronLeft aria-hidden="true" className="size-4" />
            Back
          </button>
          <h1 className="min-w-0 truncate text-xl font-normal">
            {inviting ? 'Create user' : (
              <>
                Editing access for <span className="font-semibold">{name}</span>
              </>
            )}
          </h1>
          <Button variant="secondary" busy={busy} disabled={!ready} className="justify-self-end" onClick={() => onSave(draft, email.trim())}>
            {inviting ? 'Create user' : 'Save'}
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
          <nav aria-label="Editor steps" className="mx-auto flex max-w-[80rem] justify-center border-b border-line">
            {(['access', 'review'] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? 'step' : undefined}
                onClick={() => setTab(key)}
                className={cn(
                  'min-h-12 border-b-[3px] px-7 py-3 transition-colors duration-150 ease-out',
                  tab === key ? 'border-body font-medium' : 'border-transparent font-normal hover:bg-fill',
                )}
              >
                {key === 'access' ? 'Access' : 'Review'}
              </button>
            ))}
          </nav>

          <div className="mx-auto flex max-w-[80rem] flex-col gap-2 py-6 text-center">
            <h2 className="text-2xl font-normal">{tab === 'access' ? 'Manage user access' : 'Review changes'}</h2>
            <p>
              {tab === 'access'
                ? 'Start from a suggested set or from somebody who has the right one, then narrow it hub by hub.'
                : 'What saving will change. Nothing has been saved yet.'}
            </p>
          </div>

          {tab === 'review' ? (
            <div className="mx-auto max-w-[80rem] border border-line px-4 py-4 sm:px-6">
              {inviting && email.trim() ? <p className="pb-3 font-semibold break-all">{email.trim()}</p> : null}
              {changes.length === 0 ? (
                <p className="text-secondary">Nothing has changed yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {changes.map((line) => (
                    <li key={line} className="break-words">{line}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-[80rem] border border-line">
              {inviting ? (
                <Section title="Add email address" summary={email.trim() || undefined} open={folds.email} onToggle={() => setFolds({ ...folds, email: !folds.email })}>
                  <Field id="invite-email" label="Email address" hint="They get a link to send them yourself; it works for two weeks.">
                    <TextInput
                      id="invite-email"
                      type="email"
                      autoFocus
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="someone@example.com"
                      className="max-w-[31.25rem]"
                    />
                  </Field>
                </Section>
              ) : null}

              <Section
                title="Choose how to set access"
                summary={startedFrom ?? 'Manually assign permissions'}
                open={folds.start}
                onToggle={() => setFolds({ ...folds, start: !folds.start })}
              >
                <fieldset className="flex flex-col gap-3 border-0 p-0">
                  <legend className="sr-only">Start from an existing set of permissions</legend>
                  <div className="flex flex-wrap gap-2">
                    {templates.map((template) => (
                      <Button key={template.key} type="button" title={template.description} onClick={() => start(template.label, template.grants)}>
                        {template.label}
                      </Button>
                    ))}
                  </div>
                  {copyFrom.length > 0 ? (
                    <Select
                      aria-label="Copy permissions from another user"
                      className="max-w-[31.25rem]"
                      value=""
                      onChange={(event) => {
                        const source = copyFrom.find((row) => row.userId === event.target.value)
                        if (source) start(`Copied from ${source.name}`, source.grants)
                      }}
                    >
                      <option value="">Copy from another user</option>
                      {copyFrom.map((row) => (
                        <option key={row.userId} value={row.userId}>
                          {row.name}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  <p className="text-small text-secondary">Neither saves anything; adjust the permissions below afterwards.</p>
                </fieldset>
              </Section>

              <Section title="Choose permissions" open={folds.permissions} onToggle={() => setFolds({ ...folds, permissions: !folds.permissions })}>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <Checkbox
                      label="Super Admin"
                      hint="Every hub, plus seating people and ending their access."
                      checked={draft.isSuperAdmin}
                      onChange={(event) => setDraft({ ...draft, isSuperAdmin: event.target.checked })}
                    />
                    <Checkbox
                      label="Expand all permissions"
                      checked={allExpanded}
                      onChange={(event) => setExpanded(event.target.checked ? new Set(cardKeys) : new Set())}
                    />
                  </div>
                  <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
                    <div className="flex flex-col gap-3">
                      <label className="relative block">
                        <span className="sr-only">Search permissions</span>
                        <input
                          type="search"
                          value={needle}
                          onChange={(event) => setNeedle(event.target.value)}
                          placeholder="Search"
                          className="h-10 w-full rounded-pill border border-line-strong bg-surface pr-10 pl-4 text-base font-light outline-none focus:border-body"
                        />
                        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2" />
                      </label>
                      <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
                        {(['hubs', 'critical'] as const).map((key) => (
                          <li key={key}>
                            <button
                              type="button"
                              aria-current={!wanted && category === key ? 'true' : undefined}
                              onClick={() => {
                                setCategory(key)
                                setNeedle('')
                              }}
                              className={cn(
                                'relative w-full rounded-hs px-3 py-[0.4375rem] text-left font-light',
                                !wanted && category === key ? 'bg-canvas before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-body' : 'hover:bg-fill',
                              )}
                            >
                              {CATEGORY_LABEL[key]}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {hubs.length === 0 && critical.length === 0 ? (
                      <p className="text-secondary">No permission matches {`"${needle.trim()}"`}.</p>
                    ) : (
                      <ul className="min-w-0 border border-line">
                        {hubs.map((hub) => {
                          const level = levelOf(draft, hub)
                          return card(
                            hub,
                            HUBS_WITHOUT_SCREENS.has(hub) ? `${hubName(hub)} (no screens yet)` : hubName(hub),
                            HUB_HINT[hub],
                            hubLine(draft, hub),
                            draft.isSuperAdmin || level !== 'none',
                            (on) => setDraft(withLevel(draft, hub, on ? 'view' : 'none')),
                            <>
                              {detailRow('View', <OnOff on={draft.isSuperAdmin || level !== 'none'} label={`View ${hub}`} disabled={draft.isSuperAdmin} onChange={(on) => setDraft(withLevel(draft, hub, on ? 'view' : 'none'))} />)}
                              {detailRow('Edit', <OnOff on={draft.isSuperAdmin || level === 'edit'} label={`Edit ${hub}`} disabled={draft.isSuperAdmin} onChange={(on) => setDraft(withLevel(draft, hub, on ? 'edit' : 'view'))} />)}
                              {HUBS_WITH_RECORDS.has(hub) && level !== 'none' && !draft.isSuperAdmin
                                ? detailRow(
                                    'Records reached',
                                    <Select
                                      aria-label={`How much of ${hub} this user reaches`}
                                      className="w-full sm:w-60"
                                      value={scopeOf(draft, hub)}
                                      onChange={(event) => setDraft(withRecordScope(draft, hub, event.target.value as Scope))}
                                    >
                                      {SCOPES.map((option) => (
                                        <option key={option} value={option}>
                                          {SCOPE_LABEL[option]}
                                        </option>
                                      ))}
                                    </Select>,
                                    REACH[scopeOf(draft, hub)],
                                  )
                                : null}
                            </>,
                          )
                        })}
                        {critical.map((action) => {
                          const on = draft.isSuperAdmin || draft.criticalGrants.includes(action)
                          return card(
                            `critical:${action}`,
                            CRITICAL_LABEL[action],
                            CRITICAL_HINT[action],
                            on ? 'On' : 'Off',
                            on,
                            (next) => setDraft(withCritical(draft, action, next)),
                            <p className="text-secondary">
                              A critical action falls out of no hub: it is granted here on its own, because it cannot be undone or reaches the whole database.
                            </p>,
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
      {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
    </div>
  )
}
