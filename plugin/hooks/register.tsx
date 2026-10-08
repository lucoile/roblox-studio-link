import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { BridgeState, Drift, PlaceEdit, RojoServer, StudioTarget } from '../types'
import {
  ROJO_PORT,
  bridgeLuau,
  httpServerLines,
  instanceFor,
  isHarnessSource,
  projectMappings,
  rojoServeLines,
  sourceLengthsLuau,
} from './rojo'
import { STUDIO_TOOL, isWriteCall, parseMode, parseStudios, persistsToPlace, placeName, shortTool, summarize, toolAnswer } from './studio'
import { LEVEL_COLOR, LEVEL_RANK, baseName, computeLights, currentStudio } from './status'
import type { Light } from './status'
import { GREP_CAP, TREE_PORT, describeSnapshots, formatResults, grepArgs, isLive, makeQuery, parseHeader, pickSnapshot, placeKeyOf, search, snapshotRefs } from './tree'

const PLUGIN = 'roblox-studio-link'
const PANE = 'roblox-studio-link'
const PROJECT_FILE = 'default.project.json'
const STUDIO_PLUGIN_FILE = 'StudioTree.rbxm'
const LIST_FAILURES_BEFORE_CLEAR = 3
const LISTENER_PROTOCOL = 2

const studios = atom({ plugin: 'roblox-studio-link', key: 'studios' } as const, [])
const lastStudio = atom({ plugin: 'roblox-studio-link', key: 'lastStudio' } as const, '')
const approved = atom({ plugin: 'roblox-studio-link', key: 'approved' } as const, [])
const rojo = atom({ plugin: 'roblox-studio-link', key: 'rojo' } as const, null)
const edits = atom({ plugin: 'roblox-studio-link', key: 'edits' } as const, [])
const bridges = atom({ plugin: 'roblox-studio-link', key: 'bridges' } as const, null)
const isBandHidden = atom({ plugin: 'roblox-studio-link', key: 'isBandHidden' } as const, false)

type $ = EngineInterface

const LIGHT_ORDER = [
  ['studio', 'Studio'],
  ['rojo', 'Rojo'],
  ['edits', 'Edits'],
  ['bridges', 'Bridges'],
] as const

let studioTools: Record<string, string> = {}
let mcpSplit: Record<string, [string, string]> = {}
let served: { stop: () => void; port: number } | null = null
let editsAtTurnStart = 0
let treeListener: { stop: () => void } | null = null
let treeNote = ''
let isTreeStarting = false
let listFailures = 0

async function run($: $, argv: string[], cwd?: string) {
  try {
    const done = await $.process.run(argv, { cwd, timeoutMs: 10000 })
    return done.exitCode === 0 ? done.stdout : ''
  } catch {
    return ''
  }
}

async function gitTop($: $) {
  return (await run($, ['git', 'rev-parse', '--show-toplevel'])).trim()
}

async function findStudioTools($: $) {
  const found: Record<string, string> = {}
  for (const tool of await $.tool.list()) {
    if (STUDIO_TOOL.test(tool.name)) found[shortTool(tool.name)] = tool.name
  }
  studioTools = found
  return found
}

