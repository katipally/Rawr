/** Whether a key press belongs to a field rather than to a page shortcut, so
 *  typing "/" or "?" into a search box types it instead of jumping away. */
export const typingInto = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}
