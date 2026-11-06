/* CD-09-C pure tests: the append-only ledger file every retention unit writes through (api/src/emr-retention/ledger-file.ts).
 *
 * The rules are the unit-independent ones: one header that names the ledger, entries in seq order under that ID, a closed
 * envelope, a line limit, a last line that ends with LF, fsync before an append counts, the directory synced when the
 * file is created, and nothing that repairs, truncates or rewrites a line. Each case first builds a ledger the module
 * itself reads back (the control), records its bytes, makes one change, and then asserts the refusal code and that the
 * file holds exactly the changed bytes. I/O failures go through the module's I/O port with a double that records every
 * call, so the test sees the short write, the zero-byte write and the syncs themselves. Synthetic records only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const L = require(path.join(api, 'src/emr-retention/ledger-file.ts'));
const { ContractError } = require(path.join(api, 'src/emr-contract/validation.ts'));

/** A closed record of the test's own kind: `{ n }`, a positive integer, nothing else. */
const decoder = () => ({ decode(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).join() !== 'n' || !Number.isInteger(value.n) || value.n < 1)
    throw new ContractError('SynLedgerRecordInvalid');
  return Object.freeze({ n: value.n });
} });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd09c-ledger-'));
/** The real file I/O with every call recorded; `script` may replace one call's answer. */
function recording(script = {}) {
  const calls = [];
  const io = {};
  for (const name of Object.keys(L.nodeLedgerIo)) {
    io[name] = (...args) => {
      calls.push(name);
      return script[name] ? script[name](L.nodeLedgerIo[name], ...args) : L.nodeLedgerIo[name](...args);
    };
  }
  return { io, calls };
}
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code; } };
function ledgerWith(records, io) {
  const d = dir(), file = path.join(d, 'syn-ledger.jsonl'), id = randomUUID();
  const ledger = new L.AppendOnlyLedger(file, 'SynLedger', decoder, io);
  ledger.create(id);
  for (const record of records) ledger.append(id, record);
  return { ledger, file, id, dir: d };
}

test('L01 control: create writes the header alone and syncs the directory; appends fsync and read back in seq order', () => {
  const { io, calls } = recording();
  const d = dir(), file = path.join(d, 'nested', 'syn-ledger.jsonl'), id = randomUUID();
  const ledger = new L.AppendOnlyLedger(file, 'SynLedger', decoder, io);
  assert.equal(ledger.read(), null);
  // A missing file is never answered by an append: no header appears.
  assert.equal(codeOf(() => ledger.append(id, { n: 1 })), 'SynLedgerMissing');
  assert.equal(fs.existsSync(file), false);
  calls.length = 0;
  ledger.create(id);
  const header = fs.readFileSync(file, 'utf8');
  assert.equal(header.split('\n').length, 2, 'one header line, ending with LF');
  assert.deepEqual(Object.keys(JSON.parse(header)).sort(), ['createdAt', 'formatVersion', 'kind', 'ledgerId']);
  assert.ok(calls.indexOf('fsyncSync') >= 0 && calls.indexOf('fsyncSync') < calls.indexOf('syncDirectory'),
    'the header is fsynced, then its directory: ' + calls.join());
  // The same ID again changes nothing; another ID is refused and changes nothing.
  ledger.create(id);
  assert.equal(fs.readFileSync(file, 'utf8'), header);
  assert.equal(codeOf(() => ledger.create(randomUUID())), 'SynLedgerMismatch');
  assert.equal(fs.readFileSync(file, 'utf8'), header);
  calls.length = 0;
  assert.equal(ledger.append(id, { n: 7 }).seq, 1);
  assert.ok(calls.lastIndexOf('fsyncSync') > calls.lastIndexOf('writeSync'), 'fsync after the last write: ' + calls.join());
  assert.ok(!calls.includes('syncDirectory'), 'an append to an existing file does not need the directory synced');
  assert.equal(ledger.append(id, { n: 8 }).seq, 2);
  const view = ledger.read();
  assert.equal(view.ledgerId, id);
  assert.deepEqual(view.entries.map(e => [e.seq, e.record.n]), [[1, 7], [2, 8]]);
  assert.ok(Object.isFrozen(view.entries[0]) && Object.isFrozen(view.entries[0].record));
  assert.equal(codeOf(() => ledger.append(randomUUID(), { n: 9 })), 'SynLedgerMismatch');
  assert.equal(ledger.read().entries.length, 2);
});

