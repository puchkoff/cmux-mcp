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
| `cmux_capture` | Read a terminal surface's screen / scrollback |
| `cmux_new_pane` | Split a new terminal or browser pane |
| `cmux_new_workspace` | Create a workspace (name, cwd, startup command) |
| `cmux_rename_workspace` | Retitle a workspace (via `workspace-action`) |
| `cmux_focus_pane` | Focus a pane |
| `cmux_close` | Close a surface or workspace |
| `cmux_send` | Type literal text into a pane (no Enter) |
| `cmux_send_key` | Send a named key (`Enter`, `C-c`, …) |
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
