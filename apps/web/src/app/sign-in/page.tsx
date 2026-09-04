import { Alert } from '@rawr/ui'
import { devLoginEnabled, env, googleConfigured } from '~/lib/env.ts'

type Props = { searchParams: Promise<{ error?: string; next?: string }> }

/** The front door for staff. There is one way in, Google with a verified
 *  @datasaur.ai account, and the page says so plainly: who can enter, what happens
 *  the first time, and who to ask when a role is not enough. No passwords, no
 *  invites, no magic links (01-decisions.md, sign-in). */
const SignIn = async ({ searchParams }: Props) => {
  const { error, next } = await searchParams
  const after = next && next.startsWith('/') && !next.startsWith('//') ? next : ''
  const domain = env.GOOGLE_HOSTED_DOMAIN

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-2">
        <p className="text-xl font-semibold tracking-tight text-cta">Rawr</p>
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
              Any verified <span className="font-medium text-body">@{domain}</span> account works. The
              first time in you can read everything and change nothing; an admin raises your
              role under Settings, Members.
            </p>
          </>
        ) : (
          <p className="text-secondary">
            Google sign-in is not configured yet. It needs a client ID and secret from an internal
            consent screen on the {domain} organisation.
          </p>
        )}
      </div>

      {devLoginEnabled ? (
        <form action="/api/auth/dev" method="post" className="flex flex-col gap-2 rounded-panel border border-dashed border-line p-4">
          {after ? <input type="hidden" name="next" value={after} /> : null}
          <div>
            <label htmlFor="dev-email" className="font-medium">
              Development sign-in
            </label>
            <p className="text-small text-secondary">
              Seeded addresses only: admin@, sales@, marketing@ or viewer@{domain}. Not available in
              production.
            </p>
          </div>
          <input
            id="dev-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder={`admin@${domain}`}
            className="h-9 rounded-hs border border-line bg-fill px-3 text-body outline-none focus:border-line-interactive"
          />
          <input
            name="workspace"
            type="text"
            placeholder="workspace slug (optional)"
            className="h-9 rounded-hs border border-line bg-fill px-3 text-body outline-none focus:border-line-interactive"
          />
          <button
            type="submit"
            className="h-9 rounded-hs border border-line bg-surface px-3 font-medium transition-colors hover:bg-fill-hover"
          >
            Sign in as a seeded user
          </button>
        </form>
      ) : null}

      <p className="text-small text-secondary">
        Trouble signing in? Your account has to be in the {domain} Google Workspace. Personal
        Gmail addresses are refused.
      </p>
    </main>
  )
}

export default SignIn
