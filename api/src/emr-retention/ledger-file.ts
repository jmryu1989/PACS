import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContractError, refuse } from '../emr-contract/validation';
import { syncDirectory } from '../emr-runtime/journal-file';

/*
 * CD-09-C: the append-only ledger file of a retention unit (the draft purpose ledger now; a later unit's beside it).
 *
 * What does not depend on the unit lives here: one header naming the ledger (the ID the database's anchor names), entries
 * in seq order under that ID inside a closed envelope, a line limit, a last line that ends with LF, fsync before an
 * append counts, and the directory synced when the file is created. Nothing here repairs, truncates or rewrites a line:
 * a damaged file is the unit's gate question, and a repair would answer it. What a record says, and which records may
 * follow which, is the unit's decoder; refusal codes carry the unit's prefix (the runbook and the served tests read
 * them from the server's log).
 *
 * The mirror (KIN_LEDGER_MIRROR_DIR, 2026-11-06): a second copy of the same file in another directory, so that a lost or
 * damaged ledger file is not the end of the server. It is not a backup: an append writes the same bytes to the file and
 * then to the mirror, each fsynced, and counts only when both did; an append the mirror refused fails like any other
 * (the caller's failure path). So the mirror is never ahead of the file and is behind it only by the line of an append
 * that answered failure, which the next append or start copies over from the file. A mirror that is anything else (other
 * bytes, or longer than the file) closes (`MirrorDiverged`): one of the two is not this ledger, and the product cannot
 * tell which.
 *
 * The failure spool (emr-runtime/journal-file.ts) is a different thing - it is replayed and then truncated - so only its
 * directory sync is shared.
 */

const LINE_MAX = 4096;

