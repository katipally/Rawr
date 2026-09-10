import { canView, canWrite, getRegistry } from '@rawr/db'
import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell, type NavGroup, type NavSection } from '~/components/app-shell.tsx'
import { ShortcutSheet } from '~/components/shortcut-sheet.tsx'
import { AdoptZone, ZoneProvider } from '~/components/zone.tsx'
import { CommandPalette, type Action } from '~/components/crm/command-palette.tsx'
import { EnrichmentConsent } from '~/components/crm/enrichment-consent.tsx'
import {
  accountPath,
  availabilityPath,
  bookedPath,
  bookingPagesPath,
  calendarPath,
  createRecordPath,
  formsPath,
  newBookingPagePath,
  duplicatesPath,
  exportPath,
  importsPath,
  inboxPath,
  appsPath,
  objectsPath,
  objectView,
  propertiesPath,
  segmentsPath,
  newsletterPath,
  reportsPath,
  sequencesPath,
  templatesPath,
  sitesPath,
  submissionsPath,
  tasksPath,
  accountHome,
  agentAccessPath,
} from '~/lib/links.ts'
import { settingsGroups } from '~/lib/settings-nav.ts'
import { contextFrom, memberships, readSession } from '~/server/session.ts'
import type { Hub } from '~/lib/hubs.ts'

/** A rail section before its grants are applied. The hub on a group overrides the
 *  section's, which is how Data Management lists moving contacts next to the
 *  account settings that configure them. */
