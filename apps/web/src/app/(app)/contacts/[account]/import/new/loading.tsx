import { Spinner } from '@rawr/ui'

/** The wizard takes the whole window, so it opens on a white one rather than on
 *  the imports list's skeleton. */
const Loading = () => (
  <div className="fixed inset-0 z-overlay flex items-center justify-center bg-surface">
    <Spinner size="lg" label="Opening the import" />
  </div>
)

export default Loading
