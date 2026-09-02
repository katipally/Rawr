'use client'

import { bookingTemplateValues, renderTemplate } from '@rawr/db/templates'

/** What the event will actually say, both ways: with a company known and with one
 *  not known.
 *
 *  The second case is the one worth showing. A title reading "Discovery Session
 *  with Datasaur <> " is the specific failure F2 §5 forbids, and the only way to be
 *  sure it cannot happen is to look at it.
 *
 *  The renderer is a pure function, so this preview runs the same code the booking
 *  path runs rather than a second approximation of it. */

const SAMPLE = {
  attendeeName: 'Priya Raman',
  attendeeEmail: 'priya@acme.com',
  hostName: 'Ivan',
  hostEmail: 'admin@datasaur.ai',
}

export const TemplatePreview = ({
  titleTpl,
  descriptionTpl,
  companyFallback,
  pageName,
  durationMinutes,
}: {
  titleTpl: string
  descriptionTpl: string
  companyFallback: string
  pageName: string
  durationMinutes: number
}) => {
  const cases = [
    { label: 'A work address we can place', companyName: 'Acme' },
    { label: 'A free-mail address, no company', companyName: null },
  ]

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {cases.map((sample) => {
        const values = bookingTemplateValues({
          ...SAMPLE,
          companyName: sample.companyName,
          companyFallback,
          pageName,
          durationMinutes,
        })
        return (
          <div key={sample.label} className="rounded-hs bg-fill p-2 text-xs">
            <p className="mb-1 font-medium text-secondary">{sample.label}</p>
            <p className="font-medium">{renderTemplate(titleTpl, values) || '(no title)'}</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-secondary">
              {renderTemplate(descriptionTpl, values)}
            </pre>
          </div>
        )
      })}
    </div>
  )
}
