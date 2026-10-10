import * as path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

/** A synchronous protected-state client must not block its socket's event loop.
 * The worker transports JSON only; it never receives DB handles or credentials. */
export class StateClient {
  private worker: Worker | undefined;
  constructor(private readonly socketPath: string) {}
  call(operation: string, value?: unknown): any {
    this.worker ??= new Worker(path.join(__dirname, 'state-client-worker.js'));
    this.worker.unref();
    const signal = new Int32Array(new SharedArrayBuffer(4)), { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ socketPath: this.socketPath, operation, value, signal, reply: port2 }, [port2]);
      if (Atomics.wait(signal, 0, 0, 15000) === 'timed-out')
        throw Object.assign(new Error('StateOwnerUnavailable'), { code: 'SealUnavailable' });
      const response = receiveMessageOnPort(port1)?.message;
      if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? 'StateOwnerUnavailable'),
        response?.error ?? { code: 'SealUnavailable' });
      return response.result;
    } finally { port1.close(); }
  }
}
