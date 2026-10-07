# roblox-studio-link

A Claude Code mod for Roblox projects that use Rojo and the Roblox Studio MCP server. It
shows what Claude is about to touch: which Studio a call targets, what Rojo is serving,
what was edited in the place outside Rojo, and any throwaway test harnesses in the tree.

No setup for the pane. Everything is read from the Studio MCP server, `ps`, `lsof`, `git`, Rojo's
`/api/rojo` and your `default.project.json`.

## Use it

`/studio` opens the pane. Click a button once, or press its letter (`s` serve, `d` drift,
`m` mark saved, `r` refresh). The pane rechecks every 20 s.

| Command | Does |
| --- | --- |
| `/studio serve [port]` | `rojo serve` from this worktree on the port you give, or the first free one from 34872. The pane has a "Serve on port" field too |
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
`tree_search` tool searches it. It needs no Studio round trip, answers when Studio is
busy, and returns fewer tokens than `search_game_tree` (numbers below).

```
Studio Tree plugin --HTTP--> listener (127.0.0.1:34950) --> ~/.claude/studio-tree/<placeId>.tsv <-- tree_search
```

The link between the mod and Studio is set up for you: the mod builds and installs the Studio
plugin and starts the listener, so after the first Studio restart there is nothing to configure.

- **Studio Tree plugin** (`plugin/studio-plugin/`): sends the tree from edit mode when the
  place loads, and again 3 s after adds, removes or a recorded edit (renames, moves) stop. It
  yields while it walks, so a 37k-instance place doesn't hitch Studio. The **Send tree**
  toolbar button sends it now. The mod installs it at session start with
  `rojo build --plugin StudioTree.rbxm`, again whenever its source changes, and on
  `/studio plugin`. Without `rojo` on PATH it says so and gives the command. The first send
  asks to allow HTTP to `127.0.0.1`; allow it.
- **Listener** (`plugin/listener/tree_listener.py`, needs `python3`): the mod starts it on
  `127.0.0.1:34950` and writes `~/.claude/studio-tree/<placeId>.tsv`. One runs per machine;
  other sessions use it. Studio retries every 15 s while it is down, so a tree edited with
  Claude Code closed arrives when it opens.
- **`tree_search`** (tool): `query` matches names (any of several words), `under` limits to
  a path, `class_name` to a class, `depth` to levels below. With `under` alone it lists
  children; with a query or `class_name` it searches every level. It defaults to the Studio Claude last targeted and starts its answer with the
  snapshot's age.

Each line of a snapshot is `path<TAB>ClassName<TAB>childCount`, so `Grep` works on the
file too. It is for finding things: confirm with `inspect_instance` before a write.

### Token savings

Measured on a 37,069-instance place, against `search_game_tree` called the way an agent would
(`keywords`, `instance_type`, `path`, `max_depth`; its default cap is 200 nodes). Sizes are the
characters of the tool result, tokens are chars / 4.

| Task | `search_game_tree` | `tree_search` | Saved |
| --- | --- | --- | --- |
| find `hotbar` anywhere (14 hits) | 2,056 | 1,287 | 1.6x |
| find `hotbar slot` anywhere | 27,105 (capped) | 3,782 (50 of 537) | 7.2x |
| ModuleScript named `janitor` | 473 | 229 | 2.1x |
| children of `StarterGui.MainHUD` | 1,125 | 364 | 3.1x |
| every `ScreenGui` (25) | 3,205 | 1,687 | 1.9x |
| every ModuleScript in `ServerScriptService` | 26,134 (capped) | 3,823 (50 of 241) | 6.8x |
| find `button` anywhere (broad) | 33,732 (capped) | 3,940 (50 of 151) | 8.6x |
| `perk` inside `StarterGui` | 313 | 277 | 1.1x |
| 2 levels of `ReplicatedStorage.Assets` | 34,883 (capped) | 3,418 (50 of 208) | 10.2x |
| 2 levels of `ServerScriptService` | 14,489 | 2,796 (50 of 113) | 5.2x |
| **Total** | **~35,900 tokens** | **~5,400 tokens** | **6.6x** (median 4.1x) |

Where the saving comes from: a row is about 2x smaller (`path  Class  (n children)` against a
JSON object with `parentName`, `fullPath`, `name` and `className`), and `tree_search` returns
50 rows unless you raise `limit`. With `limit: 200` the same tasks come to 2.3x overall, so the
rest of the gap is the smaller default. Small, exact lookups gain little (1.1x to 3x); broad
ones gain most. Both tools truncate broad results, so narrow with `under` or `class_name`.
Rerun the numbers on your own place before leaning on them.

## Replaces `studio-link`

It registers the same `/studio` command as the Cafe Story `studio-link` mod. Load one.
