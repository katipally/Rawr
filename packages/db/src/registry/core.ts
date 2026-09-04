import type { FieldType } from './types.ts'

export type ObjectKey = 'company' | 'contact' | 'deal'

export type CoreField = {
  key: string
  label: string
  type: FieldType
  /** Set for storage 'column'. Omitted means the field lives in <object>.custom. */
  columnName?: string
  isRequired?: boolean
  /** Writing this field writes a field_change activity. Default off, because an
   *  88,270-row import otherwise writes 371 rows per contact. A3. */
  trackChanges?: boolean
  /** select and multi_select only. */
  options?: string[]
  position: number
}

export type CoreObject = {
  key: ObjectKey
  nameSingular: string
  namePlural: string
  icon: string
  labelFieldKey: string
  fields: CoreField[]
}

/** HubSpot's own vocabulary, kept verbatim so migrated values land as themselves
 *  rather than as "other". 00-context.md. */
const LEAD_STATUS = ['New', 'Open', 'In Progress', 'Open Deal', 'Unqualified', 'Attempted to Contact', 'Connected', 'Bad Timing']
const LEAD_SOURCE = ['Organic Search', 'Paid Search', 'Email Marketing', 'Social Media', 'Referrals', 'Other Campaigns', 'Direct Traffic', 'Offline Sources']
const MARKETING_STATUS = ['Marketing contact', 'Non-marketing contact']
const DEAL_TYPE = ['New Business', 'Existing Business', 'Renewal']
const PRODUCT_OF_INTEREST = ['NLP Labeling', 'LLM Labs', 'Data Studio', 'Audio', 'OCR', 'Professional Services']

/** The registry's starting content. Every column that exists on a core record has a
 *  field_def row, because a surface that cannot see a field in the registry cannot
 *  render, filter or export it. Fields with no columnName are seeded as custom
 *  jsonb fields, which is also how a HubSpot custom property migrates. */
