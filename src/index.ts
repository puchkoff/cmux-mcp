#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCmux, withWorkspace } from './cmux.js';
import { rpc, rpcEnabled, caller, prewarm } from './rpc.js';

const server = new McpServer({ name: 'cmux-mcp', version: '0.1.9' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function call(args: string[]): Promise<ToolResult> {
  const { ok, output } = await runCmux(args);
  return { content: [{ type: 'text', text: output }], isError: !ok };
}

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function okText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

// Run a command over the fast socket, formatting the JSON result into the text a
// tool returns. Returns null to signal "fall back to the CLI" — when the socket
// is unavailable or the request fails at the transport level, so the caller runs
// the spawn-based path and behaviour is unchanged. A cmux-level error (ok:false)
// is surfaced as an error ToolResult rather than a fallback, since the CLI would
// report the same failure.
async function rpcCall(
  method: string,
  params: Record<string, unknown>,
  format: (result: any) => string,
): Promise<ToolResult | null> {
  if (!rpcEnabled()) return null;
  let resp;
  try {
    resp = await rpc(method, params);
  } catch {
    return null; // transport failure → let the caller spawn the CLI
  }
  if (resp.ok) return okText(format(resp.result));
  return errorText(resp.error?.message || resp.error?.code || 'cmux error');
}

// Move focus to a pane, preferring the socket. Returns the same {ok, output}
// shape as runCmux so call sites stay uniform.
async function focusPane(pane: string, workspace?: string): Promise<{ ok: boolean; output: string }> {
  if (rpcEnabled()) {
    try {
      const params: Record<string, unknown> = { pane_id: pane };
      if (workspace) params.workspace_id = workspace;
      const r = await rpc('pane.focus', params);
      if (r.ok) return { ok: true, output: 'OK' };
      if (r.error) return { ok: false, output: r.error.message || r.error.code || 'cmux error' };
    } catch {
      // fall through to CLI
    }
  }
  return runCmux(withWorkspace(['focus-pane', '--pane', pane], workspace));
}

// Read a surface's screen, preferring the socket. Same {ok, output} shape as
// runCmux. The socket path has no window selector, so fall back for that.
async function readScreen(
  surface: string,
  workspace?: string,
  window?: string,
): Promise<{ ok: boolean; output: string }> {
  if (rpcEnabled() && !window) {
    try {
      const r = await rpc('surface.read_text', {
        surface_id: surface,
        workspace_id: workspace || caller().workspace_id,
      });
      if (r.ok) return { ok: true, output: (r.result?.text ?? '').trim() };
    } catch {
      // fall through to CLI
    }
  }
  return runCmux(withTarget(['read-screen', '--surface', surface], workspace, window));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const workspaceArg = z
  .string()
  .optional()
  .describe('Workspace ref like "workspace:26". Defaults to the caller\'s workspace.');
const windowArg = z
  .string()
  .optional()
  .describe('Window ref like "window:1". Defaults to the caller\'s window.');
const surfaceArg = z
  .string()
  .optional()
  .describe('Surface ref like "surface:40". Defaults to the current pane.');

// Append --workspace/--window only when explicitly given. No env fallback — these
// surface-targeting tools historically sent neither, letting cmux resolve against
// the caller's own context; that exact behavior must hold when both are omitted.
function withTarget(args: string[], workspace?: string, window?: string): string[] {
  const a = [...args];
  if (workspace) a.push('--workspace', workspace);
  if (window) a.push('--window', window);
  return a;
}

// One full tree, preferring the socket and falling back to `tree --all`. The
// callbacks walk the structured form first; on the CLI path the raw text is
// handed back for the legacy regex scans.
async function fullTree(): Promise<{ windows?: any[]; text?: string } | null> {
  if (rpcEnabled()) {
    try {
      const r = await rpc('system.tree', { all_windows: true, caller: caller() });
      if (r.ok) return { windows: r.result?.windows ?? [] };
    } catch {
      // fall through to CLI
    }
  }
  const res = await runCmux(['tree', '--all']);
  return res.ok ? { text: res.output } : null;
}

// Which workspace a surface ref actually lives in.
async function surfaceWorkspace(surface: string): Promise<string | null> {
  const tree = await fullTree();
  if (!tree) return null;
  if (tree.windows) {
    for (const w of tree.windows)
      for (const ws of w.workspaces ?? [])
        for (const p of ws.panes ?? [])
          for (const s of p.surfaces ?? []) if (s.ref === surface) return ws.ref;
    return null;
  }
  const re = new RegExp(`(^|\\s)${surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|\\[|$)`);
  let ws: string | null = null;
  for (const line of (tree.text ?? '').split('\n')) {
    const m = line.match(/workspace (workspace:\d+)/);
    if (m) ws = m[1];
    if (/\bsurface\b/.test(line) && re.test(line)) return ws;
  }
  return null;
}

// Resolve an anchor ref (pane:N or surface:N) to the workspace it lives in and
// the pane to focus. new-pane has no pane-anchor flag — it splits the target
// workspace's active pane — so to split next to a SPECIFIC pane we look up its
// workspace here, focus it, then split there. A surface ref resolves to its
// containing pane.
async function resolveAnchor(ref: string): Promise<{ workspace: string; pane: string } | null> {
  const tree = await fullTree();
  if (!tree) return null;
  if (tree.windows) {
    for (const w of tree.windows)
      for (const ws of w.workspaces ?? [])
        for (const p of ws.panes ?? []) {
          if (ref.startsWith('pane:') && p.ref === ref) return { workspace: ws.ref, pane: ref };
          if (ref.startsWith('surface:') && p.ref)
            for (const s of p.surfaces ?? [])
              if (s.ref === ref) return { workspace: ws.ref, pane: p.ref };
        }
    return null;
  }
  let ws: string | null = null;
  let pane: string | null = null;
  for (const line of (tree.text ?? '').split('\n')) {
    const wm = line.match(/\bworkspace (workspace:\d+)/);
    if (wm) ws = wm[1];
    const pm = line.match(/\bpane (pane:\d+)/);
    if (pm) pane = pm[1];
    if (ref.startsWith('pane:') && pm && pm[1] === ref) return ws ? { workspace: ws, pane: ref } : null;
    const sm = line.match(/\bsurface (surface:\d+)/);
    if (ref.startsWith('surface:') && sm && sm[1] === ref) return ws && pane ? { workspace: ws, pane } : null;
  }
  return null;
}

async function callerWorkspace(): Promise<string | null> {
  if (rpcEnabled()) {
    try {
      const r = await rpc('system.identify', { caller: caller() });
      if (r.ok) return r.result?.caller?.workspace_ref ?? null;
    } catch {
      // fall through to CLI
    }
  }
  const id = await runCmux(['identify']);
  if (!id.ok) return null;
  try {
    return (JSON.parse(id.output) as { caller?: { workspace_ref?: string } | null })?.caller?.workspace_ref ?? null;
  } catch {
    return null;
  }
}

// Run a surface-targeting command and, on the ambiguous "not a terminal" / "not
// found" errors, explain WHY: a bare surface ref resolves against the caller's
// workspace, so one that lives elsewhere reads as missing. Distinguish that from a
// surface that is genuinely a non-terminal (browser) panel.
async function callSurface(args: string[], surface?: string, workspace?: string): Promise<ToolResult> {
  return explainSurfaceError(await call(args), surface, workspace);
}

// Given a surface-command result, turn the ambiguous "not a terminal" / "not
// found" failures into an explanation of WHY (see callSurface above). Shared by
// the CLI and socket paths.
async function explainSurfaceError(r: ToolResult, surface?: string, workspace?: string): Promise<ToolResult> {
  if (!r.isError || !surface) return r;
  const msg = r.content.map((c) => c.text).join('\n');
  if (!/not a terminal|not found/i.test(msg)) return r;
  const home = await surfaceWorkspace(surface);
  const target = workspace ?? (await callerWorkspace());
  if (home && home !== target) {
    return errorText(
      `${surface} not found in ${target ?? "the caller's workspace"} (the active default) — it lives in ${home}. ` +
        `Re-run with workspace=${home} to target it.  [cmux: ${msg}]`,
    );
  }
  if (home && home === target) {
    return errorText(
      `${surface} is in ${home} but cmux reports it is not a terminal — it is likely a browser / non-terminal panel, ` +
        `not a shell surface.  [cmux: ${msg}]`,
    );
  }
  return r;
}

// --- Inspect -------------------------------------------------------------

server.registerTool(
  'cmux_identify',
  {
    title: 'Identify current context',
    description:
      'Return both the caller and focused window/workspace/pane/surface refs as JSON. ' +
      'caller = the pane that ISSUED this MCP call (you); focused = wherever UI focus currently is. ' +
      'They DIFFER whenever a human (or another pane) has moved focus away from the caller. ' +
      'Use caller.pane_ref as the anchor_pane for cmux_new_pane to place panes next to yourself deterministically.',
    inputSchema: {},
  },
  async () =>
    (await rpcCall('system.identify', { caller: caller() }, (r) => JSON.stringify(r, null, 2))) ??
    call(['identify']),
);

server.registerTool(
  'cmux_tree',
  {
    title: 'Show hierarchy',
    description: 'Print the window > workspace > pane > surface tree.',
    inputSchema: { workspace: workspaceArg, all: z.boolean().optional().describe('Include all windows.') },
  },
  ({ workspace, all }) => {
    const args = withWorkspace(['tree'], workspace);
    if (all) args.push('--all');
    return call(args);
  },
);

server.registerTool(
  'cmux_list',
  {
    title: 'List windows / workspaces / panes',
    description: 'List cmux objects of the given kind.',
    inputSchema: {
      kind: z.enum(['windows', 'workspaces', 'panes']),
      workspace: workspaceArg,
    },
  },
  ({ kind, workspace }) => {
    const args = [`list-${kind}`];
    // list-windows takes no workspace filter; the other two do.
    return call(kind === 'windows' ? args : withWorkspace(args, workspace));
  },
);

server.registerTool(
  'cmux_capture',
  {
    title: 'Read pane output',
    description:
      'Read the current screen (or scrollback) of a terminal surface (wraps read-screen). Pass workspace/window to read a surface that lives in another workspace.',
    inputSchema: {
      surface: surfaceArg,
      workspace: workspaceArg,
      window: windowArg,
      lines: z.number().int().positive().optional().describe('Limit to the last N lines.'),
      scrollback: z.boolean().optional().describe('Include scrollback history.'),
    },
  },
  async ({ surface, workspace, window, lines, scrollback }) => {
    const args = ['read-screen'];
    if (surface) args.push('--surface', surface);
    if (lines) args.push('--lines', String(lines));
    if (scrollback) args.push('--scrollback');
    const cli = () => callSurface(withTarget(args, workspace, window), surface, workspace);
    // Socket read_text has no window selector — fall back to the CLI for that.
    const surfaceId = surface ?? caller().surface_id;
    if (window || !surfaceId) return cli();
    const params: Record<string, unknown> = { surface_id: surfaceId, workspace_id: workspace || caller().workspace_id };
    if (lines) params.lines = lines;
    if (scrollback) params.scrollback = true;
    const r = await rpcCall('surface.read_text', params, (res) => (res?.text ?? '').trim());
    return r ? explainSurfaceError(r, surface, workspace) : cli();
  },
);

// --- Panes & workspaces --------------------------------------------------

server.registerTool(
  'cmux_new_pane',
  {
    title: 'Split a new pane',
    description:
      'Open a new pane (terminal or browser) by splitting in the given direction. ' +
      'For deterministic placement, pass anchor_pane = your own pane_ref from cmux_identify (the caller block): ' +
      'the split then lands next to THAT pane in ITS workspace, regardless of where UI focus currently is. ' +
      "Without an anchor, target resolution is: anchor_pane > workspace > the caller's workspace > the focused workspace.",
    inputSchema: {
      direction: z.enum(['left', 'right', 'up', 'down']).default('right'),
      type: z.enum(['terminal', 'browser']).optional(),
      url: z.string().optional().describe('Initial URL for a browser pane.'),
      anchor_pane: z
        .string()
        .optional()
        .describe(
          'Split relative to this specific pane (pane:N) or surface (surface:N), in the workspace it lives in — ' +
            "regardless of UI focus. Pass cmux_identify's caller.pane_ref to place the new pane next to yourself. " +
            'Takes precedence over workspace.',
        ),
      workspace: workspaceArg,
    },
  },
  async ({ direction, type, url, anchor_pane, workspace }) => {
    let target = workspace;
    if (anchor_pane) {
      const resolved = await resolveAnchor(anchor_pane);
      if (!resolved)
        return errorText(`anchor_pane ${anchor_pane} not found in any workspace (checked tree --all).`);
      // Focus the anchor in its workspace so the split lands next to it, not next
      // to whatever pane that workspace last had active.
      const focus = await focusPane(resolved.pane, resolved.workspace);
      if (!focus.ok) return errorText(`Could not focus anchor ${resolved.pane} in ${resolved.workspace}: ${focus.output}`);
      target = resolved.workspace;
    } else if (!target) {
      // Prefer the caller's own workspace over the focused one: an MCP caller
      // almost always wants the new pane next to itself, not wherever a human
      // last clicked. Falls through to cmux's focused default only if unknown.
      target = (await callerWorkspace()) ?? undefined;
    }
    const args = ['new-pane', '--direction', direction];
    if (type) args.push('--type', type);
    if (url) args.push('--url', url);
    return call(withWorkspace(args, target));
  },
);

server.registerTool(
  'cmux_new_workspace',
  {
    title: 'Create a workspace',
    description:
      'Create a new workspace, optionally with a title, cwd, and startup command. Pass group to create it inside a workspace group.',
    inputSchema: {
      name: z.string().optional(),
      cwd: z.string().optional(),
      command: z.string().optional().describe('Command to run in the first pane.'),
      group: z.string().optional().describe('Add the new workspace to this group, e.g. "workspace_group:3".'),
    },
  },
  // Create then `group add` — cmux's own `workspace group new-workspace`
  // silently ignores --name/--cwd/--command.
  async ({ name, cwd, command, group }) => {
    const args = ['new-workspace'];
    if (name) args.push('--name', name);
    if (cwd) args.push('--cwd', cwd);
    if (command) args.push('--command', command);
    const created = await runCmux(args);
    if (!created.ok || !group) return { content: [{ type: 'text', text: created.output }], isError: !created.ok };
    const ref = created.output.match(/workspace:\d+/)?.[0];
    if (!ref) return errorText(`Created a workspace but could not parse its ref to add to ${group}:\n${created.output}`);
    const added = await runCmux(['workspace', 'group', 'add', '--group', group, '--workspace', ref]);
    if (!added.ok) return errorText(`Created ${ref} but failed to add it to ${group}: ${added.output}`);
    return { content: [{ type: 'text', text: `${created.output} (added to ${group})` }] };
  },
);

server.registerTool(
  'cmux_rename_workspace',
  {
    title: 'Rename a workspace',
    description: 'Set a workspace title. Uses workspace-action (the legacy rename alias mangles args).',
    inputSchema: { title: z.string(), workspace: workspaceArg },
  },
  ({ title, workspace }) =>
    call(withWorkspace(['workspace-action', '--action', 'rename', '--title', title], workspace)),
);

server.registerTool(
  'cmux_rename_tab',
  {
    title: 'Rename a tab',
    description:
      "Set a tab's title (the pane's tab label). Target the tab by ref, or by a surface inside it; defaults to the current tab.",
    inputSchema: {
      title: z.string(),
      tab: z.string().optional().describe('Tab ref like "tab:11".'),
      surface: surfaceArg,
      workspace: workspaceArg,
    },
  },
  ({ title, tab, surface, workspace }) => {
    const args = ['rename-tab'];
    if (tab) args.push('--tab', tab);
    if (surface) args.push('--surface', surface);
    return call(withWorkspace([...args, title], workspace));
  },
);

server.registerTool(
  'cmux_focus_pane',
  {
    title: 'Focus a pane',
    description: 'Move focus to the given pane.',
    inputSchema: { pane: z.string().describe('Pane ref like "pane:38".'), workspace: workspaceArg },
  },
  async ({ pane, workspace }) => {
    const r = await focusPane(pane, workspace);
    return r.ok ? okText(r.output) : errorText(r.output);
  },
);

server.registerTool(
  'cmux_close',
  {
    title: 'Close a surface or workspace',
    description:
      'Close a surface (tab) or an entire workspace. For kind "surface" you may pass a pane ref instead, which closes that pane\'s selected surface.',
    inputSchema: {
      kind: z.enum(['surface', 'workspace']),
      ref: z
        .string()
        .describe(
          'e.g. "surface:40" or "workspace:26". For kind "surface" a pane ref like "pane:7" is also accepted (closes that pane\'s selected surface).',
        ),
    },
  },
  async ({ kind, ref }) => {
    if (kind === 'surface' && ref.startsWith('pane:')) {
      const { output } = await runCmux(['list-pane-surfaces', '--pane', ref]);
      const match = output.match(/surface:\d+/);
      if (match) ref = match[0];
    }
    return call([`close-${kind}`, `--${kind}`, ref]);
  },
);

// "Close this workspace" must target the workspace the CALLING pane runs in
// (identify.caller.workspace_ref), never the UI-focused one. An agent can run in
// workspace A while the user has clicked into workspace B, so B is focused.
// Resolving from `focused` (or `identify --no-caller`, which drops caller) would
// close whatever the user last clicked — possibly unrelated. So we read caller,
// refuse if there is no calling pane, and require an explicit confirm first.

// Look up a workspace title from list-workspaces ("* workspace:2  My Title  [selected]").
async function workspaceTitle(ref: string): Promise<string | null> {
  if (rpcEnabled()) {
    try {
      const r = await rpc('workspace.list', { ...caller() });
      if (r.ok) {
        const ws = (r.result?.workspaces ?? []).find((w: any) => w.ref === ref);
        if (ws) return ws.title || ws.custom_title || null;
      }
    } catch {
      // fall through to CLI
    }
  }
  const res = await runCmux(['list-workspaces']);
  if (!res.ok) return null;
  for (const line of res.output.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    const i = tokens.indexOf(ref);
    if (i === -1) continue;
    const rest = tokens.slice(i + 1).filter((t) => t !== '[selected]');
    return rest.join(' ') || null;
  }
  return null;
}

server.registerTool(
  'cmux_close_current_workspace',
  {
    title: "Close the calling pane's workspace (safe)",
    description:
      "Close the workspace the CALLING pane runs in (identify.caller.workspace_ref) — NOT the focused one, which may be a workspace the user just clicked into. First call previews the resolved target; call again with confirm=true to actually close. Refuses if there is no calling pane (invoked outside a cmux terminal) rather than guessing from focus.",
    inputSchema: {
      confirm: z
        .boolean()
        .optional()
        .describe('Set true to actually close. Omit/false to only preview the resolved target.'),
    },
  },
  async ({ confirm }) => {
    const id = await runCmux(['identify']);
    if (!id.ok) return { content: [{ type: 'text', text: id.output }], isError: true };

    let caller: { workspace_ref?: string } | null = null;
    try {
      caller = (JSON.parse(id.output) as { caller?: { workspace_ref?: string } | null }).caller ?? null;
    } catch {
      return { content: [{ type: 'text', text: `Could not parse identify output:\n${id.output}` }], isError: true };
    }

    const ref = caller?.workspace_ref;
    if (!ref) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No calling pane (identify.caller is null) — this was not invoked from inside a cmux terminal. ' +
              'Refusing to fall back to the focused workspace. Pass an explicit workspace ref to cmux_close instead.',
          },
        ],
        isError: true,
      };
    }

    const title = await workspaceTitle(ref);
    const label = title ? `${ref} — ${title}` : ref;

    if (!confirm) {
      return {
        content: [
          {
            type: 'text',
            text: `About to close workspace: ${label}. Confirm by calling cmux_close_current_workspace again with confirm=true.`,
          },
        ],
      };
    }

    return call(['close-workspace', '--workspace', ref]);
  },
);

