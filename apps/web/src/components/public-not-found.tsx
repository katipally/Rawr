/** The 404 a visitor sees on a page Rawr does not own the frame of.
 *
 *  The app's own not-found offers a button to Home, which for a stranger who
 *  followed a form or booking link is a sign-in screen for a product they have
 *  never heard of. This says the link is dead and points them at the only person
 *  who can give them a live one. */
export const PublicNotFound = () => (
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
    <p style={{ fontWeight: 500 }}>This link is no longer live</p>
    <p style={{ color: '#516f90', maxWidth: '32rem' }}>
      It may have been taken down or replaced. Reply to whoever sent it to you and ask for a current
      one.
    </p>
  </main>
)
