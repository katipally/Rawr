import type { ObjectKey } from '@rawr/db'
import type { PropertySection } from '~/components/crm/property-panel.tsx'

/** HubSpot's record anatomy, because familiarity is the point:
 *
 *    HEADER   name, key fields, primary actions
 *    LEFT     properties, sectioned, collapsible, inline edit
 *    CENTRE   activity timeline with its type filter
 *    RIGHT    association rail
 *
 *  Only the fields the system ships are placed by hand, because which of those
 *  belong beside each other is a judgement nobody can derive. Everything else is
 *  laid out by its property group, which is the answer an admin already gave.
 */
export const SECTIONS: Record<ObjectKey, PropertySection[]> = {
  contact: [
    { title: 'About this contact', fieldKeys: ['first_name', 'last_name', 'email', 'phone', 'title', 'seniority', 'department', 'linkedin_url', 'city', 'country'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'company_id', 'lifecycle_stage_id', 'lead_status'] },
    { title: 'Where they came from', fieldKeys: ['lead_source', 'marketing_status', 'original_source', 'latest_source'] },
    { title: 'Email engagement', fieldKeys: ['tracking_consent', 'last_contacted_at', 'last_replied_at', 'emails_sent', 'emails_received'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
  company: [
    { title: 'About this company', fieldKeys: ['name', 'domain', 'industry', 'phone', 'description', 'linkedin_url'] },
    { title: 'Size and location', fieldKeys: ['employee_count', 'annual_revenue', 'founded_year', 'funding_raised', 'city', 'state', 'postal_code', 'country'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'lifecycle_stage_id'] },
    { title: 'Where they came from', fieldKeys: ['original_source', 'latest_source'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
  deal: [
    { title: 'About this deal', fieldKeys: ['name', 'amount', 'currency', 'close_date', 'deal_type'] },
    { title: 'Next step', fieldKeys: ['next_step', 'next_step_date'] },
    { title: 'Pipeline', fieldKeys: ['pipeline_id', 'stage_id'] },
    { title: 'Ownership', fieldKeys: ['owner_id', 'company_id'] },
    { title: 'Where it came from', fieldKeys: ['original_source', 'latest_source'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
}

/** An invented object has no hand-made layout, so what a card opens on is its
 *  first few fields, in the order the admin put them in. */
export const CUSTOM_KEY_FIELDS = 8

/** HubSpot's 417 / flex / 433 columns once the shell's card is wide enough for
 *  three. Each side is capped at a third of the row so a narrow card shrinks the
 *  sides with the middle instead of squeezing the timeline to nothing. */
export const RECORD_COLUMNS =
  '@4xl:grid-cols-[minmax(0,min(var(--spacing-record-left),32%))_minmax(0,1fr)_minmax(0,min(var(--spacing-record-right),32%))]'
