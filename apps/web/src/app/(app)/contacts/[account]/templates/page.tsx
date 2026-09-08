import { canWrite, listEmailTemplates } from '@rawr/db'
import { redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { TemplateList } from './template-list.tsx'

/** Reusable emails: the intro, the nudge, the "still interested?".
 *
 *  Shared across the account rather than owned by one person, because the
 *  reason to write one down is that a colleague sends it too. */
const TemplatesPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listEmailTemplates(contextFrom(session))

  return (
    <TemplateList
      canWrite={canWrite(contextFrom(session), 'email_template')}
      rows={rows.map((row) => ({
        id: row.id,
        name: row.name,
        subject: row.subject,
        bodyText: row.bodyText,
        authorName: row.authorName,
        updatedAt: row.updatedAt.toISOString(),
      }))}
    />
  )
}

export default TemplatesPage
