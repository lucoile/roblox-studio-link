import type { StudioTarget } from '../types'

export const STUDIO_TOOL = /^mcp__.+__(list_roblox_studios|get_studio_state|execute_luau|multi_edit|insert_asset|generate_material|generate_mesh|generate_procedural_model|generate_texture|segment_mesh|subagent|start_stop_play|character_navigation|user_keyboard_input|user_mouse_input|screen_capture|inspect_instance|script_read|script_grep|script_search|search_game_tree)$/

const ALWAYS_WRITES = new Set([
  'multi_edit',
  'insert_asset',
  'generate_material',
  'generate_mesh',
  'generate_procedural_model',
  'generate_texture',
  'segment_mesh',
])

const READ_ONLY_SUBAGENTS = new Set(['explore', 'screen_capture'])

// Conservative: a false positive only asks or records, a false negative skips the guard.
const LUAU_WRITES = [
  /[\w\])]\s*\.\s*[A-Za-z_]\w*\s*=(?!=)/,
  /:\s*(Destroy|Remove|ClearAllChildren|BreakJoints|PivotTo|MoveTo|Set\w*|Add\w*|Insert\w*|Apply\w*|Clear\w*|Publish\w*|Save\w*|Update\w*|Increment\w*)\s*\(/,
  /Instance\.new\s*\(/,
  /ChangeHistoryService/,
]

export function shortTool(tool: string): string {
  return tool.replace(/^.*__/, '')
}

export function luauWrites(code: string): boolean {
  const stripped = code.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '')
  return LUAU_WRITES.some(pattern => pattern.test(stripped))
}

export function isWriteCall(tool: string, args: Record<string, unknown>): boolean {
  const name = shortTool(tool)
  if (ALWAYS_WRITES.has(name)) return true
  if (name === 'subagent') return !READ_ONLY_SUBAGENTS.has(String(args.subagent_type ?? ''))
  if (name === 'execute_luau') return luauWrites(String(args.code ?? ''))
  return false
}

export function persistsToPlace(args: Record<string, unknown>): boolean {
  const datamodel = args.datamodel_type
  return datamodel === undefined || datamodel === 'Edit'
}

export function summarize(tool: string, args: Record<string, unknown>): string {
  const name = shortTool(tool)
  if (name === 'multi_edit') return `edited ${String(args.file_path ?? 'a script')}`
  if (name === 'insert_asset') {
    const what = String(args.assetName ?? args.assetId ?? 'an asset')
    return `inserted ${what} under ${String(args.parentPath ?? 'Workspace')}`
  }
  if (name === 'subagent') return `Studio agent: ${String(args.description ?? args.subagent_type ?? '')}`
  if (name === 'execute_luau') {
    const lines = String(args.code ?? '').split('\n').map(line => line.trim())
    const comment = lines.find(line => /^--\s*\S/.test(line))
    const first = comment?.replace(/^--\s*/, '') ?? lines.find(line => line.length > 0) ?? 'ran code'
    return `ran: ${first.slice(0, 70)}`
  }
  return name.replace(/_/g, ' ')
}

export function parseStudios(text: string): StudioTarget[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = (parsed as { studios?: unknown }).studios
  if (!Array.isArray(list)) return []
  return list.flatMap(entry => {
    const { id, name } = entry as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string') return []
    const placeId = /placeId:\s*(\d+)/.exec(name)?.[1] ?? null
    return [{ id, name, placeId, mode: null }]
  })
}

export function parseMode(text: string): string | null {
  return /Current Studio Mode:\s*(\w+)/.exec(text)?.[1] ?? null
}

export function placeName(studio: StudioTarget): string {
  return studio.name.replace(/\s*\(placeId:.*\)\s*$/, '')
}

// A registered tool answers with a string; an error goes out as a deny, which the model reads as one.
// An object result such as { content: [...] } is refused by the engine.
export function toolAnswer(text: string, isError = false): { result: string } | { deny: string } {
  return isError ? { deny: text } : { result: text }
}
