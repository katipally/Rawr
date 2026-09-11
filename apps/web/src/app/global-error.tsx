'use client'

/** Replaces the root layout, so it inherits neither globals.css nor the font.
 *  Everything it needs is inline: this is what renders when the failure is the
 *  layout itself, and reaching for the design system here could fail the same way.
 *  Every value is copied from tokens.css rather than invented. */
const GlobalError = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => (
  <html lang="en">
    <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', font: '300 16px/1.5 system-ui, sans-serif', color: '#333333', background: '#f0f0f0' }}>
      <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ margin: '0 0 .5rem', fontSize: '1.25rem', fontWeight: 500 }}>Rawr could not start this page</h1>
        <p style={{ margin: '0 0 1.5rem' }}>
          {/* Same rule as the app's own boundary: Next redacts a server error's
              message in a production build but not a client-thrown one, and a
              query error carries its statement and parameters in its text. */}
          {(process.env.NODE_ENV !== 'production' && error.message) ||
            'Something failed before the page could be built. Try again, and if it keeps happening, tell whoever runs Rawr.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{ font: 'inherit', fontWeight: 500, color: '#ffffff', background: '#00494b', border: 0, borderRadius: '999999px', padding: '.625rem 1.25rem', cursor: 'pointer' }}
        >
          Try again
        </button>
        {error.digest ? (
          <p style={{ margin: '1.5rem 0 0', fontSize: '.8125rem', color: '#8a8a8a' }}>Reference {error.digest}</p>
        ) : null}
      </main>
    </body>
  </html>
)

export default GlobalError
