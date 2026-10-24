import * as fs from 'node:fs';
import * as path from 'node:path';
import { EMR_PENDING_LIMIT } from './limits';

// Existing B1 spool and record limits. This file contains only outage failures.
export const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_MAX_BYTES = 4096;
export const JOURNAL_CAUSES = ['business-rollback', 'ledger-refused', 'ledger-unreachable', 'commit-unknown', 'cancelled', 'capacity'] as const;
export interface JournalRecord {
  id: string; operationId: string | null; eventId: string | null;
  at: string; cause: typeof JOURNAL_CAUSES[number];
}
export class JournalUnavailable extends Error {
  constructor(readonly code: string) { super(code); }
}
export function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function parse(line: string): JournalRecord {
  const r = JSON.parse(line);
  if (!r || Object.keys(r).sort().join(',') !== 'at,cause,eventId,id,operationId'
    || typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.id)
    || (r.operationId !== null && (typeof r.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.operationId)))
    || (r.eventId !== null && typeof r.eventId !== 'string')
    || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)) || !JOURNAL_CAUSES.includes(r.cause))
    throw new JournalUnavailable('FailureSpoolRecordInvalid');
  return r;
}

/** One ordinary API writer. Serial replay/append, bounded reads, fsync before
 * acceptance. The spool never reserves attempts or decides their outcome. */
export class FailureSpool {
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  constructor(directory: string) {
    if (!directory || !path.isAbsolute(directory)) throw new JournalUnavailable('FailureSpoolDirectoryRequired');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'failure-spool.jsonl');
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(directory);
  }
  private run<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new JournalUnavailable('FailureSpoolClosed'));
    if (this.queued >= EMR_PENDING_LIMIT) return Promise.reject(new JournalUnavailable('FailureSpoolBusy'));
    this.queued++;
    const next = this.tail.then(work).finally(() => { this.queued--; });
    this.tail = next.catch(() => undefined);
    return next;
  }
  append(record: JournalRecord): Promise<void> {
    return this.run(() => {
      const bytes = Buffer.from(JSON.stringify(parse(JSON.stringify(record))) + '\n');
      if (bytes.length > RECORD_MAX_BYTES) throw new JournalUnavailable('FailureSpoolRecordTooLarge');
      const fd = fs.openSync(this.file, 'a+');
      try {
        const size = fs.fstatSync(fd).size;
        if (size + bytes.length > JOURNAL_MAX_BYTES) throw new JournalUnavailable('FailureSpoolFull');
        if (size) {
          const end = Buffer.alloc(1); fs.readSync(fd, end, 0, 1, size - 1);
          if (end[0] !== 10) throw new JournalUnavailable('FailureSpoolPartialTail');
        }
        let written = 0;
        while (written < bytes.length) {
          const n = fs.writeSync(fd, bytes, written, bytes.length - written);
          if (!n) throw new JournalUnavailable('FailureSpoolWriteFailed');
          written += n;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    });
  }
  replay(importRecord: (record: JournalRecord) => Promise<void>): Promise<number> {
    return this.run(async () => {
      const fd = fs.openSync(this.file, 'r+');
      let pending = Buffer.alloc(0), offset = 0, imported = 0;
      try {
        const size = fs.fstatSync(fd).size;
        if (size > JOURNAL_MAX_BYTES) throw new JournalUnavailable('FailureSpoolFull');
        const chunk = Buffer.alloc(RECORD_MAX_BYTES);
        while (offset < size) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size-offset), offset);
          if (!n) throw new JournalUnavailable('FailureSpoolReadFailed');
          offset += n; pending = Buffer.concat([pending, chunk.subarray(0,n)]);
          let end: number;
          while ((end = pending.indexOf(10)) >= 0) {
            if (end >= RECORD_MAX_BYTES) throw new JournalUnavailable('FailureSpoolRecordTooLarge');
            await importRecord(parse(pending.subarray(0,end).toString('utf8')));
            imported++; pending = pending.subarray(end+1);
          }
          if (pending.length >= RECORD_MAX_BYTES) throw new JournalUnavailable('FailureSpoolRecordTooLarge');
        }
        if (pending.length) {
          // Preserve exact incomplete bytes. One unresolved partial file bounds
          // diagnostic accumulation and requires operator inspection.
          const partial = this.file + '.partial';
          if (fs.existsSync(partial)) {
            const size = fs.statSync(partial).size;
            if (size !== pending.length || !fs.readFileSync(partial).equals(pending))
              throw new JournalUnavailable('FailureSpoolPartialNeedsInspection');
          } else {
            const damaged = fs.openSync(partial, 'wx', 0o600);
            try { fs.writeFileSync(damaged, pending); fs.fsyncSync(damaged); } finally { fs.closeSync(damaged); }
            syncDirectory(path.dirname(this.file));
          }
        }
        // Every complete record was independently committed. A crash before
        // truncation replays the same failure IDs, never another fact.
        fs.ftruncateSync(fd, 0); fs.fsyncSync(fd);
        return imported;
      } finally { fs.closeSync(fd); }
    });
  }
  async close(): Promise<void> { this.closed = true; await this.tail; }
}
