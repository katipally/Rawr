import { devLoginEnabled, env, googleConfigured } from '~/lib/env.ts'

type Props = { searchParams: Promise<{ error?: string }> }

const SignIn = async ({ searchParams }: Props) => {
  const { error } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-lg font-medium">Sign in to Rawr</h1>

      {error ? (
        <p
          role="alert"
          className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-body"
        >
          {error}
        </p>
      ) : null}

      {googleConfigured ? (
        <a
          href="/api/auth/google"
          className="flex h-9 items-center justify-center rounded-hs bg-cta px-3 font-semibold text-white no-underline transition-colors hover:bg-cta-hover"
        >
          Continue with Google
        </a>
      ) : (
        <p className="text-secondary">
          Google sign-in is not configured yet. It needs a client ID and secret from an internal
          consent screen on the {env.GOOGLE_HOSTED_DOMAIN} organisation.
        </p>
      )}

      {devLoginEnabled ? (
        <form action="/api/auth/dev" method="post" className="flex flex-col gap-2">
          <label htmlFor="dev-email" className="font-medium">
            Development sign-in
          </label>
          <input
            id="dev-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="seeded@datasaur.ai"
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
    </main>
  )
}

export default SignIn
