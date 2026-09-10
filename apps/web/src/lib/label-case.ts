/** A label dropped into the middle of a sentence.
 *
 *  Lowercasing reads right for an ordinary noun somebody typed in title case
 *  ("Add contacts"), and wrong for anything capitalised on purpose: an acronym,
 *  a product name, "UI Drive Assets" rendered as "Add ui drive assets". An
 *  uppercase letter past the first is the signal, because a plain noun has none.
 *
 *  For prose only. A comparison or a search still lowercases both sides. */
export const inSentence = (label: string): string =>
  /[A-Z]/.test(label.slice(1)) ? label : label.toLowerCase()
