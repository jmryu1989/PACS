import * as path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { EMR_STATE_IPC_TIMEOUT_MS } from './limits';

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
      if (Atomics.wait(signal, 0, 0, EMR_STATE_IPC_TIMEOUT_MS) === 'timed-out')
        throw Object.assign(new Error('StateOwnerUnavailable'), { code: 'SealUnavailable' });
      const response = receiveMessageOnPort(port1)?.message;
      if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? 'StateOwnerUnavailable'),
        response?.error ?? { code: 'SealUnavailable' });
      return response.result;
    } finally { port1.close(); }
  }
  /** The same request without blocking this thread: the reply port settles the promise (bounded by the same timeout). */
  callAsync(operation: string, value?: unknown): Promise<any> {
    this.worker ??= new Worker(path.join(__dirname, 'state-client-worker.js'));
    this.worker.unref();
    const signal = new Int32Array(new SharedArrayBuffer(4)), { port1, port2 } = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { port1.close();
        reject(Object.assign(new Error('StateOwnerUnavailable'), { code: 'SealUnavailable' })); }, EMR_STATE_IPC_TIMEOUT_MS + 100);
      port1.once('message', response => {
        clearTimeout(timer); port1.close();
        if (response?.ok) resolve(response.result);
        else reject(Object.assign(new Error(response?.error?.message ?? 'StateOwnerUnavailable'), response?.error ?? { code: 'SealUnavailable' }));
      });
      this.worker!.postMessage({ socketPath: this.socketPath, operation, value, signal, reply: port2 }, [port2]);
    });
  }
}
