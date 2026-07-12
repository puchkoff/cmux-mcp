import { test } from 'node:test';
import assert from 'node:assert/strict';

// CMUX_BIN is read into a module-level const at import time (see cmux.test.mjs),
// so this needs its own process/import distinct from the ENOENT-path test —
// node --test already isolates each matched file into its own process.
process.env.CMUX_BIN = process.execPath; // point "cmux" at the node binary itself
const { runCmux } = await import('../dist/cmux.js');

test('runCmux resolves ok:true and returns trimmed stdout on success', async () => {
  // -e prints to stdout via the node binary standing in for cmux.
  const { ok, output } = await runCmux(['-e', "console.log('hello from fake cmux')"]);
  assert.equal(ok, true);
  assert.equal(output, 'hello from fake cmux');
});

test('runCmux merges stderr into the output on success', async () => {
  const { ok, output } = await runCmux(['-e', "console.error('warn'); console.log('out')"]);
  assert.equal(ok, true);
  assert.match(output, /warn/);
  assert.match(output, /out/);
});

test('runCmux resolves ok:false with the merged output on a non-zero exit', async () => {
  const { ok, output } = await runCmux(['-e', "console.error('boom'); process.exit(1)"]);
  assert.equal(ok, false);
  assert.match(output, /boom/);
});
