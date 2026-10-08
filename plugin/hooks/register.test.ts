import { describe, expect, test } from 'claude-code/testing'

import { instanceFor, isHarnessSource, projectMappings, rojoServeLines } from './rojo'
import { computeLights } from './status'
import { isWriteCall, luauWrites, parseStudios, shouldClearStudios, toolAnswer } from './studio'

const ONE_STUDIO = JSON.stringify({ studios: [{ id: 'a-1', name: 'My Game (placeId: 111)' }] })

describe('classifying Studio calls', () => {
  test('reads are not writes', async () => {
    expect(luauWrites('local m = game.ReplicatedStorage.Globals.Flags\nreturn #m.Source')).toBe(false)
    expect(luauWrites('return workspace:FindFirstChild("Cafe") ~= nil')).toBe(false)
    expect(isWriteCall('mcp__x__script_read', {})).toBe(false)
  })

  test('property sets, destroys and inserts are writes', async () => {
    expect(luauWrites('workspace.Cafe.Counter.Color = Color3.new(1, 0, 0)')).toBe(true)
    expect(luauWrites('game.StarterGui.MainHUD:Destroy()')).toBe(true)
    expect(luauWrites('local p = Instance.new("Part")')).toBe(true)
    expect(luauWrites('-- workspace.X = 1 only in a comment\nreturn 1')).toBe(false)
    expect(isWriteCall('mcp__x__multi_edit', {})).toBe(true)
    expect(isWriteCall('mcp__x__subagent', { subagent_type: 'explore' })).toBe(false)
  })

  test('studios carry their place id and no role', async () => {
    expect(parseStudios(ONE_STUDIO)).toEqual([{ id: 'a-1', name: 'My Game (placeId: 111)', placeId: '111', mode: null }])
  })
})

describe('mapping files to instances', () => {
  const mappings = projectMappings({
    tree: {
      ReplicatedStorage: { Globals: { $path: 'src/ReplicatedStorage/Globals' } },
      ServerScriptService: { $path: 'src/ServerScriptService' },
    },
  })

  test('scripts and init modules', async () => {
    expect(instanceFor('src/ReplicatedStorage/Globals/Flags.luau', mappings)).toEqual(['ReplicatedStorage', 'Globals', 'Flags'])
    expect(instanceFor('src/ServerScriptService/Systems/Admin/init.luau', mappings)).toEqual(['ServerScriptService', 'Systems', 'Admin'])
    expect(instanceFor('src/ServerScriptService/Probe.server.luau', mappings)).toEqual(['ServerScriptService', 'Probe'])
    expect(instanceFor('docs/x.md', mappings)).toBe(null)
  })

  test('a rokit shim and its rojo child are one server', async () => {
    const ps = [
      '84107 83888 rojo serve --port 34872',
      '84108 84107 /Users/me/.rokit/tool-storage/rojo-rbx/rojo/7.7.0/rojo serve --port 34872',
      '90000 1 rojo serve --port 34873',
    ].join('\n')
    expect(rojoServeLines(ps)).toEqual([
      { pid: '84108', port: 34872 },
      { pid: '90000', port: 34873 },
    ])
  })

  test('harness detection', async () => {
    const harness = 'if RunService:IsStudio() then script:GetAttributeChangedSignal("Command"):Connect(run) end'
    expect(isHarnessSource(harness)).toBe(true)
    expect(isHarnessSource('print("hi")')).toBe(false)
  })
})

