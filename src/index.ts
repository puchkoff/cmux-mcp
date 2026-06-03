#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCmux, withWorkspace } from './cmux.js';

const server = new McpServer({ name: 'cmux-mcp', version: '0.1.0' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function call(args: string[]): Promise<ToolResult> {
  const { ok, output } = await runCmux(args);
  return { content: [{ type: 'text', text: output }], isError: !ok };
}

const workspaceArg = z
  .string()
  .optional()
  .describe('Workspace ref like "workspace:26". Defaults to the workspace this server was launched in.');
const surfaceArg = z
  .string()
  .optional()
  .describe('Surface ref like "surface:40". Defaults to the current pane.');

// --- Inspect -------------------------------------------------------------

server.registerTool(
  'cmux_identify',
  {
    title: 'Identify current context',
    description: 'Return the caller and focused window/workspace/pane/surface refs as JSON.',
    inputSchema: {},
  },
  () => call(['identify']),
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
    description: 'Read the current screen (or scrollback) of a terminal surface.',
    inputSchema: {
      surface: surfaceArg,
      lines: z.number().int().positive().optional().describe('Limit to the last N lines.'),
      scrollback: z.boolean().optional().describe('Include scrollback history.'),
    },
  },
  ({ surface, lines, scrollback }) => {
    const args = ['read-screen'];
    if (surface) args.push('--surface', surface);
    if (lines) args.push('--lines', String(lines));
    if (scrollback) args.push('--scrollback');
    return call(args);
  },
);

// --- Panes & workspaces --------------------------------------------------

server.registerTool(
  'cmux_new_pane',
  {
    title: 'Split a new pane',
    description: 'Open a new pane (terminal or browser) by splitting in the given direction.',
    inputSchema: {
      direction: z.enum(['left', 'right', 'up', 'down']).default('right'),
      type: z.enum(['terminal', 'browser']).optional(),
      url: z.string().optional().describe('Initial URL for a browser pane.'),
      workspace: workspaceArg,
    },
  },
  ({ direction, type, url, workspace }) => {
    const args = ['new-pane', '--direction', direction];
    if (type) args.push('--type', type);
    if (url) args.push('--url', url);
    return call(withWorkspace(args, workspace));
  },
);

server.registerTool(
  'cmux_new_workspace',
  {
    title: 'Create a workspace',
    description: 'Create a new workspace, optionally with a title, cwd, and startup command.',
    inputSchema: {
      name: z.string().optional(),
      cwd: z.string().optional(),
      command: z.string().optional().describe('Command to run in the first pane.'),
    },
  },
  ({ name, cwd, command }) => {
    const args = ['new-workspace'];
    if (name) args.push('--name', name);
    if (cwd) args.push('--cwd', cwd);
    if (command) args.push('--command', command);
    return call(args);
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
  'cmux_focus_pane',
  {
    title: 'Focus a pane',
    description: 'Move focus to the given pane.',
    inputSchema: { pane: z.string().describe('Pane ref like "pane:38".'), workspace: workspaceArg },
  },
  ({ pane, workspace }) => call(withWorkspace(['focus-pane', '--pane', pane], workspace)),
);

server.registerTool(
  'cmux_close',
  {
    title: 'Close a surface or workspace',
    description: 'Close a surface (tab) or an entire workspace.',
    inputSchema: {
      kind: z.enum(['surface', 'workspace']),
      ref: z.string().describe('e.g. "surface:40" or "workspace:26".'),
    },
  },
  ({ kind, ref }) => call([`close-${kind}`, `--${kind}`, ref]),
);

// --- Input ---------------------------------------------------------------

server.registerTool(
  'cmux_send',
  {
    title: 'Send text to a pane',
    description:
      'Type literal text into a terminal surface. Does NOT press Enter — follow with cmux_send_key Enter.',
    inputSchema: { text: z.string(), surface: surfaceArg },
  },
  ({ text, surface }) => {
    const args = ['send'];
    if (surface) args.push('--surface', surface);
    args.push(text);
    return call(args);
  },
);

server.registerTool(
  'cmux_send_key',
  {
    title: 'Send a key to a pane',
    description: 'Send a named key such as Enter, Tab, Escape, C-c, C-d.',
    inputSchema: { key: z.string().describe('e.g. "Enter", "C-c".'), surface: surfaceArg },
  },
  ({ key, surface }) => {
    const args = ['send-key'];
    if (surface) args.push('--surface', surface);
    args.push(key);
    return call(args);
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

const transport = new StdioServerTransport();
await server.connect(transport);
