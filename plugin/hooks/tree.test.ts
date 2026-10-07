import { describe, expect, test } from 'claude-code/testing'

import { formatResults, grepArgs, makeQuery, normalizeName, parseHeader, search } from './tree'

const TREE = [
  '# studio-tree 1\tplace=111\tname=My Game\tat=1000\tcount=6',
  'StarterGui\tStarterGui\t2',
  'StarterGui.MainHUD\tScreenGui\t1',
  'StarterGui.MainHUD.Hotbar\tFrame\t3',
  'StarterGui.BookMenu\tScreenGui\t1',
  'StarterGui.BookMenu.Book.Perks.HotbarSlots\tFrame\t3',
  'ServerStorage.Maps.Diner\tModel\t40',
].join('\n')

// path, class, children, depth, nameLen, tags, attrs, text, lines
const row = (path: string, className: string, children: number, extra: Partial<{ tags: string; attrs: string; text: string; lines: number }> = {}) => {
  const name = path.slice(path.lastIndexOf('.') + 1)
  return [path, className, children, path.split('.').length, name.length, extra.tags ?? '', extra.attrs ?? '', extra.text ?? '', extra.lines ?? ''].join('\t')
}

const TREE2 = [
  '# studio-tree 2\tplace=222\tname=Cafe\tat=2000\tcount=9',
  row('StarterGui', 'StarterGui', 1),
  row('StarterGui.Shop', 'ScreenGui', 3),
  row('StarterGui.Shop.BuyButton', 'TextButton', 0, { text: 'Buy now', tags: 'Interactable,Shop' }),
  row('StarterGui.Shop.HotbarSlot', 'Frame', 1, { attrs: 'Slot' }),
  row('StarterGui.Shop.HotbarSlot.Icon', 'ImageLabel', 0),
  row('ServerScriptService.Main', 'Script', 0, { lines: 120 }),
  row('ServerScriptService.Util', 'ModuleScript', 0, { lines: 30 }),
  row('Workspace.Slot_floor_1', 'Part', 0),
  row('Workspace.Slot_floor_2', 'Part', 0),
  row('Workspace.Slot_floor_3', 'Part', 0),
  row('Workspace.Slot_floor_10', 'Part', 0),
].join('\n')

const paths = (found: { rows: { path: string }[] }) => found.rows.map(r => r.path)

describe('searching a tree snapshot', () => {
  test('class_name alone searches at any depth, under alone lists children', async () => {
    expect(makeQuery({ class_name: 'Frame' }).depth).toBe(null)
    expect(makeQuery({ under: 'StarterGui', class_name: 'Frame' }).depth).toBe(null)
    expect(makeQuery({ under: 'StarterGui' }).depth).toBe(1)
  })

  test('a query matches names at any depth, not their ancestors', async () => {
    const found = search(TREE, makeQuery({ query: 'hotbar' }))
    expect(paths(found)).toEqual(['StarterGui.MainHUD.Hotbar', 'StarterGui.BookMenu.Book.Perks.HotbarSlots'])
  })

  test('under without a query lists children only', async () => {
    const found = search(TREE, makeQuery({ under: 'StarterGui' }))
    expect(paths(found)).toEqual(['StarterGui.MainHUD', 'StarterGui.BookMenu'])
  })

  test('under, class and limit combine', async () => {
    const found = search(TREE, makeQuery({ under: 'game.StarterGui.BookMenu', class_name: 'Frame', depth: 10, limit: 1 }))
    expect(found.total).toBe(1)
    expect(found.rows[0]?.path).toBe('StarterGui.BookMenu.Book.Perks.HotbarSlots')
  })

  test('a sibling with a longer name is not under', async () => {
    const found = search(`${TREE}\nStarterGuiExtra.X\tFrame\t0`, makeQuery({ under: 'StarterGui', depth: 5 }))
    expect(found.rows.some(r => r.path.startsWith('StarterGuiExtra'))).toBe(false)
  })

  test('results lead with the place and the snapshot age', async () => {
    const header = parseHeader(TREE.split('\n')[0]!)
    const text = formatResults(header, '111', search(TREE, makeQuery({ query: 'diner' })), false, 1000 * 1000 + 120000)
    expect(text.split('\n')[0]).toBe('My Game (place 111), snapshot from 2 min ago, 6 instances. 1 matches.')
    expect(text.split('\n')[1]).toBe('ServerStorage.Maps.Diner  Model  (40 children)')
  })
})

