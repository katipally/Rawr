import { EmptyState } from '@rawr/ui'
import { LinkButton } from '~/components/link-button.tsx'

/** Every address the app does not route, not only the ones a page asks for with
 *  notFound(). Next sends unmatched URLs to the root file rather than to the one
 *  inside the app group, so without this a mistyped path fell through to the
 *  framework's own black-and-white 404, which is not this product. */
const NotFound = () => (
  <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4">
    <EmptyState
      title="There is nothing at this address"
      description="The link may be old, or whatever it pointed at was deleted. Everything you can reach is behind Home."
      action={
        <LinkButton variant="primary" href="/">
          Go to Home
        </LinkButton>
      }
    />
  </main>
)

export default NotFound