// --- Workspace groups ------------------------------------------------------
// Collapsible sidebar groups of workspaces (wraps `cmux workspace group`).
// Each group is owned by an "anchor" workspace whose sidebar row IS the group
// header; `create` always spawns a fresh anchor workspace. `delete` closes
// every member workspace — `ungroup` is the safe dissolve.

const groupArg = z.string().describe('Group ref like "workspace_group:3" (or its UUID).');

server.registerTool(
  'cmux_list_groups',
  {
    title: 'List workspace groups',
    description:
      "List sidebar workspace groups as JSON, including each group's name, anchor, and member workspace refs.",
    inputSchema: {},
  },
  () => call(['workspace', 'group', 'list', '--json']),
);

server.registerTool(
  'cmux_new_group',
  {
    title: 'Create a workspace group',
    description:
      'Group workspaces under a collapsible sidebar header. Spawns a fresh anchor workspace that becomes the header row. If `workspaces` is omitted, cmux seeds the group from the active sidebar selection / caller workspace — pass it explicitly to control membership.',
    inputSchema: {
      name: z.string().optional(),
      workspaces: z
        .array(z.string())
        .optional()
        .describe('Workspace refs to group, e.g. ["workspace:3", "workspace:4"].'),
      cwd: z.string().optional().describe('cwd for the new anchor workspace.'),
    },
  },
  ({ name, workspaces, cwd }) => {
    const args = ['workspace', 'group', 'create'];
    if (name) args.push('--name', name);
    if (cwd) args.push('--cwd', cwd);
    if (workspaces?.length) args.push('--from', workspaces.join(','));
    return call(args);
  },
);

