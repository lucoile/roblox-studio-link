export const TREE_PORT = 34950
export const GREP_CAP = 100000

export type TreeHeader = { version: number; place: string; name: string; at: number; count: number }
export type TreeRun = { count: number; pattern: string; first: string; last: string }
export type TreeRow = {
  path: string
  className: string
  children: number
  depth: number
  nameLen: number
  tags: string[]
  attrs: string[]
  text: string
  lines: number | null
  folded?: number
  run?: TreeRun
}
export type MatchMode = 'any' | 'all' | 'exact' | 'prefix' | 'regex'
export type TreeQuery = {
  words: string[]
  match: MatchMode
  pattern: RegExp | null
  under: string
  classes: string[]
  tags: string[]
  attribute: string
  text: string
  depth: number | null
  limit: number
  fold: boolean
  groupBy: '' | 'class' | 'parent'
  details: boolean
}
export type TreeShow = { tags: boolean; attrs: boolean; text: boolean; lines: boolean }
export type TreeSearch = { rows: TreeRow[]; total: number; items: number; counts: [string, number][] | null; show: TreeShow }

// Abstract classes the Studio MCP's instance_type accepts (IsA), expanded to the classes a snapshot holds.
const BASE_SCRIPT = ['Script', 'LocalScript']
const GUI_BUTTON = ['TextButton', 'ImageButton']
const GUI_OBJECT = ['Frame', 'ScrollingFrame', 'TextLabel', 'TextBox', 'ImageLabel', 'ViewportFrame', 'VideoFrame', 'CanvasGroup', ...GUI_BUTTON]
const LAYER = ['ScreenGui', 'SurfaceGui', 'BillboardGui']
const BASE_PART = ['Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'SpawnLocation', 'Seat', 'VehicleSeat', 'UnionOperation', 'NegateOperation', 'IntersectOperation', 'Terrain']
const UI_LAYOUT = ['UIListLayout', 'UIGridLayout', 'UIPageLayout', 'UITableLayout']
const FAMILIES: Record<string, string[]> = {
  basescript: BASE_SCRIPT,
  luasourcecontainer: [...BASE_SCRIPT, 'ModuleScript'],
  guibutton: GUI_BUTTON,
  guiobject: GUI_OBJECT,
  guibase2d: [...GUI_OBJECT, ...LAYER],
  layercollector: LAYER,
  basepart: BASE_PART,
  pvinstance: [...BASE_PART, 'Model'],
  valuebase: ['StringValue', 'IntValue', 'NumberValue', 'BoolValue', 'ObjectValue', 'Vector3Value', 'CFrameValue', 'Color3Value', 'BrickColorValue', 'RayValue'],
  uilayout: UI_LAYOUT,
  uicomponent: [...UI_LAYOUT, 'UICorner', 'UIStroke', 'UIPadding', 'UIScale', 'UIGradient', 'UIAspectRatioConstraint', 'UISizeConstraint', 'UITextSizeConstraint', 'UIFlexItem', 'UIDragDetector'],
  light: ['PointLight', 'SpotLight', 'SurfaceLight'],
}

const HEADER = /^# studio-tree (\d+)\t/

export function parseHeader(line: string): TreeHeader | null {
  const start = HEADER.exec(line)
  if (!start) return null
  const fields: Record<string, string> = {}
  for (const part of line.slice(start[0].length).split('\t')) {
    const at = part.indexOf('=')
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1)
  }
  return {
    version: Number(start[1]),
    place: fields.place ?? '',
    name: fields.name ?? '',
    at: Number(fields.at ?? 0) * 1000,
    count: Number(fields.count ?? 0),
  }
}

// Version 1 rows stop after childCount; version 2 adds depth, nameLen, tags, attrs, text and lines.
export function parseRow(line: string): TreeRow | null {
  const field = line.split('\t')
  const path = field[0]
  const className = field[1]
  if (!path || !className || path.startsWith('#')) return null
  return {
    path,
    className,
    children: Number(field[2] ?? 0),
    depth: field[3] ? Number(field[3]) : segments(path),
    nameLen: field[4] ? Number(field[4]) : 0,
    tags: field[5] ? field[5].split(',') : [],
    attrs: field[6] ? field[6].split(',') : [],
    text: field[7] ?? '',
    lines: field[8] ? Number(field[8]) : null,
  }
}

// Names can contain dots, so this is exact only for version 2 rows (depth and nameLen are stored).
function segments(path: string): number {
  return path.split('.').length
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}

export function rowName(row: TreeRow): string {
  return row.nameLen ? row.path.slice(row.path.length - row.nameLen) : nameOf(row.path)
}

export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(word => word.length > 0)
}

// "HotbarSlot", "hotbar_slot" and "Hotbar slot" all become "hotbar slot".
export function normalizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase()
}

export function expandClasses(spec: string): string[] {
  const out = new Set<string>()
  for (const name of spec.split(',').map(part => part.trim().toLowerCase()).filter(Boolean)) {
    out.add(name)
    for (const member of FAMILIES[name] ?? []) out.add(member.toLowerCase())
  }
  return [...out]
}

function list(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
}

