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
`tree_search` tool searches it. A lookup costs a few hundred tokens and no Studio round trip,
where walking a large place through `search_game_tree` takes several calls of up to ~10k
tokens each.

- **Studio Tree plugin** (`studio-plugin/`): sends the tree from edit mode when the place
  loads, and again 3 s after adds, removes or a recorded edit (renames, moves) stop. It
  yields while it walks, so a 37k-instance place doesn't hitch Studio. The **Send tree**
  toolbar button sends it now. Build and install it once per machine:

  ```
  rojo build studio-plugin/plugin.project.json --plugin StudioTree.rbxm
  ```

  Or paste `StudioTree.server.luau` into a Script and use *Save as Local Plugin*. The first
  send asks to allow HTTP to `127.0.0.1`; allow it.
- **Listener** (`plugin/listener/tree_listener.py`, needs `python3`): the mod starts it on
  `127.0.0.1:34950` and writes `~/.claude/studio-tree/<placeId>.tsv`. One runs per machine;
  other sessions use it. Studio retries every 15 s while it is down, so a tree edited with
  Claude Code closed arrives when it opens.
- **`tree_search`** (tool): `query` matches names (any of several words), `under` limits to
  a path, `class_name` to a class, `depth` to levels below. With `under` alone it lists
  children. It defaults to the Studio Claude last targeted and starts its answer with the
  snapshot's age.

Each line of a snapshot is `path<TAB>ClassName<TAB>childCount`, so `Grep` works on the
file too. It is for finding things: confirm with `inspect_instance` before a write.

## Replaces `studio-link`

It registers the same `/studio` command as the Cafe Story `studio-link` mod. Load one.
