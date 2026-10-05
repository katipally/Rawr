-- Deleting a company, contact or user checks every table that points at it, and
-- the check is `WHERE fk_column = $1`. The existing indexes lead with account_id,
-- which that lookup cannot use, so each check read the whole child table: 330,000
-- companies took 214 s to delete and 983,000 contacts 119 s.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migrator runs a deploy in one
-- transaction, which CONCURRENTLY refuses. Each build holds a write lock on its
-- table for as long as it takes, which is milliseconds at today's sizes.
--
-- Foreign keys that already lead an index (a primary key, a unique key, any
-- non-partial index) are left out.
CREATE INDEX IF NOT EXISTS activity_mailbox_id_idx
  ON public.activity (mailbox_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS activity_link_mailbox_id_idx
  ON public.activity_link (mailbox_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS attachment_uploaded_by_idx
  ON public.attachment (uploaded_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS attachment_upload_user_id_idx
  ON public.attachment_upload (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS automation_created_by_idx
  ON public.automation (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS automation_run_automation_id_idx
  ON public.automation_run (automation_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS availability_user_id_idx
  ON public.availability (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS availability_override_user_id_idx
  ON public.availability_override (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_booking_page_id_idx
  ON public.booking (booking_page_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_company_id_idx
  ON public.booking (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_contact_id_idx
  ON public.booking (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_host_user_id_idx
  ON public.booking (host_user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_reschedule_of_idx
  ON public.booking (reschedule_of);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_hold_booking_page_id_idx
  ON public.booking_hold (booking_page_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_host_booking_page_id_idx
  ON public.booking_host (booking_page_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_host_table_user_id_idx
  ON public.booking_host (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_page_owner_id_idx
  ON public.booking_page (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_page_view_booking_page_id_idx
  ON public.booking_page_view (booking_page_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_participant_booking_id_idx
  ON public.booking_participant (booking_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_participant_user_id_idx
  ON public.booking_participant (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_reminder_booking_page_id_idx
  ON public.booking_reminder (booking_page_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_reminder_sent_booking_id_idx
  ON public.booking_reminder_sent (booking_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_reminder_sent_reminder_id_idx
  ON public.booking_reminder_sent (reminder_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bulk_operation_created_by_idx
  ON public.bulk_operation (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS calendar_grant_user_id_idx
  ON public.calendar_grant (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_created_by_idx
  ON public.campaign (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS collector_notice_site_id_idx
  ON public.collector_notice (site_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS company_lifecycle_stage_id_idx
  ON public.company (lifecycle_stage_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS company_owner_id_idx
  ON public.company (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_company_id_idx
  ON public.contact (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_first_campaign_id_idx
  ON public.contact (first_campaign_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_last_campaign_id_idx
  ON public.contact (last_campaign_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_lifecycle_stage_id_idx
  ON public.contact (lifecycle_stage_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_owner_id_idx
  ON public.contact (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_activity_contact_id_idx
  ON public.contact_activity (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_event_contact_id_idx
  ON public.custom_event (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_event_session_id_idx
  ON public.custom_event (session_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_event_site_id_idx
  ON public.custom_event (site_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_record_account_id_idx
  ON public.custom_record (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_record_object_id_idx
  ON public.custom_record (object_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS custom_record_owner_id_idx
  ON public.custom_record (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS dead_letter_integration_id_idx
  ON public.dead_letter (integration_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_company_id_idx
  ON public.deal (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_owner_id_idx
  ON public.deal (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_pipeline_id_idx
  ON public.deal (pipeline_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_stage_id_idx
  ON public.deal (stage_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS duplicate_dismissal_dismissed_by_idx
  ON public.duplicate_dismissal (dismissed_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS email_template_created_by_idx
  ON public.email_template (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS field_def_object_id_idx
  ON public.field_def (object_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS field_index_account_id_idx
  ON public.field_index (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS field_index_field_id_idx
  ON public.field_index (field_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_folder_id_idx
  ON public.form (folder_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_submission_company_id_idx
  ON public.form_submission (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_submission_contact_id_idx
  ON public.form_submission (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_submission_form_id_idx
  ON public.form_submission (form_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_upload_form_id_idx
  ON public.form_upload (form_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_upload_submission_id_idx
  ON public.form_upload (submission_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_view_form_id_idx
  ON public.form_view (form_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS import_row_account_id_idx
  ON public.import_row (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS import_run_created_by_idx
  ON public.import_run (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS integration_installed_by_idx
  ON public.integration (installed_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS invitation_invited_by_idx
  ON public.invitation (invited_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mailbox_user_id_idx
  ON public.mailbox (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_call_token_id_idx
  ON public.mcp_call (token_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_oauth_code_account_id_idx
  ON public.mcp_oauth_code (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_oauth_code_user_id_idx
  ON public.mcp_oauth_code (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_token_user_id_idx
  ON public.mcp_token (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS membership_deactivated_by_idx
  ON public.membership (deactivated_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS membership_invited_by_idx
  ON public.membership (invited_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS membership_user_id_idx
  ON public.membership (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_mailbox_id_idx
  ON public.message (mailbox_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_thread_id_idx
  ON public.message (thread_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_attachment_message_id_idx
  ON public.message_attachment (message_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_blocklist_user_id_idx
  ON public.message_blocklist (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_body_account_id_idx
  ON public.message_body (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_participant_contact_id_idx
  ON public.message_participant (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_participant_message_id_idx
  ON public.message_participant (message_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_thread_read_thread_id_idx
  ON public.message_thread_read (thread_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS message_thread_read_user_id_idx
  ON public.message_thread_read (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_actor_id_idx
  ON public.notification (actor_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_user_id_idx
  ON public.notification (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS outbound_call_integration_id_idx
  ON public.outbound_call (integration_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS page_view_contact_id_idx
  ON public.page_view (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS page_view_session_id_idx
  ON public.page_view (session_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS page_view_site_id_idx
  ON public.page_view (site_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS page_view_daily_contact_id_idx
  ON public.page_view_daily (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pipeline_stage_pipeline_id_idx
  ON public.pipeline_stage (pipeline_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS preference_user_id_idx
  ON public.preference (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS report_dashboard_owner_id_idx
  ON public.report_dashboard (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS saved_view_group_by_field_id_idx
  ON public.saved_view (group_by_field_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS saved_view_object_id_idx
  ON public.saved_view (object_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS saved_view_owner_id_idx
  ON public.saved_view (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS segment_object_id_idx
  ON public.segment (object_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS segment_membership_segment_id_idx
  ON public.segment_membership (segment_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_created_by_idx
  ON public.sequence (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_owner_id_idx
  ON public.sequence (owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_contact_id_idx
  ON public.sequence_enrollment (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_enrolled_by_idx
  ON public.sequence_enrollment (enrolled_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_mailbox_id_idx
  ON public.sequence_enrollment (mailbox_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_sequence_id_idx
  ON public.sequence_enrollment (sequence_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_thread_id_idx
  ON public.sequence_enrollment (thread_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_enrollment_waiting_task_id_idx
  ON public.sequence_enrollment (waiting_task_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_event_enrollment_id_idx
  ON public.sequence_event (enrollment_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_event_send_id_idx
  ON public.sequence_event (send_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_link_send_id_idx
  ON public.sequence_link (send_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_send_contact_id_idx
  ON public.sequence_send (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_send_enrollment_id_idx
  ON public.sequence_send (enrollment_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_send_mailbox_id_idx
  ON public.sequence_send (mailbox_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_send_message_id_idx
  ON public.sequence_send (message_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_send_step_id_idx
  ON public.sequence_send (step_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sequence_step_sequence_id_idx
  ON public.sequence_step (sequence_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS subscription_state_contact_id_idx
  ON public.subscription_state (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS subscription_state_subscription_type_id_idx
  ON public.subscription_state (subscription_type_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS task_assignee_id_idx
  ON public.task (assignee_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS task_created_by_idx
  ON public.task (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS task_queue_id_idx
  ON public.task (queue_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS task_queue_created_by_idx
  ON public.task_queue (created_by);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS team_member_account_id_idx
  ON public.team_member (account_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS visitor_contact_id_idx
  ON public.visitor (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS visitor_alias_contact_id_idx
  ON public.visitor_alias (contact_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS visitor_session_site_id_idx
  ON public.visitor_session (site_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS webhook_endpoint_created_by_idx
  ON public.webhook_endpoint (created_by);
