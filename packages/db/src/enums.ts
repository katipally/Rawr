/** The vocabularies the browser and the database both speak, as plain values.
 *
 *  A client bundle cannot import the data access layer, so a list a screen needs
 *  lives here, where it can be imported from either side, and is not written a
 *  second time. */

/** What HubSpot grants a user, one hub at a time. */
export const HUBS = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] as const
export type Hub = (typeof HUBS)[number]

/** How much of a granted hub a seat reaches. HubSpot's third axis, under view and
 *  edit: everything in the account, everything its team owns, or only its own.
 *
 *  A record's team is its owner's, so moving somebody between teams moves what
 *  they can reach without touching a single record. */
export const SCOPES = ['everything', 'team', 'own'] as const
export type Scope = (typeof SCOPES)[number]

/** The acts HubSpot marks Critical, in its own per-user editor: each one is either
 *  irreversible or a lever on the whole database rather than on one record, so
 *  each is granted on its own rather than falling out of an edit grant.
 *
 *  `purge` is HubSpot's "Permanently delete", deliberately narrower than `delete`:
 *  a soft delete is somebody's mistake to undo, a purge is not. */
export const CRITICAL_ACTIONS = ['delete', 'merge', 'bulk_delete', 'import', 'export', 'purge'] as const
export type CriticalAction = (typeof CRITICAL_ACTIONS)[number]

export const AUTOMATION_RUN_STATES = ['waiting', 'done', 'skipped', 'failed'] as const
export type AutomationRunState = (typeof AUTOMATION_RUN_STATES)[number]