server.registerTool(
  'cmux_group_action',
  {
    title: 'Act on a workspace group',
    description:
      'Run an action on a group: rename (needs name), collapse, expand, pin, unpin, focus (focuses its anchor), set-color (hex; omit to clear), set-icon (symbol; omit to clear), move (toIndex/before/after), ungroup (dissolve, keep workspaces), delete (CLOSES every member workspace — needs confirm=true; prefer ungroup).',
    inputSchema: {
      action: z.enum([
        'rename',
        'collapse',
        'expand',
        'pin',
        'unpin',
        'focus',
        'set-color',
        'set-icon',
        'move',
        'ungroup',
        'delete',
      ]),
      group: groupArg,
      name: z.string().optional().describe('New name (rename).'),
      hex: z.string().optional().describe('"#RRGGBB" (set-color); omit to clear the color.'),
      symbol: z.string().optional().describe('SF Symbol name like "star.fill" (set-icon); omit to clear.'),
      toIndex: z.number().int().optional().describe('Target position (move).'),
      before: z.string().optional().describe('Move before this group ref (move).'),
      after: z.string().optional().describe('Move after this group ref (move).'),
      confirm: z.boolean().optional().describe('Required true for delete.'),
    },
  },
  ({ action, group, name, hex, symbol, toIndex, before, after, confirm }) => {
    if (action === 'delete' && !confirm) {
      return errorText(
        `delete closes EVERY workspace in ${group}. Call again with confirm=true, or use ungroup to dissolve the group and keep its workspaces.`,
      );
    }
    const args = ['workspace', 'group', action, group];
    if (name) args.push('--name', name);
    if (hex) args.push('--hex', hex);
    if (symbol) args.push('--symbol', symbol);
    if (toIndex !== undefined) args.push('--to-index', String(toIndex));
    if (before) args.push('--before', before);
    if (after) args.push('--after', after);
    return call(args);
  },
);

