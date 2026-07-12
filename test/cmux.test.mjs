import { test } from 'node:test';
import assert from 'node:assert/strict';

// cmux.ts reads CMUX_BIN/CMUX_WORKSPACE_ID into module-level consts at import
// time, so they must be set (or cleared) before the (dynamic) import — this
// process is itself likely running inside a cmux pane with both set.
process.env.CMUX_BIN = '/no/such/cmux-binary';
delete process.env.CMUX_WORKSPACE_ID;
const { withWorkspace, withTarget, runCmux } = await import('../dist/cmux.js');

test('withWorkspace appends --workspace when a value is passed', () => {
  assert.deepEqual(withWorkspace(['tree'], 'workspace:5'), ['tree', '--workspace', 'workspace:5']);
});

test('withWorkspace leaves args untouched with no workspace given', () => {
  assert.deepEqual(withWorkspace(['tree']), ['tree']);
});

test('withTarget appends both flags when both are given', () => {
  assert.deepEqual(withTarget(['read-screen'], 'workspace:1', 'window:2'), [
    'read-screen',
    '--workspace',
    'workspace:1',
    '--window',
    'window:2',
  ]);
});

test('withTarget appends only --workspace when window is omitted', () => {
  assert.deepEqual(withTarget(['read-screen'], 'workspace:1'), ['read-screen', '--workspace', 'workspace:1']);
});

test('withTarget appends only --window when workspace is omitted', () => {
  assert.deepEqual(withTarget(['read-screen'], undefined, 'window:2'), ['read-screen', '--window', 'window:2']);
});

test('withTarget leaves args untouched, and does not mutate the input, when neither is given', () => {
  const input = ['read-screen'];
  assert.deepEqual(withTarget(input), ['read-screen']);
  assert.deepEqual(input, ['read-screen']); // withTarget must copy, not mutate, its input
});

test('runCmux reports a clear error when the binary is missing', async () => {
  const { ok, output } = await runCmux(['tree']);
  assert.equal(ok, false);
  assert.match(output, /cmux binary not found/);
});
