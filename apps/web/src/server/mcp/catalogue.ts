import { GENERATED_TOOLS } from './generated.ts'
import { CURATED_TOOLS, type ToolDefinition } from './tools.ts'

/** Every tool the endpoint offers: the hand-written ten, then one per procedure.
 *  A generated tool that collides with a curated name loses, so the curated
 *  behaviour (names, dates, ambiguity refusals) is what a model gets. */
const seen = new Set(CURATED_TOOLS.map((tool) => tool.name))
export const TOOLS: ToolDefinition[] = [
  ...CURATED_TOOLS,
  ...GENERATED_TOOLS.filter((tool) => !seen.has(tool.name)),
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** Carried on the definition rather than read back off the name: every router is
 *  one word today, so splitting the name would work, and would break silently the
 *  day somebody adds a two-word one. */
export const toolsetOf = (tool: ToolDefinition): string => tool.toolset ?? 'core'

export const TOOLS_BY_TOOLSET = TOOLS.reduce<Map<string, ToolDefinition[]>>((groups, tool) => {
  const key = toolsetOf(tool)
  groups.set(key, [...(groups.get(key) ?? []), tool])
  return groups
}, new Map())