server.registerTool(
  'cmux_group_members',
  {
    title: 'Manage group membership',
    description:
      "add a workspace to a group, remove a workspace from its group (group inferred from membership), or set-anchor to make a member the group's anchor/header row.",
    inputSchema: {
      action: z.enum(['add', 'remove', 'set-anchor']),
      workspace: z.string().describe('Workspace ref like "workspace:3".'),
      group: z.string().optional().describe('Group ref; required for add and set-anchor.'),
    },
  },
  ({ action, workspace, group }) => {
    const args = ['workspace', 'group', action, '--workspace', workspace];
    if (group) args.push('--group', group);
    return call(args);
  },
);

// --- Input ---------------------------------------------------------------

server.registerTool(
  'cmux_send',
  {
    title: 'Send text to a pane',
    description:
      'Type literal text into a terminal surface. Does NOT press Enter — follow with cmux_send_key Enter. Pass workspace/window to target a surface in another workspace.',
    inputSchema: { text: z.string(), surface: surfaceArg, workspace: workspaceArg, window: windowArg },
  },
  async ({ text, surface, workspace, window }) => {
    const args = ['send'];
    if (surface) args.push('--surface', surface);
    args.push(text);
    const cli = () => callSurface(withTarget(args, workspace, window), surface, workspace);
    const surfaceId = surface ?? caller().surface_id;
    if (window || !surfaceId) return cli();
    const r = await rpcCall(
      'surface.send_text',
      { surface_id: surfaceId, text, workspace_id: workspace || caller().workspace_id },
      () => 'OK',
    );
    return r ? explainSurfaceError(r, surface, workspace) : cli();
  },
);

