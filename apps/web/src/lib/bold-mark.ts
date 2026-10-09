/** Whether Bold reads as on at the caret. queryCommandState can say a bold run is not
 *  bold, which would make Bold re-apply instead of toggle off, so an enclosing <b> or
 *  <strong> counts as on as well. */
export const boldPressed = (queried: boolean, inBoldElement: boolean): boolean => queried || inBoldElement
