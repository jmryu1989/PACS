import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContractError, refuse } from '../emr-contract/validation';
import { syncDirectory } from '../emr-runtime/journal-file';

/*
 * CD-09-C: the append-only ledger file of a retention unit (the draft purpose ledger now; a later unit's beside it).
 *
 * What does not depend on the unit lives here: one header naming the ledger (the ID the database's anchor names), entries
 * in seq order under that ID inside a closed envelope, a line limit, a last line that ends with LF, fsync before an
 * append counts, and the directory synced when the file is created. Nothing here repairs, truncates or rewrites a line
 * (a file written again whole to make it durable holds the bytes it read, below): a damaged file is the unit's gate
 * question, and a repair would answer it. What a record says, and which records may
 * follow which, is the unit's decoder; refusal codes carry the unit's prefix (the runbook and the served tests read
 * them from the server's log).
 *
 * The mirror (KIN_LEDGER_MIRROR_DIR, 2026-11-06): a second copy of the same file in another directory, so that a lost or
 * damaged ledger file is not the end of the server. It is not a backup: an append writes the same bytes to the file and
 * then to the mirror, each fsynced, and counts only when both did; an append the mirror refused fails like any other
 * (the caller's failure path), and a header already in the file counts only once the mirror has it too (create). So the
 * mirror is behind the file only by what an append or create that answered failure wrote, which the next append, create
 * or start copies over from the file, and ahead of it only while it stands in for a lost file at the gate (below). A
 * mirror that is anything else (other bytes, or longer than the file) closes (`MirrorDiverged`): one of the two is not
 * this ledger, and the product cannot tell which. Only the gate reads the mirror for the file (readForGate), and only
 * after the unit's whole match passed does the mirror take the file's place (restoreFromMirror).
 *
 * Durable means this process's own fsync covered the bytes (r3 F1). Bytes a failed write left behind read back the same
 * as durable ones, and an fsync that failed once cannot simply be asked again: the kernel may already have dropped the
 * error with the dirty pages, so a second fsync of the same file can succeed over bytes that never reached the disk. A
 * place whose bytes this ledger object did not see made durable - after a write that failed, written by another process,
 * or in a new process (the gate, a sweep) - is therefore written again whole (replaceAtomically: new bytes, fsync, rename,
 * directory) before a create, an append or the gate counts on it, and the write refuses while that fails.
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

/** What restoreFromMirror is about to put in the file's place, and why: the unit records it before the file changes. */
export interface LedgerRestoration {
  ledgerId: string;
  entries: number;
  /** The length and sha256 of the mirror's bytes that take the file's place (the file's first bytes from then on). */
  bytes: number;
  sha256: string;
  /** The file's code: why the mirror stood in (`<unit>Missing`, `<unit>PartialTail`, ...). */
  reason: string;
  file: string;
  mirror: string;
  /** Where the damaged file is kept; null for a lost one. */
  keptAs: string | null;
}

export class AppendOnlyLedger<R> {
  readonly directory: string;
  /** The same file name in the mirror directory; null without a mirror (one file, as before the mirror). */
  readonly mirror: string | null;
  // The file's code while the mirror stands in for it at the gate (between readForGate and restoreFromMirror).
  private standIn: string | null = null;
  // Each place's length as of this object's last fsync that succeeded on it (its own write, or a whole rewrite).
  private readonly durable = new Map<string, number>();
  /** `codes` is the unit's prefix: `${codes}PartialTail`, `${codes}RecordInvalid`, ... */
  constructor(readonly file: string, private readonly codes: string, private readonly decoder: () => RecordDecoder<R>,
    private readonly io: LedgerIo = nodeLedgerIo, mirrorDirectory: string | null = null) {
    this.directory = path.dirname(file);
    this.mirror = mirrorDirectory ? path.join(mirrorDirectory, path.basename(file)) : null;
  }