server.registerTool(
  'cmux_send_key',
  {
    title: 'Send a key to a pane',
    description:
      'Send a named key such as Enter, Tab, Escape, C-c, C-d. Ctrl chords accept either form: "C-u" or "ctrl+u". Pass workspace/window to target a surface in another workspace.',
    inputSchema: {
      key: z.string().describe('e.g. "Enter", "C-c" / "ctrl+c".'),
      surface: surfaceArg,
      workspace: workspaceArg,
      window: windowArg,
    },
  },
  async ({ key, surface, workspace, window }) => {
    // Accept "ctrl+u" / "ctrl-u" as aliases for cmux's "C-u" form.
    const normalized = key.replace(/^(ctrl|control)[-+]/i, 'C-');
    const args = ['send-key'];
    if (surface) args.push('--surface', surface);
    args.push(normalized);
    const cli = () => callSurface(withTarget(args, workspace, window), surface, workspace);
    const surfaceId = surface ?? caller().surface_id;
    let r: ToolResult;
    if (window || !surfaceId) {
      r = await cli();
    } else {
      const sock = await rpcCall(
        'surface.send_key',
        { key: normalized, surface_id: surfaceId, workspace_id: workspace || caller().workspace_id },
        () => 'OK',
      );
      r = sock ? await explainSurfaceError(sock, surface, workspace) : await cli();
    }
    if (r.isError && /unknown key/i.test(r.content.map((c) => c.text).join('\n'))) {
      return errorText(
        `Unknown key "${key}". cmux accepts named keys — e.g. Enter, Tab, Escape, Space, Backspace, Delete, ` +
          `Up, Down, Left, Right, Home, End, PageUp, PageDown — and ctrl chords like C-c (or ctrl+c).`,
      );
    }
    return r;
  },
);