/** The file calls a ledger makes; the deployment's are node:fs. */
export interface LedgerIo {
  existsSync(file: string): boolean;
  readFileSync(file: string): Buffer;
  mkdirSync(directory: string, options: { recursive: true; mode: number }): unknown;
  openSync(file: string, flags: string, mode: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  syncDirectory(directory: string): void;
}
export const nodeLedgerIo: LedgerIo = {
  existsSync: file => fs.existsSync(file),
  readFileSync: file => fs.readFileSync(file),
  mkdirSync: (directory, options) => fs.mkdirSync(directory, options),
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  fsyncSync: fd => fs.fsyncSync(fd),
  closeSync: fd => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  syncDirectory: directory => syncDirectory(directory),
};

/**
 * A unit's reading of its records, in file order. `decode` sees each record after every earlier one (so order rules -
 * which record may follow which - are the decoder's), and refuses with the unit's own code. `append` is a record about
 * to be written: the same rules, plus whatever the unit no longer writes.
 */
export interface RecordDecoder<R> { decode(value: unknown, mode: 'read' | 'append'): R }

export interface LedgerEntry<R> { seq: number; appendedAt: string; record: Readonly<R> }
export interface LedgerView<R> { ledgerId: string; entries: readonly LedgerEntry<R>[] }

function exactKeys(value: any, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

interface Folded<R> { view: LedgerView<R>; decoder: RecordDecoder<R>; bytes: Buffer }

export class AppendOnlyLedger<R> {
  readonly directory: string;
  /** The same file name in the mirror directory; null without a mirror (one file, as before the mirror). */
  readonly mirror: string | null;
  /** `codes` is the unit's prefix: `${codes}PartialTail`, `${codes}RecordInvalid`, ... */
  constructor(readonly file: string, private readonly codes: string, private readonly decoder: () => RecordDecoder<R>,
    private readonly io: LedgerIo = nodeLedgerIo, mirrorDirectory: string | null = null) {
    this.directory = path.dirname(file);
    this.mirror = mirrorDirectory ? path.join(mirrorDirectory, path.basename(file)) : null;
  }

  private fold(file: string = this.file): Folded<R> | null {
    if (!this.io.existsSync(file)) return null;
    const bytes = this.io.readFileSync(file);
    if (!bytes.length || bytes[bytes.length - 1] !== 10) refuse(this.codes + 'PartialTail');
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    let header: any;
    try { header = JSON.parse(lines[0]); } catch { refuse(this.codes + 'HeaderInvalid'); }
    if (!exactKeys(header, ['kind', 'formatVersion', 'ledgerId', 'createdAt']) || header.kind !== 'header' ||
        header.formatVersion !== 1 || typeof header.ledgerId !== 'string') refuse(this.codes + 'HeaderInvalid');
    const decoder = this.decoder();
    const entries = lines.slice(1).map((line, index) => {
      if (Buffer.byteLength(line) > LINE_MAX) refuse(this.codes + 'RecordInvalid');
      let entry: any;
      try { entry = JSON.parse(line); } catch { refuse(this.codes + 'RecordInvalid'); }
      if (!exactKeys(entry, ['kind', 'seq', 'ledgerId', 'appendedAt', 'record']) || entry.kind !== 'entry' ||
          entry.seq !== index + 1 || entry.ledgerId !== header.ledgerId || typeof entry.appendedAt !== 'string')
        refuse(this.codes + 'RecordInvalid');
      return Object.freeze({ seq: entry.seq, appendedAt: entry.appendedAt, record: Object.freeze(decoder.decode(entry.record, 'read')) });
    });
    return { view: Object.freeze({ ledgerId: header.ledgerId, entries: Object.freeze(entries) }), decoder, bytes };
  }

  read(): LedgerView<R> | null { return this.fold()?.view ?? null; }

  /** The header alone: the ledger the database's anchor names, written before the database records that it exists. */
  create(ledgerId: string): void {
    const current = this.read();
    if (current) { if (current.ledgerId !== ledgerId) refuse(this.codes + 'Mismatch'); return; }
    this.write(JSON.stringify({ kind: 'header', formatVersion: 1, ledgerId, createdAt: new Date().toISOString() }) + '\n', true,
      Buffer.alloc(0));
  }

  /** One record after every earlier one, durable when this returns. A missing file is refused (never created here). */
  append(ledgerId: string, record: R): { seq: number; durableAt: string } {
    const current = this.fold();
    if (!current) refuse(this.codes + 'Missing');
    if (current.view.ledgerId !== ledgerId) refuse(this.codes + 'Mismatch');
    const decoded = current.decoder.decode(JSON.parse(JSON.stringify(record)), 'append');
    const seq = current.view.entries.length + 1;
    const line = JSON.stringify({ kind: 'entry', seq, ledgerId, appendedAt: new Date().toISOString(), record: decoded });
    // A line the reader would refuse is never written: the ledger would stop being readable after it.
    if (Buffer.byteLength(line) > LINE_MAX) refuse(this.codes + 'RecordInvalid');
    this.write(line + '\n', false, current.bytes);
    return { seq, durableAt: new Date().toISOString() };
  }

  /** The mirror is the file's bytes: equal, or brought up to them when it is absent or a prefix of them. */
  private alignMirror(own: Buffer): void {
    const mirror = this.mirror!;
    const copy = this.io.existsSync(mirror) ? this.io.readFileSync(mirror) : null;
    if (copy ? copy.equals(own) : !own.length) return;
    if (copy && (copy.length > own.length || !own.subarray(0, copy.length).equals(copy))) refuse(this.codes + 'MirrorDiverged');
    try { replaceAtomically(path.dirname(mirror), mirror, own, this.io); }
    catch { refuse(this.codes + 'MirrorWriteFailed'); }
  }

  /** `before`: the file's bytes this text follows (empty for a header). */
  private write(text: string, created: boolean, before: Buffer): void {
    const bytes = Buffer.from(text);
    if (this.mirror) this.alignMirror(before);
    this.writeTo(this.file, bytes, created, 'WriteFailed');
    if (!this.mirror) return;
    try { this.writeTo(this.mirror, bytes, created, 'MirrorWriteFailed'); }
    catch (error) { if (error instanceof ContractError) throw error; refuse(this.codes + 'MirrorWriteFailed'); }
  }

  private writeTo(file: string, bytes: Buffer, created: boolean, failed: string): void {
    const directory = path.dirname(file);
    if (created) this.io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = this.io.openSync(file, 'a', 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        const n = this.io.writeSync(fd, bytes, written, bytes.length - written);
        // What was written stays: a partial last line is the reader's PartialTail, not something to undo here.
        if (!n) refuse(this.codes + failed);
        written += n;
      }
      this.io.fsyncSync(fd);
    } finally { this.io.closeSync(fd); }
    if (created) this.io.syncDirectory(directory);
  }
}

/** A small record replaced whole (the draft purpose adoption, a mirror brought up to its file): tmp, fsync, rename, then the directory. */
export function replaceAtomically(directory: string, file: string, text: string | Buffer, io: LedgerIo = nodeLedgerIo): void {
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  const bytes = Buffer.from(text);
  const fd = io.openSync(temporary, 'w', 0o600);
  try {
    let written = 0;
    while (written < bytes.length) {
      const n = io.writeSync(fd, bytes, written, bytes.length - written);
      if (!n) throw new Error('ReplaceWriteFailed');
      written += n;
    }
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  io.renameSync(temporary, file);
  io.syncDirectory(directory);
}

/**
 * A ledger directory: the deployment's own, absolute, and outside the backed-up state. There is no fallback - a ledger
 * inside a backed-up volume would come back with an older database and prove nothing - so `closed` is called with
 * 'DirectoryRequired' or 'InsideBackup' (the unit prefixes its code).
 */
export function ledgerDirectory(directory: string | undefined, backedUpState: string | undefined, closed: (code: string) => never): string {
  if (!directory || !path.isAbsolute(directory)) closed('DirectoryRequired');
  if (backedUpState && within(directory, backedUpState)) closed('InsideBackup');
  return directory;
}

/** `directory` is `parent` or under it. */
function within(directory: string, parent: string): boolean {
  const inside = path.relative(path.resolve(parent), path.resolve(directory));
  return !inside || (!inside.startsWith('..') && !path.isAbsolute(inside));
}

/**
 * The mirror directory (KIN_LEDGER_MIRROR_DIR): none when unset or empty (one file, as before the mirror). Otherwise
 * absolute, outside the backed-up state for the ledger's own reason, and apart from the ledger directory (the same file
 * twice, or one directory inside the other, is not a second copy): 'MirrorDirectoryRequired', 'MirrorInsideBackup',
 * 'MirrorInsideLedger' (the unit prefixes its code). Where it lives - the deployment's own volume on this host by default
 * - is the deployment's choice.
 */
export function ledgerMirrorDirectory(mirror: string | undefined, ledger: string, backedUpState: string | undefined,
    closed: (code: string) => never): string | null {
  if (!mirror) return null;
  if (!path.isAbsolute(mirror)) closed('MirrorDirectoryRequired');
  if (backedUpState && within(mirror, backedUpState)) closed('MirrorInsideBackup');
  if (within(mirror, ledger) || within(ledger, mirror)) closed('MirrorInsideLedger');
  return mirror;
}
