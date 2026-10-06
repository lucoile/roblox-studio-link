# roblox-studio-link

Claude Code mod for Roblox projects that use Rojo and the Roblox Studio MCP server.

## Install

```
claude plugin marketplace add lucoile/roblox-studio-link
claude plugin install roblox-studio-link@roblox-studio-link
```

Then restart Claude Code and run `/studio`.

Needs a Claude Code build with mods (plugin hooks modules) and the Roblox Studio MCP server connected.


No setup: everything is read from the Studio MCP server, `ps`, `lsof`, `git`, Rojo's `/api/rojo` and your `default.project.json`.

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

