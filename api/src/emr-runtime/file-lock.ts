/** A fixed N-API binding built with the image. It exposes flock(2) only; no request
 * text, filenames, executable names or module paths reach the native boundary. */
export function lockFile(fd: number, exclusive: boolean, probe = false): boolean {
  const binding = require('../../native/flock.node');
  return binding.flock(fd, exclusive, probe);
}