test('L02 a damaged file is refused on read and on append with its own code, and its bytes stay exactly as damaged', () => {
  const cases = [
    ['last line without LF', 'SynLedgerPartialTail', text => text.slice(0, -1)],
    ['a partial entry', 'SynLedgerPartialTail', text => text + '{"kind":"entry"'],
    ['a skipped seq', 'SynLedgerRecordInvalid', text => text.replace('"seq":2', '"seq":3')],
    ['an entry of another ledger', 'SynLedgerRecordInvalid', (text, id) => text.replace(new RegExp('"ledgerId":"' + id + '","appendedAt"'), '"ledgerId":"' + randomUUID() + '","appendedAt"')],
    ['a key outside the envelope', 'SynLedgerRecordInvalid', text => text.replace('"kind":"entry"', '"kind":"entry","note":"x"')],
    ['a line over the limit', 'SynLedgerRecordInvalid', text => text.replace('"record":{"n":2}', '"record":{"n":2},"pad":"' + 'x'.repeat(4096) + '"')],
    ['a record its decoder refuses', 'SynLedgerRecordInvalid', text => text.replace('"record":{"n":2}', '"record":{"n":0}')],
    ['a header of another format', 'SynLedgerHeaderInvalid', text => text.replace('"formatVersion":1', '"formatVersion":2')],
  ];
  for (const [label, code, damage] of cases) {
    const { ledger, file, id } = ledgerWith([{ n: 1 }, { n: 2 }]);
    assert.deepEqual(ledger.read().entries.map(e => e.record.n), [1, 2], label + ': control');
    const damaged = damage(fs.readFileSync(file, 'utf8'), id);
    assert.notEqual(damaged, fs.readFileSync(file, 'utf8'), label + ': the damage changed the bytes');
    fs.writeFileSync(file, damaged);
    assert.equal(codeOf(() => ledger.read()), code, label);
    assert.equal(codeOf(() => ledger.append(id, { n: 3 })), code, label + ' (append)');
    assert.equal(codeOf(() => ledger.create(id)), code, label + ' (create)');
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, label + ': never repaired, truncated or extended');
  }
});