// Server names can contain "__", so try each split of the tool name until one connects.
async function mcpText($: $, short: string, args: Record<string, unknown>) {
  const full = studioTools[short] ?? (await findStudioTools($))[short]
  if (!full) throw new Error('The Roblox Studio MCP server is not connected.')
  const known = mcpSplit[full]
  const body = full.slice('mcp__'.length)
  const splits: [string, string][] = known
    ? [known]
    : [...body.matchAll(/__/g)].map(m => [body.slice(0, m.index), body.slice(m.index! + 2)])
  let lastError: unknown = null
  for (const [server, tool] of splits) {
    let answer: Awaited<ReturnType<typeof $.mcp.call>>
    try {
      answer = await $.mcp.call(server, tool, args)
    } catch (error) {
      lastError = error
      continue
    }
    mcpSplit[full] = [server, tool]
    const text = answer.content.map(block => ('text' in block ? String(block.text) : '')).join('')
    if (answer.isError) throw new Error(text)
    return text
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function refreshStatus($: $) {
  const list = await read($, studios)
  const current = currentStudio(list, await read($, lastStudio))
  const state = await read($, rojo)
  const unsaved = (await read($, edits)).filter(edit => !edit.isSaved).length
  const parts: string[] = []
  if (current) parts.push(`Studio: ${placeName(current)}${current.mode ? ` (${current.mode.toLowerCase()})` : ''}`)
  else if (list.length > 1) parts.push(`${list.length} Studios`)
  if (state?.hasProject) {
    const here = state.servers.find(s => s.isHere)
    parts.push(here ? 'Rojo: here' : state.servers.length ? `Rojo: ${baseName(state.servers[0]!.root)}` : 'Rojo: off')
  }
  if (unsaved) parts.push(`${unsaved} unsaved`)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

async function refreshStudios($: $) {
  let list: StudioTarget[]
  try {
    list = parseStudios(await mcpText($, 'list_roblox_studios', {}))
    listFailures = 0
  } catch (error) {
    // One failed listing must not wipe the cache the write guard reads; a Studio that really
    // went away fails every time, so clear only after several in a row.
    listFailures++
    $.ui.log(`list_roblox_studios failed (${listFailures}): ${String(error)}`, { to: 'debug' })
    if (listFailures < LIST_FAILURES_BEFORE_CLEAR) return
    list = []
  }
  for (const studio of list) {
    try {
      studio.mode = parseMode(await mcpText($, 'get_studio_state', { studio_id: studio.id }))
    } catch {
      studio.mode = null
    }
  }
  await update($, studios, () => list)
}

async function processRoot($: $, pid: string) {
  const lsof = await run($, ['lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'])
  const fromLsof = /^n(.+)$/m.exec(lsof)?.[1]
  if (fromLsof) return fromLsof
  return (await run($, ['readlink', `/proc/${pid}/cwd`])).trim()
}

async function refreshRojo($: $) {
  const here = await gitTop($)
  if (!here) return
  const branch = (await run($, ['git', 'branch', '--show-current'])).trim()
  let hasProject = true
  try {
    await $.fs.read(`${here}/${PROJECT_FILE}`)
  } catch {
    hasProject = false
  }
  const servers: RojoServer[] = []
  for (const { pid, port } of rojoServeLines(await run($, ['ps', '-axo', 'pid=,ppid=,command=']))) {
    const root = await processRoot($, pid)
    const top = root ? (await run($, ['git', 'rev-parse', '--show-toplevel'], root)).trim() || root : ''
    let projectName: string | null = null
    let expectedPlaceIds: string[] = []
    try {
      const answer = await $.http.fetch(`http://localhost:${port}/api/rojo`)
      if (answer.ok) {
        const info = JSON.parse(answer.text) as { projectName?: string; expectedPlaceIds?: unknown }
        projectName = info.projectName ?? null
        if (Array.isArray(info.expectedPlaceIds)) expectedPlaceIds = info.expectedPlaceIds.map(String)
      }
    } catch {}
    servers.push({
      pid,
      port,
      root: top,
      branch: top ? (await run($, ['git', 'branch', '--show-current'], top)).trim() : '',
      projectName,
      expectedPlaceIds,
      isHere: top === here,
      isOurs: served !== null && served.port === port && top === here,
    })
  }
  await update($, rojo, previous => ({
    checkedAt: Date.now(),
    here,
    branch,
    hasProject,
    servers,
    drift: previous?.here === here ? previous.drift : null,
  }))
}

async function refreshBridges($: $) {
  const top = await gitTop($)
  if (!top) return
  const status = await run($, ['git', 'status', '--porcelain', '--untracked-files=all'], top)
  const staged = new Set((await run($, ['git', 'diff', '--cached', '--name-only'], top)).split('\n').filter(Boolean))
  const harnesses: string[] = []
  for (const line of status.split('\n')) {
    const code = line.slice(0, 2)
    const file = line.slice(3).trim()
    const isNew = code === '??' || code.startsWith('A')
    if (!isNew || !/\.(server|client)\.luau?$/.test(file)) continue
    try {
      if (isHarnessSource(await $.fs.read(`${top}/${file}`))) harnesses.push(file)
    } catch {}
  }
  const servers = []
  for (const { pid, port } of httpServerLines(await run($, ['ps', '-axo', 'pid=,command=']))) {
    servers.push({ pid, port, root: await processRoot($, pid) })
  }
  const next: BridgeState = {
    harnesses,
    stagedHarnesses: harnesses.filter(file => staged.has(file)),
    servers,
  }
  await update($, bridges, () => next)
  return next
}

async function refreshAll($: $) {
  // Tool names and server splits are cached; drop them so a reconnected MCP server is found again.
  studioTools = {}
  mcpSplit = {}
  await Promise.all([refreshStudios($), refreshRojo($), refreshBridges($)])
  await refreshStatus($)
}

async function checkDrift($: $): Promise<Drift> {
  const top = await gitTop($)
  const studio = currentStudio(await read($, studios), await read($, lastStudio)) ?? (await read($, studios))[0]
  const fail = (error: string): Drift => ({ checkedAt: Date.now(), studioName: studio ? placeName(studio) : '', files: [], error })
  if (!top) return fail('Not in a git worktree.')
  if (!studio) return fail('No Studio is connected.')
  let project: unknown
  try {
    project = JSON.parse(await $.fs.read(`${top}/${PROJECT_FILE}`))
  } catch {
    return fail(`No ${PROJECT_FILE} in this worktree.`)
  }
  const isLuau = (file: string) => /\.luau?$/.test(file)
  let files = (await run($, ['git', 'diff', '--name-only', 'HEAD'], top)).split('\n')
  files = files.concat((await run($, ['git', 'ls-files', '--others', '--exclude-standard'], top)).split('\n'))
  files = files.filter(isLuau)
  if (files.length === 0) {
    files = (await run($, ['git', 'log', '-5', '--name-only', '--format='], top)).split('\n').filter(isLuau)
  }
  const mappings = projectMappings(project)
  const checked = [...new Set(files)]
    .map(file => ({ file, instance: instanceFor(file, mappings) }))
    .filter((item): item is { file: string; instance: string[] } => item.instance !== null)
    .slice(0, 25)
  if (checked.length === 0) return fail('No synced source files to compare.')
  let lengths: number[]
  try {
    const text = await mcpText($, 'execute_luau', {
      studio_id: studio.id,
      datamodel_type: 'Edit',
      code: sourceLengthsLuau(checked.map(item => item.instance)),
    })
    lengths = JSON.parse(text) as number[]
  } catch (error) {
    return fail(`Studio didn't answer: ${String(error).slice(0, 120)}`)
  }
  const encoder = new TextEncoder()
  const result: Drift = { checkedAt: Date.now(), studioName: placeName(studio), files: [], error: null }
  for (const [i, item] of checked.entries()) {
    let local = -2
    try {
      local = encoder.encode(await $.fs.read(`${top}/${item.file}`)).length
    } catch {}
    const remote = lengths[i] ?? -1
    result.files.push({ file: item.file, status: remote < 0 ? 'missing' : remote === local ? 'same' : 'differs' })
  }
  return result
}

async function runDrift($: $) {
  const drift = await checkDrift($)
  await update($, rojo, state => (state ? { ...state, drift } : state))
  return drift
}

async function portInUse($: $, port: number): Promise<boolean> {
  if ((await run($, ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).trim()) return true
  try {
    await $.http.fetch(`http://localhost:${port}/`)
    return true
  } catch {
    return false
  }
}

async function freePort($: $, tried: Set<number>): Promise<number | null> {
  for (let port = ROJO_PORT; port < ROJO_PORT + 50; port++) {
    if (!tried.has(port) && !(await portInUse($, port))) return port
  }
  return null
}

// Resolves null once rojo says it's listening (or is still up after a few seconds), else its output.
async function startRojo($: $, root: string, port: number): Promise<string | null> {
  let child: ReturnType<typeof $.process.spawn>
  try {
    child = $.process.spawn({ argv: ['rojo', 'serve', '--port', String(port)], cwd: root })
  } catch {
    return 'rojo is not on PATH. Install it (rokit, aftman or the Rojo release) and try again.'
  }
  const mine = { stop: () => void child.return(undefined as never), port }
  served = mine
  let output = ''
  let hasEnded = false
  let settle: (failure: string | null) => void = () => {}
  const ready = new Promise<string | null>(resolve => (settle = resolve))
  void (async () => {
    try {
      for await (const piece of child) {
        output += piece.text
        $.ui.log(piece.text.trimEnd(), { to: 'debug' })
        if (/listening/i.test(output)) settle(null)
      }
    } catch (error) {
      output += String(error)
    }
    hasEnded = true
    settle(output.trim() || 'rojo serve exited')
    if (served === mine) {
      served = null
      await refreshRojo($)
      await refreshStatus($)
    }
  })()
  $.clock.after(4000, () => settle(hasEnded ? output.trim() || 'rojo serve exited' : null))
  const failure = await ready
  return hasEnded ? failure ?? (output.trim() || 'rojo serve exited') : null
}

async function serveHere($: $, wanted?: string): Promise<string> {
  await refreshRojo($)
  const state = await read($, rojo)
  if (!state) return 'Not in a git worktree.'
  if (!state.hasProject) return `No ${PROJECT_FILE} in ${baseName(state.here)}.`
  const existing = state.servers.find(s => s.isHere)
  if (existing) return `Rojo is already serving ${baseName(state.here)} on port ${existing.port}.`
  const chosen = wanted?.trim() ? Number(wanted.trim()) : null
  if (chosen !== null && (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535)) {
    return `${wanted!.trim()} isn't a port between 1024 and 65535.`
  }
  const tried = new Set<number>()
  for (let attempt = 0; attempt < (chosen === null ? 5 : 1); attempt++) {
    if (chosen !== null && (await portInUse($, chosen))) return `Port ${chosen} is already in use.`
    const port = chosen ?? (await freePort($, tried))
    if (port === null) return `No free port between ${ROJO_PORT} and ${ROJO_PORT + 49}.`
    tried.add(port)
    const failure = await startRojo($, state.here, port)
    if (failure === null) {
      await refreshRojo($)
      await refreshStatus($)
      const others = state.servers.map(s => `${baseName(s.root) || `pid ${s.pid}`} on ${s.port}`)
      return [
        `Serving ${baseName(state.here)} on port ${port}.`,
        port !== ROJO_PORT ? `Set the port to ${port} in Studio's Rojo plugin and connect.` : '',
        others.length ? `Still running: ${others.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ')
    }
    if (!/in use|addrinuse|address already|os error 48|os error 98/i.test(failure)) {
      return `rojo serve failed: ${failure.slice(0, 200)}`
    }
  }
  return chosen === null ? 'rojo serve kept finding its port taken; try again.' : `rojo couldn't bind port ${chosen}.`
}

async function stopServer($: $, pid?: string): Promise<string> {
  await refreshRojo($)
  const state = await read($, rojo)
  const target = state?.servers.find(s => (pid ? s.pid === pid : s.isHere))
  if (!target) return pid ? `No Rojo server with pid ${pid}.` : 'Rojo is not serving this worktree.'
  if (target.isOurs && served) served.stop()
  else await run($, ['kill', target.pid])
  await new Promise<void>(resolve => $.clock.after(500, resolve))
  await refreshRojo($)
  await refreshStatus($)
  return `Stopped Rojo for ${baseName(target.root) || `pid ${target.pid}`} on port ${target.port}.`
}

async function resolveStudio($: $, id: unknown) {
  const wanted = typeof id === 'string' && id ? id : await read($, lastStudio)
  let studio = (await read($, studios)).find(s => s.id === wanted)
  if (!studio) {
    await refreshStudios($)
    const list = await read($, studios)
    studio = list.find(s => s.id === wanted) ?? (wanted ? undefined : currentStudio(list, '') ?? undefined)
  }
  return studio ?? null
}

// With one Studio open a write can only land there. With several, the first write to each asks.
async function guard($: $, studio: StudioTarget | null, studioId: string): Promise<string | null> {
  if (!studio) {
    return `roblox-studio-link: Studio ${studioId || '(none given)'} isn't in list_roblox_studios. List the open Studios and check the target before writing.`
  }
  const open = await read($, studios)
  if (open.length < 2 || (await read($, approved)).includes(studio.id)) return null
  let answer = ''
  try {
    answer = await $.ui.ask(`${open.length} Studios are open. Let Claude edit ${placeName(studio)}?`, [
      'Allow once',
      'Allow for this session',
      'Block',
    ])
  } catch {}
  if (answer === 'Allow for this session') {
    await update($, approved, list => [...list, studio.id])
    return null
  }
  return answer === 'Allow once' ? null : `roblox-studio-link: edits to ${placeName(studio)} weren't approved. Confirm the target Studio with the user.`
}

async function recordEdit($: $, studio: StudioTarget, tool: string, summary: string) {
  const edit: PlaceEdit = {
    at: Date.now(),
    studioId: studio.id,
    placeName: placeName(studio),
    tool: shortTool(tool),
    summary,
    isSaved: false,
  }
  await update($, edits, list => [...list, edit].slice(-200))
  await refreshStatus($)
}

async function markSaved($: $) {
  await update($, edits, list => list.map(edit => ({ ...edit, isSaved: true })))
  await refreshStatus($)
}

function resultText(ran: { text?: string; result?: unknown }): string {
  if (ran.text) return ran.text
  const content = (ran.result as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('')
}

function driftLine(drift: Drift, Text: any) {
  if (drift.error) return <Text key="drift" color="yellow">drift: {drift.error}</Text>
  const off = drift.files.filter(file => file.status !== 'same')
  if (off.length === 0) return <Text key="drift" dimColor>drift: {drift.files.length} files match {drift.studioName}</Text>
  return (
    <Text key="drift" color="yellow" wrap="truncate-end">
      drift: {off.length} of {drift.files.length} differ in {drift.studioName} · {off.slice(0, 4).map(f => baseName(f.file)).join(', ')}
    </Text>
  )
}

async function treeDir($: $): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '.'}/.claude/studio-tree`
}

// 0 when nothing answers, 1 for a listener with no /version, else the protocol it reports.
async function treeListenerVersion($: $): Promise<number> {
  try {
    const health = await $.http.fetch(`http://127.0.0.1:${TREE_PORT}/health`)
    if (!health.ok || health.text.trim() !== 'studio-tree') return 0
    const version = await $.http.fetch(`http://127.0.0.1:${TREE_PORT}/version`)
    return version.ok ? Number(version.text.trim()) || 1 : 1
  } catch {
    return 0
  }
}

async function isTreeListening($: $): Promise<boolean> {
  return (await treeListenerVersion($)) > 0
}

// An older listener left running by an earlier session would ignore sessions and heartbeats. It is ours when
// its command line names tree_listener.py; anything else on the port is left alone.
async function stopOldListener($: $): Promise<boolean> {
  const pids = (await run($, ['lsof', '-ti', `tcp:${TREE_PORT}`, '-sTCP:LISTEN'])).split('\n').filter(Boolean)
  let isStopped = false
  for (const pid of pids) {
    if (!/tree_listener\.py/.test(await run($, ['ps', '-p', pid, '-o', 'command=']))) continue
    await run($, ['kill', pid])
    isStopped = true
  }
  if (isStopped) await new Promise<void>(resolve => $.clock.after(700, resolve))
  return isStopped
}

// One listener per machine: when another session already runs it, this one leaves it be.
async function ensureTreeListener($: $): Promise<void> {
  if (treeListener || isTreeStarting) return
  isTreeStarting = true
  try {
    const version = await treeListenerVersion($)
    if (version === 0) await startTreeListener($)
    else if (version < LISTENER_PROTOCOL) {
      if (await stopOldListener($)) await startTreeListener($)
      else treeNote = `A tree listener on port ${TREE_PORT} is older than this mod and could not be replaced; stop it and reopen Claude Code.`
    }
  } finally {
    isTreeStarting = false
  }
}

async function startTreeListener($: $): Promise<void> {
  const script = `${$.plugin.root}/listener/tree_listener.py`
  let child: ReturnType<typeof $.process.spawn>
  try {
    child = $.process.spawn({ argv: ['python3', script, '--port', String(TREE_PORT), '--dir', await treeDir($)] })
  } catch {
    treeNote = 'python3 is not on PATH, so the tree listener could not start.'
    return
  }
  const mine = { stop: () => void child.return(undefined as never) }
  treeListener = mine
  void (async () => {
    let output = ''
    try {
      for await (const piece of child) {
        output += piece.text
        $.ui.log(piece.text.trimEnd(), { to: 'debug' })
      }
    } catch (error) {
      output += String(error)
    }
    if (treeListener === mine) treeListener = null
    treeNote = output.trim().split('\n').pop() ?? 'the tree listener exited'
  })()
}

type TreeTarget = { file: string; place: string; note: string }

// Which snapshot a search reads: the one named by session, else the place of the Studio named by studio_id or
// place_id, else the Studio Claude last targeted. With several Studios open and none picked there is no safe guess.
async function resolveTree($: $, args: Record<string, unknown>): Promise<TreeTarget | { error: string }> {
  const dir = await treeDir($)
  let listed: { name: string; mtimeMs: number }[] = []
  try {
    listed = (await $.fs.list(dir)).filter(entry => entry.name.endsWith('.tsv'))
  } catch {}
  const now = await $.clock.now()
  const session = typeof args.session === 'string' ? args.session.trim() : ''
  const wantedPlace = typeof args.place_id === 'string' ? args.place_id.trim() : ''
  const studioId = typeof args.studio_id === 'string' ? args.studio_id.trim() : ''

  let place = wantedPlace
  if (!session && !place) {
    const studio = await resolveStudio($, studioId)
    if (studio) place = placeKeyOf(studio.placeId, placeName(studio))
    else if (studioId) return { error: `Studio ${studioId} is not in list_roblox_studios. List the open Studios and pass one of their ids.` }
  }
  if (!session && !place) {
    const open = await read($, studios)
    const refs = snapshotRefs(listed)
    if (open.length > 1 && refs.length > 1) {
      const shown = refs.filter(ref => isLive(ref, now)).slice(0, 6)
      const entries = await describeEntries($, dir, shown.length ? shown : refs.slice(0, 6))
      return {
        error: `${open.length} Studios are open and none is targeted, so I won't guess which tree to search. Pass studio_id, place_id or session. Snapshots:\n${describeSnapshots(entries, now)}`,
      }
    }
    place = refs[0]?.place ?? ''
  }
  if (place && !/^[A-Za-z0-9_-]+$/.test(place)) return { error: `"${place}" is not a place id.` }

  let pick = pickSnapshot(listed, place, now, session)
  if (!pick.ref && place.startsWith('local-')) {
    // The plugin names an unsaved place by game.Name, which the Studio list may spell differently.
    const local = snapshotRefs(listed).filter(ref => ref.place.startsWith('local-'))
    if (local.length) pick = pickSnapshot(listed, local[0]!.place, now)
  }
  if (!pick.ref) return { error: await noSnapshot($, dir, session ? `session ${session}` : place ? `place ${place}` : '') }
  return { file: `${dir}/${pick.ref.file}`, place: pick.ref.place, note: pick.note }
}

async function describeEntries($: $, dir: string, refs: ReturnType<typeof snapshotRefs>) {
  const heads = await $.process.run(['head', '-q', '-n', '1', ...refs.map(ref => `${dir}/${ref.file}`)], { timeoutMs: 5000 })
  const lines = heads.stdout.split('\n')
  return refs.map((ref, index) => ({ ref, header: parseHeader(lines[index] ?? '') }))
}

async function noSnapshot($: $, dir: string, what: string): Promise<string> {
  await ensureTreeListener($)
  const listening = await isTreeListening($)
  return [
    `No tree snapshot${what ? ` for ${what}` : ''} in ${dir}.`,
    listening
      ? 'The listener is running; the Studio Tree plugin in that Studio has not sent a tree yet (installed? HTTP allowed for 127.0.0.1?).'
      : `The listener is not running${treeNote ? `: ${treeNote}` : '.'}`,
    'Use search_game_tree with path and max_depth meanwhile.',
  ].join(' ')
}

async function treeSearch($: $, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const query = makeQuery(args)
  const target = await resolveTree($, args)
  if ('error' in target) return { isError: true, text: target.error }
  const { file, place } = target
  const argv = grepArgs(query, file)
  if (!argv) return { isError: true, text: 'Give query, under, class_name, tag, attribute, text or group_by.' }
  const [head, found] = await Promise.all([
    $.process.run(['head', '-n', '1', file], { timeoutMs: 5000 }),
    $.process.run(argv, { timeoutMs: 20000 }),
  ])
  if (found.exitCode > 1) return { isError: true, text: `grep failed: ${found.stderr.trim()}` }
  const isCapped = found.isStdoutTruncated === true || found.stdout.split('\n').length > GREP_CAP
  const result = search(found.stdout, query)
  const header = parseHeader(head.stdout.trim())
  const usesV2 = query.tags.length > 0 || query.attribute !== '' || query.text !== ''
  const notes = [
    target.note,
    header && header.version < 2 && usesV2
      ? 'This snapshot has no tags, attributes or text yet: restart Roblox Studio so the updated Studio Tree plugin sends a new one.'
      : '',
  ].filter(Boolean)
  return { isError: false, text: formatResults(header, place, result, isCapped, await $.clock.now(), notes.join('\n')) }
}

function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

// rojo's --plugin writes to Studio's local plugins folder; rebuilt only when the source changes.
async function installStudioPlugin($: $, isForced: boolean): Promise<string> {
  const project = `${$.plugin.root}/studio-plugin/plugin.project.json`
  const source = await $.fs.read(`${$.plugin.root}/studio-plugin/StudioTree.server.luau`)
  const hash = hashText(source)
  const home = await $.env.get('HOME')
  const macFile = home ? `${home}/Documents/Roblox/Plugins/${STUDIO_PLUGIN_FILE}` : ''
  const isMissing = macFile ? !(await $.fs.exists(macFile)) : false
  if (!isForced && !isMissing && (await $.store.get('studioPluginHash')) === hash) return ''
  const manual = `rojo build "${project}" --plugin ${STUDIO_PLUGIN_FILE}`
  let done: Awaited<ReturnType<typeof $.process.run>>
  try {
    done = await $.process.run(['rojo', 'build', project, '--plugin', STUDIO_PLUGIN_FILE], { timeoutMs: 30000 })
  } catch {
    return `Could not install the Studio Tree plugin: rojo is not on PATH. Run: ${manual}`
  }
  if (done.exitCode !== 0) {
    return `Could not install the Studio Tree plugin (${(done.stderr || done.stdout).trim().split('\n').pop()}). Run: ${manual}`
  }
  await $.store.set('studioPluginHash', hash)
  return 'Installed the Studio Tree plugin. Studio loads it on its next start if it has not already.'
}

async function openPane($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Studio', focus: true })
  void refreshAll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'studio',
      description: 'Studio targets, Rojo sync, place edits and bridges',
      argumentHint: '[serve [port] | stop [pid] | drift | saved | refresh | plugin | band]',
    })
    await $.tool.register({
      name: 'bridge_command',
      description:
        'Sends a command to a throwaway harness Script that Rojo synced into ServerScriptService and waits for it to bump its Seq attribute. The harness reads a Command attribute and writes Result and Seq. Sets the Command attribute directly, so vary the command string to repeat one. Needs play mode running. Returns the harness Result attribute.',
      inputSchema: {
        type: 'object',
        properties: {
          harness: { type: 'string', description: 'Name of the harness Script under ServerScriptService' },
          command: { type: 'string', description: 'The value to set as the Command attribute' },
          studio_id: { type: 'string', description: 'Target Studio; defaults to the last one used' },
          timeout_seconds: { type: 'number', description: 'How long to wait for Seq to change; default 20' },
        },
        required: ['harness', 'command'],
      },
    })
    await $.tool.register({
      name: 'tree_search',
      description:
        "Searches a snapshot of a Studio place's instance tree that the Studio Tree plugin keeps on disk, so lookups cost a few hundred tokens and no Studio round trip. Use it before search_game_tree to find where something is. query matches instance names case-insensitively, camelCase aware (\"hotbar slot\" finds HotbarSlot), any of several words by default, best match first; match picks any, all, exact, prefix or regex. under limits to a path and its descendants; with under and no filter it lists children (depth 1, raise depth for more). class_name takes class names or families (BaseScript, LuaSourceContainer, GuiObject, BasePart, ValueBase, UIComponent...), comma separated. tag, attribute and text filter on CollectionService tags, attribute names and the Text of text GUI objects. Numbered siblings (Slot_floor_1..200) collapse into one line, and matches below a match fold into it; fold false lists everything. group_by class or parent returns counts instead of rows. Rows are path, ClassName and child count; tag, attribute and text filters add what they matched, details adds tags, attribute names, text and script line counts to every row. The first line says how old the snapshot is: edits reach it within seconds, but confirm with inspect_instance before writing.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name keywords, separated by spaces or commas (a regular expression when match is regex)' },
          match: { type: 'string', enum: ['any', 'all', 'exact', 'prefix', 'regex'], description: 'How query matches names; default any word' },
          under: { type: 'string', description: 'Dot path to search under, e.g. StarterGui.MainHUD' },
          class_name: { type: 'string', description: 'ClassName or family to keep, comma separated, e.g. Frame, BaseScript, GuiObject' },
          tag: { type: 'string', description: 'CollectionService tag, comma separated for any of several' },
          attribute: { type: 'string', description: 'Part of an attribute name the instance has' },
          text: { type: 'string', description: 'Part of the Text of a TextLabel, TextButton or TextBox' },
          depth: { type: 'number', description: 'Levels below under (or below the root) to include; default 1 when only under is given, unlimited once any filter is' },
          fold: { type: 'boolean', description: 'Collapse numbered siblings and fold matches below a match; default true' },
          group_by: { type: 'string', enum: ['class', 'parent'], description: 'Return counts per class or per parent instead of rows' },
          details: { type: 'boolean', description: 'Show tags, attribute names, text and script line counts on every row; default only what a filter asked for' },
          studio_id: { type: 'string', description: 'Studio (from list_roblox_studios) whose place to search; defaults to the Studio last targeted' },
          place_id: { type: 'string', description: 'Place to search instead of a Studio\'s' },
          session: { type: 'string', description: 'Snapshot of one Studio when several have the same place open (the answer names the sessions)' },
          limit: { type: 'number', description: 'Rows to return; default 50, max 500' },
        },
      },
    })
    void refreshAll($)
    void ensureTreeListener($)
    void installStudioPlugin($, false)
      .then(note => note && $.ui.toast(note, { timeoutMs: 8000 }))
      .catch(error => $.ui.log(`Studio Tree plugin install: ${String(error)}`, { to: 'debug' }))
    $.clock.every(20000, () => {
      void refreshAll($)
      void ensureTreeListener($)
    })
    return started
  })

  on('session.end', ($, e, next) => {
    served?.stop()
    treeListener?.stop()
    return next(e)
  })

  on('command.run', { command: 'studio' }, async ($, e) => {
    const [verb = '', arg] = e.args.trim().split(/\s+/)
    if (verb === 'serve') return { text: await serveHere($, arg) }
    if (verb === 'stop') return { text: await stopServer($, arg) }
    if (verb === 'drift') {
      const drift = await runDrift($)
      if (drift.error) return { text: drift.error }
      const off = drift.files.filter(f => f.status !== 'same')
      return {
        text: off.length
          ? `${off.length} of ${drift.files.length} files differ in ${drift.studioName}: ${off.map(f => `${f.file} (${f.status})`).join(', ')}`
          : `All ${drift.files.length} checked files match ${drift.studioName}.`,
      }
    }
    if (verb === 'saved') {
      await markSaved($)
      return { text: 'Marked every Studio edit as saved.' }
    }
    if (verb === 'refresh') {
      await refreshAll($)
      return { text: 'Refreshed Studio, Rojo and bridges.' }
    }
    if (verb === 'plugin') return { text: await installStudioPlugin($, true) }
    if (verb === 'band') {
      const hidden = !(await read($, isBandHidden))
      await update($, isBandHidden, () => hidden)
      return { text: hidden ? 'Band hidden.' : 'Band shown when something needs attention.' }
    }
    await openPane($)
    return { text: 'Studio pane opened.' }
  })

  on('tool.call', { tool: STUDIO_TOOL }, async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const short = shortTool(e.tool)
    if (short === 'list_roblox_studios') {
      const ran = await next(e)
      const text = resultText(ran)
      if (text) {
        const list = parseStudios(text)
        const known = await read($, studios)
        if (list.length) {
          await update($, studios, () => list.map(s => ({ ...s, mode: known.find(k => k.id === s.id)?.mode ?? null })))
        }
      }
      return ran
    }
    const studioId = typeof args.studio_id === 'string' ? args.studio_id : ''
    if (studioId) await update($, lastStudio, () => studioId)
    if (!isWriteCall(e.tool, args)) {
      const ran = await next(e)
      if (short === 'start_stop_play' || short === 'get_studio_state') void refreshStudios($).then(() => refreshStatus($))
      else void refreshStatus($)
      return ran
    }
    const studio = await resolveStudio($, studioId)
    const denied = await guard($, studio, studioId)
    if (denied) return { deny: denied }
    const ran = await next(e)
    if (studio && ran.deny === undefined && ran.isError !== true && persistsToPlace(args)) {
      await recordEdit($, studio, e.tool, summarize(e.tool, args))
    }
    return ran
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__bridge_command` }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const studioId = String(args.studio_id ?? '')
    const studio = await resolveStudio($, studioId)
    const denied = await guard($, studio, studioId)
    if (denied || !studio) return { deny: denied ?? 'roblox-studio-link: no Studio target.' }
    const timeout = Math.min(120, Math.max(1, Number(args.timeout_seconds ?? 20)))
    try {
      const text = await mcpText($, 'execute_luau', {
        studio_id: studio.id,
        datamodel_type: 'Server',
        code: bridgeLuau(String(args.harness), String(args.command), timeout),
      })
      return toolAnswer(text)
    } catch (error) {
      return toolAnswer(`Bridge call failed: ${String(error)}`, true)
    }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__tree_search` }, async ($, e) => {
    try {
      const { text, isError } = await treeSearch($, e as unknown as Record<string, unknown>)
      return toolAnswer(text, isError)
    } catch (error) {
      return toolAnswer(`Tree search failed: ${String(error)}`, true)
    }
  })

  on('turn.start', async ($, e, next) => {
    editsAtTurnStart = (await read($, edits)).length
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const list = await read($, edits)
    const fresh = list.slice(editsAtTurnStart).filter(edit => !edit.isSaved)
    if (fresh.length) {
      const places = [...new Set(fresh.map(edit => edit.placeName))].join(' and ')
      $.ui.toast(`Save ${places} in Studio: ${fresh.length} edit${fresh.length === 1 ? '' : 's'} this turn.`, { timeoutMs: 8000 })
    }
    return next(e)
  })

  // Text only: the band takes its focus on the first click, so a Button here would need two.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const lights = computeLights({
      studios: await read($, studios),
      lastStudio: await read($, lastStudio),
      rojo: await read($, rojo),
      edits: await read($, edits),
      bridges: await read($, bridges),
    })
    const entries = LIGHT_ORDER.map(([key, label]) => ({ key, label, light: lights[key] }))
    const worst = entries.reduce((a, b) => (LEVEL_RANK[b.light.level] > LEVEL_RANK[a.light.level] ? b : a))
    if (LEVEL_RANK[worst.light.level] < LEVEL_RANK.warn) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {entries.map(({ key, label, light }) => (
          <Text key={`light-${key}`} color={LEVEL_COLOR[light.level]}>
            ● <Text color={light.level === 'idle' ? 'gray' : undefined}>{label}</Text>
          </Text>
        ))}
        <Box flexGrow={1}>
          <Text color={LEVEL_COLOR[worst.light.level]} wrap="truncate-end">
            {worst.label}: {worst.light.summary}
          </Text>
        </Box>
        <Button key="open" label="/studio" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const list = await read($, studios)
    const lastId = await read($, lastStudio)
    const state = await read($, rojo)
    const editList = await read($, edits)
    const bridge = await read($, bridges)
    const lights = computeLights({ studios: list, lastStudio: lastId, rojo: state, edits: editList, bridges: bridge })
    const current = currentStudio(list, lastId)
    const unsaved = editList.filter(edit => !edit.isSaved)
    const isServingHere = state?.servers.some(s => s.isHere) ?? false

    const header = (key: string, label: string, light: Light, actions?: RenderChildren) => (
      <Box key={`head-${key}`} flexDirection="row" gap={1}>
        <Text color={LEVEL_COLOR[light.level]}>●</Text>
        <Text bold>{label.padEnd(8)}</Text>
        <Box flexGrow={1}>
          <Text color={light.level === 'ok' || light.level === 'idle' ? undefined : LEVEL_COLOR[light.level]} dimColor={light.level === 'idle'} wrap="truncate-end">
            {light.summary}
          </Text>
        </Box>
        {actions}
      </Box>
    )
    const muted = (key: string, text: string) => (
      <Text key={key} dimColor wrap="truncate-end">
        {text}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header('studio', 'Studio', lights.studio)}
          <Box flexDirection="column" paddingLeft={2}>
            {list.map(studio => (
              <Text key={`studio-${studio.id}`} dimColor={studio !== current} wrap="truncate-end">
                {studio === current ? '› ' : '  '}
                {(studio.mode ?? '').padEnd(7)}
                {placeName(studio)}
                {studio.placeId ? `  ${studio.placeId}` : ''}
              </Text>
            ))}
          </Box>
        </Box>

        <Box flexDirection="column">
          {header(
            'rojo',
            'Rojo',
            lights.rojo,
            state?.hasProject && (
              <Box flexDirection="row" gap={1}>
                {!isServingHere && (
                  <Box key="port-box" width={12} flexShrink={0}>
                    <Input
                      key="port"
                      placeholder={String(ROJO_PORT)}
                      onSubmit={value => void serveHere($, value).then(message => $.ui.toast(message, { timeoutMs: 6000 }))}
                    />
                  </Box>
                )}
                {!isServingHere && <Button key="serve" label="Serve here" hotkey="s" onPress={() => void serveHere($)} />}
                <Button key="drift" label="Drift" hotkey="d" onPress={() => void runDrift($)} />
              </Box>
            ),
          )}
          <Box flexDirection="column" paddingLeft={2}>
            {state?.servers.map(server => (
              <Box key={`server-${server.pid}`} flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Text dimColor={!server.isHere} wrap="truncate-end">
                    {`:${server.port}`.padEnd(8)}
                    {server.isHere ? 'this worktree' : baseName(server.root) || `pid ${server.pid}`}
                    {server.branch ? ` (${server.branch})` : ''}
                    {server.projectName ? ` · ${server.projectName}` : ''}
                    {server.isOurs ? ' · started here' : ''}
                  </Text>
                </Box>
                <Button key={`stop-${server.pid}`} label="Stop" onPress={() => void stopServer($, server.pid)} />
              </Box>
            ))}
            {state && !isServingHere && muted('here', `this worktree: ${baseName(state.here)}${state.branch ? ` (${state.branch})` : ''}`)}
            {state?.drift && driftLine(state.drift, Text)}
          </Box>
        </Box>

        <Box flexDirection="column">
          {header(
            'edits',
            'Edits',
            lights.edits,
            unsaved.length > 0 && <Button key="saved" label="Mark saved" hotkey="m" onPress={() => void markSaved($)} />,
          )}
          <Box flexDirection="column" paddingLeft={2}>
            {editList.slice(-8).map((edit, i) => (
              <Text key={`edit-${i}`} dimColor={edit.isSaved} wrap="truncate-end">
                {(edit.isSaved ? '  ' : '* ') + edit.placeName.padEnd(18)}
                {edit.summary}
              </Text>
            ))}
            {unsaved.length > 0 && muted('save-note', 'Save the place in Studio; edits made through MCP are not on disk until you do.')}
          </Box>
        </Box>

        <Box flexDirection="column">
          {header('bridges', 'Bridges', lights.bridges)}
          <Box flexDirection="column" paddingLeft={2}>
            {bridge?.harnesses.map(file => (
              <Text key={`harness-${file}`} color={bridge.stagedHarnesses.includes(file) ? 'red' : 'yellow'} wrap="truncate-end">
                {(bridge.stagedHarnesses.includes(file) ? 'staged  ' : 'harness ') + file}
              </Text>
            ))}
            {bridge?.servers.map(server => muted(`http-${server.pid}`, `${`:${server.port}`.padEnd(8)}http.server ${baseName(server.root) || `pid ${server.pid}`}`))}
          </Box>
        </Box>

        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refreshAll($)} />
          <Text dimColor>rechecks every 20 s</Text>
        </Box>
      </Box>
    )
  })
}
