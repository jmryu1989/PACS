import { spawnSync } from 'node:child_process';

/** util-linux is already in the Debian runtime. The child locks the parent's open
 * file description through fd 3; its exit cannot release the parent's ownership.
 * Closing that descriptor releases it, including on process death. No shell or
 * request-controlled executable/arguments participate in this boundary. */
export function lockFile(fd: number, exclusive: boolean, probe = false): boolean {
  if (process.platform !== 'linux' || !Number.isInteger(fd) || fd < 0)
    throw Object.assign(new Error('LinuxExternalWriterRequired'), { code: 'SealUnavailable' });
  const result = spawnSync('/usr/bin/flock', [...(probe ? ['-n'] : []), exclusive ? '-x' : '-u', '3'],
    { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (probe && result.status === 1) return false;
  if (result.error || result.status !== 0) throw Object.assign(new Error('FileLockUnavailable'), { code: 'SealUnavailable' });
  return true;
}