describe('matching and ranking names', () => {
  test('camelCase, snake_case and spaced names normalise alike', async () => {
    expect(normalizeName('HotbarSlot')).toBe('hotbar slot')
    expect(normalizeName('C4 Hotbar slot')).toBe('c4 hotbar slot')
    expect(normalizeName('Slot_floor_8')).toBe('slot floor 8')
    expect(normalizeName('HTTPServer')).toBe('http server')
  })

  test('a spaced query finds a camelCase name, best match first', async () => {
    const found = search(TREE2, makeQuery({ query: 'hotbar slot' }))
    expect(found.rows[0]?.path).toBe('StarterGui.Shop.HotbarSlot')
  })

  test('exact beats prefix beats substring', async () => {
    const text = [row('A.Slotted', 'Part', 0), row('A.Slot', 'Part', 0), row('A.Backslot', 'Part', 0), row('A.Slot_two', 'Part', 0)].join('\n')
    expect(paths(search(text, makeQuery({ query: 'slot' })))).toEqual(['A.Slot', 'A.Slotted', 'A.Slot_two', 'A.Backslot'])
  })

  test('all requires every word, prefix and exact narrow it', async () => {
    expect(paths(search(TREE2, makeQuery({ query: 'hotbar icon', match: 'all' })))).toEqual([])
    expect(paths(search(TREE2, makeQuery({ query: 'hotbar buy', match: 'any' }))).length).toBe(2)
    expect(paths(search(TREE2, makeQuery({ query: 'hot', match: 'prefix' })))).toEqual(['StarterGui.Shop.HotbarSlot'])
    expect(paths(search(TREE2, makeQuery({ query: 'hot', match: 'exact' })))).toEqual([])
  })

  test('regex matches the name, not the whole path', async () => {
    expect(paths(search(TREE2, makeQuery({ query: '^Buy', match: 'regex' })))).toEqual(['StarterGui.Shop.BuyButton'])
    expect(paths(search(TREE2, makeQuery({ query: '(', match: 'regex' }))).length).toBe(0)
  })

  test('dots in a name do not break depth or the name', async () => {
    const text = [row('A', 'Folder', 1), `A.janitor@1.18.3\tFolder\t0\t2\t15\t\t\t\t`].join('\n')
    expect(paths(search(text, makeQuery({ under: 'A' })))).toEqual(['A.janitor@1.18.3'])
    expect(paths(search(text, makeQuery({ query: 'janitor' })))).toEqual(['A.janitor@1.18.3'])
  })
})

describe('class families, tags, attributes and text', () => {
  test('instance_type families expand like IsA', async () => {
    expect(paths(search(TREE2, makeQuery({ class_name: 'BaseScript' })))).toEqual(['ServerScriptService.Main'])
    expect(paths(search(TREE2, makeQuery({ class_name: 'LuaSourceContainer' }))).length).toBe(2)
    expect(paths(search(TREE2, makeQuery({ class_name: 'GuiObject' }))).length).toBe(3)
    expect(search(TREE2, makeQuery({ class_name: 'Part, ModuleScript' })).total).toBe(5)
  })

  test('tag, attribute and text filters read the version 2 columns', async () => {
    expect(paths(search(TREE2, makeQuery({ tag: 'interactable' })))).toEqual(['StarterGui.Shop.BuyButton'])
    expect(paths(search(TREE2, makeQuery({ attribute: 'slot' })))).toEqual(['StarterGui.Shop.HotbarSlot'])
    expect(paths(search(TREE2, makeQuery({ text: 'buy' })))).toEqual(['StarterGui.Shop.BuyButton'])
  })

  test('rows show what a filter matched, details shows everything', async () => {
    const header = parseHeader(TREE2.split('\n')[0]!)
    const out = formatResults(header, '222', search(TREE2, makeQuery({ text: 'buy' })), false, 2000 * 1000)
    expect(out.split('\n')[1]).toBe('StarterGui.Shop.BuyButton  TextButton  "Buy now"')
    const tagged = formatResults(header, '222', search(TREE2, makeQuery({ tag: 'shop' })), false, 2000 * 1000)
    expect(tagged.split('\n')[1]).toBe('StarterGui.Shop.BuyButton  TextButton  #Interactable #Shop')
    const plain = formatResults(header, '222', search(TREE2, makeQuery({ class_name: 'Script' })), false, 2000 * 1000)
    expect(plain.split('\n')[1]).toBe('ServerScriptService.Main  Script')
    const all = formatResults(header, '222', search(TREE2, makeQuery({ class_name: 'Script', details: true })), false, 2000 * 1000)
    expect(all.split('\n')[1]).toBe('ServerScriptService.Main  Script  120 lines')
  })
})

