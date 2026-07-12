import { test } from 'node:test';
import assert from 'node:assert/strict';

// RPC_DISABLED is a module-level const read from CMUX_NO_RPC at import time.
process.env.CMUX_NO_RPC = '1';
const { rpcEnabled, rpc } = await import('../dist/rpc.js');

test('rpcEnabled is false when CMUX_NO_RPC=1', () => {
  assert.equal(rpcEnabled(), false);
});

test('rpc rejects immediately when disabled, without touching the socket', async () => {
  await assert.rejects(() => rpc('system.identify', {}), /rpc disabled/);
});
