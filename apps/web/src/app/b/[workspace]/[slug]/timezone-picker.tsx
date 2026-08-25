'use client'

import { useEffect, useMemo, useState } from 'react'

/** The visitor's timezone, in the URL like everything else.
 *
 *  The page is complete without this component: the times are computed on the
 *  server in whatever zone the URL names, defaulting to UTC. What this adds is the
 *  offer to switch to the zone the browser thinks it is in, which is the right
 *  default but must not be the only option. The client's clock is never trusted for
 *  anything but this preselection: a wrong clock changes which times are displayed
 *  in, never which are available.
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
  basePath,
}: {
  timezone: string
  basePath: string
}) => {
  const [detected, setDetected] = useState<string | null>(null)
  const list = useMemo(zones, [])

  useEffect(() => {
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone)
    } catch {
      setDetected(null)
    }
  }, [])

  const href = (zone: string): string => {
    const [path, search = ''] = basePath.split('?')
    const params = new URLSearchParams(search)
    params.set('tz', zone)
    // Dropping the chosen slot on purpose: a time picked in one zone should be
    // re-picked after switching, not silently reinterpreted.
    params.delete('slot')
    return `${path}?${params.toString()}`
  }

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
