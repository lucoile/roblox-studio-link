# roblox-studio-link

Claude Code mod for Roblox projects that use Rojo and the Roblox Studio MCP server.

## Install

```
claude plugin marketplace add lucoile/roblox-studio-link
claude plugin install roblox-studio-link@roblox-studio-link
```

Then restart Claude Code and run `/studio`.

Needs a Claude Code build with mods (plugin hooks modules) and the Roblox Studio MCP server connected.


No setup for the pane: everything is read from the Studio MCP server, `ps`, `lsof`, `git`, Rojo's `/api/rojo` and your `default.project.json`.

## Use it

`/studio` opens the pane. Click a button once, or press its letter (`s` serve, `d` drift,
`m` mark saved, `r` refresh). The pane rechecks every 20 s.

| Command | Does |
| --- | --- |
| `/studio serve` | `rojo serve` from this worktree on the first free port from 34872 |
| `/studio stop [pid]` | Stops this worktree's server, or the one with that pid |
| `/studio drift` | Compares the Source of your changed scripts with the Studio copy |
| `/studio saved` | Marks every Studio edit as saved |
| `/studio refresh` | Rechecks everything now |
| `/studio plugin` | Rebuilds and installs the Studio Tree plugin |
| `/studio band` | Hides or shows the band above the prompt |

## What it shows

- **Studio**: every open Studio with its mode (Edit/Play) and place id. The status line
  names the one Claude last targeted.
- **Rojo**: every `rojo serve` running on the machine, with worktree, branch, port and
  project name. Warns when the server isn't yours, or when the project expects a different
  place id than the Studio Claude targets.
- **Edits**: Studio writes Claude made through MCP, by place, with a toast at the end of a
  turn that changed a place to save it.
- **Bridges**: new `*.server.luau` / `*.client.luau` scripts that check `IsStudio()` and
  read a `Command` attribute (a test harness), and `python3 -m http.server` source servers.
  Red when a harness is staged for commit.

The band above the prompt appears only when a light is yellow or red.

## Guard and tool

- Writes to a Studio that isn't in `list_roblox_studios` are refused.
- When more than one Studio is open, the first write to each asks once
  (`Allow once`, `Allow for this session`, `Block`). With one Studio open it never asks.
- `bridge_command` (tool) sets a harness's `Command` attribute and waits for `Seq`,
  returning `Result`. Needs play mode.

The `execute_luau` write check is a pattern match on the code, so it errs towards asking.

## Tree search

A Studio plugin keeps a snapshot of each open place's instance tree on disk, and the
`tree_search` tool searches it. It needs no Studio round trip, answers when Studio is busy,
and returns fewer tokens than `search_game_tree` (numbers below).

```
Studio Tree plugin --HTTP--> listener (127.0.0.1:34950) --> ~/.claude/studio-tree/<placeId>.tsv <-- tree_search
```

The link between the mod and Studio is set up for you: the mod builds and installs the Studio
plugin and starts the listener, so after the first Studio restart there is nothing to configure.

- **Studio Tree plugin** (`plugin/studio-plugin/`): sends the tree from edit mode when the
  place loads. After that, adds and removes re-send only the top-level instance they happened
  in (for example `ServerStorage.UIKit`), 3 s after the changes stop. Renames, moves, undo and
  the **Send tree** toolbar button re-send everything, and so does a delta that comes more than
  5 minutes after the last full send. It yields while it walks, so a 37k-instance place
  (0.6 s) doesn't hitch Studio. The mod installs it at session start with
  `rojo build --plugin StudioTree.rbxm`, again whenever its source changes, and on
  `/studio plugin`. Without `rojo` on PATH it says so and gives the command. The first send
  asks to allow HTTP to `127.0.0.1`; allow it. Restart Studio once after an update.
- **Listener** (`plugin/listener/tree_listener.py`, needs `python3`): the mod starts it on
  `127.0.0.1:34950` and writes `~/.claude/studio-tree/<placeId>.tsv`, patching it for deltas.
  One runs per machine; other sessions use it, so restart any session still running an older
  listener. Studio retries every 15 s while it is down, so a tree edited with Claude Code
  closed arrives when it opens.
- **`tree_search`** (tool): see below.

