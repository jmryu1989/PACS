import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { protectedDirectory } from './journal-file';
import { executeExternal } from './external-writer';

export interface WriterRequest { directory: string; operation: string; value?: any }
export type WriterTransport = (request: WriterRequest) => any;

/** The process doing synchronous protected-state IO owns the kernel lock's open file description.
 * flock(1) acquires it through an inherited descriptor; the parent retains that same description
 * until all writes/fsyncs finish. Process death closes it and cannot leave a live stale writer.
 * Both streams, API, retention and journal use this inode, which is never unlinked or leased.
 * The transport is also the filesystem boundary for the bounded transaction model.
 */
export class StateCoordinator {
  readonly directory: string;
  constructor(directory: string, private readonly transport: WriterTransport = nativeWriter) {
    protectedDirectory(directory, 'seal');
    this.directory = path.resolve(directory);
  }
  call<T = any>(operation: string, value?: any): T {
    return this.transport({ directory: this.directory, operation, value });
  }
}

function nativeWriter(request: WriterRequest): any {
  if (process.platform !== 'linux') throw Object.assign(new Error('LinuxExternalWriterRequired'), { code: 'SealUnavailable' });
  const fd = fs.openSync(path.join(request.directory, 'writer.lock'), 'a+', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    if (result.error || result.status !== 0) throw Object.assign(new Error('ExternalWriterUnavailable'), { code: 'SealUnavailable' });
    try { return executeExternal(request); }
    catch (error: any) {
      if (/^(Seal|FailureJournal|EmrState)/.test(error.code || '') || error.name === 'ContractError') throw error;
      throw Object.assign(new Error('ExternalWriterUnavailable'), { code: 'SealUnavailable' });
    }
  } finally { fs.closeSync(fd); }
}
