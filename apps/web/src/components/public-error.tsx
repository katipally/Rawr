'use client'

/** The boundary a visitor sees, on a page Rawr does not own the frame of.
 *
 *  The app's own error screen tells the reader to go and find whoever runs Rawr,
 *  quoting a digest. That is the right sentence for a colleague and the wrong one
 *  for somebody who followed a link to book half an hour: they have no idea what
 *  Rawr is, and the person they need is the one whose page they were on. So this
 *  says what happened, offers the one thing that ever helps, and stops. */
export const PublicErrorScreen = ({ reset }: { error: Error; reset: () => void }) => (
  <main
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '3rem 1rem',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
      color: '#33475b',
    }}
  >
    <p style={{ fontWeight: 500 }}>This page could not load</p>
    <p style={{ color: '#516f90', maxWidth: '32rem' }}>
      Something went wrong at our end, not yours. Try again in a moment, or reply to whoever sent
      you this link.
    </p>
    <button
      type="button"
      onClick={reset}
      style={{
        minHeight: '2.25rem',
        padding: '0.375rem 0.875rem',
        borderRadius: '3px',
        border: '1px solid #cbd6e2',
        background: '#ffffff',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      Try again
    </button>
  </main>
)