// --- Panels (agent surfaces) --------------------------------------------
// Agent panels (e.g. `cmux claude-teams`) are driven through dedicated panel
// commands rather than plain send/read-screen.

server.registerTool(
  'cmux_list_panels',
  {
    title: 'List panels',
    description: 'List the panels (agent/terminal surfaces) in a workspace, so you can discover a panel ref to drive.',
    inputSchema: { workspace: workspaceArg, window: windowArg },
  },
  ({ workspace, window }) => call(withTarget(['list-panels'], workspace, window)),
);

server.registerTool(
  'cmux_send_panel',
  {
    title: 'Send text to a panel',
    description:
      'Send text into an agent panel via send-panel. Use cmux_list_panels to find the panel ref. Pass workspace/window when the panel lives in another workspace.',
    inputSchema: {
      panel: z.string().describe('Panel ref like "surface:39".'),
      text: z.string(),
      workspace: workspaceArg,
      window: windowArg,
    },
  },
  ({ panel, text, workspace, window }) => {
    const args = withTarget(['send-panel', '--panel', panel], workspace, window);
    args.push(text);
    return callSurface(args, panel, workspace);
  },
);

server.registerTool(
  'cmux_wait_ready',
  {
    title: 'Wait for a panel to be ready',
    description:
      'Poll a surface/panel until it looks ready for input, then return the final screen. Ready = the screen matches `pattern` (regex) or, when no pattern is given, the screen is non-empty and unchanged between two polls. Use after spawning a panel instead of sleeping. For a live TUI (blinking cursor never settles) pass a `pattern` that marks the input prompt.',
    inputSchema: {
      surface: z.string().describe('Surface/panel ref to watch, e.g. "surface:39".'),
      pattern: z.string().optional().describe('Regex; ready as soon as the screen matches it.'),
      workspace: workspaceArg,
      window: windowArg,
      timeoutMs: z.number().int().positive().optional().describe('Give up after this long (default 15000).'),
    },
  },
  async ({ surface, pattern, workspace, window, timeoutMs }) => {
    const limit = timeoutMs ?? 15_000;
    const deadline = Date.now() + limit;
    const re = pattern ? new RegExp(pattern) : null;
    let prev: string | null = null;
    while (Date.now() < deadline) {
      const r = await readScreen(surface, workspace, window);
      if (r.ok) {
        const screen = r.output.trim();
        if (re) {
          if (re.test(r.output)) return { content: [{ type: 'text', text: `READY ${surface}\n--- screen ---\n${screen}` }] };
        } else if (screen && prev !== null && screen === prev) {
          return { content: [{ type: 'text', text: `READY ${surface}\n--- screen ---\n${screen}` }] };
        }
        prev = screen;
      }
      await sleep(400);
    }
    return errorText(`cmux_wait_ready: ${surface} not ready after ${limit}ms.\n--- last screen ---\n${prev ?? '(no output)'}`);
  },
);

