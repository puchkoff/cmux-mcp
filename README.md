<p align="center">
  <img src="assets/logo-blue.svg" alt="cmux-mcp" width="480">
</p>

MCP server wrapping the [cmux](https://cmux.io) CLI. Lets an MCP client (Claude
Code, etc.) drive cmux panes, workspaces, terminal input, and the embedded
browser.

It shells out to the `cmux` binary — cmux handles socket auth and ref parsing,
so this stays a thin, robust layer rather than re-speaking the Unix-socket RPC.

## Tools

| Tool | What it does |
|------|--------------|
| `cmux_identify` | Current + focused window/workspace/pane/surface refs (JSON) |
| `cmux_tree` | window > workspace > pane > surface hierarchy |
| `cmux_list` | List `windows` / `workspaces` / `panes` |
| `cmux_capture` | Read a terminal surface's screen / scrollback (workspace/window-aware) |
| `cmux_new_pane` | Split a new terminal or browser pane |
| `cmux_new_workspace` | Create a workspace (name, cwd, startup command, optional group) |
| `cmux_list_groups` | List workspace groups (JSON with anchor + member refs) |
| `cmux_new_group` | Group workspaces under a collapsible sidebar header |
| `cmux_group_action` | rename / collapse / expand / pin / focus / set-color / set-icon / move / ungroup / delete (confirm-guarded) a group |
| `cmux_group_members` | add / remove / set-anchor of a group's member workspaces |
| `cmux_rename_workspace` | Retitle a workspace (via `workspace-action`) |
| `cmux_rename_tab` | Retitle a tab (the pane's tab label, via `rename-tab`) |
| `cmux_focus_pane` | Focus a pane |
| `cmux_close` | Close a surface or workspace (explicit ref) |
| `cmux_close_current_workspace` | Safely close the *calling* pane's workspace (confirm-guarded) |
| `cmux_send` | Type literal text into a pane (no Enter, workspace/window-aware) |
| `cmux_send_key` | Send a named key (`Enter`, `C-c`/`ctrl+c`, …) |
| `cmux_list_panels` | List a workspace's panels to discover a panel ref |
| `cmux_send_panel` | Send text to an agent panel (`send-panel`) |
| `cmux_wait_ready` | Poll a panel until it's ready for input (vs. sleeping) |
| `cmux_notify` | Post a cmux notification |
| `cmux_browser` | Passthrough for any `cmux browser` subcommand (args array) |
| `cmux_raw` | Escape hatch — run any `cmux` subcommand |

The browser and raw passthroughs cover cmux's full surface without exploding the
tool list into ~90 entries. The typed tools just save the agent from
hand-assembling argv for the common verbs.

## Workspace targeting

cmux defaults pane/workspace-spawning commands to the **focused** workspace,
which drifts as the user clicks around. When a tool call omits `workspace`, the
server falls back to `CMUX_WORKSPACE_ID` from its own environment — i.e. the
workspace the MCP client (and this server) was launched in — so new panes land
where the user is actually working. Pass `workspace` explicitly to override.

### Driving a surface in another workspace

`cmux_send`, `cmux_send_key`, and `cmux_capture` resolve a bare `surface:N` ref
against the **caller's** workspace. To drive a pane in a workspace you spawned
elsewhere (e.g. a `cmux_new_workspace` running Claude), pass `workspace` (and
`window` if needed) alongside `surface`. Without it cmux can't find the ref and
reports a misleading `Surface is not a terminal`; these tools now rewrite that to
name the surface's real workspace and tell you which `workspace=` to pass.

For agent panels (`cmux claude-teams`), discover the ref with `cmux_list_panels`,
drive it with `cmux_send_panel`, and use `cmux_wait_ready` (with a `pattern`
matching the input prompt) to know when it accepts input instead of sleeping.

### "Close this workspace" safety

`cmux identify` returns two refs: `caller` (the pane the calling process actually
runs in) and `focused` (the workspace with UI focus right now). These differ — an
agent runs in workspace A while the user clicks into workspace B, so B is focused.

`cmux_close_current_workspace` always resolves the target from
`identify.caller.workspace_ref`, never `focused`. If `caller` is null (invoked
outside a cmux terminal) it refuses and asks for an explicit ref rather than
guessing from focus. The first call only previews the resolved target
(`About to close workspace:5 — user-roles-3. Confirm?`); you must call again with
`confirm=true` to actually close — so a wrong target is caught before it's
destructive.

> Do **not** use `identify --no-caller` (or read `focused.workspace_ref`) when the
> intent is "act on my own workspace" — it drops `caller` and can close whatever the
> user last clicked. `--no-caller` is only for queries *about* UI focus.

## Install

Requires Node ≥ 18 and the [cmux](https://cmux.io) app (the `cmux` binary).

### Without cloning (recommended)

`npx` installs and builds straight from GitHub — no clone, no manual build:

```bash
claude mcp add cmux -- npx -y github:puchkoff/cmux-mcp
```

The first run compiles the TypeScript (via the package's `prepare` step) and caches it; later runs start instantly.

### From a clone

```bash
git clone https://github.com/puchkoff/cmux-mcp.git
cd cmux-mcp
npm install
npm run build        # compiles to dist/
```

## Register with Claude Code

If you cloned, register with the absolute path to the built entrypoint:

```bash
claude mcp add cmux -- node /absolute/path/to/cmux-mcp/dist/index.js
```

- `--scope user` registers it for every project (default is the current project).
- After adding, restart Claude Code (or reconnect via `/mcp`) — MCP tools load at session start.
- Verify: `claude mcp get cmux` should report `✓ Connected`. The `cmux_*` tools then appear.

Or register by hand in `.mcp.json` / settings:

```json
{
  "mcpServers": {
    "cmux": {
      "command": "node",
      "args": ["/absolute/path/to/cmux-mcp/dist/index.js"]
    }
  }
}
```

Works with any MCP client (Cursor, etc.) — point it at `node dist/index.js`.

## Env

- `CMUX_BIN` — path to the `cmux` binary if it isn't on `PATH`
  (bundled at `/Applications/cmux.app/Contents/Resources/bin/cmux` on macOS).
- `CMUX_WORKSPACE_ID` — default workspace ref (auto-set inside a cmux pane).