A snapshot row is tab separated: `path, ClassName, childCount, depth, nameLength, tags,
attributes, text, lines`. `depth` and `nameLength` keep paths exact when a name contains a dot;
`tags` are CollectionService tags, `attributes` the attribute names, `text` the first 60
characters of a TextLabel, TextButton or TextBox, and `lines` the line count of a script.
`Grep` works on the file too. It is for finding things: confirm with `inspect_instance` before
a write.

### Searching

| Argument | Does |
| --- | --- |
| `query` | Instance names, case-insensitive and camelCase aware (`hotbar slot` finds `HotbarSlot`). Several words match any of them; best match first (exact, prefix, word, substring) |
| `match` | `any` (default), `all`, `exact`, `prefix` or `regex` |
| `under` | Dot path to search under. With `under` alone it lists children; any filter makes it search every level |
| `class_name` | Class names or families, comma separated: `BaseScript`, `LuaSourceContainer`, `GuiObject`, `BasePart`, `ValueBase`, `UIComponent`... (what `instance_type` does in `search_game_tree`) |
| `tag`, `attribute`, `text` | CollectionService tag, part of an attribute name, part of a text GUI's `Text` |
| `depth` | Levels below `under` |
| `fold` | On by default: numbered siblings (`Slot_floor_1` to `Slot_floor_200`) become one line, and matches below a match count on it unless they match better |
| `group_by` | `class` or `parent`: counts instead of rows |
| `details` | Show tags, attribute names, text and script lines on every row; otherwise only what a filter matched |
| `limit` | Rows to return, 50 by default, 500 at most |

The answer starts with the snapshot's age, and the tool defaults to the Studio Claude last
targeted.

### Token savings

Measured on a 37,070-instance place (Cafe Story PTR) against `search_game_tree` called the way
an agent would (`keywords`, `instance_type`, `path`, `max_depth`; its cap is 200 nodes). Sizes
are the characters of the tool result; tokens are about chars / 4. Both tools truncate broad
results, so the last column says how much of the answer each one shows.

| Task | `search_game_tree` | `tree_search` | Shown by `tree_search` |
| --- | --- | --- | --- |
| find `hotbar` anywhere | 2,056 | 1,326 | all 15 |
| find `hotbar slot` anywhere | 27,105 (capped) | 4,514 | 526 of 543 matches |
| ModuleScript named `janitor` | 473 | 267 | all 3 |
| children of `StarterGui.MainHUD` | 1,125 | 364 | all 6 |
| every `ScreenGui` | 3,205 | 1,687 | all 25 |
| every ModuleScript in `ServerScriptService` | 26,134 (capped) | 3,823 | 50 of 241 |
| find `button` anywhere | 33,751 (capped) | 4,316 | 80 of 161 matches |
| `perk` inside `StarterGui` | 313 | 277 | all 2 |
| 2 levels of `ReplicatedStorage.Assets` | 34,883 (capped) | 3,437 | 50 of 208 |
| 2 levels of `ServerScriptService` | 14,489 | 2,796 | 50 of 113 |
| **Total** | **143,534 chars** | **22,807 chars** | **6.3x less** |

Most of that is the 50-row default. With `limit: 200`, so both return the same number of rows,
the total is 2.7x less. Small exact lookups gain 1.1x to 3x.

Getting the right answer to the top matters more than size. Cost until the wanted instance
shows up in the result:

| Looking for | `search_game_tree` | `tree_search` |
| --- | --- | --- |
| `C4 Hotbar slot`, query `hotbar slot` | not among its 200 nodes (27,105 chars) | 8th row, 862 chars |
| `PerkTable`, query `perk table` | 19,230 chars in | 3rd row, 371 chars |
| `C4 Hotbar slot`, query `slot` | not among its 200 nodes | not in the top 50: one word is too broad, narrow it |

Things `search_game_tree` cannot do at all:

| Task | `tree_search` |
| --- | --- |
| count `StarterGui` by class (`group_by: class`) | 120 chars; `search_game_tree` needs the whole subtree and is capped at 24,110 chars |
| buttons whose text says `Claim` (`text`) | 111 matches |
| instances tagged `KitButton` (`tag`) | 168 matches |
| `SlotId` attribute under `ServerStorage.Maps` (`attribute`) | 462 matches in 4,578 chars, in collapsed runs |

A snapshot is about 12% bigger than before these columns (4.45 MB against 3.97 MB for this
place). The numbers are from one place and one afternoon; treat them as a guide.
