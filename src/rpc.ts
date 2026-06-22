import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// cmux's CLI is a thin client over a Unix socket speaking newline-delimited
// JSON-RPC. Spawning that 55MB binary costs ~150ms per call (almost all process
// start-up); talking to the socket from this long-lived process is ~5ms. We keep
// one persistent, authenticated connection and reuse it for every request.
//
// Every code path here is best-effort: any failure (no socket, auth required,
// timeout, unexpected wire data) rejects so the caller can fall back to the CLI.
// That keeps behaviour identical to the spawn-per-call version when the fast path
// is unavailable.

const SOCKET_PATH =
  process.env.CMUX_SOCKET_PATH || path.join(os.homedir(), '.local/state/cmux/cmux.sock');

// Explicit kill switch for debugging / forcing the CLI path.
const RPC_DISABLED = process.env.CMUX_NO_RPC === '1';

const REQUEST_TIMEOUT_MS = 10_000;
// After a connection failure, stop hammering the socket and let calls fall
// straight through to the CLI for a while.
const COOLDOWN_MS = 30_000;

type Pending = { resolve: (v: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type RpcResponse = {
  ok?: boolean;
  result?: any;
  error?: { code?: string; message?: string };
};

let socket: net.Socket | null = null;
let ready: Promise<void> | null = null;
let buffer = '';
let cooldownUntil = 0;
const pending = new Map<string, Pending>();

// The caller context cmux injects into params from the terminal's environment.
// Methods resolve bare refs ("workspace:8") against this when no target is given.
export function caller(): { workspace_id?: string; surface_id?: string } {
  const ctx: { workspace_id?: string; surface_id?: string } = {};
  if (process.env.CMUX_WORKSPACE_ID) ctx.workspace_id = process.env.CMUX_WORKSPACE_ID;
  if (process.env.CMUX_SURFACE_ID) ctx.surface_id = process.env.CMUX_SURFACE_ID;
  return ctx;
}

export function rpcEnabled(): boolean {
  return !RPC_DISABLED && Date.now() >= cooldownUntil;
}

function failAllPending(err: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function teardown(err: Error): void {
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
  ready = null;
  buffer = '';
  cooldownUntil = Date.now() + COOLDOWN_MS;
  failAllPending(err);
}

// Lines after the auth handshake are JSON responses keyed by request id.
function onData(chunk: Buffer): void {
  buffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: RpcResponse & { id?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON (e.g. stray notices)
    }
    const id = msg.id;
    if (!id) continue;
    const p = pending.get(id);
    if (!p) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }
}

// Connect, authenticate, and resolve once the socket is ready for requests. The
// first line the server sends back is the auth result ("OK: ..."); we gate all
// requests behind it.
function connect(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    let authed = false;
    const fail = (e: Error) => {
      teardown(e);
      reject(e);
    };
    sock.once('error', fail);
    sock.on('close', () => teardown(new Error('cmux socket closed')));
    sock.on('connect', () => {
      // Local sockets reply "Authentication not required" and accept any token;
      // a secured socket needs the real password from the environment.
      const token = process.env.CMUX_SOCKET_PASSWORD || 'mcp';
      sock.write(`auth ${token}\n`);
    });
    sock.on('data', (chunk: Buffer) => {
      if (!authed) {
        const nl = (buffer + chunk.toString('utf8')).indexOf('\n');
        buffer += chunk.toString('utf8');
        if (nl < 0) return; // wait for the full auth line
        const authLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!/^OK/i.test(authLine)) {
          fail(new Error(`cmux socket auth refused: ${authLine}`));
          return;
        }
        authed = true;
        sock.removeListener('error', fail);
        sock.on('error', (e) => teardown(e));
        socket = sock;
        resolve();
        if (buffer.includes('\n')) onData(Buffer.alloc(0)); // drain anything buffered
        return;
      }
      onData(chunk);
    });
  });
  return ready;
}

// Send one JSON-RPC request over the shared connection. Rejects on any transport
// or timeout failure so the caller can fall back to spawning the CLI.
export async function rpc(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
  if (!rpcEnabled()) throw new Error('cmux rpc disabled');
  await connect();
  const sock = socket;
  if (!sock) throw new Error('cmux socket unavailable');
  const id = randomUUID();
  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cmux rpc timeout: ${method}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    sock.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