describe('edits and the pane', () => {
  test('an Edit-mode write is recorded and drawn', async ($, on) => {
    on('tool.call', { tool: 'mcp__Roblox_Studio__list_roblox_studios' }, () => ({
      result: { content: [{ type: 'text', text: ONE_STUDIO }] },
    }))
    on('tool.call', { tool: 'mcp__Roblox_Studio__multi_edit' }, () => ({
      result: { content: [{ type: 'text', text: 'ok' }] },
    }))
    await $.tool.call({ tool: 'mcp__Roblox_Studio__list_roblox_studios' })
    const edit = { file_path: 'game.ServerScriptService.X', edits: [], datamodel_type: 'Edit' }
    const done = await $.tool.call({ tool: 'mcp__Roblox_Studio__multi_edit', studio_id: 'a-1', ...edit })
    expect(done.deny).toBeUndefined()

    const unlisted = await $.tool.call({ tool: 'mcp__Roblox_Studio__multi_edit', studio_id: 'nope', ...edit })
    expect(String(unlisted.deny)).toContain("isn't in list_roblox_studios")

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({
        plugin: 'roblox-studio-link',
        surface,
        component: 'Pane',
        requestId: 'roblox-studio-link',
        props: { title: 'Studio', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      })
      expect(await pane.find({ type: 'Text', text: /\* My Game\s+edited game\.ServerScriptService\.X/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '1 unsaved · My Game' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'saved' })).toBeDefined()
      await pane.unmount()

      const band = await $.ui.mount({
        plugin: 'roblox-studio-link',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
      })
      expect(await band.find({ type: 'Text', text: 'Edits: 1 unsaved · My Game' })).toBeDefined()
      await band.unmount()
    }
  })
})

describe('answering as a registered tool', () => {
  test('a string result, or a deny for an error, never a content object', async () => {
    expect(toolAnswer('rows')).toEqual({ result: 'rows' })
    expect(toolAnswer('no snapshot', true)).toEqual({ deny: 'no snapshot' })
  })
})

describe('keeping the Studio list', () => {
  const minute = 60 * 1000
  test('failed listings alone never clear it; only many failures after a long silence do', async () => {
    expect(shouldClearStudios(1, 0, 100 * minute)).toBe(false)
    expect(shouldClearStudios(40, 100 * minute, 101 * minute)).toBe(false)
    expect(shouldClearStudios(40, 0, 100 * minute)).toBe(true)
  })
})

describe('status lights', () => {
  const studio = { id: 'a-1', name: 'My Game (placeId: 111)', placeId: '111', mode: null }
  const base = { studios: [studio], lastStudio: studio.id, rojo: null, edits: [], bridges: null }
  const server = (isHere: boolean, expectedPlaceIds: string[] = []) => ({
    pid: '1',
    port: 34873,
    root: isHere ? '/w/game' : '/w/other',
    branch: '',
    projectName: null,
    expectedPlaceIds,
    isHere,
    isOurs: false,
  })
  const rojoState = (servers: ReturnType<typeof server>[]) => ({ checkedAt: 0, here: '/w/game', branch: 'main', hasProject: true, servers, drift: null })

  test('each function gets a level', async () => {
    expect(computeLights({ ...base, studios: [] }).studio.level).toBe('idle')
    expect(computeLights(base).studio).toEqual({ level: 'ok', summary: 'My Game' })
    expect(computeLights({ ...base, studios: [studio, { ...studio, id: 'b-2' }], lastStudio: '' }).studio.level).toBe('warn')
    expect(computeLights({ ...base, rojo: rojoState([]) }).rojo).toEqual({ level: 'warn', summary: 'not serving' })
    expect(computeLights({ ...base, rojo: { ...rojoState([]), hasProject: false } }).rojo.level).toBe('idle')
    expect(computeLights({ ...base, rojo: rojoState([server(true)]) }).rojo).toEqual({ level: 'ok', summary: 'serving here :34873' })
    expect(computeLights({ ...base, rojo: rojoState([server(false)]) }).rojo).toEqual({ level: 'warn', summary: 'serving other :34873' })
    expect(computeLights({ ...base, rojo: rojoState([server(true, ['222'])]) }).rojo.level).toBe('warn')
    expect(computeLights({ ...base, rojo: rojoState([server(true, ['111'])]) }).rojo.level).toBe('ok')
    const bridges = { harnesses: ['src/Probe.server.luau'], stagedHarnesses: [], servers: [] }
    expect(computeLights({ ...base, bridges }).bridges.level).toBe('warn')
    expect(computeLights({ ...base, bridges: { ...bridges, stagedHarnesses: bridges.harnesses } }).bridges.level).toBe('error')
  })
})
