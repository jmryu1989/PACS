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
const { randomUUID } = require('node:crypto');
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
  // A zero-byte write after 5 bytes: WriteFailed, no fsync counted as success, and the 5 bytes stay (no truncation).
  let n = 0;
  const stuck = recording({ writeSync: (real, fd, buffer, offset, length) => (n++ === 0 ? real(fd, buffer, offset, 5) : 0) });
  const b = ledgerWith([{ n: 1 }]);
  const before = fs.readFileSync(b.file);
  const ledger = new L.AppendOnlyLedger(b.file, 'SynLedger', decoder, stuck.io);
  assert.equal(codeOf(() => ledger.append(b.id, { n: 2 })), 'SynLedgerWriteFailed');
  assert.equal(stuck.calls.filter(c => c === 'writeSync').length, 2, 'the zero-byte answer was reached');
  const after = fs.readFileSync(b.file);
  assert.deepEqual(after.subarray(0, before.length), before, 'the earlier lines are untouched');
  assert.equal(after.length, before.length + 5, 'the partial bytes are left, not repaired');
  assert.equal(codeOf(() => ledger.read()), 'SynLedgerPartialTail');
  // fsync itself failing is the append's failure (the caller does not count the record).
  const unsynced = recording({ fsyncSync: () => { throw Object.assign(new Error('SYN EIO'), { code: 'EIO' }); } });
  const c = ledgerWith([]);
  const failing = new L.AppendOnlyLedger(c.file, 'SynLedger', decoder, unsynced.io);
  assert.throws(() => failing.append(c.id, { n: 1 }), /SYN EIO/);
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