  private fold(file: string = this.standIn ? this.mirror! : this.file): Folded<R> | null {
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

  /** Whether the mirror stands in for the file (the gate read it for a missing or unreadable file). */
  get standingIn(): string | null { return this.standIn; }

  /**
   * The gate's reading. A file that reads is the ledger: an absent mirror (one set up beside an existing ledger) or one
   * the file extends is brought up to it first, and any other mirror closes (`MirrorDiverged`). A missing or unreadable
   * file beside a mirror that reads: the mirror's view, standing in for the file (`standIn` is the file's own code), for
   * the unit to match with the database exactly like the file; until restoreFromMirror, reads and appends use the
   * mirror alone. A mirror that does not read either leaves the file's answer: its code, or - for a missing file beside
   * a mirror file, which only a ledger that existed leaves - `Missing`.
   *
   * Whatever the gate reads it first makes durable in this process (the file and the mirror, or the mirror standing in):
   * a start after a write whose fsync failed binds or opens nothing on bytes no fsync confirmed (r3 F1).
   */
  readForGate(): { view: LedgerView<R> | null; standIn: string | null } {
    this.standIn = null;
    let own: Folded<R> | null = null, failure: unknown = null;
    try { own = this.fold(this.file); } catch (error) { failure = error; }
    if (!this.mirror) { if (failure) throw failure; if (own) this.settle(own.bytes); return { view: own?.view ?? null, standIn: null }; }
    if (own) { this.settle(own.bytes); return { view: own.view, standIn: null }; }
    let mirrored: Folded<R> | null = null;
    try { mirrored = this.fold(this.mirror); } catch { mirrored = null; }
    if (!mirrored) {
      if (failure) throw failure;
      if (this.io.existsSync(this.mirror) && this.io.readFileSync(this.mirror).length) refuse(this.codes + 'Missing');
      return { view: null, standIn: null };
    }
    this.ensureDurable(this.mirror, mirrored.bytes, mirrored.bytes, 'MirrorWriteFailed');
    this.standIn = failure ? (failure instanceof ContractError ? failure.code : this.codes + 'Unreadable') : this.codes + 'Missing';
    return { view: mirrored.view, standIn: this.standIn };
  }

  /**
   * After the unit's whole gate passed on the mirror's view: the mirror's bytes (with whatever the gate appended to it)
   * take the file's place, whole (tmp, fsync, rename, directory). A damaged file is kept beside it under a new name;
   * nothing is deleted. Returns the file's code.
   *
   * `record` (the unit's audit row) is written first, and the file changes only after it resolved: a restore no record
   * names never happens (`RestoreUnrecorded`, the file left as it was). A restore that stops after its record (a crash,
   * `RestoreFailed`) leaves the file lost or damaged, so the next start stands the mirror in again and records again; the
   * record's length and sha256 tell which of them the file then holds. A record written after the file changed could be
   * lost with a crash between the two, and the next start would find a readable file with no trace of the restore.
   */
  async restoreFromMirror(record: (restoration: LedgerRestoration) => Promise<unknown>): Promise<string> {
    const reason = this.standIn;
    if (!reason || !this.mirror) throw new Error('LedgerNotStandingIn');
    const restored = this.fold(this.mirror)!;
    const keptAs = this.io.existsSync(this.file) ? `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
    try {
      await record({ ledgerId: restored.view.ledgerId, entries: restored.view.entries.length, bytes: restored.bytes.length,
        sha256: createHash('sha256').update(restored.bytes).digest('hex'), reason, file: this.file, mirror: this.mirror, keptAs });
    } catch { refuse(this.codes + 'RestoreUnrecorded'); }
    try {
      if (keptAs) this.io.renameSync(this.file, keptAs);
      replaceAtomically(this.directory, this.file, restored.bytes, this.io);
    } catch { refuse(this.codes + 'RestoreFailed'); }
    this.durable.set(this.file, restored.bytes.length);
    this.standIn = null;
    return reason;
  }

  /**
   * The header alone: the ledger the database's anchor names, written before the database records that it exists. A
   * header already there (an earlier create whose database write did not commit) is this ledger only once the mirror
   * has it too: the mirror is brought up to it here, or the create fails as the earlier one did - a database that records
   * a ledger kept in one place has lost the second copy it was promised. The same for durability: a header whose fsync
   * (or its directory's) failed reads back like one that succeeded, so it binds only once both places are durable here.
   */
  create(ledgerId: string): void {
    const current = this.fold();
    if (current) {
      if (current.view.ledgerId !== ledgerId) refuse(this.codes + 'Mismatch');
      this.settle(current.bytes);
      return;
    }
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

  /** The mirror's bytes when they are `own` (the file's bytes) or a prefix of them; anything else is `MirrorDiverged`. */
  private mirrorCopy(own: Buffer): Buffer | null {
    const copy = this.io.existsSync(this.mirror!) ? this.io.readFileSync(this.mirror!) : null;
    if (copy && (copy.length > own.length || !own.subarray(0, copy.length).equals(copy))) refuse(this.codes + 'MirrorDiverged');
    return copy;
  }

  /**
   * `file` holds `bytes`, durable as far as this object saw: kept when it holds them and this object's last fsync on it
   * covered exactly that length, otherwise written again whole (absent, behind, or bytes no fsync here confirmed).
   */
  private ensureDurable(file: string, current: Buffer | null, bytes: Buffer, failed: string): void {
    if (current?.equals(bytes) && this.durable.get(file) === bytes.length) return;
    this.durable.delete(file);
    try { replaceAtomically(path.dirname(file), file, bytes, this.io); } catch { refuse(this.codes + failed); }
    this.durable.set(file, bytes.length);
  }

  /**
   * Every place this ledger writes holds `own` (the ledger's bytes as read) durably: the file and the mirror brought up
   * to it, or - standing in - the mirror alone. The mirror is checked before anything is written.
   */
  private settle(own: Buffer): void {
    if (this.standIn) { this.ensureDurable(this.mirror!, own, own, 'WriteFailed'); return; }
    const copy = this.mirror ? this.mirrorCopy(own) : null;
    this.ensureDurable(this.file, own, own, 'WriteFailed');
    if (this.mirror) this.ensureDurable(this.mirror, copy, own, 'MirrorWriteFailed');
  }

  /** `before`: the ledger's bytes this text follows (empty for a header). */
  private write(text: string, created: boolean, before: Buffer): void {
    const bytes = Buffer.from(text);
    // A header starts both places; anything after it follows bytes made durable here first.
    if (!created) this.settle(before);
    else if (this.mirror) this.mirrorCopy(before);
    // Standing in, the mirror is the only ledger there is until the gate restores the file from it.
    if (this.standIn) { this.writeTo(this.mirror!, bytes, created, 'WriteFailed', before.length); return; }
    this.writeTo(this.file, bytes, created, 'WriteFailed', before.length);
    if (!this.mirror) return;
    try { this.writeTo(this.mirror, bytes, created, 'MirrorWriteFailed', before.length); }
    catch (error) { if (error instanceof ContractError) throw error; refuse(this.codes + 'MirrorWriteFailed'); }
  }

  /** `prior`: the place's length before this write, durable (write settled it first). */
  private writeTo(file: string, bytes: Buffer, created: boolean, failed: string, prior: number): void {
    const directory = path.dirname(file);
    // Until this write's fsync (and the directory's, for a new file) succeeded, the place holds bytes nothing confirmed.
    this.durable.delete(file);
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
    this.durable.set(file, prior + bytes.length);
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