export const CORE_OBJECTS: CoreObject[] = [
  {
    key: 'company',
    nameSingular: 'Company',
    namePlural: 'Companies',
    icon: 'building',
    labelFieldKey: 'name',
    fields: [
      { key: 'name', label: 'Company name', type: 'text', columnName: 'name', position: 0 },
      { key: 'domain', label: 'Company domain name', type: 'url', columnName: 'domain', position: 1 },
      { key: 'industry', label: 'Industry', type: 'text', columnName: 'industry', position: 2 },
      { key: 'city', label: 'City', type: 'text', columnName: 'city', position: 3 },
      { key: 'country', label: 'Country/Region', type: 'text', columnName: 'country', position: 4 },
      { key: 'phone', label: 'Phone number', type: 'phone', columnName: 'phone', position: 5 },
      { key: 'employee_count', label: 'Number of employees', type: 'number', columnName: 'employee_count', position: 6 },
      { key: 'annual_revenue', label: 'Annual revenue', type: 'currency', columnName: 'annual_revenue', position: 7 },
      { key: 'owner_id', label: 'Company owner', type: 'user', columnName: 'owner_id', trackChanges: true, position: 8 },
      { key: 'lifecycle_stage_id', label: 'Lifecycle stage', type: 'relation', columnName: 'lifecycle_stage_id', trackChanges: true, position: 9 },
      { key: 'original_source', label: 'Original source', type: 'json', columnName: 'original_source', position: 10 },
      { key: 'latest_source', label: 'Latest source', type: 'json', columnName: 'latest_source', position: 11 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 12 },
    ],
  },
  {
    key: 'contact',
    nameSingular: 'Contact',
    namePlural: 'Contacts',
    icon: 'user',
    labelFieldKey: 'first_name',
    fields: [
      { key: 'first_name', label: 'First name', type: 'text', columnName: 'first_name', position: 0 },
      { key: 'last_name', label: 'Last name', type: 'text', columnName: 'last_name', position: 1 },
      { key: 'email', label: 'Email', type: 'email', columnName: 'email', position: 2 },
      { key: 'phone', label: 'Phone number', type: 'phone', columnName: 'phone', position: 3 },
      { key: 'title', label: 'Job title', type: 'text', columnName: 'title', position: 4 },
      { key: 'linkedin_url', label: 'LinkedIn URL', type: 'linkedin', columnName: 'linkedin_url', position: 5 },
      { key: 'company_id', label: 'Primary company', type: 'relation', columnName: 'company_id', trackChanges: true, position: 6 },
      { key: 'owner_id', label: 'Contact owner', type: 'user', columnName: 'owner_id', trackChanges: true, position: 7 },
      { key: 'lifecycle_stage_id', label: 'Lifecycle stage', type: 'relation', columnName: 'lifecycle_stage_id', trackChanges: true, position: 8 },
      { key: 'lead_status', label: 'Lead status', type: 'select', columnName: 'lead_status', options: LEAD_STATUS, trackChanges: true, position: 9 },
      { key: 'lead_source', label: 'Lead source', type: 'select', columnName: 'lead_source', options: LEAD_SOURCE, position: 10 },
      { key: 'marketing_status', label: 'Marketing contact status', type: 'select', columnName: 'marketing_status', options: MARKETING_STATUS, position: 11 },
      { key: 'original_source', label: 'Original source', type: 'json', columnName: 'original_source', position: 12 },
      { key: 'latest_source', label: 'Latest source', type: 'json', columnName: 'latest_source', position: 13 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 14 },
      // Derived, read only: dal/engagement.ts keeps them, registry.ts marks them system.
      { key: 'last_contacted_at', label: 'Last contacted', type: 'datetime', columnName: 'last_contacted_at', position: 15 },
      { key: 'last_replied_at', label: 'Last reply', type: 'datetime', columnName: 'last_replied_at', position: 16 },
      { key: 'emails_sent', label: 'Emails sent', type: 'number', columnName: 'emails_sent', position: 17 },
      { key: 'emails_received', label: 'Emails received', type: 'number', columnName: 'emails_received', position: 18 },
    ],
  },
  {
    key: 'deal',
    nameSingular: 'Deal',
    namePlural: 'Deals',
    icon: 'handshake',
    labelFieldKey: 'name',
    fields: [
      { key: 'name', label: 'Deal name', type: 'text', columnName: 'name', isRequired: true, position: 0 },
      { key: 'pipeline_id', label: 'Pipeline', type: 'relation', columnName: 'pipeline_id', isRequired: true, position: 1 },
      { key: 'stage_id', label: 'Deal stage', type: 'relation', columnName: 'stage_id', isRequired: true, trackChanges: true, position: 2 },
      { key: 'amount', label: 'Amount', type: 'currency', columnName: 'amount', trackChanges: true, position: 3 },
      { key: 'currency', label: 'Currency', type: 'select', columnName: 'currency', options: ['USD', 'EUR', 'GBP', 'SGD', 'IDR', 'AUD', 'JPY'], position: 4 },
      { key: 'close_date', label: 'Close date', type: 'date', columnName: 'close_date', trackChanges: true, position: 5 },
      { key: 'next_step', label: 'Next step', type: 'long_text', columnName: 'next_step', trackChanges: true, position: 6 },
      { key: 'next_step_date', label: 'Next step date', type: 'date', columnName: 'next_step_date', trackChanges: true, position: 7 },
      { key: 'owner_id', label: 'Deal owner', type: 'user', columnName: 'owner_id', trackChanges: true, position: 8 },
      { key: 'company_id', label: 'Associated company', type: 'relation', columnName: 'company_id', position: 9 },
      { key: 'deal_type', label: 'Deal type', type: 'select', columnName: 'deal_type', options: DEAL_TYPE, position: 10 },
      { key: 'original_source', label: 'Original source', type: 'json', columnName: 'original_source', position: 11 },
      { key: 'latest_source', label: 'Latest source', type: 'json', columnName: 'latest_source', position: 12 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 13 },
      // Custom HubSpot properties. No column, so they migrate straight into custom
      // jsonb and prove the registry's custom path on day one. A1.
      { key: 'uttr_pipeline', label: 'UTTR pipeline', type: 'boolean', position: 14 },
      { key: 'deal_product_of_interest', label: 'Product of interest', type: 'multi_select', options: PRODUCT_OF_INTEREST, position: 15 },
    ],
  },
]

