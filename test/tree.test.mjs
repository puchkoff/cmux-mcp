import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSurfaceWorkspace, findAnchor } from '../dist/tree.js';

// Shape mirrors real `cmux tree --all --json` output (and RPC system.tree).
const windows = [
  {
    workspaces: [
      {
        ref: 'workspace:1',
        panes: [
          { ref: 'pane:1', surfaces: [{ ref: 'surface:1' }] },
        ],
      },
      {
        ref: 'workspace:2',
        panes: [
          { ref: 'pane:2', surfaces: [{ ref: 'surface:2' }, { ref: 'surface:3' }] },
        ],
      },
    ],
  },
];

test('findSurfaceWorkspace finds the owning workspace', () => {
  assert.equal(findSurfaceWorkspace(windows, 'surface:2'), 'workspace:2');
  assert.equal(findSurfaceWorkspace(windows, 'surface:3'), 'workspace:2');
});

test('findSurfaceWorkspace returns null for an unknown surface', () => {
  assert.equal(findSurfaceWorkspace(windows, 'surface:999'), null);
});

test('findAnchor resolves a pane ref directly', () => {
  assert.deepEqual(findAnchor(windows, 'pane:2'), { workspace: 'workspace:2', pane: 'pane:2' });
});

test('findAnchor resolves a surface ref to its containing pane', () => {
  assert.deepEqual(findAnchor(windows, 'surface:1'), { workspace: 'workspace:1', pane: 'pane:1' });
});

test('findAnchor returns null for an unknown ref', () => {
  assert.equal(findAnchor(windows, 'pane:999'), null);
  assert.equal(findAnchor(windows, 'surface:999'), null);
});

test('findSurfaceWorkspace/findAnchor tolerate missing workspaces/panes/surfaces', () => {
  assert.equal(findSurfaceWorkspace([{}], 'surface:1'), null);
  assert.equal(findAnchor([{ workspaces: [{ ref: 'workspace:1' }] }], 'pane:1'), null);
});
