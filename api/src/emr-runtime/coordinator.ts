import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:net';
import { protectedDirectory } from './journal-file';
import { executeExternal, WriterContext } from './external-writer';
import { lockFile } from './file-lock';
import { StateClient } from './state-client';

export interface WriterRequest { directory: string; operation: string; value?: any; context?: WriterContext }
export type WriterTransport = (request: WriterRequest) => any;
interface Owner { fd: number; context: WriterContext; server?: Server }
const owners = new Map<string, Owner>();

/** One process owns the kernel fence for this protected state for its entire lifetime.
 * Other writers send state operations over local IPC. Their DB transactions and
 * role credentials stay in their own process. Both streams and journals share
 * this owner; its synchronous IO is serialized by its event loop.
 * Process death closes the fence. Its inode is never removed, replaced or leased.
 */
export class StateCoordinator {
  readonly directory: string;
  private readonly context: WriterContext = {};
  private owner: Owner | undefined;
  private client: StateClient | undefined;
  readonly ownerId = randomUUID();
  private ownerFd: number | undefined;
  constructor(directory: string, private readonly transport?: WriterTransport) {
    protectedDirectory(directory, 'seal');
    this.directory = path.resolve(directory);
    if (!transport) this.initialize();
  }
  private initialize(): void {
    const ownerDirectory = protectedDirectory(this.directory, 'owners');
    this.owner = owners.get(this.directory);
    let acquired = false;
    if (!this.owner) {
      const fd = fs.openSync(path.join(this.directory, 'writer.lock'), 'a+', 0o600);
      try {
        if (lockFile(fd, true, true)) { this.owner = { fd, context: this.context }; acquired = true; }
        else fs.closeSync(fd);
      } catch (error) { fs.closeSync(fd); throw error; }
    }
    try {
      // Registration also has a short kernel fence: a new peer cannot lose its
      // file between creation and locking while a replacement owner sweeps.
      const registration = fs.openSync(path.join(this.directory, 'owners.lock'), 'a+', 0o600);
      try {
        lockFile(registration, true);
        if (this.owner) for (const owner of fs.readdirSync(ownerDirectory)) {
          if (/^[0-9a-f-]{36}$/.test(owner) && !this.ownerAlive(owner)) fs.unlinkSync(path.join(ownerDirectory, owner));
        }
        if (this.ownerFd === undefined) {
          this.ownerFd = fs.openSync(path.join(ownerDirectory, this.ownerId), 'wx', 0o600);
          lockFile(this.ownerFd, true);
        }
      } finally { fs.closeSync(registration); }
      const socketPath = path.join(this.directory, 'writer.sock');
      if (acquired) {
        const old = fs.lstatSync(socketPath, { throwIfNoEntry: false });
        if (old) {
          if (!old.isSocket()) throw Object.assign(new Error('StateSocketRefused'), { code: 'SealUnavailable' });
          fs.unlinkSync(socketPath);
        }
        const owner = this.owner;
        const server = createServer(socket => {
          let bytes = '', done = false;
          socket.setEncoding('utf8'); socket.on('error', () => socket.destroy());
          socket.on('data', part => {
            if (done) return;
            bytes += part;
            if (!bytes.endsWith('\n')) return;
            done = true;
            let response: any;
            try {
              const request = JSON.parse(bytes);
              response = { ok: true, result: executeExternal({ directory: this.directory,
                operation: request.operation, value: request.value, context: owner.context }) };
            } catch (error: any) {
              response = { ok: false, error: { code: error.code ?? 'SealUnavailable', name: error.name,
                message: error.message, detail: error.detail } };
            }
            socket.end(JSON.stringify(response) + '\n');
          });
        });
        server.listen(socketPath); server.unref(); owner.server = server;
        owners.set(this.directory, owner);
      } else if (!this.owner) this.client ??= new StateClient(socketPath);
    } catch (error) {
      if (this.ownerFd !== undefined) { fs.closeSync(this.ownerFd); this.ownerFd = undefined; }
      if (acquired) { this.owner.server?.close(); fs.closeSync(this.owner.fd); this.owner = undefined; }
      throw error;
    }
  }
  private remote(operation: string, value?: any): any {
    // Reads and keyed journal operations are replay-safe: the journal returns
    // the original record for the same ID/body and refuses conflicting bodies.
    // Other disconnected mutations may already be durable; never infer success
    // or replay them unless the request had not connected.
    for (let attempt = 0; ; attempt++) {
      if (this.owner) return executeExternal({ directory: this.directory, operation, value, context: this.owner.context });
      try { return this.client.call(operation, value); }
      catch (error: any) {
        if (!error.ownerGone || (!error.beforeConnect && !['read', 'journal-load', 'journal-find', 'journal-record'].includes(operation)) || attempt >= 7) throw error;
        this.initialize();
        if (!this.owner) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  ownerAlive(owner: string): boolean {
    if (this.transport) return this.call('owner-alive', owner);
    if (owner === this.ownerId && this.ownerFd !== undefined) return true;
    if (!/^[0-9a-f-]{36}$/.test(owner)) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt' });
    let fd: number;
    try { fd = fs.openSync(path.join(this.directory, 'owners', owner), 'r'); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
    try { return !lockFile(fd, true, true); }
    finally { fs.closeSync(fd); }
  }
  call<T = any>(operation: string, value?: any): T {
    const request = { directory: this.directory, operation, value, context: this.context };
    if (this.transport) return this.transport(request);
    if (process.platform !== 'linux') throw Object.assign(new Error('LinuxExternalWriterRequired'), { code: 'SealUnavailable' });
    try {
      this.owner ??= owners.get(this.directory);
      if (this.owner) return executeExternal({ ...request, context: this.owner.context });
      if (typeof value !== 'function') return this.remote(operation, value);
      // Closures execute in the requesting role's process. Only the resulting
      // state patch crosses IPC, and a stale snapshot can never replace a newer
      // reservation. Retrying re-evaluates against the owner's verified state.
      for (;;) {
        const state = this.remote('read'), before = JSON.stringify(state), revision = state.revision;
        const result = value(state);
        if (JSON.stringify(state) === before) return { changed: false, result } as T;
        state.revision++;
        const installed = this.remote('compare-and-set', { before: revision, state, operation });
        if (installed.changed) return { changed: true, result } as T;
      }
    }
    catch (error: any) {
      if (/^(Seal|FailureJournal|EmrState)/.test(error.code || '') || error.name === 'ContractError') throw error;
      throw Object.assign(new Error('ExternalWriterUnavailable'), { code: 'SealUnavailable' });
    }
  }
}
