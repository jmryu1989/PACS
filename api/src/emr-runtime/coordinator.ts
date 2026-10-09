import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectedDirectory } from './journal-file';
import { executeExternal, WriterContext } from './external-writer';
import { lockFile } from './file-lock';

export interface WriterRequest { directory: string; operation: string; value?: any; context?: WriterContext }
export type WriterTransport = (request: WriterRequest) => any;

/** The process doing synchronous protected-state IO owns a persistent kernel lock descriptor.
 * Acquiring/releasing flock requires only a syscall, without spawning a process for each record.
 * Process death closes it and cannot leave a live stale writer.
 * Both streams, API, retention and journal use this inode, which is never unlinked or leased.
 * The transport is also the filesystem boundary for the bounded transaction model.
 */
export class StateCoordinator {
  readonly directory: string;
  private readonly context: WriterContext = {};
  private fd: number | undefined;
  readonly ownerId = randomUUID();
  private ownerFd: number | undefined;
  constructor(directory: string, private readonly transport?: WriterTransport) {
    protectedDirectory(directory, 'seal');
    this.directory = path.resolve(directory);
    if (!transport) {
      const owners = protectedDirectory(directory, 'owners');
      this.ownerFd = fs.openSync(path.join(owners, this.ownerId), 'wx', 0o600);
      lockFile(this.ownerFd, true);
    }
  }
  ownerAlive(owner: string): boolean {
    if (this.transport) return this.call('owner-alive', owner);
    if (owner === this.ownerId) return true;
    if (!/^[0-9a-f-]{36}$/.test(owner)) throw Object.assign(new Error('SealCorrupt'), { code: 'SealCorrupt' });
    let fd: number;
    try { fd = fs.openSync(path.join(this.directory, 'owners', owner), 'r'); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
    try { const free = lockFile(fd, true, true); if (free) lockFile(fd, false); return !free; }
    finally { fs.closeSync(fd); }
  }
  call<T = any>(operation: string, value?: any): T {
    const request = { directory: this.directory, operation, value, context: this.context };
    if (this.transport) return this.transport(request);
    if (process.platform !== 'linux') throw Object.assign(new Error('LinuxExternalWriterRequired'), { code: 'SealUnavailable' });
    this.fd ??= fs.openSync(path.join(this.directory, 'writer.lock'), 'a+', 0o600);
    lockFile(this.fd, true);
    try { return executeExternal(request); }
    catch (error: any) {
      if (/^(Seal|FailureJournal|EmrState)/.test(error.code || '') || error.name === 'ContractError') throw error;
      throw Object.assign(new Error('ExternalWriterUnavailable'), { code: 'SealUnavailable' });
    } finally { lockFile(this.fd, false); }
  }
}
