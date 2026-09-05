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

const fieldIn = (shape: string) => (
  key: string,
  label: string,
  type: RegistryField['type'],
  extra: Partial<RegistryField> = {},
): RegistryField => ({
  id: `${shape}:${key}`,
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

const field = fieldIn('activity')

/** A RegistryObject that is not one of the workspace's objects: a fixed shape the
 *  mapper, the preview and the coercion rules run against unchanged, so a file
 *  that carries something other than records costs no second mapper. */
const shapeOf = (
  id: string,
  nameSingular: string,
  namePlural: string,
  fields: RegistryField[],
): RegistryObject => ({
  id,
  key: 'contact',
  nameSingular,
  namePlural,
  icon: null,
  // Never queried: this shape exists so the mapper and the coercion rules run
  // unchanged against a file carrying something other than records. The table
  // it names is the one it borrows its key from, and is never read.
  isCustom: false,
  table: 'contact',
  labelFieldKey: null,
  fields,
  byKey: new Map(fields.map((entry) => [entry.key, entry])),
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
    // Same as shapeOf above: read by the mapper, never queried.
    isCustom: false,
    table: 'contact',
    labelFieldKey: null,
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

/* -- B9: the four files a portal exports that are not records -------------- */

const OBJECT_CHOICES = ['contact', 'company', 'deal']

/** A property definition, one per row. This is the file that has to land first:
 *  three hundred and seventy-two columns cannot be imported into fields that do
 *  not exist yet, and creating them by hand is three hundred and seventy-two
 *  chances to spell one differently. */
export const PROPERTY_IMPORT: RegistryObject = (() => {
  const f = fieldIn('property')
  return shapeOf('property', 'Property', 'Properties', [
    f('object_key', 'Applies to', 'select', { position: 0, options: OBJECT_CHOICES }),
    f('label', 'Property name', 'text', { position: 1 }),
    f('key', 'Internal name', 'text', { position: 2 }),
    f('type', 'Type', 'text', { position: 3 }),
    f('field_type', 'Field type', 'text', { position: 4 }),
    f('options', 'Options', 'long_text', { position: 5 }),
    f('help_text', 'Description', 'long_text', { position: 6 }),
    f('group_name', 'Group', 'text', { position: 7 }),
  ])
})()

/** A link between a deal and the people and companies on it. The record exports
 *  carry a contact's primary company and nothing else, so every deal arrives with
 *  no one on it until this file does. */
export const ASSOCIATION_IMPORT: RegistryObject = (() => {
  const f = fieldIn('association')
  return shapeOf('association', 'Association', 'Associations', [
    f('deal_name', 'Deal', 'text', { position: 0 }),
    f('contact_email', 'Contact email', 'email', { position: 1 }),
    f('company_domain', 'Company domain', 'text', { position: 2 }),
    f('label', 'Role', 'text', { position: 3 }),
  ])
})()

/** One row per person per list. A hundred and twenty-nine lists arrive as a
 *  segment each, holding the members the file names rather than a query, because
 *  HubSpot's filter language does not translate and a segment that silently stops
 *  matching is worse than one that says it is a snapshot. */
export const LIST_IMPORT: RegistryObject = (() => {
  const f = fieldIn('list')
  return shapeOf('list', 'List membership', 'List memberships', [
    f('list_name', 'List', 'text', { position: 0 }),
    f('contact_email', 'Contact email', 'email', { position: 1 }),
  ])
})()

/** Form submission history, so the forms report is not empty on the first day and
 *  a contact's timeline does not start at the cutover. */
export const SUBMISSION_IMPORT: RegistryObject = (() => {
  const f = fieldIn('submission')
  return shapeOf('submission', 'Submission', 'Submissions', [
    f('form_name', 'Form', 'text', { position: 0 }),
    f('contact_email', 'Contact email', 'email', { position: 1 }),
    f('submitted_at', 'Submitted at', 'datetime', { position: 2 }),
    f('page_url', 'Page', 'url', { position: 3 }),
    f('body', 'Submitted values', 'long_text', { position: 4 }),
    f('external_id', 'Record ID', 'text', { position: 5 }),
  ])
})()

/** Header aliases per shape.
 *
 *  HubSpot's exports for these four are not documented the way its record exports
 *  are, and the property export in particular could not be read from the portal
 *  this was written against, because exporting properties needs a permission that
 *  account does not hold. So each alias list is generous rather than exact: every
 *  plausible spelling maps, and anything missed still shows in the mapper for a
 *  person to point at. Nothing here silently guesses a column wrong. */
const SHAPE_ALIASES: Record<string, Record<string, string>> = {
  property: {
    object: 'object_key',
    objecttype: 'object_key',
    appliesto: 'object_key',
    name: 'label',
    propertyname: 'label',
    label: 'label',
    internalname: 'key',
    propertyinternalname: 'key',
    apiname: 'key',
    type: 'type',
    datatype: 'type',
    fieldtype: 'field_type',
    formfieldtype: 'field_type',
    options: 'options',
    values: 'options',
    optionvalues: 'options',
    description: 'help_text',
    propertydescription: 'help_text',
    group: 'group_name',
    groupname: 'group_name',
    propertygroup: 'group_name',
    createdby: '',
    usedin: '',
    fillrate: '',
  },
  association: {
    dealname: 'deal_name',
    deal: 'deal_name',
    associateddeal: 'deal_name',
    contactemail: 'contact_email',
    email: 'contact_email',
    associatedcontact: 'contact_email',
    companydomain: 'company_domain',
    associatedcompany: 'company_domain',
    companydomainname: 'company_domain',
    associationlabel: 'label',
    role: 'label',
  },
  list: {
    listname: 'list_name',
    list: 'list_name',
    segment: 'list_name',
    segmentname: 'list_name',
    contactemail: 'contact_email',
    email: 'contact_email',
    emailaddress: 'contact_email',
  },
  submission: {
    formname: 'form_name',
    form: 'form_name',
    contactemail: 'contact_email',
    email: 'contact_email',
    submittedat: 'submitted_at',
    submittedon: 'submitted_at',
    conversiondate: 'submitted_at',
    submissiondate: 'submitted_at',
    pageurl: 'page_url',
    page: 'page_url',
    url: 'page_url',
    values: 'body',
    submittedvalues: 'body',
    recordid: 'external_id',
    submissionid: 'external_id',
  },
}

export const hubspotShapePreset = (shape: string, headers: string[]): Preset => {
  const aliases = SHAPE_ALIASES[shape]
  if (!aliases) return {}
  const preset: Preset = {}
  const taken = new Set<string>()
  for (const header of headers) {
    const key = aliases[loose(header)]
    if (key === undefined) continue
    if (key === '') {
      preset[header] = null
      continue
    }
    if (taken.has(key)) continue
    preset[header] = key
    taken.add(key)
  }
  return preset
}

/** HubSpot's type vocabulary, in the two columns its property export carries, as
 *  a Rawr field type.
 *
 *  `type` is the storage kind and `field_type` how the form draws it. Only the
 *  enumeration pair genuinely needs both: a single-select and a multi-select are
 *  the same HubSpot type and different Rawr ones. Anything unrecognised becomes
 *  text, which loses the widget and never loses the value. */
export const hubspotFieldType = (type: string, fieldType: string): RegistryField['type'] => {
  const t = loose(type)
  const f = loose(fieldType)
  if (t === 'enumeration' || f === 'select' || f === 'radio' || f === 'checkbox') {
    return f === 'checkbox' ? 'multi_select' : 'select'
  }
  if (t === 'bool' || f === 'booleancheckbox') return 'boolean'
  if (t === 'number') return f === 'calculationequation' ? 'number' : 'number'
  if (t === 'date') return 'date'
  if (t === 'datetime') return 'datetime'
  if (t === 'phonenumber') return 'phone'
  if (f === 'textarea' || f === 'html') return 'long_text'
  return 'text'
}