test('L03 an append the module or the decoder refuses is refused before any byte is written', () => {
  const { io, calls } = recording();
  const d = dir(), file = path.join(d, 'syn-ledger.jsonl'), id = randomUUID();
  const ledger = new L.AppendOnlyLedger(file, 'SynLedger', decoder, io);
  ledger.create(id); ledger.append(id, { n: 1 });
  const before = fs.readFileSync(file);
  for (const [record, code] of [[{ n: 0 }, 'SynLedgerRecordInvalid'], [{ n: 1, uid: 'syn' }, 'SynLedgerRecordInvalid'],
    [{ n: Number.MAX_SAFE_INTEGER, pad: 'x'.repeat(5000) }, 'SynLedgerRecordInvalid']]) {
    calls.length = 0;
    assert.equal(codeOf(() => ledger.append(id, record)), code);
    assert.ok(!calls.includes('writeSync') && !calls.includes('openSync'), 'nothing opened for writing: ' + calls.join());
  }
  // A record the decoder accepts whose line would pass the limit is refused before writing too (it could never be read).
  const wide = new L.AppendOnlyLedger(file, 'SynLedger', () => ({ decode: value => value }), io);
  calls.length = 0;
  assert.equal(codeOf(() => wide.append(id, { n: 2, pad: 'x'.repeat(4096) })), 'SynLedgerRecordInvalid');
  assert.ok(!calls.includes('writeSync'));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('L04 short writes are completed before fsync; a zero-byte write fails the append and its partial bytes are left as they are', () => {
  // Short writes: each write accepts at most 5 bytes.
  const short = recording({ writeSync: (real, fd, buffer, offset, length) => real(fd, buffer, offset, Math.min(5, length)) });
  const a = ledgerWith([], short.io);
  short.calls.length = 0;
  a.ledger.append(a.id, { n: 42 });
  const writes = short.calls.filter(c => c === 'writeSync').length;
  assert.ok(writes > 5, 'the write was really split: ' + writes);
  assert.ok(short.calls.indexOf('fsyncSync') > short.calls.lastIndexOf('writeSync'));
  assert.deepEqual(a.ledger.read().entries.map(e => e.record.n), [42]);
  // A zero-byte write after 5 bytes: WriteFailed, no fsync counted as success, and the 5 bytes stay (no truncation). The
  // failure is armed once the ledger's own file is durable for this object (a new object rewrites it first, r3 F1).
  let n = 0, armed = false;
  const stuck = recording({ writeSync: (real, fd, buffer, offset, length) => (!armed ? real(fd, buffer, offset, length)
    : n++ === 0 ? real(fd, buffer, offset, 5) : 0) });
  const b = ledgerWith([], stuck.io);
  b.ledger.append(b.id, { n: 1 });
  const before = fs.readFileSync(b.file);
  armed = true; stuck.calls.length = 0;
  assert.equal(codeOf(() => b.ledger.append(b.id, { n: 2 })), 'SynLedgerWriteFailed');
  assert.equal(stuck.calls.filter(c => c === 'writeSync').length, 2, 'the zero-byte answer was reached');
  const after = fs.readFileSync(b.file);
  assert.deepEqual(after.subarray(0, before.length), before, 'the earlier lines are untouched');
  assert.equal(after.length, before.length + 5, 'the partial bytes are left, not repaired');
  assert.equal(codeOf(() => b.ledger.read()), 'SynLedgerPartialTail');
  // fsync itself failing is the append's failure (the caller does not count the record).
  let unsyncedArmed = false;
  const unsynced = recording({ fsyncSync: (real, fd) => { if (unsyncedArmed) throw Object.assign(new Error('SYN EIO'), { code: 'EIO' }); real(fd); } });
  const c = ledgerWith([], unsynced.io);
  unsyncedArmed = true; unsynced.calls.length = 0;
  assert.throws(() => c.ledger.append(c.id, { n: 1 }), /SYN EIO/);
  assert.ok(unsynced.calls.includes('closeSync'), 'the descriptor is closed after the failure');
});

test('L05 a replaced file (the adoption record) goes tmp, fsync, rename, then the directory', () => {
  const { io, calls } = recording();
  const d = path.join(dir(), 'fresh'), file = path.join(d, 'syn-adoption.json');
  L.replaceAtomically(d, file, JSON.stringify({ state: 'prepared' }) + '\n', io);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { state: 'prepared' });
  const order = ['writeSync', 'fsyncSync', 'renameSync', 'syncDirectory'].map(c => calls.indexOf(c));
  assert.deepEqual([...order].sort((x, y) => x - y), order, calls.join());
  assert.ok(order.every(i => i >= 0));
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('L06 a ledger directory is absolute and outside the backed-up state; there is no fallback', () => {
  const closed = code => { throw Object.assign(new Error(code), { code }); };
  assert.equal(L.ledgerDirectory('/var/lib/kin-purpose', '/var/lib/kin-emr', closed), '/var/lib/kin-purpose');
  assert.equal(L.ledgerDirectory('/var/lib/kin-emr-purpose', '/var/lib/kin-emr', closed), '/var/lib/kin-emr-purpose');
  assert.equal(L.ledgerDirectory('/var/lib/kin-purpose', undefined, closed), '/var/lib/kin-purpose');
  for (const [directory, code] of [[undefined, 'DirectoryRequired'], ['', 'DirectoryRequired'], ['relative', 'DirectoryRequired'],
    ['/var/lib/kin-emr', 'InsideBackup'], ['/var/lib/kin-emr/ledger', 'InsideBackup'], ['/var/lib/kin-emr/../kin-emr/x', 'InsideBackup']])
    assert.equal(codeOf(() => L.ledgerDirectory(directory, '/var/lib/kin-emr', closed)), code, String(directory));
});

// ── The mirror (KIN_LEDGER_MIRROR_DIR, 2026-11-06 decision: a second copy on this host, not a backup) ──
//
// REQ: "장부를 따로 한 벌 더 보관" (정모 님 11-06) with the order's contract: every append writes the same bytes to both
// places, each fsynced, and counts only when both did; one failing is the append's failure. RISK: a copy that can be
// behind the ledger brings back destructions the ledger already completed (the older-copy hazard of RC4/D14), and a copy
// that is something else must never take the ledger's place. TEST: L07-L15 here, the units' gates in
// draft_purpose_test.cjs (PM01-PM10), report_retention_test.cjs (R12-R13) and report_retention_pg_test.cjs (PG11).

/** A ledger with a mirror in its own directory. */
function mirroredWith(records, io) {
  const d = dir(), m = dir(), file = path.join(d, 'syn-ledger.jsonl'), id = randomUUID();
  const ledger = new L.AppendOnlyLedger(file, 'SynLedger', decoder, io, m);
  ledger.create(id);
  for (const record of records) ledger.append(id, record);
  return { ledger, file, mirror: path.join(m, 'syn-ledger.jsonl'), id, dir: d, mirrorDir: m };
}
const bytes = file => (fs.existsSync(file) ? fs.readFileSync(file) : null);
/** Every opened file with the calls made on its descriptor, in order. */
function byFile(script = {}) {
  const opened = new Map(), log = [];
  const r = recording({
    openSync: (real, file, ...rest) => { const fd = real(file, ...rest); opened.set(fd, file); log.push(['open', file]); return fd; },
    writeSync: (real, fd, ...rest) => { log.push(['write', opened.get(fd)]); return script.writeSync ? script.writeSync(real, opened.get(fd), fd, ...rest) : real(fd, ...rest); },
    fsyncSync: (real, fd) => { log.push(['fsync', opened.get(fd)]); return real(fd); },
  });
  return { io: r.io, log };
}

test('L07 the header and every append are the same bytes in both places, each written and fsynced, the file first', () => {
  const { io, log } = byFile();
  const a = mirroredWith([], io);
  assert.deepEqual(bytes(a.mirror), bytes(a.file), 'the header in both');
  log.length = 0;
  a.ledger.append(a.id, { n: 1 });
  const fsyncs = log.filter(([kind]) => kind === 'fsync').map(([, file]) => file);
  assert.deepEqual(fsyncs, [a.file, a.mirror], 'each place fsynced once, the file first');
  for (const target of [a.file, a.mirror]) {
    const own = log.filter(([, file]) => file === target).map(([kind]) => kind);
    assert.equal(own.at(-1), 'fsync', target + ': fsync after its last write');
  }
  for (let n = 2; n <= 5; n++) { a.ledger.append(a.id, { n }); assert.deepEqual(bytes(a.mirror), bytes(a.file), 'after ' + n); }
  // Without a mirror nothing else is written (one file, as before).
  const single = byFile();
  const s = ledgerWith([], single.io);
  s.ledger.append(s.id, { n: 1 });
  assert.deepEqual([...new Set(single.log.map(([, file]) => file))], [s.file]);
});

test('L08 one place failing fails the append: the file failing leaves the mirror untouched; the mirror failing is MirrorWriteFailed and is caught up from the file', () => {
  // The file's write fails: WriteFailed, and the mirror was not written.
  const a = mirroredWith([{ n: 1 }]);
  const fileFails = byFile({ writeSync: (real, file, fd, buffer, offset, length) => (file === a.file ? 0 : real(fd, buffer, offset, length)) });
  const mirrorBefore = bytes(a.mirror);
  const viaFile = new L.AppendOnlyLedger(a.file, 'SynLedger', decoder, fileFails.io, a.mirrorDir);
  assert.equal(codeOf(() => viaFile.append(a.id, { n: 2 })), 'SynLedgerWriteFailed');
  assert.deepEqual(bytes(a.mirror), mirrorBefore, 'the mirror was not written');
  // The mirror's write fails after the file took the line: the append fails with its own code.
  const b = mirroredWith([{ n: 1 }]);
  const mirrorFails = byFile({ writeSync: (real, file, fd, buffer, offset, length) => (file === b.mirror ? 0 : real(fd, buffer, offset, length)) });
  const viaMirror = new L.AppendOnlyLedger(b.file, 'SynLedger', decoder, mirrorFails.io, b.mirrorDir);
  assert.equal(codeOf(() => viaMirror.append(b.id, { n: 2 })), 'SynLedgerMirrorWriteFailed');
  assert.deepEqual(b.ledger.read().entries.map(e => e.record.n), [1, 2], 'the file holds the line (the caller saw a failure)');
  assert.ok(bytes(b.mirror).length < bytes(b.file).length, 'the mirror is behind by that line only');
  assert.deepEqual(bytes(b.file).subarray(0, bytes(b.mirror).length), bytes(b.mirror));
  // A thrown error on the mirror is the same failure.
  const thrown = byFile({ writeSync: (real, file, fd, ...rest) => { if (file === b.mirror) throw Object.assign(new Error('SYN ENOSPC'), { code: 'ENOSPC' }); return real(fd, ...rest); } });
  assert.equal(codeOf(() => new L.AppendOnlyLedger(b.file, 'SynLedger', decoder, thrown.io, b.mirrorDir).append(b.id, { n: 3 })), 'SynLedgerMirrorWriteFailed');
  // The next append (the mirror writable again) brings the mirror up to the file first, then writes both.
  b.ledger.append(b.id, { n: 4 });
  assert.deepEqual(bytes(b.mirror), bytes(b.file));
  assert.deepEqual(b.ledger.read().entries.map(e => e.record.n), [1, 2, 3, 4]);
});

test('L09 the gate brings an absent or lagging mirror up to the file, and closes on any other mirror without writing', () => {
  // Absent: a mirror set up beside an existing ledger.
  const a = ledgerWith([{ n: 1 }, { n: 2 }]);
  const m = dir(), mirror = path.join(m, 'syn-ledger.jsonl');
  const gate = new L.AppendOnlyLedger(a.file, 'SynLedger', decoder, undefined, m);
  assert.deepEqual(gate.readForGate(), { view: a.ledger.read(), standIn: null });
  assert.deepEqual(bytes(mirror), bytes(a.file));
  // Lagging (a byte prefix, even inside a line): brought up.
  const lag = bytes(a.file).subarray(0, bytes(a.file).length - 7);
  fs.writeFileSync(mirror, lag);
  gate.readForGate();
  assert.deepEqual(bytes(mirror), bytes(a.file));
  // Anything else: MirrorDiverged on the gate's read and on an append, and neither place changes.
  const fileBytes = bytes(a.file);
  for (const [label, other] of [['longer than the file', Buffer.concat([fileBytes, Buffer.from('{"kind":"entry"}\n')])],
    ['other bytes', Buffer.from(fileBytes.toString('utf8').replace('"n":2', '"n":3'))],
    ['another ledger', fs.readFileSync(ledgerWith([{ n: 1 }]).file)]]) {
    fs.writeFileSync(mirror, other);
    assert.equal(codeOf(() => gate.readForGate()), 'SynLedgerMirrorDiverged', label);
    assert.equal(codeOf(() => gate.append(a.id, { n: 9 })), 'SynLedgerMirrorDiverged', label + ' (append)');
    assert.deepEqual(bytes(a.file), fileBytes, label + ': the file is unchanged');
    assert.deepEqual(bytes(mirror), other, label + ': the mirror is unchanged');
  }
  // A header create beside a mirror that already holds a ledger (the file lost) is refused, nothing written.
  const lost = mirroredWith([{ n: 1 }]);
  fs.unlinkSync(lost.file);
  assert.equal(codeOf(() => lost.ledger.create(lost.id)), 'SynLedgerMirrorDiverged');
  assert.equal(fs.existsSync(lost.file), false);
});

test('L10 a missing or damaged file: the readable mirror stands in, takes appends alone, and replaces the file only on restoreFromMirror', async () => {
  for (const [label, code, lose] of [['missing', 'SynLedgerMissing', file => fs.unlinkSync(file)],
    ['partial last line', 'SynLedgerPartialTail', file => fs.appendFileSync(file, '{"kind":"entry"')],
    ['edited line', 'SynLedgerRecordInvalid', file => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"seq":2', '"seq":5'))]]) {
    const a = mirroredWith([{ n: 1 }, { n: 2 }]);
    const view = a.ledger.read(), mirrorBytes = bytes(a.mirror);
    lose(a.file);
    const damaged = bytes(a.file);
    const gate = new L.AppendOnlyLedger(a.file, 'SynLedger', decoder, undefined, a.mirrorDir);
    assert.deepEqual(gate.readForGate(), { view, standIn: code }, label);
    assert.equal(gate.standingIn, code);
    assert.deepEqual(gate.read(), view, label + ': reads go to the mirror');
    assert.deepEqual(bytes(a.file), damaged, label + ': nothing written to the file yet');
    gate.append(a.id, { n: 3 });
    assert.deepEqual(bytes(a.file), damaged, label + ': an append goes to the mirror alone');
    assert.equal(bytes(a.mirror).length > mirrorBytes.length, true);
    const records = [];
    assert.equal(await gate.restoreFromMirror(async r => { records.push(r); }), code);
    assert.equal(gate.standingIn, null);
    assert.deepEqual(bytes(a.file), bytes(a.mirror), label + ': the file is the mirror\'s bytes');
    assert.deepEqual(gate.read().entries.map(e => e.record.n), [1, 2, 3]);
    const kept = fs.readdirSync(a.dir);
    if (damaged) assert.deepEqual(fs.readFileSync(path.join(a.dir, kept.find(n => n.includes('.unreadable-')))), damaged, label + ': the damaged file is kept');
    else assert.ok(!kept.some(n => n.includes('.unreadable-')));
    assert.equal(records.length, 1, label + ': one record of the restore');
    assert.deepEqual([records[0].ledgerId, records[0].entries, records[0].reason], [a.id, 3, code]);
    assert.equal(records[0].keptAs && path.basename(records[0].keptAs), kept.find(n => n.includes('.unreadable-')) ?? null, label + ': where the damaged file is kept');
    // From now on both places are written again.
    gate.append(a.id, { n: 4 });
    assert.deepEqual(bytes(a.file), bytes(a.mirror));
  }
  await assert.rejects(mirroredWith([]).ledger.restoreFromMirror(async () => {}), /LedgerNotStandingIn/);
});

test('L11 a mirror that does not read leaves the file\'s answer: its code, or Missing for a lost file beside a mirror file', () => {
  const a = mirroredWith([{ n: 1 }]);
  fs.appendFileSync(a.mirror, '{"kind":"entry"');
  const mirrorBytes = bytes(a.mirror);
  fs.unlinkSync(a.file);
  const gate = new L.AppendOnlyLedger(a.file, 'SynLedger', decoder, undefined, a.mirrorDir);
  assert.equal(codeOf(() => gate.readForGate()), 'SynLedgerMissing');
  assert.equal(gate.standingIn, null);
  fs.writeFileSync(a.file, '{"kind":"header"');
  assert.equal(codeOf(() => gate.readForGate()), 'SynLedgerPartialTail');
  assert.deepEqual(bytes(a.mirror), mirrorBytes);
  // No file and no mirror, or an empty mirror file: no ledger, as without a mirror.
  const fresh = dir(), m = dir(), file = path.join(fresh, 'syn-ledger.jsonl');
  const empty = new L.AppendOnlyLedger(file, 'SynLedger', decoder, undefined, m);
  assert.deepEqual(empty.readForGate(), { view: null, standIn: null });
  fs.writeFileSync(path.join(m, 'syn-ledger.jsonl'), '');
  assert.deepEqual(empty.readForGate(), { view: null, standIn: null });
  // Without a mirror the gate's read is the plain read.
  const plain = ledgerWith([{ n: 1 }]);
  assert.deepEqual(new L.AppendOnlyLedger(plain.file, 'SynLedger', decoder).readForGate(), { view: plain.ledger.read(), standIn: null });
});

test('L12 property: with no failure the mirror is the file\'s bytes after every write, so it always stands in for the file it lost', () => {
  const a = mirroredWith([]);
  let seed = 7;
  for (let i = 0; i < 40; i++) {
    seed = (seed * 48271) % 2147483647;
    a.ledger.append(a.id, { n: 1 + (seed % 1000) });
    assert.deepEqual(bytes(a.mirror), bytes(a.file), 'after append ' + (i + 1));
    if (i % 8 === 7) {
      // Lose the file at this point in a copy of both directories: the mirror reads exactly as the file did.
      const d = dir(), m = dir();
      fs.copyFileSync(a.mirror, path.join(m, 'syn-ledger.jsonl'));
      const lost = new L.AppendOnlyLedger(path.join(d, 'syn-ledger.jsonl'), 'SynLedger', decoder, undefined, m);
      assert.deepEqual(lost.readForGate(), { view: a.ledger.read(), standIn: 'SynLedgerMissing' });
    }
  }
});

test('L13 the mirror directory is absolute, outside the backed-up state and apart from the ledger directory; unset is none', () => {
  const closed = code => { throw Object.assign(new Error(code), { code }); };
  assert.equal(L.ledgerMirrorDirectory(undefined, '/var/lib/kin-purpose', '/var/lib/kin-emr', closed), null);
  assert.equal(L.ledgerMirrorDirectory('', '/var/lib/kin-purpose', '/var/lib/kin-emr', closed), null);
  assert.equal(L.ledgerMirrorDirectory('/var/lib/kin-ledger-mirror', '/var/lib/kin-purpose', '/var/lib/kin-emr', closed), '/var/lib/kin-ledger-mirror');
  for (const [mirror, code] of [['relative', 'MirrorDirectoryRequired'], ['/var/lib/kin-emr', 'MirrorInsideBackup'],
    ['/var/lib/kin-emr/mirror', 'MirrorInsideBackup'], ['/var/lib/kin-purpose', 'MirrorInsideLedger'],
    ['/var/lib/kin-purpose/mirror', 'MirrorInsideLedger'], ['/var/lib', 'MirrorInsideLedger']])
    assert.equal(codeOf(() => L.ledgerMirrorDirectory(mirror, '/var/lib/kin-purpose', '/var/lib/kin-emr', closed)), code, mirror);
});

/** The node I/O with every write into `directory` (the mirror and its temporary file) answering 0 bytes while `fail()`. */
function directoryWritesFail(directory, fail) {
  return byFile({ writeSync: (real, file, fd, ...rest) => (fail() && path.dirname(file) === directory ? 0 : real(fd, ...rest)) }).io;
}

test('L14 r2 F1: a header already in the file (an earlier create whose mirror write failed) is created only once the mirror has it too', () => {
  const d = dir(), m = dir(), file = path.join(d, 'syn-ledger.jsonl'), mirror = path.join(m, 'syn-ledger.jsonl'), id = randomUUID();
  let failing = true;
  const ledger = new L.AppendOnlyLedger(file, 'SynLedger', decoder, directoryWritesFail(m, () => failing), m);
  assert.equal(codeOf(() => ledger.create(id)), 'SynLedgerMirrorWriteFailed', 'the first create');
  assert.equal(ledger.read().ledgerId, id, 'the file took the header');
  // The retry while the mirror still fails: refused again, never answered as created beside the file alone.
  assert.equal(codeOf(() => ledger.create(id)), 'SynLedgerMirrorWriteFailed', 'the retry while the mirror fails');
  assert.notDeepEqual(bytes(mirror), bytes(file));
  // The mirror writable again: the retry brings it up to the file and returns; the file is not written twice.
  const header = bytes(file);
  failing = false;
  assert.equal(codeOf(() => ledger.create(id)), null, 'the retry after the mirror recovered');
  assert.deepEqual(bytes(file), header);
  assert.deepEqual(bytes(mirror), header);
  // Another ID beside that header is refused as before; a mirror that is not this ledger is refused too.
  assert.equal(codeOf(() => ledger.create(randomUUID())), 'SynLedgerMismatch');
  fs.writeFileSync(mirror, Buffer.concat([header, Buffer.from('{"kind":"entry"}\n')]));
  assert.equal(codeOf(() => ledger.create(id)), 'SynLedgerMirrorDiverged');
  // Without a mirror an existing header is the ledger, as before the mirror.
  const plain = ledgerWith([]);
  assert.equal(codeOf(() => plain.ledger.create(plain.id)), null);
});

test('L15 r2 F2: the restore is recorded before the file changes; a record that fails restores nothing, and a restore that stopped after its record is done (and recorded) again by the next gate', async () => {
  const a = mirroredWith([{ n: 1 }, { n: 2 }]);
  const mirrorBytes = bytes(a.mirror), sha256 = createHash('sha256').update(mirrorBytes).digest('hex');
  fs.unlinkSync(a.file);
  const gateWith = io => { const g = new L.AppendOnlyLedger(a.file, 'SynLedger', decoder, io, a.mirrorDir); g.readForGate(); return g; };
  const records = [];
  const record = async r => { assert.equal(bytes(a.file), null, 'recorded before the file changes'); records.push(r); };
  // The record cannot be written: nothing is restored and the mirror still stands in.
  const first = gateWith();
  await assert.rejects(first.restoreFromMirror(async () => { throw new Error('SYN audit insert failed'); }), e => e.code === 'SynLedgerRestoreUnrecorded');
  assert.equal(bytes(a.file), null, 'not restored without its record');
  assert.equal(first.standingIn, 'SynLedgerMissing');
  // Recorded, then the file's replacement fails (as a stop between the two would leave it): the file is still lost.
  const io = { ...L.nodeLedgerIo, renameSync: (from, to) => { if (to === a.file) throw Object.assign(new Error('SYN EIO'), { code: 'EIO' }); fs.renameSync(from, to); } };
  await assert.rejects(gateWith(io).restoreFromMirror(record), e => e.code === 'SynLedgerRestoreFailed');
  assert.equal(bytes(a.file), null);
  assert.equal(records.length, 1, 'the restore it began is recorded');
  // The next gate: the lost file is not a normal start; the mirror stands in again, is recorded again, and restores.
  const next = gateWith();
  assert.equal(next.standingIn, 'SynLedgerMissing');
  assert.equal(await next.restoreFromMirror(record), 'SynLedgerMissing');
  assert.deepEqual(bytes(a.file), mirrorBytes);
  assert.equal(records.length, 2);
  for (const r of records)
    assert.deepEqual(r, { ledgerId: a.id, entries: 2, bytes: mirrorBytes.length, sha256, reason: 'SynLedgerMissing', file: a.file,
      mirror: a.mirror, keptAs: null }, 'each record names the bytes that take the file\'s place');
  // A start after that reads the file: no stand-in, nothing to record.
  assert.equal(gateWith().standingIn, null);
});
