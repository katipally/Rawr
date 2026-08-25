import { DEFAULT_SETTINGS, type FormField, type FormSettings } from '../dal/form-schema.ts'

/** The forms every workspace starts with.
 *
 *  The first two reproduce what is live on datasaur.ai today, so cutover swaps a
 *  script tag and nothing else changes for a visitor:
 *
 *    1e5bd40a-660d-4018-b67f-7fd07b6df934   /contact-us, /book-a-demo, /demo
 *    65dc4e99-b46e-4b12-b1d5-3665e7471f6d   /contact-us
 *
 *  The third is the gated-asset form the paid hubspotonwebflow.com bridge exists
 *  for. It has to reach Rawr without that bridge, which is the whole reason the
 *  subscription can then be cancelled. 00-context.md §8. */

export type SeedForm = {
  name: string
  slug: string
  fields: FormField[]
  settings: FormSettings
}

const PRODUCT_INTEREST = [
  { value: 'Data Studio', label: 'Data Studio' },
  { value: 'LLM Labs', label: 'LLM Labs' },
  { value: 'Deliver', label: 'Deliver' },
  { value: 'Not sure yet', label: 'Not sure yet' },
]

export const SEED_FORMS: SeedForm[] = [
  {
    name: 'Contact Us',
    slug: 'contact-us',
    fields: [
      { key: 'first_name', type: 'text', label: 'First name', required: true, mapsTo: 'contact.first_name', step: 0 },
      { key: 'last_name', type: 'text', label: 'Last name', required: true, mapsTo: 'contact.last_name', step: 0 },
      { key: 'email', type: 'email', label: 'Work email', required: true, mapsTo: 'contact.email', step: 0,
        help: 'We reply to this address.' },
      { key: 'company', type: 'text', label: 'Company', required: false, mapsTo: 'company.name', step: 0 },
      { key: 'phone', type: 'phone', label: 'Phone number', required: false, mapsTo: 'contact.phone', step: 0 },
      { key: 'product_of_interest', type: 'multi_select', label: 'What are you interested in?',
        required: false, options: PRODUCT_INTEREST, mapsTo: null, step: 0 },
      { key: 'message', type: 'long_text', label: 'How can we help?', required: false, mapsTo: null, step: 0,
        validation: { maxLength: 2000 } },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      submitLabel: 'Talk to sales',
      successValue: 'Thanks. Someone from the team will be in touch within one business day.',
      lifecycleStageOnSubmit: 'Lead',
      notifySlack: true,
    },
  },
  {
    name: 'Contact Us - Send us a message',
    slug: 'send-us-a-message',
    fields: [
      { key: 'name', type: 'text', label: 'Name', required: true, mapsTo: 'contact.first_name', step: 0 },
      { key: 'email', type: 'email', label: 'Email', required: true, mapsTo: 'contact.email', step: 0 },
      { key: 'company', type: 'text', label: 'Company', required: false, mapsTo: 'company.name', step: 0 },
      { key: 'message', type: 'long_text', label: 'Message', required: true, mapsTo: null, step: 0,
        validation: { maxLength: 2000 } },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      submitLabel: 'Send message',
      successValue: 'Thanks for the message. We read every one of these.',
      lifecycleStageOnSubmit: 'Lead',
      notifySlack: true,
    },
  },
  {
    name: 'Gated asset download',
    slug: 'gated-asset',
    fields: [
      { key: 'email', type: 'email', label: 'Work email', required: true, mapsTo: 'contact.email', step: 0,
        help: 'We send the download link here.' },
      // Set by the embed from the page it sits on, so one form serves every
      // case study, whitepaper and guide rather than one form per asset.
      { key: 'asset', type: 'hidden', label: 'Asset', required: false, mapsTo: null, step: 0 },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      submitLabel: 'Get the download',
      successValue: 'Check your inbox. The link is on its way.',
      lifecycleStageOnSubmit: 'Subscriber',
      // A gated download is not a sales conversation, so it does not interrupt
      // #sales-leads-2026. It still lands on the contact's timeline.
      notifySlack: false,
    },
  },
  {
    name: 'Newsletter',
    slug: 'newsletter',
    fields: [
      { key: 'email', type: 'email', label: 'Email', required: true, mapsTo: 'contact.email', step: 0,
        placeholder: 'you@company.com' },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      submitLabel: 'Subscribe',
      successValue: 'You are on the list.',
      lifecycleStageOnSubmit: 'Subscriber',
      notifySlack: false,
      subscriptionOptIns: ['Newsletter'],
    },
  },
  /** Exercises the parts a one-step form never reaches: multiple steps, a
   *  conditional field, a select, and a required field that is only required
   *  when it is visible. Every builder feature has to be reachable in seed data
   *  or it is not really tested. */
  {
    name: 'Free consultation',
    slug: 'free-consultation',
    fields: [
      { key: 'first_name', type: 'text', label: 'First name', required: true, mapsTo: 'contact.first_name', step: 0 },
      { key: 'email', type: 'email', label: 'Work email', required: true, mapsTo: 'contact.email', step: 0 },
      { key: 'team_size', type: 'select', label: 'How big is your labeling team?', required: true, step: 1,
        options: [
          { value: '1-5', label: '1 to 5' },
          { value: '6-25', label: '6 to 25' },
          { value: '26-100', label: '26 to 100' },
          { value: '100+', label: 'More than 100' },
        ],
        mapsTo: null },
      { key: 'vendor', type: 'text', label: 'Which vendor are you using today?', required: true, step: 1,
        mapsTo: null, visibleIf: { field: 'team_size', equals: '100+' },
        help: 'Only asked of larger teams, so we can bring the right person.' },
      { key: 'timeline', type: 'select', label: 'When are you looking to start?', required: false, step: 1,
        options: [
          { value: 'now', label: 'Right away' },
          { value: 'quarter', label: 'This quarter' },
          { value: 'exploring', label: 'Just exploring' },
        ],
        mapsTo: null },
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      submitLabel: 'Book the consultation',
      successValue: 'Thanks. We will send some times over shortly.',
      lifecycleStageOnSubmit: 'Lead',
      notifySlack: true,
      steps: ['About you', 'About your team'],
    },
  },
]
