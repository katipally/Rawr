import { Alert } from '@rawr/ui'
import { calendarAtSignIn, env, googleConfigured, hostedDomainRequired, visitorAccessOpen } from '~/lib/env.ts'

type Props = { searchParams: Promise<{ error?: string; next?: string }> }

/** The front door. There is one way in, a verified Google account, and the page
 *  says plainly who can enter and what they get the first time. No passwords, no
 *  magic links, and nothing that takes an address on trust. */
const SignIn = async ({ searchParams }: Props) => {
  const { error, next } = await searchParams
  const after = next && next.startsWith('/') && !next.startsWith('//') ? next : ''

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-2">
        <img src="/rawr-logo.svg" alt="Rawr" width={190} height={80} className="h-12 w-auto self-start" />
        <h1 className="text-lg font-medium">Sign in</h1>
        <p className="text-secondary">
          The CRM behind datasaur.ai: contacts, companies, deals, forms, bookings and the
          history on every record.
        </p>
      </div>

      {error ? (
        <Alert>
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4">
        {googleConfigured ? (
          <>
            <a
              href={after ? `/api/auth/google?next=${encodeURIComponent(after)}` : '/api/auth/google'}
              className="flex min-h-10 items-center justify-center gap-3 rounded-hs bg-cta px-3 font-semibold text-white no-underline transition-colors hover:bg-cta-hover"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0 rounded-full bg-white p-0.5">
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z" />
                <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.8-3.8H1.3v3.1A12 12 0 0 0 12 24Z" />
                <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1Z" />
                <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8Z" />
              </svg>
              Continue with Google
            </a>
            <p className="text-small text-secondary">
              {hostedDomainRequired ? (
                <>
                  Any verified{' '}
                  <span className="font-medium text-body">@{env.GOOGLE_HOSTED_DOMAIN}</span> account
                  works.{' '}
                </>
              ) : visitorAccessOpen ? (
                'Any verified Google account works. '
              ) : (
                'Sign in with the address you were invited on. '
              )}
              You arrive able to read everything and change nothing; an admin raises what you can
              reach under Settings, Members and Teams.
            </p>
            {calendarAtSignIn ? (
              /* Google blocks the whole authorisation when a Account admin has
                 not reviewed the app, and it blocks it over the calendar scopes.
                 Without a way past that, a policy on Google's side keeps everybody
                 out of the CRM rather than just leaving calendars unconnected. */
              <p className="text-small text-secondary">
                Signing in also connects your calendar, so booking pages work straight away. If
                Google says an admin has to review this app,{' '}
                <a
                  href={
                    after
                      ? `/api/auth/google?calendar=0&next=${encodeURIComponent(after)}`
                      : '/api/auth/google?calendar=0'
                  }
                  className="font-medium text-link"
                >
                  sign in without the calendar
                </a>{' '}
                and connect it later from Meetings, Calendars.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-secondary">
            Google sign-in is not configured yet. It needs a client ID and secret from a Google
            Cloud OAuth client.
          </p>
        )}
      </div>

      {hostedDomainRequired ? (
        <p className="text-small text-secondary">
          Trouble signing in? Your account has to be in the {env.GOOGLE_HOSTED_DOMAIN} Google
          Account. Personal Gmail addresses are refused.
        </p>
      ) : visitorAccessOpen ? (
        <p className="text-small text-secondary">
          Trouble signing in? Any Google account works, as long as its address is verified.
        </p>
      ) : (
        <p className="text-small text-secondary">
          Trouble signing in? Any Google account is accepted, but it needs a seat: either an
          invitation sent to that address, or an account that claims its domain.
        </p>
      )}
    </main>
  )
}

export default SignIn
