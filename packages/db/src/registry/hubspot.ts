import { operatorsFor } from './types.ts'
import type { ObjectKey } from './core.ts'
import type { RegistryField, RegistryObject } from '../dal/registry.ts'

/** B5. Reading a HubSpot portal's own exports.
 *
 *  Most of it needs nothing: Rawr's field labels were written to match HubSpot's,
 *  so "Company domain name" and "Number of Employees" already match on label.
 *  What is listed here is only what HubSpot names differently from us, plus the
 *  columns every export carries that mean nothing on this side and would otherwise
 *  be offered as a mapping somebody has to decline one by one. */

const loose = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** HubSpot header -> Rawr field key, for the headers a label match misses. */
const ALIASES: Record<ObjectKey, Record<string, string>> = {
  company: {
    companyname: 'name',
    companydomainname: 'domain',
    companyowner: 'owner_id',
    postalcode: 'city',
    numberofemployees: 'employee_count',
    countryregion: 'country',
    createdate: 'created_at',
  },
  contact: {
    firstname: 'first_name',
    lastname: 'last_name',
    emailaddress: 'email',
    phonenumber: 'phone',
    mobilephonenumber: 'phone',
    jobtitle: 'title',
    linkedin: 'linkedin_url',
    associatedcompany: 'company_id',
    primaryassociatedcompanyid: 'company_id',
    companyname: 'company_id',
    contactowner: 'owner_id',
    lifecyclestage: 'lifecycle_stage_id',
    leadstatus: 'lead_status',
    originalsource: 'lead_source',
    marketingcontactstatus: 'marketing_status',
    createdate: 'created_at',
  },
  deal: {
    dealname: 'name',
    dealstage: 'stage_id',
    dealowner: 'owner_id',
    dealtype: 'deal_type',
    associatedcompany: 'company_id',
    closedate: 'close_date',
    dealprobability: '',
    createdate: 'created_at',
  },
}

/** Columns HubSpot puts in every export that have no home here. Mapped to nothing
 *  on purpose, so the mapper shows them already dismissed rather than as work. */
const IGNORED = new Set(
  [
    'Record ID',
    'Object ID',
    'HubSpot Team',
    'Merged Record IDs',
    'Time Zone',
    'Last Modified Date',
    'Last Activity Date',
    'Next Activity Date',
    'Number of Sales Activities',
    'Number of times contacted',
    'Days to Close',
    'Is Deleted',
    'Currency Code Symbol',
  ].map(loose),
)

export type Preset = Record<string, string | null>

/** What the mapper opens with for a HubSpot file. Anything not named here is left
 *  for the general suggestion pass, which matches on label. */
export const hubspotPreset = (object: ObjectKey, headers: string[]): Preset => {
  const aliases = ALIASES[object]
  const preset: Preset = {}
  const taken = new Set<string>()
  for (const header of headers) {
    const key = aliases[loose(header)]
    if (IGNORED.has(loose(header))) {
      preset[header] = null
      continue
    }
    // An empty alias is a header we recognise and deliberately do not carry over.
    if (key === undefined || key === '' || taken.has(key)) continue
    preset[header] = key
    taken.add(key)
  }
  return preset
}

/** True when the file looks like it came out of a HubSpot export rather than a
 *  spreadsheet somebody typed. Two independent HubSpot-only headers, so one
 *  coincidence is not enough. */
export const looksLikeHubspot = (headers: string[]): boolean => {
  const seen = new Set(headers.map(loose))
  const tells = ['recordid', 'objectid', 'hubspotteam', 'associatedcompany', 'lifecyclestage', 'createdate']
  return tells.filter((tell) => seen.has(tell)).length >= 2
}

const field = (
  key: string,
  label: string,
  type: RegistryField['type'],
  extra: Partial<RegistryField> = {},
): RegistryField => ({
  id: `activity:${key}`,
  key,
  label,
  type,
  storage: 'column',
  columnName: key,
  isRequired: false,
  isCustom: false,
  isSystem: false,
  trackChanges: false,
  options: [],
  helpText: null,
  position: 0,
  operators: operatorsFor(type),
  ...extra,
})

/** The shape an activity file is mapped against.
 *
 *  Not a real object: nothing is created from these columns, they are read to
 *  decide which record a note or a logged email belongs to and what it said. It
 *  is a RegistryObject so the mapper, the preview and the coercion rules that
 *  already exist work on it unchanged. */
export const ACTIVITY_IMPORT: RegistryObject = (() => {
  const fields = [
    field('contact_email', 'Contact email', 'email', { position: 0 }),
    field('company_domain', 'Company domain', 'text', { position: 1 }),
    field('activity_type', 'Activity type', 'select', {
      position: 2,
      options: ['note', 'email', 'call', 'meeting'],
    }),
    field('subject', 'Subject', 'text', { position: 3 }),
    field('body', 'Body', 'long_text', { position: 4 }),
    field('occurred_at', 'Activity date', 'datetime', { position: 5 }),
    field('external_id', 'Record ID', 'text', { position: 6 }),
  ]
  return {
    id: 'activity',
    key: 'contact',
    nameSingular: 'Activity',
    namePlural: 'Activities',
    icon: null,
    fields,
    byKey: new Map(fields.map((entry) => [entry.key, entry])),
  }
})()

/** HubSpot's engagement export, whose headers differ again. */
export const hubspotActivityPreset = (headers: string[]): Preset => {
  const aliases: Record<string, string> = {
    associatedcontact: 'contact_email',
    contactemail: 'contact_email',
    email: 'contact_email',
    associatedcompany: 'company_domain',
    companydomain: 'company_domain',
    activitytype: 'activity_type',
    engagementtype: 'activity_type',
    type: 'activity_type',
    activityassignedto: '',
    subject: 'subject',
    emailsubject: 'subject',
    notebody: 'body',
    body: 'body',
    activitydate: 'occurred_at',
    createdate: 'occurred_at',
    recordid: 'external_id',
    activityid: 'external_id',
  }
  const preset: Preset = {}
  const taken = new Set<string>()
  for (const header of headers) {
    const key = aliases[loose(header)]
    if (key === undefined || key === '' || taken.has(key)) continue
    preset[header] = key
    taken.add(key)
  }
  return preset
}
