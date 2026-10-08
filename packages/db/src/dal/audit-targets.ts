/** Where each audit entity's target is named. Every entity a mutation writes has an
 *  entry, so a new entity gets its name here and the test that lists the writes fails
 *  until it does.
 *
 *  `from` is the table, or a join or union of tables, with the target's row aliased
 *  `t`. `name` is the expression that reads its name off that row. `snapshot` is the
 *  key in the audit row's before or after that holds the name once the row is gone.
 *
 *  `'link'` names the record a link row points at, which the row itself records.
 *  `null` is an entity with no target of its own, so its audit row reads as its label. */
export type AuditTarget = { from: string; name: string; snapshot?: string } | 'link' | null

const contactName = (alias: string): string =>
  `coalesce(nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), ''), ${alias}.email)`

export const AUDIT_TARGETS: Record<string, AuditTarget> = {
  account: { from: 'account t', name: 't.name', snapshot: 'name' },
  activity: { from: 'activity t', name: 't.subject' },
  association: 'link',
  attachment: { from: 'attachment t', name: 't.filename', snapshot: 'filename' },
  automation: { from: 'automation t', name: 't.name', snapshot: 'name' },
  availability: { from: 'user_account t', name: 't.name' },
  availability_override: { from: 'user_account t', name: 't.name' },
  booking: { from: 'booking t', name: "coalesce(t.attendee_name, t.attendee_email)" },
  booking_page: { from: 'booking_page t', name: 't.name', snapshot: 'name' },
  calendar_grant: { from: 'user_account t', name: 't.name' },
  campaign: { from: 'campaign t', name: 't.name', snapshot: 'name' },
  company: { from: 'company t', name: 'coalesce(t.name, t.domain)', snapshot: 'name' },
  contact: { from: 'contact t', name: contactName('t'), snapshot: 'name' },
  custom_event_def: { from: 'custom_event_def t', name: 'coalesce(t.label, t.name)', snapshot: 'name' },
  deal: { from: 'deal t', name: 't.name', snapshot: 'name' },
  dead_letter: { from: 'dead_letter t', name: 't.job_name' },
  duplicate_dismissal: {
    from: `(select c.id, ${contactName('c')} as name from contact c union all select co.id, coalesce(co.name, co.domain) from company co) t`,
    name: 't.name',
  },
  email_template: { from: 'email_template t', name: 't.name', snapshot: 'name' },
  enrichment_request: null,
  erasure: { from: 'contact t', name: contactName('t'), snapshot: 'name' },
  export: null,
  field_def: {
    from: '(select id, label as name from field_def union all select id, name_plural as name from object_def) t',
    name: 't.name',
    snapshot: 'key',
  },
  form: { from: 'form t', name: 't.name', snapshot: 'name' },
  form_folder: { from: 'form_folder t', name: 't.name', snapshot: 'name' },
  form_submission: { from: 'form_submission t join form f on f.id = t.form_id', name: 'f.name' },
  import_run: { from: 'import_run t', name: 't.filename' },
  integration: { from: 'integration t', name: 't.kind', snapshot: 'kind' },
  invitation: { from: 'invitation t', name: 't.email', snapshot: 'email' },
  lifecycle_stage: { from: 'lifecycle_stage t', name: 't.name', snapshot: 'name' },
  mailbox: { from: 'mailbox t', name: 't.email', snapshot: 'email' },
  mcp_oauth_code: { from: 'mcp_oauth_code t join mcp_client c on c.id = t.client_id', name: 'c.name' },
  mcp_token: { from: 'mcp_token t', name: 't.name', snapshot: 'name' },
  membership: { from: 'user_account t', name: 't.name', snapshot: 'email' },
  message: { from: 'message t join message_thread th on th.id = t.thread_id', name: 'th.subject' },
  message_blocklist: { from: 'message_blocklist t', name: 't.pattern', snapshot: 'pattern' },
  message_thread: { from: 'message_thread t', name: 't.subject' },
  message_thread_read: { from: 'message_thread t', name: 't.subject' },
  object_def: { from: 'object_def t', name: 't.name_plural', snapshot: 'namePlural' },
  pipeline: { from: 'pipeline t', name: 't.name', snapshot: 'name' },
  pipeline_stage: {
    from: '(select id, name from pipeline_stage union all select id, name from pipeline) t',
    name: 't.name',
    snapshot: 'name',
  },
  report_dashboard: { from: 'report_dashboard t', name: 't.name', snapshot: 'name' },
  saved_view: {
    from: '(select id, name from saved_view union all select id, name_plural as name from object_def) t',
    name: 't.name',
    snapshot: 'name',
  },
  segment: { from: 'segment t', name: 't.name', snapshot: 'name' },
  sequence: { from: 'sequence t', name: 't.name', snapshot: 'name' },
  sequence_enrollment: {
    from: `(select e.id, ${contactName('c')} as name from sequence_enrollment e join contact c on c.id = e.contact_id union all select id, name from sequence) t`,
    name: 't.name',
  },
  sequence_send: { from: 'sequence_send t join contact c on c.id = t.contact_id', name: contactName('c') },
  sequence_step: { from: 'sequence t', name: 't.name', snapshot: 'name' },
  site: { from: 'site t', name: 'coalesce(t.name, t.host)', snapshot: 'host' },
  subscription_state: { from: 'contact t', name: contactName('t'), snapshot: 'name' },
  subscription_type: { from: 'subscription_type t', name: 't.name', snapshot: 'name' },
  task: { from: 'task t', name: 't.title', snapshot: 'title' },
  task_queue: { from: 'task_queue t', name: 't.name', snapshot: 'name' },
  team: { from: 'team t', name: 't.name', snapshot: 'name' },
  team_member: { from: 'team t', name: 't.name', snapshot: 'name' },
  webhook_endpoint: { from: 'webhook_endpoint t', name: 't.name', snapshot: 'name' },
}