const MODES: MatchMode[] = ['any', 'all', 'exact', 'prefix', 'regex']

export function makeQuery(args: Record<string, unknown>): TreeQuery {
  const raw = String(args.query ?? '')
  const match = MODES.find(mode => mode === args.match) ?? 'any'
  let pattern: RegExp | null = null
  if (match === 'regex' && raw) {
    try {
      pattern = new RegExp(raw, 'i')
    } catch {}
  }
  const words = pattern ? [] : queryWords(raw)
  const under = String(args.under ?? '')
    .trim()
    .replace(/^game\./, '')
  const classes = expandClasses(String(args.class_name ?? ''))
  const tags = list(args.tag)
  const attribute = String(args.attribute ?? '').trim().toLowerCase()
  const text = String(args.text ?? '').trim().toLowerCase()
  const hasFilter = words.length > 0 || pattern !== null || classes.length > 0 || tags.length > 0 || attribute !== '' || text !== ''
  const rawDepth = args.depth === undefined ? null : Number(args.depth)
  const depth = rawDepth !== null && Number.isFinite(rawDepth) ? Math.max(1, Math.floor(rawDepth)) : hasFilter ? null : 1
  const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50))
  const groupBy = args.group_by === 'class' || args.group_by === 'parent' ? args.group_by : ''
  return { words, match, pattern, under, classes, tags, attribute, text, depth, limit, fold: args.fold !== false, groupBy, details: args.details === true }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// grep narrows the file before the rows cross into the plugin; scoreRow() is the real filter.
// The most selective filter goes first: words, then text, tag, attribute, class, under.
export function grepArgs(query: TreeQuery, file: string): string[] | null {
  const base = ['grep', '-m', String(GREP_CAP)]
  if (query.words.length) return [...base, '-i', '-F', ...query.words.flatMap(word => ['-e', word]), '--', file]
  if (query.text) return [...base, '-i', '-F', '-e', query.text, '--', file]
  if (query.tags.length) return [...base, '-i', '-F', ...query.tags.flatMap(tag => ['-e', tag]), '--', file]
  if (query.attribute) return [...base, '-i', '-F', '-e', query.attribute, '--', file]
  if (query.classes.length) return [...base, '-i', '-E', '-e', `\t(${query.classes.map(escapeRegex).join('|')})\t`, '--', file]
  if (query.under) return [...base, '-E', '-e', `^${escapeRegex(query.under)}[.\t]`, '--', file]
  if (query.pattern || query.groupBy) return [...base, '-v', '-e', '^#', '--', file]
  return null
}

const MISS = 4

// 0 exact, 1 prefix, 2 word boundary, 3 substring; null when the word is not in the name.
function wordScore(raw: string, norm: string, word: string, mode: MatchMode): number | null {
  if (raw === word || norm === word) return 0
  if (mode === 'exact') return null
  if (raw.startsWith(word) || norm.startsWith(word)) return 1
  if ((' ' + norm).includes(' ' + word)) return 2
  if (mode === 'prefix') return null
  return raw.includes(word) || norm.includes(word) ? 3 : null
}

function nameScore(row: TreeRow, query: TreeQuery): number | null {
  const name = rowName(row)
  if (query.pattern) return query.pattern.test(name) ? 2 : null
  if (!query.words.length) return 0
  const raw = name.toLowerCase()
  const norm = normalizeName(name)
  const scores = query.words.map(word => wordScore(raw, norm, word, query.match))
  const hits = scores.filter(score => score !== null)
  if (!hits.length || (query.match === 'all' && hits.length < scores.length)) return null
  if (query.words.length > 1 && (raw === query.words.join(' ') || norm === query.words.join(' '))) return -1
  return scores.reduce<number>((sum, score) => sum + (score ?? MISS), 0) / scores.length
}

