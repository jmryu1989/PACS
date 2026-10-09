import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { protectedDirectory } from './journal-file';

export interface WriterRequest { directory: string; operation: string; value?: any }
export type WriterTransport = (request: WriterRequest) => any;

/** All protected-state IO runs in the kernel-lock owner, never in a client holding a revocable lease.
 * Both streams, the API, retention and journal use this same lock inode. It is never unlinked.
 * Killing a client cannot release the worker's lock while that worker can still publish files.
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
  const result = spawnSync('flock', ['--exclusive', path.join(request.directory, 'writer.lock'), process.execPath,
    path.join(__dirname, 'external-writer.js')], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Object.assign(new Error('ExternalWriterUnavailable'), { code: 'SealUnavailable' });
  const response = JSON.parse(result.stdout);
  if (response.error) throw Object.assign(new Error(response.error), { code: response.error, detail: response.detail });
  return response.value;
}
