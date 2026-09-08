/** What a visitor sees while a public page is being built on the server.
 *
 *  Deliberately not a spinner and not a skeleton of the real layout: the booking
 *  page resolves an account, a page, its hosts and a week of free slots before it
 *  can draw anything, and a skeleton that guesses at the shape flashes into a
 *  different one. A line that says it is loading is honest and does not move. */
export const PublicLoading = ({ what }: { what: string }) => (
  <main
    aria-busy="true"
    style={{
      padding: '3rem 1rem',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
      color: '#516f90',
    }}
  >
    Loading {what}…
  </main>
)
