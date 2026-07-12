import { test } from 'node:test';
import assert from 'node:assert/strict';

// cmux.ts reads CMUX_BIN/CMUX_WORKSPACE_ID into module-level consts at import
// time, so they must be set (or cleared) before the (dynamic) import — this
// process is itself likely running inside a cmux pane with both set.
process.env.CMUX_BIN = '/no/such/cmux-binary';
delete process.env.CMUX_WORKSPACE_ID;
const { withWorkspace, runCmux } = await import('../dist/cmux.js');

test('withWorkspace appends --workspace when a value is passed', () => {
  assert.deepEqual(withWorkspace(['tree'], 'workspace:5'), ['tree', '--workspace', 'workspace:5']);
});

test('withWorkspace leaves args untouched with no workspace given', () => {
  assert.deepEqual(withWorkspace(['tree']), ['tree']);
});

test('runCmux reports a clear error when the binary is missing', async () => {
  const { ok, output } = await runCmux(['tree']);
  assert.equal(ok, false);
  assert.match(output, /cmux binary not found/);
});
