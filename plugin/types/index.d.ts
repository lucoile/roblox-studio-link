export type StudioTarget = {
  id: string
  name: string
  placeId: string | null
  mode: string | null
}

export type RojoServer = {
  pid: string
  port: number
  root: string
  branch: string
  projectName: string | null
  expectedPlaceIds: string[]
  isHere: boolean
  isOurs: boolean
}

export type DriftFile = {
  file: string
  status: 'same' | 'differs' | 'missing'
}

export type Drift = {
  checkedAt: number
  studioName: string
  files: DriftFile[]
  error: string | null
}

export type RojoState = {
  checkedAt: number
  here: string
  branch: string
  hasProject: boolean
  servers: RojoServer[]
  drift: Drift | null
}

export type PlaceEdit = {
  at: number
  studioId: string
  placeName: string
  tool: string
  summary: string
  isSaved: boolean
}

export type BridgeServer = { pid: string; port: string; root: string }

export type BridgeState = {
  harnesses: string[]
  stagedHarnesses: string[]
  servers: BridgeServer[]
}

declare module 'claude-code' {
  interface PluginState {
    'roblox-studio-link': {
      studios: StudioTarget[]
      lastStudio: string
      approved: string[]
      rojo: RojoState | null
      edits: PlaceEdit[]
      bridges: BridgeState | null
      isBandHidden: boolean
    }
  }
}
