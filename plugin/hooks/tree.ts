export const TREE_PORT = 34950
export const TREE_FORMAT = '# studio-tree 1'
export const GREP_CAP = 20000

export type TreeHeader = { place: string; name: string; at: number; count: number }
export type TreeRow = { path: string; className: string; children: number }
export type TreeQuery = { words: string[]; under: string; className: string; depth: number | null; limit: number }

export function parseHeader(line: string): TreeHeader | null {
  if (!line.startsWith(TREE_FORMAT + '\t')) return null
  const fields: Record<string, string> = {}
  for (const part of line.slice(TREE_FORMAT.length + 1).split('\t')) {
    const at = part.indexOf('=')
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1)
  }
  return {
    place: fields.place ?? '',
    name: fields.name ?? '',
    at: Number(fields.at ?? 0) * 1000,
    count: Number(fields.count ?? 0),
  }
}

export function parseRow(line: string): TreeRow | null {
  const [path, className, children] = line.split('\t')
  if (!path || !className || path.startsWith('#')) return null
  return { path, className, children: Number(children ?? 0) }
}

// Names can contain dots, so depth and the last segment are approximate for those.
function segments(path: string): number {
  return path.split('.').length
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}

export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(word => word.length > 0)
}

export function makeQuery(args: Record<string, unknown>): TreeQuery {
  const words = queryWords(String(args.query ?? ''))
  const under = String(args.under ?? '')
    .trim()
    .replace(/^game\./, '')
  const rawDepth = args.depth === undefined ? null : Number(args.depth)
  const depth = rawDepth !== null && Number.isFinite(rawDepth) ? Math.max(1, Math.floor(rawDepth)) : words.length ? null : 1
  const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50))
  return { words, under, className: String(args.class_name ?? '').trim(), depth, limit }
}

// grep narrows the file before the rows cross into the plugin; matches() is the real filter.
export function grepArgs(query: TreeQuery, file: string): string[] | null {
  const base = ['grep', '-m', String(GREP_CAP)]
  if (query.words.length) return [...base, '-i', '-F', ...query.words.flatMap(word => ['-e', word]), '--', file]
  if (query.under) return [...base, '-F', '-e', query.under, '--', file]
  if (query.className) return [...base, '-F', '-e', `\t${query.className}\t`, '--', file]
  return null
}

export function matches(row: TreeRow, query: TreeQuery): boolean {
  if (query.under && row.path !== query.under && !row.path.startsWith(query.under + '.')) return false
  if (query.className && row.className !== query.className) return false
  if (query.depth !== null) {
    const below = segments(row.path) - (query.under ? segments(query.under) : 0)
    if (below > query.depth || (query.under && below < 1)) return false
  }
  if (query.words.length) {
    const name = nameOf(row.path).toLowerCase()
    if (!query.words.some(word => name.includes(word))) return false
  }
  return true
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

export function search(text: string, query: TreeQuery): { rows: TreeRow[]; total: number } {
  const rows: TreeRow[] = []
  let total = 0
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (!row || !matches(row, query)) continue
    total++
    if (rows.length < query.limit) rows.push(row)
  }
  return { rows, total }
}

export function formatResults(
  header: TreeHeader | null,
  place: string,
  found: { rows: TreeRow[]; total: number },
  isCapped: boolean,
  now: number,
): string {
  const title = header ? `${header.name || 'Place'} (place ${header.place || place})` : `Place ${place}`
  const age = header?.at ? `snapshot from ${formatAge(now - header.at)} ago` : 'snapshot age unknown'
  const size = header?.count ? `, ${header.count} instances` : ''
  const shown = found.total > found.rows.length ? `, showing ${found.rows.length}` : ''
  const capped = isCapped ? ' (search hit its cap; narrow it with under or class_name)' : ''
  const lines = [`${title}, ${age}${size}. ${found.total} matches${shown}${capped}.`]
  for (const row of found.rows) {
    lines.push(`${row.path}  ${row.className}${row.children ? `  (${row.children} children)` : ''}`)
  }
  return lines.join('\n')
}
