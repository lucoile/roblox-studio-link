import type { BridgeState, PlaceEdit, RojoState, StudioTarget } from '../types'
import { placeName } from './studio'

export type Level = 'ok' | 'warn' | 'error' | 'idle'

export type Light = { level: Level; summary: string }

export type Lights = { studio: Light; rojo: Light; edits: Light; bridges: Light }

export const LEVEL_COLOR: Record<Level, string> = {
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  idle: 'gray',
}

export const LEVEL_RANK: Record<Level, number> = { idle: 0, ok: 1, warn: 2, error: 3 }

export type LightInput = {
  studios: StudioTarget[]
  lastStudio: string
  rojo: RojoState | null
  edits: PlaceEdit[]
  bridges: BridgeState | null
}

export function currentStudio(studios: StudioTarget[], lastStudio: string): StudioTarget | null {
  return studios.find(s => s.id === lastStudio) ?? (studios.length === 1 ? studios[0]! : null)
}

export function computeLights(input: LightInput): Lights {
  return {
    studio: studioLight(input),
    rojo: rojoLight(input),
    edits: editsLight(input),
    bridges: bridgesLight(input),
  }
}

function studioLight({ studios, lastStudio }: LightInput): Light {
  if (studios.length === 0) return { level: 'idle', summary: 'no Studio connected' }
  const current = currentStudio(studios, lastStudio)
  if (!current) return { level: 'warn', summary: `${studios.length} open, none targeted yet` }
  const mode = current.mode ? ` · ${current.mode.toLowerCase()}` : ''
  const others = studios.length > 1 ? ` · ${studios.length} open` : ''
  return { level: 'ok', summary: `${placeName(current)}${mode}${others}` }
}

function rojoLight({ rojo, studios, lastStudio }: LightInput): Light {
  if (!rojo) return { level: 'idle', summary: 'checking' }
  if (!rojo.hasProject) return { level: 'idle', summary: 'no Rojo project here' }
  const here = rojo.servers.find(s => s.isHere)
  if (here) {
    const current = currentStudio(studios, lastStudio)
    if (current?.placeId && here.expectedPlaceIds.length > 0 && !here.expectedPlaceIds.includes(current.placeId)) {
      return { level: 'warn', summary: `serving here :${here.port} · project expects a different place than ${placeName(current)}` }
    }
    const off = rojo.drift?.files.filter(f => f.status !== 'same').length ?? 0
    if (off > 0) return { level: 'warn', summary: `serving here :${here.port} · ${off} file${off === 1 ? '' : 's'} differ` }
    return { level: 'ok', summary: `serving here :${here.port}` }
  }
  const other = rojo.servers[0]
  if (other) return { level: 'warn', summary: `serving ${baseName(other.root) || `pid ${other.pid}`} :${other.port}` }
  return studios.length > 0 ? { level: 'warn', summary: 'not serving' } : { level: 'idle', summary: 'not serving' }
}

function editsLight({ edits }: LightInput): Light {
  if (edits.length === 0) return { level: 'idle', summary: 'none this session' }
  const unsaved = edits.filter(e => !e.isSaved)
  if (unsaved.length === 0) return { level: 'ok', summary: `${edits.length} saved` }
  const places = [...new Set(unsaved.map(e => e.placeName))].join(', ')
  return { level: 'warn', summary: `${unsaved.length} unsaved · ${places}` }
}

function bridgesLight({ bridges }: LightInput): Light {
  if (!bridges) return { level: 'idle', summary: 'checking' }
  if (bridges.stagedHarnesses.length) return { level: 'error', summary: 'harness staged for commit' }
  if (bridges.harnesses.length) {
    return { level: 'warn', summary: `${bridges.harnesses.length} harness${bridges.harnesses.length === 1 ? '' : 'es'} in the tree` }
  }
  if (bridges.servers.length) {
    return { level: 'ok', summary: `${bridges.servers.length} source server${bridges.servers.length === 1 ? '' : 's'}` }
  }
  return { level: 'idle', summary: 'none' }
}

export function baseName(path: string): string {
  return path.replace(/\/$/, '').split('/').pop() ?? path
}
