import { execFile } from 'node:child_process';

// The cmux binary ships inside the app bundle and is usually on PATH. Allow an
// override so the server works when it isn't.
const CMUX_BIN = process.env.CMUX_BIN || 'cmux';

// Where the user's pane lives. cmux defaults pane/workspace-spawning commands to
// the *focused* workspace, which drifts as the user clicks around. When the
// agent doesn't name a workspace, fall back to the one this process was launched
// in so panes land where the user is actually working.
export const DEFAULT_WORKSPACE = process.env.CMUX_WORKSPACE_ID || '';

export type CmuxResult = {
  ok: boolean;
  output: string;
};

export function runCmux(args: string[], timeoutMs = 30_000): Promise<CmuxResult> {
  return new Promise((resolve) => {
    execFile(
      CMUX_BIN,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // Silence the "X is now an alias for Y" deprecation notices that cmux
        // prints to stdout — they'd otherwise pollute every result.
        env: { ...process.env, CMUX_QUIET: '1' },
      },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({
              ok: false,
              output: `cmux binary not found (tried "${CMUX_BIN}"). Set CMUX_BIN to its path.`,
            });
            return;
          }
          resolve({ ok: false, output: out || String(err) });
          return;
        }
        resolve({ ok: true, output: out || '(no output)' });
      },
    );
  });
}

// Append --workspace only when a value resolves. An explicit arg wins over the
// launch-time default; passing neither lets cmux use the focused workspace.
export function withWorkspace(args: string[], workspace?: string): string[] {
  const ws = workspace || DEFAULT_WORKSPACE;
  return ws ? [...args, '--workspace', ws] : args;
}

// Append --workspace/--window only when explicitly given. No env fallback —
// these surface-targeting tools historically sent neither, letting cmux
// resolve against the caller's own context; that exact behavior must hold
// when both are omitted.
export function withTarget(args: string[], workspace?: string, window?: string): string[] {
  const a = [...args];
  if (workspace) a.push('--workspace', workspace);
  if (window) a.push('--window', window);
  return a;
}
