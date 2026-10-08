export type PickablePerson = { id: string; label: string; deactivated: boolean }

/** The people a NEW assignment can name: active members, in the order given. A
 *  deactivated member is added back only when they are the value already stored,
 *  labelled, so the picker never shows a saved value as somebody else. */
export const pickableUsers = (users: PickablePerson[], currentId?: string | null): { id: string; label: string }[] => {
  const active = users.filter((person) => !person.deactivated).map(({ id, label }) => ({ id, label }))
  const stored = users.find((person) => person.deactivated && person.id === currentId)
  return stored ? [...active, { id: stored.id, label: `${stored.label} (deactivated)` }] : active
}

/** The "Assigned to" filter: everyone except the viewer, whose own choice is "Me".
 *  A deactivated member stays, labelled, so their tasks can still be found. */
export const assigneeFilterUsers = (users: PickablePerson[], viewerId: string | null): { id: string; label: string }[] =>
  users
    .filter((person) => person.id !== viewerId)
    .map((person) => ({ id: person.id, label: person.deactivated ? `${person.label} (deactivated)` : person.label }))
