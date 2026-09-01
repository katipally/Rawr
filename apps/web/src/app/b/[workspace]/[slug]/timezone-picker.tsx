'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/** The visitor's timezone, in the URL like everything else.
 *
 *  The page is complete without this component: the times are computed on the
 *  server in whatever zone the URL names, defaulting to UTC. What this adds is the
 *  switch to the zone the browser thinks it is in. The client's clock is never
 *  trusted for anything but this: a wrong clock changes which times are displayed
 *  in, never which are available.
 *
 *  When the URL carries no tz the detected zone is applied automatically, replacing
 *  the history entry so Back still leaves the page. When the URL does carry one it
 *  is a decision somebody made, and it is only ever offered as a link — otherwise a
 *  link shared from Jakarta would silently re-render in the reader's own zone and
 *  the two would be talking about different times.
 *
 *  A plain link and a plain select, so no click handler is load-bearing. */

const zones = (): string[] => {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (supported) return supported('timeZone')
  } catch {
    // Older engines do not enumerate zones. The detected one and the current one
    // are still offered, which covers everybody who is not deliberately browsing
    // as somebody else.
  }
  return []
}

export const TimezonePicker = ({
  timezone,
  explicit,
  basePath,
}: {
  timezone: string
  /** True when tz came from the URL. False means the page fell back to UTC. */
  explicit: boolean
  basePath: string
}) => {
  const [detected, setDetected] = useState<string | null>(null)
  const list = useMemo(zones, [])

  const href = useCallback(
    (zone: string): string => {
      const [path, search = ''] = basePath.split('?')
      const params = new URLSearchParams(search)
      params.set('tz', zone)
      // Dropping the chosen slot on purpose: a time picked in one zone should be
      // re-picked after switching, not silently reinterpreted.
      params.delete('slot')
      return `${path}?${params.toString()}`
    },
    [basePath],
  )

  useEffect(() => {
    let found: string | null = null
    try {
      found = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      found = null
    }
    setDetected(found)
    if (!explicit && found && found !== timezone) {
      // replace, not assign: the UTC render was never a page anybody asked for, so
      // it must not sit in the history and swallow a Back press.
      window.location.replace(href(found))
    }
  }, [explicit, href, timezone])

  const options = list.length > 0 ? list : [...new Set([timezone, detected].filter(Boolean) as string[])]

  return (
    <div className="rawr-b-tz">
      <label htmlFor="rawr-b-tz-select">Times shown in</label>
      <select
        id="rawr-b-tz-select"
        value={timezone}
        onChange={(event) => {
          window.location.href = href(event.target.value)
        }}
      >
        {options.includes(timezone) ? null : <option value={timezone}>{timezone}</option>}
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      {detected && detected !== timezone ? (
        <a href={href(detected)} rel="nofollow">
          Use {detected}
        </a>
      ) : null}
    </div>
  )
}
