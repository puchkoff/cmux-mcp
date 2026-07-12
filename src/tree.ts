// Pure traversal over the window > workspace > pane > surface shape returned
// by both `system.tree` (RPC) and `cmux tree --all --json` (CLI fallback) —
// see fullTree() in index.ts, which is the only caller.

export type TreeSurface = { ref: string };
export type TreePane = { ref: string; surfaces?: TreeSurface[] };
export type TreeWorkspace = { ref: string; panes?: TreePane[] };
export type TreeWindow = { workspaces?: TreeWorkspace[] };

// Which workspace ref a surface lives in.
export function findSurfaceWorkspace(windows: TreeWindow[], surface: string): string | null {
  for (const w of windows)
    for (const ws of w.workspaces ?? [])
      for (const p of ws.panes ?? [])
        for (const s of p.surfaces ?? []) if (s.ref === surface) return ws.ref;
  return null;
}

// Resolve a pane:N or surface:N ref to the workspace it lives in and the pane
// to focus (a surface ref resolves to its containing pane).
export function findAnchor(windows: TreeWindow[], ref: string): { workspace: string; pane: string } | null {
  for (const w of windows)
    for (const ws of w.workspaces ?? [])
      for (const p of ws.panes ?? []) {
        if (ref.startsWith('pane:') && p.ref === ref) return { workspace: ws.ref, pane: ref };
        if (ref.startsWith('surface:') && p.ref)
          for (const s of p.surfaces ?? [])
            if (s.ref === ref) return { workspace: ws.ref, pane: p.ref };
      }
  return null;
}
