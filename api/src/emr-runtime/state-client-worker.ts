import { createConnection, type Socket } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { EMR_STATE_IPC_TIMEOUT_MS, EMR_STATE_MAX_OPERATIONS } from './limits';
import { encodeStateFrame, parseStateRequest, parseStateResponse, StateFrameReader, StateProtocolError,
  type StateRequest, type StateErrorCode, type StateOutcome } from './state-protocol';
import type { StateEndpoint } from './state-client';

if (workerData?.endpoint) asynchronousTransport(workerData.endpoint);
else legacyTransport();

function asynchronousTransport(endpoint: StateEndpoint): void {
  const pending = new Map<string, { cancel: () => void }>();
  const sockets = new Set<Socket>();
  const tasks = new Set<Promise<void>>();
  let closed = false, control: Socket | undefined, sessionOpened = false;
  const postFailure = (id: string, code: StateErrorCode, outcome: StateOutcome) =>
    parentPort.postMessage({ type: 'failure', id, error: { code, outcome } });
  function lost(): void {
    if (closed) return;
    parentPort.postMessage({ type: 'loss' });
    void close();
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const operation of pending.values()) operation.cancel();
    for (const socket of sockets) socket.destroy();
    // Path checks already started before quiesce are still owned and must settle.
    await Promise.allSettled([...tasks]);
    await Promise.all([...sockets].map(socket => new Promise<void>(resolve => {
      if (socket.closed) resolve(); else socket.once('close', resolve);
    })));
    parentPort.close();
  }
  parentPort.on('message', message => {
    if (message?.type === 'close') { void close(); return; }
    if (message?.type === 'cancel') { pending.get(message.id)?.cancel(); return; }
    if (message?.type !== 'request' || closed) return;
    let request: StateRequest;
    try { request = parseStateRequest(message.request, endpoint.role); }
    catch { postFailure(message.request?.requestId, 'PROTOCOL', 'not-started'); return; }
    if (tasks.size >= EMR_STATE_MAX_OPERATIONS) { postFailure(request.requestId, 'OVERLOADED', 'not-started'); return; }
    if (request.operation === 'hello' ? sessionOpened || !!control : !sessionOpened || !control) {
      postFailure(request.requestId, 'SESSION', 'not-started'); return;
    }
    const task = run(request);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  async function run(request: StateRequest): Promise<void> {
    let connected = false, finished = false, socket: Socket | undefined;
    const reader = new StateFrameReader();
    let settle: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const finish = (code?: StateErrorCode, response?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer); pending.delete(request.requestId);
      if (code) postFailure(request.requestId, code, connected ? 'unknown' : 'not-started');
      else parentPort.postMessage({ type: 'result', id: request.requestId, response });
      if (request.operation !== 'hello' || code) socket?.destroy();
      settle();
    };
    const timer = setTimeout(() => finish('TIMEOUT'), EMR_STATE_IPC_TIMEOUT_MS);
    pending.set(request.requestId, { cancel: () => finish('CLOSED') });
    try {
      await verifyEndpoint(endpoint);
      if (closed || finished) { finish('CLOSED'); return; }
      socket = createConnection({ path: endpoint.path, allowHalfOpen: true });
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        if (socket === control) lost();
        if (!finished) finish('UNAVAILABLE');
      });
      socket.on('error', () => { finish('UNAVAILABLE'); lost(); });
      socket.on('connect', () => {
        if (closed || finished) { socket.destroy(); return; }
        connected = true;
        const frame = encodeStateFrame(request);
        if (request.operation === 'hello') { control = socket; socket.write(frame); }
        else socket.end(frame);
      });
      socket.on('data', part => {
        try {
          if (reader.push(part) && request.operation === 'hello') {
            const response = parseStateResponse(reader.finish(), request);
            if (response.ok) sessionOpened = true;
            finish(undefined, response);
            if (!response.ok) lost();
          }
        } catch { finish('PROTOCOL'); lost(); }
      });
      socket.on('end', () => {
        if (request.operation === 'hello') { finish('UNAVAILABLE'); lost(); return; }
        try { finish(undefined, parseStateResponse(reader.finish(), request)); }
        catch (error) { finish(error instanceof StateProtocolError ? error.code : 'PROTOCOL'); lost(); }
      });
      await done;
    } catch {
      finish('UNAVAILABLE'); lost();
    }
  }
}

async function verifyEndpoint(endpoint: StateEndpoint): Promise<void> {
  if (!['api', 'retention'].includes(endpoint.role) || !Number.isSafeInteger(endpoint.ownerUid) || endpoint.ownerUid <= 0 ||
    !Number.isSafeInteger(endpoint.groupId) || endpoint.groupId <= 0) throw new Error('endpoint');
  if (process.platform === 'win32') {
    // Local transport tests exercise named pipes only; they make no Unix permission/fence claim.
    if (!/^\\\\\.\\pipe\\kin-emr-[a-zA-Z0-9-]+$/.test(endpoint.path)) throw new Error('named-pipe');
    return;
  }
  if (process.platform !== 'linux' || !path.isAbsolute(endpoint.path) || endpoint.path.includes('\0') ||
    path.normalize(endpoint.path) !== endpoint.path) throw new Error('endpoint');
  const parent = path.dirname(endpoint.path);
  const [directory, socket, canonical] = await Promise.all([lstat(parent), lstat(endpoint.path), realpath(parent)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || canonical !== parent ||
    directory.uid !== endpoint.ownerUid || directory.gid !== endpoint.groupId || (directory.mode & 0o777) !== 0o750 ||
    !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== endpoint.ownerUid || socket.gid !== endpoint.groupId ||
    (socket.mode & 0o777) !== 0o660) throw new Error('endpoint-permissions');
}

function legacyTransport(): void {

// A fresh connection per operation cannot retain a dead owner's authority. The
// kernel fence protects the replacement socket and every operation it accepts.
parentPort.on('message', ({ socketPath, operation, value, signal, reply }) => {
  const socket = createConnection(socketPath);
  let bytes = '', finished = false, connected = false;
  const finish = (response: any) => {
    if (finished) return;
    finished = true; socket.destroy();
    reply.postMessage(response); reply.close();
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  };
  const unavailable = (ownerGone = false) => finish({ ok: false, error: { code: 'SealUnavailable',
    message: 'StateOwnerUnavailable', ownerGone, beforeConnect: !connected } });
  socket.setTimeout(EMR_STATE_IPC_TIMEOUT_MS, () => unavailable());
  socket.on('error', () => unavailable(true)); socket.on('end', () => { if (!finished) unavailable(true); });
  socket.on('connect', () => { connected = true; socket.write(JSON.stringify({ operation, value }) + '\n'); });
  socket.setEncoding('utf8');
  socket.on('data', part => {
    bytes += part;
    if (!bytes.endsWith('\n')) return;
    try { finish(JSON.parse(bytes)); } catch { unavailable(); }
  });
});
}
