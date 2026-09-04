'use client'

/** Replaces the root layout, so it inherits neither globals.css nor the font.
 *  Everything it needs is inline: this is what renders when the failure is the
 *  layout itself, and reaching for the design system here could fail the same way. */
const GlobalError = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => (
  <html lang="en">
    <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', font: '300 16px/1.5 system-ui, sans-serif', color: '#33475b', background: '#f5f8fa' }}>
      <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ margin: '0 0 .5rem', fontSize: '1.25rem', fontWeight: 500 }}>Rawr could not start this page</h1>
        <p style={{ margin: '0 0 1.5rem' }}>
          {error.message || 'Something failed without saying what.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{ font: 'inherit', fontWeight: 500, color: '#fff', background: '#ff7a59', border: 0, borderRadius: '.1875rem', padding: '.625rem 1.25rem', cursor: 'pointer' }}
        >
          Try again
        </button>
        {error.digest ? (
          <p style={{ margin: '1.5rem 0 0', fontSize: '.8125rem', color: '#7c98b6' }}>Reference {error.digest}</p>
        ) : null}
      </main>
    </body>
  </html>
)

export default GlobalError
