'use client'

import { CalendarCheck, CircleCheck, Mail, Phone, StickyNote } from 'lucide-react'
import { useNavigation } from '~/components/navigation.tsx'
import { replaceParams } from '~/lib/url-params.ts'

export type RecordQuickActionsProps = {
  /** Where the Email button goes, and what its tooltip says. A null href
   *  disables it and the title is the reason, so there is never a button that
   *  cannot do anything.
   *
   *  A company and a deal have no address of their own, so the href points at an
   *  associated contact's page with the composer open. */
  email: { href: string | null; title: string }
  canWrite: boolean
}

/** HubSpot's row of round buttons under a record's name: Note, Email, Call,
 *  Task, Meeting.
 *
 *  None of them own a form. Each asks for the panel already on this page through
 *  the address, so there is one composer, one task form and one compose dialog,
 *  and "log a call on this deal" is a link somebody can be sent. */
export const RecordQuickActions = ({ email, canWrite }: RecordQuickActionsProps) => {
  const { navigate } = useNavigation()

  if (!canWrite) return null

  const actions = [
    { label: 'Note', icon: StickyNote, onClick: () => replaceParams({ log: 'note', task: null }) },
    {
      label: 'Email',
      icon: Mail,
      onClick: () => {
        if (email.href) navigate(email.href)
      },
      disabled: email.href === null,
      title: email.title,
    },
    { label: 'Call', icon: Phone, onClick: () => replaceParams({ log: 'call', task: null }) },
    { label: 'Task', icon: CircleCheck, onClick: () => replaceParams({ task: 'new', log: null }) },
    { label: 'Meeting', icon: CalendarCheck, onClick: () => replaceParams({ log: 'meeting', task: null }) },
  ]

  return (
    <div className="flex flex-wrap items-start justify-between gap-1">
      {actions.map(({ label, icon: Icon, onClick, disabled, title }) => (
        <button
          key={label}
          type="button"
          onClick={onClick}
          disabled={disabled}
          title={title ?? label}
          className="group flex min-w-10 flex-col items-center gap-1 px-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="grid h-pill w-8 place-items-center rounded-pill border border-line-strong bg-surface transition-colors duration-150 ease-out group-hover:bg-fill-hover group-disabled:group-hover:bg-surface">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <span className="text-center text-small font-body">{label}</span>
        </button>
      ))}
    </div>
  )
}
