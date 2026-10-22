import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeExternal, inspectExternal, inspectFingerprint, WriterContext } from './external-writer';
import { lockFile } from './file-lock';

export interface WriterRequest { directory: string; operation: string; value?: any; context?: WriterContext }
export type WriterTransport = (request: WriterRequest) => any;

/** Local service primitive. No socket, peer registration, promotion or remote state patch exists here.
 * A successfully acquired descriptor deliberately survives close and startup failure: only process
 * death releases the fence, including when a timed-out continuation could still be running.
 */
export class StateCoordinator {
  readonly directory: string;
  readonly ownerId = randomUUID();
  private readonly context: WriterContext = {};
  private fd: number | undefined;
  private readonly rootIdentity: string;
  private closed = false;
  /** `options.format` is the owner's explicit entry mode (state-serve-v3 = 3, state-serve-v4 = 4; default 3): the
   * stored format must be exactly that one, or admission refuses before the fence is taken. */
  constructor(directory: string, private readonly transport?: WriterTransport, options: { format?: 3 | 4 } = {}) {
    if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) this.refuse();
    this.directory = path.resolve(directory);
    this.context.format = options.format ?? 3;
    // One validating admission of the directory's content; the re-checks across the fence compare bytes identities.
    inspectExternal(this.directory, undefined, this.context.format);
    const inspected = { fingerprint: inspectFingerprint(this.directory) };
    const root = fs.lstatSync(this.directory);
    this.rootIdentity = `${root.dev}:${root.ino}`;
    // Explicit transports are used by local storage components; they expose no deployable IPC path.
    if (transport) return;
    if (process.platform !== 'linux') this.refuse();
    if (!root?.isDirectory() || root.isSymbolicLink() || fs.realpathSync.native(this.directory) !== this.directory ||
      (root.mode & 0o077) !== 0 || root.uid !== process.getuid()) this.refuse();
    // Anchor lock creation to the directory we inspected. Replacing the pathname
    // must not create writer.lock in the replacement before its format is checked.
    const directoryFd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(directoryFd);
      if (`${opened.dev}:${opened.ino}` !== this.rootIdentity ||
        inspectFingerprint(this.directory) !== inspected.fingerprint) this.refuse();
      const file = `/proc/self/fd/${directoryFd}/writer.lock`;
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
          !lockFile(fd, true, true)) this.refuse();
        this.fd = fd;
      } catch (error) { fs.closeSync(fd); throw error; }
    } finally { fs.closeSync(directoryFd); }
    // A pre-lock observation is not a lease. Revalidate the exact target after
    // acquiring the fence; leave it held until process death even on refusal.
    if (inspectFingerprint(this.directory) !== inspected.fingerprint) this.refuse();
  }
  private refuse(): never { throw Object.assign(new Error('StateOwnerRefused'), { code: 'SealUnavailable' }); }
  get holdsWriterFence(): boolean { return !this.closed && this.fd !== undefined; }
  get format(): 3 | 4 { return this.context.format ?? 3; }
  call<T = any>(operation: string, value?: any): T {
    if (this.closed) return this.refuse();
    const root = fs.lstatSync(this.directory, { throwIfNoEntry: false });
    if (!root?.isDirectory() || root.isSymbolicLink() || `${root.dev}:${root.ino}` !== this.rootIdentity ||
      (process.platform === 'win32' ? fs.realpathSync.native(this.directory).toLowerCase() !== this.directory.toLowerCase() :
        fs.realpathSync.native(this.directory) !== this.directory)) return this.refuse();
    const request = { directory: this.directory, operation, value, context: this.context };
    if (this.transport) return this.transport(request);
    if (!this.holdsWriterFence) return this.refuse();
    return executeExternal(request);
  }
  /** Revoke all local IO first. Cached read/WAL handles are independent of the lifetime lock. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const handles = [this.context.log?.fd];
    this.context.log = undefined;
    const errors: unknown[] = [];
    for (const fd of new Set(handles)) if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (error) { errors.push(error); }
    }
    try { this.context.engine?.close(); } catch (error) { errors.push(error); }
    this.context.engine = undefined;
    if (errors.length) this.refuse();
  }
}
