import { createConnection } from 'node:net';
import { parentPort } from 'node:worker_threads';
import { EMR_STATE_IPC_TIMEOUT_MS } from './limits';

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
