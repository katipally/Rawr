import type { fieldTypeEnum } from '../schema/enums.ts'

type FieldType = (typeof fieldTypeEnum.enumValues)[number]

export type CoreField = {
  key: string
  label: string
  type: FieldType
  columnName: string
  isRequired?: boolean
  position: number
}

export type CoreObject = {
  key: 'company' | 'contact' | 'deal'
  nameSingular: string
  namePlural: string
  icon: string
  labelFieldKey: string
  fields: CoreField[]
}

/** The registry's starting content. Every column that exists on a core record has a
 *  field_def row, because a surface that cannot see a field in the registry cannot
 *  render, filter or export it. Custom fields are added at runtime as jsonb. */
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
      { key: 'owner_id', label: 'Company owner', type: 'user', columnName: 'owner_id', position: 8 },
      { key: 'lifecycle_stage_id', label: 'Lifecycle stage', type: 'relation', columnName: 'lifecycle_stage_id', position: 9 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 10 },
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
      { key: 'company_id', label: 'Primary company', type: 'relation', columnName: 'company_id', position: 6 },
      { key: 'owner_id', label: 'Contact owner', type: 'user', columnName: 'owner_id', position: 7 },
      { key: 'lifecycle_stage_id', label: 'Lifecycle stage', type: 'relation', columnName: 'lifecycle_stage_id', position: 8 },
      { key: 'lead_status', label: 'Lead status', type: 'select', columnName: 'lead_status', position: 9 },
      { key: 'lead_source', label: 'Original source', type: 'select', columnName: 'lead_source', position: 10 },
      { key: 'marketing_status', label: 'Marketing contact status', type: 'select', columnName: 'marketing_status', position: 11 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 12 },
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
      { key: 'stage_id', label: 'Deal stage', type: 'relation', columnName: 'stage_id', isRequired: true, position: 2 },
      { key: 'amount', label: 'Amount', type: 'currency', columnName: 'amount', position: 3 },
      { key: 'close_date', label: 'Close date', type: 'date', columnName: 'close_date', position: 4 },
      { key: 'next_step', label: 'Next step', type: 'text', columnName: 'next_step', position: 5 },
      { key: 'next_step_date', label: 'Next step date', type: 'date', columnName: 'next_step_date', position: 6 },
      { key: 'owner_id', label: 'Deal owner', type: 'user', columnName: 'owner_id', position: 7 },
      { key: 'company_id', label: 'Associated company', type: 'relation', columnName: 'company_id', position: 8 },
      { key: 'deal_type', label: 'Deal type', type: 'select', columnName: 'deal_type', position: 9 },
      { key: 'created_at', label: 'Create date', type: 'datetime', columnName: 'created_at', position: 10 },
    ],
  },
]

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