// --- Notify / status -----------------------------------------------------

server.registerTool(
  'cmux_notify',
  {
    title: 'Post a notification',
    description: 'Show a cmux notification.',
    inputSchema: { title: z.string(), body: z.string().optional(), workspace: workspaceArg },
  },
  ({ title, body, workspace }) => {
    const args = ['notify', '--title', title];
    if (body) args.push('--body', body);
    return call(withWorkspace(args, workspace));
  },
);

// --- Browser -------------------------------------------------------------
// The browser surface has ~80 subcommands. Rather than mirror each one, expose a
// single passthrough — the agent already knows the `cmux browser` vocabulary from
// the skill, and this keeps the tool list readable.

server.registerTool(
  'cmux_browser',
  {
    title: 'Drive the embedded browser',
    description:
      'Run a `cmux browser` subcommand. Pass tokens as an args array, e.g. ["goto","https://x.com","--snapshot-after"] or ["click","button#submit"]. Common subcommands: open, goto, snapshot, screenshot, click, type, fill, eval, get, find, wait, back, reload.',
    inputSchema: {
      args: z.array(z.string()).min(1).describe('Tokens after "cmux browser".'),
    },
  },
  ({ args }) => call(['browser', ...args]),
);

// --- Escape hatch --------------------------------------------------------

server.registerTool(
  'cmux_raw',
  {
    title: 'Run any cmux command',
    description:
      'Escape hatch for cmux subcommands without a dedicated tool. Pass tokens after "cmux" as an array, e.g. ["new-split","right","--focus","true"]. Run ["help"] to discover commands.',
    inputSchema: { args: z.array(z.string()).min(1).describe('Tokens after "cmux".') },
  },
  ({ args }) => call(args),
);

// Open the socket now so the first tool call doesn't pay connect+auth latency.
prewarm();

const transport = new StdioServerTransport();
await server.connect(transport);
