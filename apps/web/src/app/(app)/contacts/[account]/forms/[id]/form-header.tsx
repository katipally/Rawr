import { cn } from '@rawr/ui'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { LinkButton } from '~/components/link-button.tsx'
import { StatusDot } from '~/components/row-actions.tsx'
import { formPerformancePath, formsPath, submissionsPath } from '~/lib/links.ts'

export type FormTab = 'performance' | 'clean' | 'quarantined' | 'released' | 'confirmed_spam'

/** HubSpot's form page header, shared by a form's performance and its
 *  submissions so the review queue filtered to one form reads as that form's
 *  tab: back link, name, whether it is live, Edit form, and the tabs. */
export const FormHeader = ({
  account,
  form,
  current,
  aside,
}: {
  account: string
  form: { id: string; name: string; isActive: boolean }
  current: FormTab
  /** Beside the tabs: the range on performance. */
  aside?: ReactNode
}) => {
  const tabs: { key: FormTab; label: string; href: string }[] = [
    { key: 'performance', label: 'Performance', href: formPerformancePath(account, form.id) },
    { key: 'clean', label: 'Submissions', href: submissionsPath(account, { form: form.id, state: 'clean' }) },
    { key: 'quarantined', label: 'Held for review', href: submissionsPath(account, { form: form.id, state: 'quarantined' }) },
    { key: 'released', label: 'Released', href: submissionsPath(account, { form: form.id, state: 'released' }) },
    { key: 'confirmed_spam', label: 'Spam', href: submissionsPath(account, { form: form.id, state: 'confirmed_spam' }) },
  ]
  return (
    <header className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={formsPath(account)}
            className="inline-flex items-center gap-0.5 self-start text-small font-semibold text-body no-underline hover:underline"
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
            Back to all forms
          </Link>
          <h1 className="min-w-0 break-words text-xl font-medium">{form.name}</h1>
          <span className="flex min-w-0 text-small">
            <StatusDot tone={form.isActive ? 'live' : 'off'}>{form.isActive ? 'Published' : 'Turned off'}</StatusDot>
          </span>
        </div>
        <LinkButton variant="primary" href={formsPath(account, form.id)}>
          Edit form
        </LinkButton>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
        <nav aria-label="Form" className="scroll-fade-x flex min-w-0 overflow-x-auto">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={tab.key === current ? 'page' : undefined}
              className={cn(
                'relative flex h-12 shrink-0 items-center rounded-hs px-7 whitespace-nowrap text-body no-underline transition-colors duration-150 ease-out hover:bg-fill',
                tab.key === current
                  ? 'font-medium after:absolute after:inset-x-3 after:bottom-0 after:h-1 after:rounded-[24px] after:bg-body'
                  : 'font-normal',
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        {aside ? <div className="pb-2">{aside}</div> : null}
      </div>
    </header>
  )
}