// Lower is a better match; null means the row is out. Rows with no name query all score 0.
export function scoreRow(row: TreeRow, query: TreeQuery): number | null {
  if (query.under && row.path !== query.under && !row.path.startsWith(query.under + '.')) return null
  if (query.classes.length && !query.classes.includes(row.className.toLowerCase())) return null
  if (query.tags.length && !query.tags.some(tag => row.tags.some(own => own.toLowerCase() === tag))) return null
  if (query.attribute && !row.attrs.some(attr => attr.toLowerCase().includes(query.attribute))) return null
  if (query.text && !row.text.toLowerCase().includes(query.text)) return null
  if (query.depth !== null) {
    const below = row.depth - (query.under ? segments(query.under) : 0)
    if (below > query.depth || (query.under && below < 1)) return null
  }
  return nameScore(row, query)
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

type Scored = { row: TreeRow; score: number; order: number }

// A match's matching descendants add nothing the match does not already say: count them on it.
// A descendant that matches better than the ancestor stays, or the best answer would hide under a weak one.
function fold(matched: Scored[]): Scored[] {
  const scores = new Map(matched.map(item => [item.row.path, item.score]))
  const counts = new Map<string, number>()
  const kept: Scored[] = []
  for (const item of matched) {
    const path = item.row.path
    let top: string | null = null
    for (let dot = path.indexOf('.'); dot !== -1; dot = path.indexOf('.', dot + 1)) {
      const ancestor = scores.get(path.slice(0, dot))
      if (ancestor !== undefined && ancestor <= item.score) {
        top = path.slice(0, dot)
        break
      }
    }
    if (top === null) kept.push(item)
    else counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  for (const item of kept) {
    const folded = counts.get(item.row.path)
    if (folded) item.row.folded = folded
  }
  return kept
}

// Siblings that differ only in digits (Slot_floor_1 .. Slot_floor_200) or share a name become one line.
const RUN_MIN = 4

function collapse(items: Scored[]): TreeRow[] {
  const keyOf = (row: TreeRow) => {
    const name = rowName(row)
    return `${row.path.slice(0, row.path.length - name.length)}|${name.replace(/\d+/g, '#')}|${row.className}`
  }
  const groups = new Map<string, Scored[]>()
  for (const item of items) {
    const key = keyOf(item.row)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const out: TreeRow[] = []
  const emitted = new Set<string>()
  for (const item of items) {
    const key = keyOf(item.row)
    const members = groups.get(key)!
    if (members.length < RUN_MIN) {
      out.push(item.row)
    } else if (!emitted.has(key)) {
      emitted.add(key)
      const byOrder = [...members].sort((a, b) => a.order - b.order)
      const folded = members.reduce((sum, member) => sum + (member.row.folded ?? 0), 0)
      out.push({
        ...item.row,
        folded: folded || undefined,
        run: {
          count: members.length,
          pattern: rowName(item.row).replace(/\d+/g, '#'),
          first: rowName(byOrder[0]!.row),
          last: rowName(byOrder[byOrder.length - 1]!.row),
        },
      })
    }
  }
  return out
}

function parentOf(row: TreeRow): string {
  const name = rowName(row)
  return row.path.slice(0, Math.max(0, row.path.length - name.length - 1))
}

const NOTHING: TreeShow = { tags: false, attrs: false, text: false, lines: false }

export function search(text: string, query: TreeQuery): TreeSearch {
  const matched: Scored[] = []
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (!row) continue
    const score = scoreRow(row, query)
    if (score !== null) matched.push({ row, score, order: matched.length })
  }
  const total = matched.length
  if (query.groupBy) {
    const counts = new Map<string, number>()
    for (const { row } of matched) {
      const key = query.groupBy === 'class' ? row.className : parentOf(row) || '(root)'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return { rows: [], total, items: counts.size, counts: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30), show: NOTHING }
  }
  const isRanked = query.words.length > 0 || query.pattern !== null
  if (isRanked) matched.sort((a, b) => a.score - b.score || a.row.depth - b.row.depth || a.order - b.order)
  const kept = query.fold && isRanked ? fold(matched) : matched
  const rows = query.fold ? collapse(kept) : kept.map(item => item.row)
  const show = {
    tags: query.details || query.tags.length > 0,
    attrs: query.details || query.attribute !== '',
    text: query.details || query.text !== '',
    lines: query.details,
  }
  return { rows: rows.slice(0, query.limit), total, items: rows.length, counts: null, show }
}

function rowLine(row: TreeRow, show: TreeShow): string {
  let line: string
  if (row.run) {
    const parent = parentOf(row)
    const range = row.run.first === row.run.last ? '' : `  (${row.run.first} .. ${row.run.last})`
    line = `${parent ? parent + '.' : ''}${row.run.pattern}  ${row.className}  x${row.run.count}${range}`
  } else {
    line = `${row.path}  ${row.className}${row.children ? `  (${row.children} children)` : ''}`
  }
  if (show.tags && row.tags.length) line += `  ${row.tags.map(tag => '#' + tag).join(' ')}`
  if (show.attrs && row.attrs.length) line += `  ${row.attrs.map(attr => '@' + attr).join(' ')}`
  if (show.text && row.text) line += `  "${row.text}"`
  if (show.lines && row.lines !== null) line += `  ${row.lines} lines`
  if (row.folded) line += `  +${row.folded} more match below`
  return line
}

export function formatResults(
  header: TreeHeader | null,
  place: string,
  found: TreeSearch,
  isCapped: boolean,
  now: number,
  note = '',
): string {
  const title = header ? `${header.name || 'Place'} (place ${header.place || place})` : `Place ${place}`
  const age = header?.at ? `snapshot from ${formatAge(now - header.at)} ago` : 'snapshot age unknown'
  const size = header?.count ? `, ${header.count} instances` : ''
  const grouped = found.counts ? `, ${found.items} groups` : found.items !== found.total ? `, ${found.items} after folding` : ''
  const shown = !found.counts && found.rows.length < found.items ? `, showing ${found.rows.length}` : ''
  const capped = isCapped ? ' (search hit its cap; narrow it with under or class_name)' : ''
  const lines = [`${title}, ${age}${size}. ${found.total} matches${grouped}${shown}${capped}.`]
  if (note) lines.push(note)
  if (found.counts) for (const [key, count] of found.counts) lines.push(`${key}  ${count}`)
  else for (const row of found.rows) lines.push(rowLine(row, found.show))
  return lines.join('\n')
}
