import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caller, rpcEnabled } from '../dist/rpc.js';

test('caller returns an empty object when no caller env is set', () => {
  const prevWs = process.env.CMUX_WORKSPACE_ID;
  const prevSurf = process.env.CMUX_SURFACE_ID;
  delete process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_SURFACE_ID;
  try {
    assert.deepEqual(caller(), {});
  } finally {
    if (prevWs !== undefined) process.env.CMUX_WORKSPACE_ID = prevWs;
    if (prevSurf !== undefined) process.env.CMUX_SURFACE_ID = prevSurf;
  }
});

test('caller reads workspace_id/surface_id from the environment', () => {
  const prevWs = process.env.CMUX_WORKSPACE_ID;
  const prevSurf = process.env.CMUX_SURFACE_ID;
  process.env.CMUX_WORKSPACE_ID = 'workspace:7';
  process.env.CMUX_SURFACE_ID = 'surface:9';
  try {
    assert.deepEqual(caller(), { workspace_id: 'workspace:7', surface_id: 'surface:9' });
  } finally {
    if (prevWs === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = prevWs;
    if (prevSurf === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = prevSurf;
  }
});

test('rpcEnabled is true by default (not disabled, no cooldown tripped)', () => {
  assert.equal(rpcEnabled(), true);
});
