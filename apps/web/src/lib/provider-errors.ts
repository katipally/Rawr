const KNOWN: { code: RegExp; says: string }[] = [
  {
    code: /invalid_grant/i,
    says: 'Google no longer accepts this connection, because access was revoked or the password changed. Reconnect it.',
  },
  {
    code: /not_in_channel/i,
    says: 'Slack could not post because the bot is not in the channel. Invite the bot to it, then send a test.',
  },
  {
    code: /missing_scope/i,
    says: 'Slack refused because the app is missing a permission. Add chat:write to the Slack app, reinstall it, then send a test.',
  },
  {
    code: /channel_not_found|is_archived/i,
    says: 'Slack could not find the channel to post in. Check the channel in the Slack settings.',
  },
  {
    code: /invalid_auth|token_revoked|token_expired|account_inactive/i,
    says: 'Slack no longer accepts the token. Paste a new one in the Slack settings.',
  },
]

/** What a provider's refusal means and what to do about it, for the codes people
 *  actually hit, or null for anything else so the caller keeps the text it has. */
export const plainError = (raw: string): string | null => KNOWN.find((entry) => entry.code.test(raw))?.says ?? null