describe('folding and grouping results', () => {
  test('a better match below a weaker one is not hidden', async () => {
    const text = [row('A.S8 Table', 'Frame', 1), row('A.S8 Table.Specimens', 'Frame', 1), row('A.S8 Table.Specimens.PerkTable', 'Frame', 0)].join('\n')
    const found = search(text, makeQuery({ query: 'perk table' }))
    expect(found.rows[0]?.path).toBe('A.S8 Table.Specimens.PerkTable')
    expect(paths(found).includes('A.S8 Table')).toBe(true)
  })

  test('numbered siblings collapse into one line', async () => {
    const header = parseHeader(TREE2.split('\n')[0]!)
    const found = search(TREE2, makeQuery({ query: 'slot floor', match: 'all' }))
    expect(found.total).toBe(4)
    expect(found.items).toBe(1)
    expect(formatResults(header, '222', found, false, 2000 * 1000)).toContain('Workspace.Slot_floor_#  Part  x4  (Slot_floor_1 .. Slot_floor_10)')
    expect(search(TREE2, makeQuery({ query: 'slot floor', match: 'all', fold: false })).items).toBe(4)
  })

  test('matches below a match fold into it', async () => {
    const text = [row('A.Hotbar', 'Frame', 2), row('A.Hotbar.HotbarSlot', 'Frame', 0), row('A.Hotbar.Hotbar2', 'Frame', 0)].join('\n')
    const found = search(text, makeQuery({ query: 'hotbar' }))
    expect(paths(found)).toEqual(['A.Hotbar'])
    expect(found.rows[0]?.folded).toBe(2)
    expect(found.total).toBe(3)
  })

  test('group_by counts instead of listing', async () => {
    const found = search(TREE2, makeQuery({ under: 'Workspace', depth: 3, group_by: 'class' }))
    expect(found.counts).toEqual([['Part', 4]])
    expect(found.rows).toEqual([])
  })
})

describe('prefiltering with grep', () => {
  test('words come first, then text, tag, attribute, class and under', async () => {
    expect(grepArgs(makeQuery({ query: 'a, b' }), 'f')).toEqual(['grep', '-m', '100000', '-i', '-F', '-e', 'a', '-e', 'b', '--', 'f'])
    expect(grepArgs(makeQuery({ text: 'Buy' }), 'f')).toEqual(['grep', '-m', '100000', '-i', '-F', '-e', 'buy', '--', 'f'])
    expect(grepArgs(makeQuery({ class_name: 'Script' }), 'f')).toEqual(['grep', '-m', '100000', '-i', '-E', '-e', '\t(script)\t', '--', 'f'])
    expect(grepArgs(makeQuery({ under: 'Workspace' }), 'f')).toEqual(['grep', '-m', '100000', '-E', '-e', '^Workspace[.\t]', '--', 'f'])
    expect(grepArgs(makeQuery({ query: '^a', match: 'regex' }), 'f')).toEqual(['grep', '-m', '100000', '-v', '-e', '^#', '--', 'f'])
    expect(grepArgs(makeQuery({}), 'f')).toBe(null)
  })
})
