/** English past tense, by rule. The action column holds a verb stem and new ones
 *  are added all over the DAL without touching this file, so a lookup table would
 *  be stale the week after it was written; these are the stems the rule gets
 *  wrong. */
const IRREGULAR: Record<string, string> = {
  send: 'sent',
  resend: 'resent',
  read: 'read',
  set: 'set',
  submit: 'submitted',
  run: 'ran',
}

const pastTense = (verb: string): string =>
  IRREGULAR[verb] ??
  (/[^aeiou]y$/.test(verb)
    ? `${verb.slice(0, -1)}ied`
    : verb.endsWith('e')
      ? `${verb}d`
      : /^[^aeiou]*[aeiou][bdgmnpt]$/.test(verb)
        ? `${verb}${verb.at(-1)}ed`
        : /[aeiou]l$/.test(verb)
          ? `${verb}led`
          : `${verb}ed`)

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Whole actions the verb rule cannot read: an activity type that is a noun, or an
 *  action whose first word is not the verb it describes. */
const PHRASE: Record<string, string> = {
  note: 'added a note',
  call: 'logged a call',
  email: 'logged an email',
  meeting: 'logged a meeting',
  task: 'added a task',
  booking: 'booked',
  form_submission: 'submitted a form',
  read: 'marked read',
  unread: 'marked unread',
  status: 'changed the status',
  set_members: 'changed the members',
  stage_change: 'changed the stage',
  lifecycle_change: 'changed the lifecycle stage',
  subscription_change: 'changed a subscription',
  segment_change: 'changed a segment',
  field_change: 'changed a field',
  association_change: 'changed an association',
  'conference-link': 'added a conference link',
  send_failed: 'failed to send',
  replay_failed: 'failed to replay',
}

/** What was done, in the Action column. Only the first word of an action is the
 *  verb, so `save_steps` is "Saved steps". */
export const actionOf = (action: string): string => {
  const phrase = PHRASE[action]
  if (phrase) return sentence(phrase)
  const [verb = '', ...rest] = action.split('_')
  return sentence([pastTense(verb), ...rest].join(' '))
}

/** Words that are not plain English in a category name. */
const TERM: Record<string, string> = { mcp: 'MCP', oauth: 'OAuth', def: 'definition' }

/** Whole categories whose name read word by word is not what the entity is. */
const CATEGORY: Record<string, string> = { message_thread_read: 'Read state' }

export const categoryOf = (entity: string): string =>
  CATEGORY[entity] ?? sentence(entity.split('_').map((word) => TERM[word] ?? word).join(' '))

/** A changed field's key as a reader would say it: `reassignedTo` is "reassigned to". */
export const fieldOf = (key: string): string =>
  key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase()
