export const ROJO_PORT = 34872

export type PathMapping = { fsPath: string; instance: string[] }

export function projectMappings(project: unknown): PathMapping[] {
  const out: PathMapping[] = []
  const walk = (node: unknown, instance: string[]) => {
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (typeof record.$path === 'string') {
      out.push({ fsPath: record.$path.replace(/^\.\//, '').replace(/\/$/, ''), instance })
    }
    for (const [key, child] of Object.entries(record)) {
      if (!key.startsWith('$')) walk(child, [...instance, key])
    }
  }
  walk((project as { tree?: unknown })?.tree, [])
  return out
}

export function instanceFor(file: string, mappings: PathMapping[]): string[] | null {
  if (!/\.luau?$/.test(file)) return null
  let best: PathMapping | null = null
  for (const mapping of mappings) {
    const covers = file === mapping.fsPath || file.startsWith(mapping.fsPath + '/')
    if (covers && (!best || mapping.fsPath.length > best.fsPath.length)) best = mapping
  }
  if (!best) return null
  if (file === best.fsPath) return best.instance
  const rest = file.slice(best.fsPath.length + 1).split('/')
  const last = rest.pop()!.replace(/(\.server|\.client)?\.luau?$/, '')
  return last === 'init' ? [...best.instance, ...rest] : [...best.instance, ...rest, last]
}

export function sourceLengthsLuau(paths: string[][]): string {
  return [
    '-- roblox-studio-link: read Source lengths to compare with the worktree',
    'local HttpService = game:GetService("HttpService")',
    `local items = HttpService:JSONDecode([==[${JSON.stringify(paths)}]==])`,
    'local out = {}',
    'for i, segments in items do',
    '\tlocal node = game',
    '\tfor _, name in segments do',
    '\t\tnode = node and node:FindFirstChild(name)',
    '\tend',
    '\tout[i] = if node and node:IsA("LuaSourceContainer") then #(node :: any).Source else -1',
    'end',
    'return HttpService:JSONEncode(out)',
  ].join('\n')
}

export function bridgeLuau(harness: string, command: string, timeoutSeconds: number): string {
  return [
    '-- roblox-studio-link: send a command to a Rojo-synced harness script',
    'local HttpService = game:GetService("HttpService")',
    `local args = HttpService:JSONDecode([==[${JSON.stringify({ harness, command })}]==])`,
    'local harness = game:GetService("ServerScriptService"):FindFirstChild(args.harness)',
    'if not harness then',
    '\treturn HttpService:JSONEncode({ error = "No ServerScriptService." .. args.harness .. ". Is play running and the harness synced?" })',
    'end',
    'if harness:GetAttribute("Command") == args.command then',
    '\treturn HttpService:JSONEncode({ error = "Command is already set to that value; vary it so the harness runs again." })',
    'end',
    'local seq = harness:GetAttribute("Seq")',
    'harness:SetAttribute("Command", args.command)',
    `local deadline = os.clock() + ${timeoutSeconds}`,
    'while harness:GetAttribute("Seq") == seq and os.clock() < deadline do',
    '\ttask.wait(0.1)',
    'end',
    'local result = harness:GetAttribute("Result")',
    'return HttpService:JSONEncode({ seq = harness:GetAttribute("Seq"), result = result, timedOut = harness:GetAttribute("Seq") == seq })',
  ].join('\n')
}

export function rojoServeLines(ps: string): { pid: string; port: number }[] {
  return ps.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) return []
    const pid = match[1]!
    const command = match[2]!
    if (!/(^|\/)rojo(\s|$)/.test(command) || !/\sserve(\s|$)/.test(command)) return []
    const port = Number(/--port[=\s]+(\d+)/.exec(command)?.[1] ?? ROJO_PORT)
    return [{ pid, port }]
  })
}

export function httpServerLines(ps: string): { pid: string; port: string }[] {
  return ps.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const command = match?.[2]
    if (!match || !command || !/-m\s+http\.server/.test(command)) return []
    return [{ pid: match[1]!, port: /http\.server\s+(\d+)/.exec(command)?.[1] ?? '8000' }]
  })
}

export function isHarnessSource(source: string): boolean {
  return /IsStudio\s*\(/.test(source) && /GetAttribute(ChangedSignal)?\(\s*["']Command["']/.test(source)
}
