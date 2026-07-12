import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// SOCKET_PATH is a module-level const read from CMUX_SOCKET_PATH at import
// time; point it at a path nothing is listening on so connect() genuinely
// fails, exercising the real cooldown behavior rather than a mocked one.
process.env.CMUX_SOCKET_PATH = path.join(os.tmpdir(), `cmux-mcp-test-no-socket-${process.pid}.sock`);
const { rpc, rpcEnabled } = await import('../dist/rpc.js');

test('a real connect failure rejects the call and trips the cooldown', async () => {
  assert.equal(rpcEnabled(), true); // nothing tripped yet
  await assert.rejects(() => rpc('system.identify', {}));
  assert.equal(rpcEnabled(), false); // cooldown now active — caller should fall back to the CLI
});
