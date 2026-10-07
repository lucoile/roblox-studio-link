import { describe, expect, test } from 'claude-code/testing'

import { formatResults, grepArgs, makeQuery, parseHeader, search } from './tree'

const TREE = [
  '# studio-tree 1\tplace=111\tname=My Game\tat=1000\tcount=6',
  'StarterGui\tStarterGui\t2',
  'StarterGui.MainHUD\tScreenGui\t1',
  'StarterGui.MainHUD.Hotbar\tFrame\t3',
  'StarterGui.BookMenu\tScreenGui\t1',
  'StarterGui.BookMenu.Book.Perks.HotbarSlots\tFrame\t3',
  'ServerStorage.Maps.Diner\tModel\t40',
].join('\n')

describe('searching a tree snapshot', () => {
  test('class_name alone searches at any depth, under alone lists children', async () => {
    expect(makeQuery({ class_name: 'Frame' }).depth).toBe(null)
    expect(makeQuery({ under: 'StarterGui', class_name: 'Frame' }).depth).toBe(null)
    expect(makeQuery({ under: 'StarterGui' }).depth).toBe(1)
  })

  test('a query matches names at any depth, not their ancestors', async () => {
    const found = search(TREE, makeQuery({ query: 'hotbar' }))
    expect(found.rows.map(row => row.path)).toEqual(['StarterGui.MainHUD.Hotbar', 'StarterGui.BookMenu.Book.Perks.HotbarSlots'])
  })

  test('under without a query lists children only', async () => {
    const found = search(TREE, makeQuery({ under: 'StarterGui' }))
    expect(found.rows.map(row => row.path)).toEqual(['StarterGui.MainHUD', 'StarterGui.BookMenu'])
  })

  test('under, class and limit combine', async () => {
    const found = search(TREE, makeQuery({ under: 'game.StarterGui.BookMenu', class_name: 'Frame', depth: 10, limit: 1 }))
    expect(found.total).toBe(1)
    expect(found.rows[0]?.path).toBe('StarterGui.BookMenu.Book.Perks.HotbarSlots')
  })

  test('a sibling with a longer name is not under', async () => {
    const found = search(`${TREE}\nStarterGuiExtra.X\tFrame\t0`, makeQuery({ under: 'StarterGui', depth: 5 }))
    expect(found.rows.some(row => row.path.startsWith('StarterGuiExtra'))).toBe(false)
  })

  test('grep prefilters by words, then under, then class', async () => {
    expect(grepArgs(makeQuery({ query: 'a, b' }), 'f')).toEqual(['grep', '-m', '20000', '-i', '-F', '-e', 'a', '-e', 'b', '--', 'f'])
    expect(grepArgs(makeQuery({ under: 'Workspace' }), 'f')).toEqual(['grep', '-m', '20000', '-F', '-e', 'Workspace', '--', 'f'])
    expect(grepArgs(makeQuery({}), 'f')).toBe(null)
  })

  test('results lead with the place and the snapshot age', async () => {
    const header = parseHeader(TREE.split('\n')[0]!)
    const text = formatResults(header, '111', search(TREE, makeQuery({ query: 'diner' })), false, 1000 * 1000 + 120000)
    expect(text.split('\n')[0]).toBe('My Game (place 111), snapshot from 2 min ago, 6 instances. 1 matches.')
    expect(text.split('\n')[1]).toBe('ServerStorage.Maps.Diner  Model  (40 children)')
  })
})
