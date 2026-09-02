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
