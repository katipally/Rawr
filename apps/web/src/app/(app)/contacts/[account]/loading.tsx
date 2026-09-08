import { LoadingScreen } from '@rawr/ui'

/** Streams in the instant the server starts answering, while the page's own
 *  reads run. The shell stays put; only this area waits. */
const Loading = () => <LoadingScreen />

export default Loading
