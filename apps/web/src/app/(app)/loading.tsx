import { LoadingScreen } from '@rawr/ui'

/** The fallback under the app shell itself, for the segments that have none of
 *  their own. Without it a screen with no nested boundary held the previous page
 *  on the display while the next one read the database. */
const Loading = () => <LoadingScreen />

export default Loading
