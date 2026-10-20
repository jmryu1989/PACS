import * as path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { EMR_CLEANUP_TIMEOUT_MS, EMR_STATE_IPC_TIMEOUT_MS, EMR_STATE_MAX_OPERATIONS } from './limits';
import { encodeStateFrame, parseStateRequest, parseStateResponse, StateProtocolError, type HelloResult,
  type StateErrorCode, type StateOperation, type StateRequest, type StateResults,
  type StateRole, type StateValues } from './state-protocol';

/** Fixed by deployment, never supplied over IPC. Clients have no writable socket parent. */
export interface StateEndpoint { path: string; role: StateRole; ownerUid: number; groupId: number }
interface Pending {
  request: StateRequest;
  resolve: (value: any) => void;
  reject: (error: StateProtocolError) => void;
  timer: NodeJS.Timeout;
}

/** The asynchronous service path owns a persistent control session and a finite set of worker operations.
 * The worker transports typed JSON only; it never receives DB handles or credentials. */
export class StateClient {
  private worker: Worker | undefined;
  private readonly socketPath: string;
  private readonly endpoint: StateEndpoint | undefined;
  private readonly pending = new Map<string, Pending>();
  private session: (HelloResult & { serviceEpoch: string; clientInstanceId: string }) | undefined;
  private opening: Promise<HelloResult & { serviceEpoch: string; clientInstanceId: string }> | undefined;
  private openingClient: string | undefined;
  private ended = false;
  private closeTask: Promise<void> | undefined;
  private workerExit: Promise<void> | undefined;
  private readonly loss = new AbortController();
  /** String construction exists only for the legacy local-component path, removed with its coordinator consumer. */
  constructor(endpoint: string | StateEndpoint) {
    this.socketPath = typeof endpoint === 'string' ? endpoint : endpoint.path;
    this.endpoint = typeof endpoint === 'string' ? undefined : Object.freeze({ ...endpoint });
  }
  get unavailable(): AbortSignal { return this.loss.signal; }

  openSession(clientInstanceId: string): Promise<HelloResult & { serviceEpoch: string; clientInstanceId: string }> {
    if (this.ended || !this.endpoint) return Promise.reject(new StateProtocolError('CLOSED', 'not-started'));
    if (this.opening) return this.openingClient === clientInstanceId ? this.opening :
      Promise.reject(new StateProtocolError('SESSION', 'not-started'));
    const request = parseStateRequest({ v: 1, requestId: randomUUID(), serviceEpoch: null, session: null,
      workId: null, operation: 'hello', value: { protocol: 1, clientInstanceId } }, this.endpoint.role);
    this.openingClient = clientInstanceId;
    this.opening = this.send(request).then(result => {
      if (this.ended) throw new StateProtocolError('CLOSED', 'unknown');
      return this.session = Object.freeze({ ...result.result, serviceEpoch: result.serviceEpoch, clientInstanceId });
    }).catch(error => { this.fail(error.code ?? 'UNAVAILABLE'); throw error; });
    return this.opening;
  }

  async callAsync<O extends Exclude<StateOperation, 'hello'>>(operation: O, workId: string | null,
    value: StateValues[O]): Promise<StateResults[O]> {
    if (this.ended || !this.session) throw new StateProtocolError('CLOSED', 'not-started');
    if (value.clientInstanceId !== this.session.clientInstanceId ||
      value.chains.viewing !== this.session.chains.viewing || value.chains.history !== this.session.chains.history)
      throw new StateProtocolError('SESSION', 'not-started');
    const request = parseStateRequest({ v: 1, requestId: randomUUID(), serviceEpoch: this.session.serviceEpoch,
      session: this.session.session, workId, operation, value }, this.endpoint.role);
    const response = await this.send(request);
    if (this.ended) throw new StateProtocolError('CLOSED', 'unknown');
    return response.result;
  }

  private startWorker(): void {
    if (this.worker) return;
    const worker = this.worker = new Worker(path.join(__dirname, 'state-client-worker.js'), {
      workerData: { endpoint: this.endpoint },
    });
    // An open session owns its worker. Only close/exit proves release; unref is not drain accounting.
    this.workerExit = new Promise(resolve => worker.once('exit', () => { this.fail('UNAVAILABLE'); resolve(); }));
    worker.on('error', () => this.fail('UNAVAILABLE'));
    worker.on('message', message => {
      if (message?.type === 'loss') { this.fail('UNAVAILABLE'); return; }
      if (message?.type !== 'result' && message?.type !== 'failure') { this.fail('PROTOCOL'); return; }
      const pending = this.pending.get(message.id);
      // A parent deadline may have retired the call before its worker cancellation arrived.
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      try {
        if (message.type === 'failure') {
          const response = parseStateResponse({ v: 1, requestId: message.id, serviceEpoch: pending.request.serviceEpoch,
            ok: false, error: message.error }, pending.request);
          if (response.ok === false) throw new StateProtocolError(response.error.code, response.error.outcome);
        }
        const response = parseStateResponse(message.response, pending.request);
        if (response.ok === false) throw new StateProtocolError(response.error.code, response.error.outcome);
        pending.resolve(response);
      } catch (error) {
        const failure = error instanceof StateProtocolError ? error : new StateProtocolError('PROTOCOL', 'unknown');
        pending.reject(failure);
        if (['PROTOCOL', 'EPOCH', 'SESSION', 'CLOSED'].includes(failure.code)) this.fail(failure.code);
      }
    });
  }

  private send(request: StateRequest): Promise<any> {
    if (this.ended) return Promise.reject(new StateProtocolError('CLOSED', 'not-started'));
    if (this.pending.size >= EMR_STATE_MAX_OPERATIONS) return Promise.reject(new StateProtocolError('OVERLOADED', 'not-started'));
    // Encode before any worker acquisition, and copy only the validated immutable request.
    encodeStateFrame(request);
    this.startWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        this.worker.postMessage({ type: 'cancel', id: request.requestId });
        reject(new StateProtocolError('TIMEOUT', 'unknown'));
      }, EMR_STATE_IPC_TIMEOUT_MS);
      this.pending.set(request.requestId, { request, resolve, reject, timer });
      try { this.worker.postMessage({ type: 'request', request }); }
      catch { this.fail('UNAVAILABLE'); }
    });
  }

  private fail(code: StateErrorCode): void {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new StateProtocolError(code, 'unknown')); }
    this.pending.clear(); this.loss.abort(new StateProtocolError(code, 'unavailable'));
    void this.close().catch(() => { /* The owner awaits the same rejected close promise at teardown. */ });
  }

  /** The caller includes this promise in its shared cleanup budget. No new session can ever open on this object. */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new StateProtocolError('CLOSED', 'unknown')); }
    this.pending.clear();
    this.closeTask = (async () => {
      if (!this.worker) return;
      if (!this.endpoint) { await this.worker.terminate(); return; }
      this.worker.postMessage({ type: 'close' });
      let timer: NodeJS.Timeout;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StateProtocolError('TIMEOUT', 'unknown')), EMR_CLEANUP_TIMEOUT_MS);
      });
      try { await Promise.race([this.workerExit, expired]); }
      catch (error) { await this.worker.terminate(); throw error; }
      finally { clearTimeout(timer); }
    })();
    return this.closeTask;
  }

  call(operation: string, value?: unknown): any {
    if (this.endpoint || this.ended) throw new StateProtocolError('FORBIDDEN', 'not-started');
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
}