export const objectByKey = (key: string): CoreObject | undefined =>
  CORE_OBJECTS.find((o) => o.key === key)

/** The view tabs every workspace starts with. 'all' is reserved: it is the address
 *  /objects/:object/views/all/list resolves to and it can never be deleted. */
export type CoreView = {
  slug: string
  name: string
  kind: 'table' | 'board'
  columns: string[]
  filters?: unknown[]
  sorts?: { key: string; direction: 'asc' | 'desc' }[]
  groupBy?: string
  position: number
}

export const CORE_VIEWS: Record<ObjectKey, CoreView[]> = {
  contact: [
    {
      slug: 'all',
      name: 'All contacts',
      kind: 'table',
      columns: ['first_name', 'last_name', 'email', 'company_id', 'title', 'lead_status', 'owner_id', 'last_contacted_at', 'created_at'],
      sorts: [{ key: 'created_at', direction: 'desc' }],
      position: 0,
    },
    {
      slug: 'my-contacts',
      name: 'My contacts',
      kind: 'table',
      columns: ['first_name', 'last_name', 'email', 'company_id', 'lead_status', 'created_at'],
      filters: [{ field: 'owner_id', operator: 'is', value: '@me' }],
      sorts: [{ key: 'created_at', direction: 'desc' }],
      position: 1,
    },
  ],
  company: [
    {
      slug: 'all',
      name: 'All companies',
      kind: 'table',
      columns: ['name', 'domain', 'industry', 'country', 'employee_count', 'owner_id', 'created_at'],
      sorts: [{ key: 'created_at', direction: 'desc' }],
      position: 0,
    },
  ],
  deal: [
    {
      slug: 'all',
      name: 'All deals',
      kind: 'table',
      columns: ['name', 'stage_id', 'amount', 'close_date', 'next_step', 'next_step_date', 'owner_id'],
      sorts: [{ key: 'close_date', direction: 'asc' }],
      groupBy: 'stage_id',
      position: 0,
    },
    {
      slug: 'overdue-next-step',
      name: 'Next step overdue',
      kind: 'table',
      columns: ['name', 'stage_id', 'amount', 'next_step', 'next_step_date', 'owner_id'],
      // The Monday chase. A past next_step_date is the signal, not an error. A9.
      filters: [{ field: 'next_step_date', operator: 'before', value: '@today' }],
      sorts: [{ key: 'next_step_date', direction: 'asc' }],
      groupBy: 'stage_id',
      position: 1,
    },
  ],
}

/** 00-context.md section 2. Reproduced exactly, probabilities included. */
export const ENTERPRISE_STAGES = [
  { name: 'Meeting Booked', probability: '5' },
  { name: 'Interest (Mtg Occurred)', probability: '10' },
  { name: 'Research (2nd Meeting)', probability: '25' },
  { name: 'In Trial', probability: '35' },
  { name: 'Review (Eval/Pricing)', probability: '50' },
  { name: 'Decision (Internal)', probability: '75' },
  { name: 'Procurement', probability: '90' },
  { name: 'Closed Won', probability: '100', isClosedWon: true },
  { name: 'Closed Lost', probability: '0', isClosedLost: true },
] as const

export const SALES_STAGES = [
  { name: 'Appointment Scheduled', probability: '20' },
  { name: 'Qualified To Buy', probability: '40' },
  { name: 'Presentation Scheduled', probability: '60' },
  { name: 'Decision Maker Bought-In', probability: '80' },
  { name: 'Contract Sent', probability: '90' },
  { name: 'Closed Won', probability: '100', isClosedWon: true },
  { name: 'Closed Lost', probability: '0', isClosedLost: true },
] as const

export const LIFECYCLE_STAGES = [
  'Subscriber',
  'Lead',
  'Marketing Qualified Lead',
  'Sales Qualified Lead',
  'Opportunity',
  'Customer',
  'Evangelist',
  'Other',
] as const