type HubSection = Omit<NavSection, 'groups'> & { hub: Hub; groups: (NavGroup & { hub?: Hub })[] }

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const account = session.accountSlug
  const ctx = contextFrom(session)
  const [mine, registry] = await Promise.all([memberships(session.userId), getRegistry(ctx)])
  // Built from the session, because every CRM address carries its account.
  // The sections are HubSpot's hubs in HubSpot's order. Home is the logo, and
  // Settings is its own place, reached from the top bar.
  const sections: HubSection[] = [
    {
      key: 'crm',
      label: 'CRM',
      icon: 'crm',
      hub: 'contacts',
      groups: [
        {
          label: 'Records',
          // From the registry, so an object an admin invents is in the menu the
          // moment it exists rather than only at an address somebody typed.
          items: registry.objects.map((object) => ({
            href: objectView(account, object.key, 'all'),
            label: object.namePlural,
            match: `/contacts/${account}/objects/${object.key}`,
          })),
        },
        {
          label: 'Work',
          items: [
            { href: segmentsPath(account), label: 'Segments (Lists)', match: `/contacts/${account}/segments` },
            { href: inboxPath(account), label: 'Inbox', match: `/contacts/${account}/inbox` },
            { href: bookedPath(account), label: 'Meetings', match: `/meetings/${account}/booked` },
            { href: tasksPath(account), label: 'Tasks' },
          ],
        },
      ],
    },
    {
      key: 'marketing',
      label: 'Marketing',
      icon: 'marketing',
      hub: 'marketing',
      groups: [
        {
          label: 'Capture',
          items: [
            { href: newsletterPath(account), label: 'Newsletter', match: `/contacts/${account}/newsletter` },
            { href: formsPath(account), label: 'Forms', match: `/contacts/${account}/forms` },
            { href: submissionsPath(account, { state: 'quarantined' }), label: 'Form submissions', match: `/contacts/${account}/submissions` },
          ],
        },
        {
          label: 'Analytics',
          hub: 'reports',
          items: [
            { href: reportsPath(account, { tab: 'forms' }), label: 'Marketing Analytics', match: `/contacts/${account}/reports/forms` },
          ],
        },
      ],
    },
    {
      key: 'sales',
      label: 'Sales',
      icon: 'sales',
      hub: 'sales',
      groups: [
        {
          label: 'Selling',
          items: [
            { href: calendarPath(account), label: 'Calendar', match: `/meetings/${account}/calendar` },
            { href: availabilityPath(account), label: 'Availability', match: `/meetings/${account}/availability` },
            { href: bookingPagesPath(account), label: 'Meetings Scheduler', match: `/meetings/${account}/pages` },
            { href: templatesPath(account), label: 'Templates', match: `/contacts/${account}/templates` },
            { href: sequencesPath(account), label: 'Sequences', match: `/contacts/${account}/sequences` },
          ],
        },
        {
          label: 'Analytics',
          hub: 'reports',
          items: [
            { href: reportsPath(account, { tab: 'pipeline' }), label: 'Sales Analytics', match: `/contacts/${account}/reports/pipeline` },
          ],
        },
      ],
    },
    {
      key: 'data',
      label: 'Data Management',
      icon: 'data',
      hub: 'contacts',
      groups: [
        {
          label: 'Move data',
          items: [
            { href: importsPath(account), label: 'Import', match: `/contacts/${account}/import` },
            { href: exportPath(account), label: 'Export' },
            { href: duplicatesPath(account), label: 'Duplicates' },
          ],
        },
        {
          label: 'Configure',
          hub: 'account',
          items: [
            { href: objectsPath(), label: 'Data Model' },
            { href: propertiesPath(), label: 'Properties' },
            { href: sitesPath(), label: 'Event Management' },
            { href: appsPath(), label: 'Connected Apps' },
          ],
        },
      ],
    },
    {
      key: 'reporting',
      label: 'Reporting',
      icon: 'reporting',
      hub: 'reports',
      groups: [
        {
          label: 'Reports',
          items: [
            { href: reportsPath(account, { tab: 'dashboards' }), label: 'Dashboards', match: `/contacts/${account}/reports/dashboards` },
            { href: reportsPath(account), label: 'Reports', match: `/contacts/${account}/reports` },
          ],
        },
      ],
    },
  ]

  // A grant the person does not hold hides its links rather than letting them
  // walk into a refusal, which is what HubSpot does and what the + menu below
  // already did.
  const nav: NavSection[] = sections.flatMap(({ hub, groups, ...section }) => {
    const kept = groups.flatMap(({ hub: groupHub, ...group }) =>
      canView(ctx, groupHub ?? hub) ? [group] : [],
    )
    return kept.length ? [{ ...section, groups: kept }] : []
  })

  // Only what these grants can actually make. A read-only member was offered
  // four things to create and every one of them landed on a page that quietly
  // ignored the request, because the create dialog checks the grant and the menu
  // did not.
  const create = [
    { key: 'contact', label: 'Contact', href: createRecordPath(account, 'contact'), entity: 'contact' as const },
    { key: 'company', label: 'Company', href: createRecordPath(account, 'company'), entity: 'company' as const },
    { key: 'deal', label: 'Deal', href: createRecordPath(account, 'deal'), entity: 'deal' as const },
    { key: 'task', label: 'Task', href: tasksPath(account, { new: '1' }), entity: 'task' as const },
    // Both were complete and reachable only by hovering a rail icon, which is why
    // they read as missing features.
    { key: 'form', label: 'Form', href: formsPath(account, 'new'), entity: 'form' as const },
    {
      key: 'booking_page',
      label: 'Scheduling page',
      href: newBookingPagePath(account),
      entity: 'booking_page' as const,
    },
  ].flatMap(({ entity, ...option }) => (canWrite(ctx, entity) ? [option] : []))

  // The + menu is already a list of verbs behind a grant check. Search says them
  // the way a person would, and adds the ones that were only ever a rail item.
  const actions: Action[] = [
    ...create.map((option) => ({
      href: option.href,
      label: `Create ${option.label.toLowerCase()}`,
      keywords: ['new', 'add', option.label],
    })),
    ...(canWrite(ctx, 'contact')
      ? [
          { href: importsPath(account), label: 'Import records', keywords: ['csv', 'upload', 'migrate'] },
          { href: duplicatesPath(account), label: 'Find duplicates', keywords: ['merge', 'dedupe'] },
        ]
      : []),
    { href: exportPath(account), label: 'Export to CSV', keywords: ['download', 'xlsx', 'spreadsheet'] },
    { href: appsPath(), label: 'Connect an app', keywords: ['integration', 'gmail', 'slack', 'apollo'] },
    { href: agentAccessPath(), label: 'Connect an assistant', keywords: ['mcp', 'token', 'agent', 'claude'] },
  ]

  return (
    <ZoneProvider zone={session.timezone}>
    <ToastProvider>
      <AppShell
        accountName={session.accountName}
        accountSlug={account}
        accounts={mine.map((m) => ({
          slug: m.accountSlug,
          name: m.accountName,
        }))}
        email={session.email}
        avatarUrl={session.avatarUrl}
        nav={nav}
        create={create}
        settingsHref={accountPath()}
        accountHref={accountPath()}
        homeHref={accountHome(account)}
        search={
          <CommandPalette
            account={account}
            actions={actions}
            // The rail and the settings rail, flattened. Two sources, both the
            // ones those rails render from, so a page either gains is findable
            // the same day rather than when somebody remembers a third list.
            pages={[
              ...nav.flatMap((section) =>
                section.groups
                  ? section.groups.flatMap((group) =>
                      group.items.map((item) => ({
                        label: item.label,
                        section: section.label,
                        href: item.href,
                      })),
                    )
                  : section.href
                    ? [{ label: section.label, section: section.label, href: section.href }]
                    : [],
              ),
              ...settingsGroups(account).flatMap((group) =>
                group.sections.map((entry) => ({
                  label: entry.label,
                  section: `Settings · ${group.label}`,
                  href: entry.href,
                  keywords: entry.keywords,
                })),
              ),
            ]}
          />
        }
      >
        {/* Above the page rather than inside it: what is waiting to be enriched
            is an account-wide question, and the answer costs credits wherever
            the person happens to be standing. */}
        <EnrichmentConsent canWrite={canWrite(ctx, 'contact')} />
        {children}
      </AppShell>
      <ShortcutSheet />
      <AdoptZone stored={session.timezone} />
    </ToastProvider>
    </ZoneProvider>
  )
}

export default AppLayout
