// biome-ignore-all lint/correctness/noInnerDeclarations: written in ES5 on purpose — see the module comment
// biome-ignore-all lint/suspicious/noGlobalIsNan: same, `Number.isNaN` is ES2015
// biome-ignore-all lint/suspicious/noGlobalIsFinite: same, `Number.isFinite` is ES2015
// biome-ignore-all lint/correctness/noUnusedVariables: same, a bare `catch {}` is ES2019
/** Checking one answer in the browser, before it is sent.
 *
 *  The server is the authority and revalidates everything, so this exists only to
 *  tell somebody about a typo while their cursor is still in the field rather than
 *  after a round trip. Two rules follow from that:
 *
 *    - it must never refuse an answer the server would accept, or a person is
 *      locked out of a form that would have worked;
 *    - its messages must be the server's messages, or the same mistake is
 *      described two ways depending on which check caught it first.
 *
 *  `clientFieldError` is shipped to the browser by stringifying it into the embed
 *  script, so the code that runs there is literally the code tested here rather
 *  than a copy of it. That is why it takes plain data, declares no types inside,
 *  references nothing outside itself, and is written in the conservative style the
 *  rest of the embed uses. */

export type ClientField = {
  key: string
  label: string
  type: string
  required?: boolean | undefined
  options?: { value: string; label: string }[] | undefined
  validation?:
    | {
        regex?: string | undefined
        min?: number | undefined
        max?: number | undefined
        minLength?: number | undefined
        maxLength?: number | undefined
      }
    | undefined
}

/** The message for one answer, or null when it passes. Mirrors `checkField` in
 *  packages/db/src/dal/form-validate.ts, and `form-rules.test.ts` holds the two
 *  together over a table of cases. */
export function clientFieldError(field: ClientField, value: unknown): string | null {
  var list = Array.isArray(value) ? value : null
  var text = list ? '' : String(value == null ? '' : value)
  var empty = list ? list.length === 0 : text.trim() === ''

  if (empty) return field.required ? field.label + ' is required.' : null

  if (list && list.length > 50) return field.label + ' has too many choices selected.'
  if (!list && text.length > 5000) return field.label + ' is longer than 5000 characters.'

  var rules = field.validation
  if (rules && rules.minLength && text.length < rules.minLength) {
    return field.label + ' must be at least ' + rules.minLength + ' characters.'
  }
  if (rules && rules.maxLength && text.length > rules.maxLength) {
    return field.label + ' must be ' + rules.maxLength + ' characters or fewer.'
  }
  if (rules && rules.regex) {
    try {
      if (!new RegExp(rules.regex).test(text)) return field.label + ' is not in the expected format.'
    } catch (e) {
      // A pattern that no longer compiles must not block a real person. The
      // server takes the same view.
    }
  }

  if (field.type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim().toLowerCase())) {
      return field.label + ' is not an email address.'
    }
  } else if (field.type === 'number') {
    var n = Number(text)
    if (!isFinite(n)) return field.label + ' must be a number.'
    if (rules && rules.min !== undefined && n < rules.min) {
      return field.label + ' must be at least ' + rules.min + '.'
    }
    if (rules && rules.max !== undefined && n > rules.max) {
      return field.label + ' must be at most ' + rules.max + '.'
    }
  } else if (field.type === 'date') {
    if (isNaN(Date.parse(text))) return field.label + ' is not a date.'
  } else if (field.type === 'url') {
    try {
      new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text)
    } catch (e) {
      return field.label + ' is not a web address.'
    }
  } else if (field.type === 'phone') {
    if (!/^[+0-9][0-9\s().-]{4,30}$/.test(text)) return field.label + ' is not a phone number.'
  } else if (field.type === 'select' || field.type === 'radio') {
    if (field.options && field.options.length) {
      var found = false
      for (var i = 0; i < field.options.length; i++) {
        var option = field.options[i]
        if (option && option.value === text) found = true
      }
      if (!found) return field.label + ' is not one of the available choices.'
    }
  } else if (field.type === 'multi_select') {
    if (field.options && field.options.length && list) {
      for (var j = 0; j < list.length; j++) {
        var ok = false
        for (var k = 0; k < field.options.length; k++) {
          var choice = field.options[k]
          if (choice && choice.value === list[j]) ok = true
        }
        if (!ok) return field.label + ' does not offer "' + list[j] + '" as a choice.'
      }
    }
  }

  return null
}

/** The function's own source, for inlining into the embed script. Taking it from
 *  the function rather than repeating it is the whole point: there is one
 *  implementation, and the browser runs the one the tests ran. */
export const clientFieldErrorSource = (): string => clientFieldError.toString()
