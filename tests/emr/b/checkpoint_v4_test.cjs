/* KIN-EMR-STATE-V4 codec/index behaviour (V4-T01 codec/roundtrip, V4-T02 index/collision/range, V4-T03 every-use
 * integrity). Bytes define this format, so byte vectors are the oracle; nothing here asserts a source spelling.
 *   node --test tests/emr/b/checkpoint_v4_test.cjs
 * Selection: EMR_V4_CASES=V4-T01,V4-T02 (default: every case in this file). */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const ts = require(process.env.KIN_EMR_TYPESCRIPT || path.join(root, 'api/node_modules/typescript'));
const compile = (file, transform = s => s) => {
  const m = new module.constructor(file, module);
  m.filename = file; m.paths = module.paths;
  m._compile(ts.transpileModule(transform(fs.readFileSync(file, 'utf8')), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true }, fileName: file }).outputText, file);
  return m.exports;
};
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true } , fileName: f }).outputText, f);
const V4 = require(path.join(root, 'api/src/emr-runtime/checkpoint-v4.ts'));
const selected = (process.env.EMR_V4_CASES || '').split(',').filter(Boolean);
const only = name => selected.length ? selected.includes(name.split(' ')[0]) : true;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const H = (domain, bytes) => crypto.createHash('sha256').update(domain, 'ascii').update(Buffer.from([0])).update(typeof bytes === 'string' ? Buffer.from(bytes) : bytes).digest('hex');
const LINEAGE = { version: 1, id: '11aa0000-0000-4000-8000-000000000009', origin: { instanceId: 'v4-test', chains: { viewing: '7c1f3a52-0000-4000-8000-000000000001', history: '7c1f3a52-0000-4000-8000-000000000002' }, database: { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 } } };
const lineageSha = V4.lineageSha256(LINEAGE);
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(root, 'tmp/emr-b2-c-16/', 'v4-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}
fs.mkdirSync(path.join(root, 'tmp/emr-b2-c-16'), { recursive: true });
const rejects = (fn, detail) => { let error = null; try { fn(); } catch (e) { error = e; } assert.ok(error, 'expected refusal' + (detail ? ' ' + detail : '')); assert.equal(error.code, 'SealCorrupt', detail + ': ' + String(error.message)); return error; };

test('V4-T01 canonical control bytes J(x) and H(domain, bytes) are exactly the format vectors', { skip: !only('V4-T01') }, () => {
  assert.equal(V4.canonical({ b: 1, a: [true, null, 'xé\n"'], c: { z: '1', y: '0' } }), '{"a":[true,null,"xé\\n\\""],"b":1,"c":{"y":"0","z":"1"}}');
  assert.equal(V4.canonical({ '😀': 1, 'Z': 2, 'a': 3 }), '{"Z":2,"a":3,"😀":1}', 'keys sort by UTF-16 code units, not code points');
  assert.throws(() => V4.canonical({ a: -0 }), { code: 'SealCorrupt' });
  assert.throws(() => V4.canonical({ a: Infinity }), { code: 'SealCorrupt' });
  assert.throws(() => V4.canonical({ a: undefined }), { code: 'SealCorrupt' });
  for (const bad of ['{"b":1,"a":2}', '{"a":1,"a":2}', ' {"a":1}', '{"a":1.0}', '{"a":1e3}', '{"a":-0}', '{"a":"\\u0041"}', '{"a":1}\n']) rejects(() => V4.parseCanonical(bad), 'noncanonical ' + bad);
  assert.deepEqual(V4.parseCanonical('{"a":[1,"x"],"b":{"c":null}}'), { a: [1, 'x'], b: { c: null } });
  rejects(() => V4.parseCanonical(Buffer.from([0x7b, 0x22, 0x61, 0xff, 0x22, 0x3a, 0x31, 0x7d])), 'invalid utf-8');
  assert.equal(V4.domainHash('KIN-EMR-V4/blob', 'abc'), H('KIN-EMR-V4/blob', 'abc'));
  assert.notEqual(V4.domainHash('KIN-EMR-V4/blob', 'abc'), V4.domainHash('KIN-EMR-V4/page', 'abc'));
  assert.equal(V4.domainHash('KIN-EMR-V4/lineage', V4.canonical(LINEAGE)), lineageSha);
  const env = V4.envelope('KIN-EMR-V4/root', { z: '1', a: '2' });
  assert.equal(env.text, '{"body":{"a":"2","z":"1"},"sha256":"' + H('KIN-EMR-V4/root', '{"a":"2","z":"1"}') + '"}\n');
  assert.deepEqual(V4.openEnvelope('KIN-EMR-V4/root', env.text).body, { a: '2', z: '1' });
  rejects(() => V4.openEnvelope('KIN-EMR-V4/selector', env.text), 'wrong domain');
  rejects(() => V4.openEnvelope('KIN-EMR-V4/root', env.text.replace('"2"', '"3"')), 'changed body');
  rejects(() => V4.openEnvelope('KIN-EMR-V4/root', env.text.slice(0, -1)), 'unterminated');
  assert.equal(V4.parseDecimal('0', 'x'), 0); assert.equal(V4.parseDecimal('9007199254740991', 'x'), 9007199254740991);
  for (const bad of ['', '01', '-1', '1.0', 9, '9007199254740992', '18446744073709551615']) rejects(() => V4.parseDecimal(bad, 'x'), 'decimal ' + bad);
  const ref = { pack: 'a'.repeat(32), page: '258', sha256: 'b'.repeat(64) }, bin = V4.refToBinary(ref);
  assert.equal(bin.length, 56); assert.equal(bin.subarray(0, 16).toString('hex'), 'a'.repeat(32)); assert.equal(bin.readBigUInt64LE(16), 258n);
  assert.deepEqual(V4.refFromBinary(bin, 'x'), ref); assert.equal(V4.refFromBinary(Buffer.alloc(56), 'x'), null);
  rejects(() => V4.validRef({ pack: '0'.repeat(32), page: '0', sha256: 'b'.repeat(64) }, 'x'), 'zero pack');
  rejects(() => V4.validRef({ pack: 'a'.repeat(32), page: '01', sha256: 'b'.repeat(64) }, 'x'), 'leading zero page');
});

test('V4-T01 page layout: header fields, zero padding and footer are checked against the reference', { skip: !only('V4-T01') }, () => {
  const pack = 'c'.repeat(32), payload = Buffer.from('{"x":1}');
  const page = V4.buildPage({ kind: 1, page: 7, revision: 12, entryCount: 3, tree: 5, level: 0, lineageSha256: lineageSha, pack }, payload);
  assert.equal(page.length, 65536);
  assert.equal(page.subarray(0, 8).toString('ascii'), 'KEMRP004'); assert.equal(page.readUInt16LE(8), 4); assert.equal(page.readUInt16LE(10), 1);
  assert.equal(page.readUInt16LE(12), 128); assert.equal(page.readUInt16LE(14), 0); assert.equal(page.readBigUInt64LE(16), 7n); assert.equal(page.readBigUInt64LE(24), 12n);
  assert.equal(page.readUInt32LE(32), payload.length); assert.equal(page.readUInt32LE(36), 3); assert.equal(page.readUInt16LE(40), 5); assert.equal(page.readUInt16LE(42), 0);
  assert.equal(page.readUInt32LE(44), 0); assert.equal(page.subarray(48, 80).toString('hex'), lineageSha); assert.equal(page.subarray(80, 96).toString('hex'), pack);
  assert.ok(page.subarray(96, 128).every(b => b === 0)); assert.equal(page.subarray(128, 128 + payload.length).toString(), payload.toString());
  assert.ok(page.subarray(128 + payload.length, 65504).every(b => b === 0));
  assert.equal(page.subarray(65504).toString('hex'), H('KIN-EMR-V4/page', page.subarray(0, 65504)));
  const ref = { pack, page: '7', sha256: V4.pageSha256(page) };
  const parsed = V4.parsePage(page, { ref, lineageSha256: lineageSha, kind: 1, tree: 5, level: 0, maxRevision: 12 });
  assert.equal(parsed.payload.toString(), '{"x":1}'); assert.equal(parsed.header.revision, 12);
  rejects(() => V4.parsePage(page, { ref: { ...ref, page: '8' }, lineageSha256: lineageSha }), 'wrong address');
  rejects(() => V4.parsePage(page, { ref: { ...ref, pack: 'd'.repeat(32) }, lineageSha256: lineageSha }), 'wrong pack');
  rejects(() => V4.parsePage(page, { ref, lineageSha256: 'e'.repeat(64) }), 'wrong lineage');
  rejects(() => V4.parsePage(page, { ref, lineageSha256: lineageSha, tree: 6 }), 'wrong tree');
  rejects(() => V4.parsePage(page, { ref, lineageSha256: lineageSha, kind: 2 }), 'wrong kind');
  rejects(() => V4.parsePage(page, { ref, lineageSha256: lineageSha, maxRevision: 11 }), 'revision beyond root');
  rejects(() => V4.parsePage(page.subarray(0, 65535), { ref, lineageSha256: lineageSha }), 'truncated');
  const flipped = Buffer.from(page); flipped[200] ^= 1; rejects(() => V4.parsePage(flipped, { ref, lineageSha256: lineageSha }), 'changed payload byte');
  const padded = Buffer.from(page); padded[60000] = 1; rejects(() => V4.parsePage(padded, { ref, lineageSha256: lineageSha }), 'nonzero padding');
  // Rechecksummed but altered bytes: a new valid footer never satisfies the parent's expected checksum.
  const relabelled = Buffer.from(page); relabelled.writeUInt16LE(2, 10); V4.domainHashRaw('KIN-EMR-V4/page', relabelled.subarray(0, 65504)).copy(relabelled, 65504);
  rejects(() => V4.parsePage(relabelled, { ref, lineageSha256: lineageSha }), 'rechecksummed page under the old reference');
  rejects(() => V4.parsePage(relabelled, { ref: { ...ref, sha256: V4.pageSha256(relabelled) }, lineageSha256: lineageSha, kind: 1 }), 'rechecksummed page with the wrong kind for its reference');
  rejects(() => V4.buildPage({ kind: 1, page: 0, revision: 1, entryCount: 0, tree: 1, level: 0, lineageSha256: lineageSha, pack }, Buffer.alloc(65377)), 'payload beyond capacity');
});

test('V4-T01 packs, overflow blobs and every-use verification of stored bytes', { skip: !only('V4-T01') }, t => {
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 4 * 65536 });
  const writer = new V4.PackWriter(store, 3);
  const small = writer.append(1, 5, 0, 0, Buffer.from('{"entries":[]}'));
  const big = crypto.randomBytes(200000), descriptor = V4.writeBlob(writer, 5, big);
  writer.flush();
  assert.equal(descriptor.bytes, '200000'); assert.equal(descriptor.pages, String(Math.ceil(200000 / 65320))); assert.equal(descriptor.sha256, H('KIN-EMR-V4/blob', big));
  assert.ok(V4.readBlob(store, descriptor, 5, 'blob').equals(big));
  rejects(() => V4.readBlob(store, descriptor, 6, 'blob'), 'blob read under another tree');
  rejects(() => V4.readBlob(store, { ...descriptor, sha256: 'f'.repeat(64) }, 5, 'blob'), 'wrong whole-blob hash');
  rejects(() => V4.readBlob(store, { ...descriptor, bytes: '199999', pages: descriptor.pages }, 5, 'blob'), 'wrong length');
  const packs = store.listPacks(); assert.equal(packs.length, 1);
  const file = store.packFile(packs[0]); assert.equal(fs.statSync(file).size, 65536 * (1 + Number(descriptor.pages)));
  // A page read after cache eviction detects changed bytes; a cached verified page is reused as immutable checked bytes.
  const parsed = store.page(small, { kind: 1, tree: 5 }, (h, p) => p.toString());
  assert.equal(parsed, '{"entries":[]}');
  const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, Buffer.from([0x5b]), 0, 1, 128); fs.closeSync(fd);
  assert.equal(store.page(small, { kind: 1, tree: 5 }, (h, p) => p.toString()), '{"entries":[]}', 'the already verified immutable buffer is reused');
  store.invalidate();
  rejects(() => store.page(small, { kind: 1, tree: 5 }, (h, p) => p.toString()), 'fresh read of changed bytes');
  rejects(() => V4.readBlob(store, descriptor, 5, 'blob') && store.readRaw({ pack: packs[0], page: String(1 + Number(descriptor.pages)), sha256: 'a'.repeat(64) }), 'page beyond the pack');
  rejects(() => store.readRaw({ pack: 'e'.repeat(32), page: '0', sha256: 'a'.repeat(64) }), 'missing pack');
  // Packs seal at 256 pages and are never overwritten: the next page goes to a new pack.
  const w2 = new V4.PackWriter(store, 4);
  const refs = []; for (let i = 0; i < 300; i++) refs.push(w2.append(1, 2, 0, 0, Buffer.from('{"i":' + i + '}')));
  w2.close();
  assert.equal(new Set(refs.map(r => r.pack)).size, 2); assert.equal(refs[255].page, '255'); assert.equal(refs[256].page, '0');
  assert.ok(refs.every(r => !/^0+$/.test(r.pack)));
  writer.close(); store.close();
});

test('V4-T01 open pack descriptors are bounded: reads across more packs than the budget succeed while the store never holds more descriptors than the budget', { skip: !only('V4-T01') }, t => {
  // RC-03/RC-05 (S1-PRE-16 resource bound): a state of thousands of packs must not hold one descriptor per pack ever read.
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 0, maxDescriptors: 3 });
  const refs = [];
  for (let i = 0; i < 6; i++) { const w = new V4.PackWriter(store, 1); refs.push(w.append(1, 2, 0, 0, Buffer.from('{"i":' + i + '}'))); w.close(); }
  assert.equal(store.listPacks().length, 6, 'one pack per writer');
  for (let round = 0; round < 3; round++) for (const [i, ref] of refs.entries()) {
    assert.equal(store.page(ref, { kind: 1, tree: 2 }, (h, p) => p.toString()), '{"i":' + i + '}', 'every pack is readable through the bounded descriptor set');
    assert.ok(store.openDescriptors <= 3, 'the store never holds more descriptors than its budget: ' + store.openDescriptors);
  }
  assert.equal(store.openDescriptors, 3, 'the budget is used, not avoided');
  store.release(refs[5].pack); assert.equal(store.openDescriptors, 2, 'a released pack closes its descriptor');
  store.close(); assert.equal(store.openDescriptors, 0);
});

function populate(store, writer, treeId, n, valueOf = i => JSON.stringify({ phase: 'committed', generation: i, binding: { attemptId: 'a'.repeat(36), sequence: i, hash: 'h'.repeat(64), contentSha256: 'c'.repeat(64) } })) {
  const changes = new Map();
  for (let i = 0; i < n; i++) changes.set('viewing:' + String(i).padStart(8, '0') + '-' + sha256(String(i)).slice(0, 20), valueOf(i));
  return { tree: V4.Tree.empty(writer, treeId).apply(writer, changes), changes };
}

test('V4-T02 copy-on-write B+ tree: membership, verified absence, ranges, splits, deletes, overflow values', { skip: !only('V4-T02') }, t => {
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 64 * 65536 });
  const writer = new V4.PackWriter(store, 1);
  const empty = V4.Tree.empty(writer, 5);
  assert.equal(empty.count, 0); assert.equal(empty.level, 0); assert.equal(empty.get('viewing:x'), undefined, 'a genuine empty root leaf answers absence');
  const { tree, changes } = populate(store, writer, 5, 6000);
  writer.flush();
  assert.equal(tree.count, 6000); assert.ok(tree.level >= 1, 'six thousand ~200-byte members split into branches: level ' + tree.level);
  for (const [key, value] of changes) assert.equal(tree.get(key), value);
  assert.equal(tree.get('viewing:absent'), undefined); assert.equal(tree.get(''), undefined);
  assert.deepEqual(tree.check(), { keys: 6000, pages: tree.check().pages });
  assert.equal([...tree.entries()].length, 6000);
  // Delete half, update a few, insert a large value and a long key (overflow).
  const edits = new Map(); let i = 0;
  for (const key of changes.keys()) { if (i % 2 === 0) edits.set(key, null); else if (i % 7 === 0) edits.set(key, '{"phase":"aborted"}'); i++; }
  const longKey = 'viewing:' + 'k'.repeat(70000), bigValue = JSON.stringify({ payload: 'x'.repeat(150000) });
  edits.set(longKey, '{"big":1}'); edits.set('viewing:big', bigValue);
  const w2 = new V4.PackWriter(store, 2);
  const next = tree.apply(w2, edits); w2.flush();
  assert.equal(next.count, 3002);
  i = 0; for (const [key, value] of changes) { assert.equal(next.get(key), i % 2 === 0 ? undefined : (i % 7 === 0 ? '{"phase":"aborted"}' : value)); i++; }
  assert.equal(next.get(longKey), '{"big":1}'); assert.equal(next.get('viewing:big'), bigValue);
  assert.equal(next.check().keys, 3002);
  // The old root still answers its own membership (immutable pages are shared, not rewritten).
  assert.equal(tree.count, 6000); assert.equal(tree.get([...changes.keys()][0]), [...changes.values()][0]); assert.equal(tree.get(longKey), undefined);
  // A one-key change rewrites only its route: every other page of the new root is the old root's page (copy-on-write).
  const w3 = new V4.PackWriter(store, 3);
  const touched = next.apply(w3, new Map([[[...changes.keys()][1], '{"phase":"superseded"}']])); w3.close();
  const before = new Set([...next.pages()].map(r => r.pack + ':' + r.page)), after = [...touched.pages()];
  const shared = after.filter(r => before.has(r.pack + ':' + r.page)).length;
  assert.ok(after.length - shared <= next.level + 1 && shared >= after.length - (next.level + 1), 'unchanged pages are shared: ' + shared + '/' + after.length);
  assert.equal(touched.get([...changes.keys()][1]), '{"phase":"superseded"}'); assert.equal(next.get([...changes.keys()][1]), [...changes.values()][1]);
  w2.close(); writer.close(); store.close();
});

test('V4-T02 splits are even: a growing tree keeps every non-root page at least half full (never a full page and a one-member remainder)', { skip: !only('V4-T02') }, t => {
  // A tree grown by small random batches (the owner's transitions): members route by digest, so inserts land anywhere.
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 64 * 65536 });
  const writer = new V4.PackWriter(store, 1);
  let tree = V4.Tree.empty(writer, 3);
  const members = new Map();
  const value = i => JSON.stringify({ stream: 'viewing', attemptId: 'a'.repeat(36), sequence: i, hash: 'h'.repeat(64) });
  try {
    for (let i = 0; i < 1500; i += 3) {
      const changes = new Map();
      for (let j = i; j < i + 3; j++) { const key = 'slot:' + sha256(String(j)); changes.set(key, value(j)); members.set(key, value(j)); }
      writer.revision = i + 2; tree = tree.apply(writer, changes);
    }
  } catch (error) {
    // A full page plus a one-member remainder per split multiplies tiny leaves until their parent cannot hold them.
    assert.fail('a growing tree accepts every insert (a split never overflows a page): ' + String(error && (error.detail || error.message)));
  }
  writer.flush();
  assert.equal(tree.count, 1500); assert.ok(tree.level >= 1, 'the members split into several leaves');
  for (const [key, raw] of members) assert.equal(tree.get(key), raw);
  assert.equal(tree.check().keys, 1500);
  // Every page but the root holds at least half a page less one member: a split yields halves and a page only grows
  // afterwards. A full page plus a remainder would leave one-member pages whose intervals almost never fill.
  const fills = []; let pages = 0;
  for (const ref of tree.pages()) {
    const { header, payload } = V4.parsePage(store.readRaw(ref), { ref, lineageSha256: lineageSha });
    pages++;
    if (header.kind === V4.KIND.overflow || (ref.pack === tree.root.pack && ref.page === tree.root.page)) continue;
    fills.push({ level: header.level, entries: header.entryCount, bytes: payload.length });
  }
  const half = Math.floor(V4.BODY_CAPACITY / 2) - 2 * 400;
  assert.ok(fills.length >= 4, 'several non-root pages: ' + fills.length);
  for (const fill of fills) assert.ok(fill.bytes >= half, 'every non-root page is at least half full: ' + JSON.stringify(fill));
  assert.ok(pages <= 2 * Math.ceil(1500 * 300 / half) + 2, 'the page count follows the member bytes: ' + pages);
  writer.close(); store.close();
  // The partition itself: the fewest capacity-bounded groups, evened out, the minimum per group kept.
  const even = V4.partitionSizes(new Array(218).fill(300), 65176, 2);
  assert.deepEqual(even, [109, 218], 'two halves, not a full page and a one-child remainder');
  assert.deepEqual(V4.partitionSizes([300, 300, 300], 65176, 2), [3]);
  assert.deepEqual(V4.partitionSizes([], 65176, 1), [0]);
  const sizes = Array.from({ length: 700 }, (_, i) => 100 + ((i * 7919) % 900));
  const ends = V4.partitionSizes(sizes, 65176, 1);
  let start = 0; const totals = [];
  for (const end of ends) { totals.push(sizes.slice(start, end).reduce((a, b) => a + b, 0)); start = end; }
  assert.equal(ends[ends.length - 1], 700); assert.ok(totals.every(b => b <= 65176), 'no group over capacity');
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 2 * 1000, 'groups are even: ' + JSON.stringify(totals));
});

test('V4-T02 the bounded resumable walk visits every member and every page exactly once; copy-on-write reports the pages a new root drops', { skip: !only('V4-T02') }, t => {
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 16 * 65536 });
  const writer = new V4.PackWriter(store, 1);
  const { tree, changes } = populate(store, writer, 5, 4000);
  const bigKey = 'viewing:' + 'q'.repeat(70000);
  const withBlob = tree.apply(writer, new Map([[bigKey, '{"big":true}']]));
  writer.flush();
  assert.ok(withBlob.level >= 1);
  const reachable = [...withBlob.pages()].map(r => r.pack + ':' + r.page);
  assert.equal(new Set(reachable).size, reachable.length, 'the reachable page set lists each page once');
  // Walks of every budget see the same members in the same order and every reachable page exactly once.
  for (const budget of [1, 3, 7, 4096]) {
    const seen = [], visited = new Map();
    let from = null, steps = 0, keys = 0;
    for (;;) {
      const step = withBlob.checkFrom(from, budget, (key, raw) => seen.push([key, raw]), ref => visited.set(ref.pack + ':' + ref.page, (visited.get(ref.pack + ':' + ref.page) ?? 0) + 1));
      steps++; keys += step.keys;
      if (step.done) { assert.equal(step.next, null); break; }
      assert.ok(typeof step.next === 'string' && /^[0-9a-f]{64}$/.test(step.next), 'the cursor is a leaf boundary');
      from = step.next;
      assert.ok(steps < 10000);
    }
    assert.equal(keys, 4001, 'budget ' + budget + ': every member counted once');
    assert.equal(seen.length, 4001);
    assert.deepEqual(seen.map(([k]) => k), [...withBlob.entries()].map(([k]) => k), 'budget ' + budget + ': the walk order is the routing order');
    assert.deepEqual([...visited].filter(([, n]) => n !== 1), [], 'budget ' + budget + ': no page is visited twice');
    assert.deepEqual([...visited.keys()].sort(), [...reachable].sort(), 'budget ' + budget + ': the visited set is the reachable set');
    if (budget === 1) assert.ok(steps > 10, 'one leaf per step takes many steps: ' + steps);
  }
  // Copy-on-write accounting: the pages the new root no longer references are exactly the old reachable set minus the
  // new one (the replaced route, the replaced bucket's blob, nothing shared); the writer lists what it appended.
  const w2 = new V4.PackWriter(store, 2), orphans = [];
  const firstKey = [...changes.keys()][0];
  const next = withBlob.apply(w2, new Map([[firstKey, null], [bigKey, '{"big":false}']]), orphans); w2.flush();
  const before = new Set(reachable), after = new Set([...next.pages()].map(r => r.pack + ':' + r.page));
  const dropped = [...before].filter(p => !after.has(p)).sort(), reported = orphans.map(r => r.pack + ':' + r.page).sort();
  assert.deepEqual(reported, dropped, 'the orphans of a transition are exactly the pages the new root dropped');
  const appended = new Set(w2.written.map(r => r.pack + ':' + r.page)), added = [...after].filter(p => !before.has(p));
  assert.ok(added.every(p => appended.has(p)), 'every page the new root added was appended by this writer');
  assert.equal(next.get(firstKey), undefined); assert.equal(next.get(bigKey), '{"big":false}'); assert.equal(next.count, 4000);
  // RC-03 (S1-PRE-14): a relocation touch moves an overflow chain only when it occupies a pack being evacuated; the
  // moved bucket keeps its value, the old chain is reported orphaned, and an ordinary touch leaves the chain in place.
  const chainBefore = [...next.pagesWithOwners()].filter(([, owner]) => owner !== null);
  assert.ok(chainBefore.length >= 2, 'the long key is stored as an overflow chain: ' + chainBefore.length);
  assert.ok(chainBefore.every(([, owner]) => owner.tree === 5 && owner.digest === V4.routingDigest(5, bigKey)), 'every overflow page names the bucket that owns its chain');
  const chainPacks = new Set(chainBefore.map(([ref]) => ref.pack));
  const w3 = new V4.PackWriter(store, 3), untouched = [];
  const stays = next.touch(w3, [V4.routingDigest(5, bigKey)], untouched); w3.flush();
  assert.deepEqual([...stays.pagesWithOwners()].filter(([, o]) => o !== null).map(([r]) => r.pack + ':' + r.page), chainBefore.map(([r]) => r.pack + ':' + r.page), 'a plain touch reuses the chain where it is');
  assert.ok(untouched.every(r => !chainBefore.some(([c]) => c.pack === r.pack && c.page === r.page)), 'a plain touch orphans no chain page');
  const w4 = new V4.PackWriter(store, 4), moved = [];
  const evacuated = next.touch(w4, [V4.routingDigest(5, bigKey)], moved, chainPacks); w4.flush();
  const chainAfter = [...evacuated.pagesWithOwners()].filter(([, o]) => o !== null).map(([r]) => r);
  assert.equal(chainAfter.length, chainBefore.length, 'the chain is copied page for page');
  assert.ok(chainAfter.every(r => !chainPacks.has(r.pack)), 'an evacuated overflow chain leaves its pack');
  assert.ok(chainBefore.every(([c]) => moved.some(r => r.pack === c.pack && r.page === c.page)), 'the old chain pages are the orphans of the evacuation');
  assert.equal(evacuated.get(bigKey), '{"big":false}', 'the evacuated bucket keeps its value'); assert.equal(evacuated.count, 4000);
  assert.deepEqual(w4.overflowRoutes.map(n => n.tree + ':' + n.digest), ['5:' + V4.routingDigest(5, bigKey)], 'the writer records the owning bucket of the chain it wrote');
  w4.close(); w3.close(); w2.close(); writer.close(); store.close();
});

test('V4-T02 collision buckets retain and compare the full key (isolated harness with a substituted routing hash)', { skip: !only('V4-T02') }, t => {
  // An isolated copy of the module whose routing digest depends only on the key's first character: distinct keys
  // collide deliberately; nothing in the product can select this behaviour.
  const H2 = compile(path.join(root, 'api/src/emr-runtime/checkpoint-v4.ts'), source => source.replace(
    "return domainHash(DOMAIN.key, Buffer.concat([id, Buffer.from(key, 'utf16le').swap16()]));",
    "return domainHash(DOMAIN.key, Buffer.concat([id, Buffer.from(key.slice(0, 1), 'utf16le').swap16()]));"));
  assert.notEqual(H2.routingDigest(5, 'ab'), V4.routingDigest(5, 'ab'), 'the harness substitute is in effect');
  assert.equal(H2.routingDigest(5, 'ab'), H2.routingDigest(5, 'ac'));
  const dir = scratch(t), store = new H2.PackStore(path.join(dir, 'v4'), lineageSha, {});
  const writer = new H2.PackWriter(store, 1);
  const changes = new Map([['ab', '{"v":"ab"}'], ['ac', '{"v":"ac"}'], ['a😀', '{"v":"emoji"}'], ['a\uD83D', '{"v":"lone-high"}'], ['b', '{"v":"b"}'], ['aa', '{"v":"aa"}']]);
  const tree = H2.Tree.empty(writer, 5).apply(writer, changes); writer.flush();
  assert.equal(tree.count, 6);
  for (const [key, value] of changes) assert.equal(tree.get(key), value, 'full-key identity inside a bucket: ' + JSON.stringify(key));
  assert.equal(tree.get('ad'), undefined, 'absence inside an existing bucket after exhaustive comparison');
  assert.equal(tree.get('a'), undefined);
  const w2 = new H2.PackWriter(store, 2);
  const next = tree.apply(w2, new Map([['ab', null], ['ac', '{"v":"ac2"}']])); w2.flush();
  assert.equal(next.get('ab'), undefined); assert.equal(next.get('ac'), '{"v":"ac2"}'); assert.equal(next.get('aa'), '{"v":"aa"}'); assert.equal(next.count, 5);
  assert.equal(next.check().keys, 5);
  // The bucket's pairs are sorted by UTF-16 code units: the lone high surrogate sorts after the pair's second unit? No -
  // 'a\uD83D' < 'a😀' (prefix), both after 'ac' (0x63 < 0xD83D).
  const leafPairs = [...next.entries()].map(([k]) => k);
  assert.deepEqual(leafPairs.slice(0, 4), ['aa', 'ac', 'a\uD83D', 'a😀']);
  w2.close(); writer.close(); store.close();
});

test('V4-T03 a corrupt, missing or truncated page on the route is never absence and the index is not used past it', { skip: !only('V4-T03') }, t => {
  const dir = scratch(t), store = new V4.PackStore(path.join(dir, 'v4'), lineageSha, { cacheBytes: 2 * 65536 });
  const writer = new V4.PackWriter(store, 1);
  const { tree, changes } = populate(store, writer, 5, 3000); writer.close();
  const keys = [...changes.keys()];
  assert.ok(tree.level >= 1);
  // Corrupt one leaf page byte: lookups routed through it refuse (SealCorrupt), others still answer.
  const victim = [...tree.pages()].find(r => { const node = store.page(r, {}, h => h); return node.kind === 1; });
  store.invalidate();
  const file = store.packFile(victim.pack), pageStart = Number(victim.page) * 65536;
  const pristinePage = fs.readFileSync(file).subarray(pageStart, pageStart + 65536);
  const writeAt = (offset, bytes) => { const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, bytes, 0, bytes.length, offset); } finally { fs.closeSync(fd); } store.invalidate(); };
  writeAt(pageStart + 300, Buffer.from([0xff]));
  let refused = 0, answered = 0;
  for (const key of keys) { try { assert.notEqual(tree.get(key), undefined); answered++; } catch (e) { assert.equal(e.code, 'SealCorrupt'); refused++; } }
  assert.ok(refused > 0 && answered > 0, 'refused ' + refused + ', answered ' + answered);
  assert.throws(() => tree.check(), { code: 'SealCorrupt' }, 'the full check refuses the tree');
  // A structurally valid change (one digit of a stored member's generation; the leaf stays canonical JSON and the
  // member stays a valid record) is refused by the page checksum alone: no lookup ever returns the altered value.
  writeAt(pageStart, pristinePage);
  for (const key of keys) assert.equal(tree.get(key), changes.get(key), 'the restored page answers again');
  const payload = pristinePage.subarray(128, 65504).toString('latin1'), marker = '\\"generation\\":1';
  const at = payload.indexOf(marker);
  assert.ok(at > 0, 'the leaf holds an inline member whose generation starts with 1');
  writeAt(pageStart + 128 + at + marker.length - 1, Buffer.from('2'));
  let digitRefused = 0;
  for (const key of keys) { try { assert.equal(tree.get(key), changes.get(key), 'no altered value is ever returned'); } catch (e) { assert.equal(e.code, 'SealCorrupt', String(e.message)); digitRefused++; } }
  assert.ok(digitRefused > 0, 'the validly structured change is refused by the page checksum: refused ' + digitRefused);
  writeAt(pageStart + 300, Buffer.from([0xff]));
  // Truncate the pack below the victim page: the same refusal class, never absence.
  fs.truncateSync(file, Number(victim.page) * 65536);
  store.invalidate();
  let truncated = 0;
  for (const key of keys) { try { tree.get(key); } catch (e) { assert.equal(e.code, 'SealCorrupt'); truncated++; } }
  assert.ok(truncated > 0);
  // A missing pack: every route through it refuses.
  fs.unlinkSync(file); store.invalidate();
  assert.throws(() => { for (const key of keys) tree.get(key); }, { code: 'SealCorrupt' });
  store.close();
});

test('V4-T01 root, selector and WAL envelopes: exact schemas, filenames by hash, atomic selector, chained records', { skip: !only('V4-T01') }, t => {
  const dir = scratch(t), v4 = path.join(dir, 'v4'), store = new V4.PackStore(v4, lineageSha, {});
  const writer = new V4.PackWriter(store, 1);
  const trees = V4.TREE_IDS.map(id => { const tr = V4.Tree.empty(writer, id); return { id, count: '0', ref: tr.root }; });
  writer.close();
  const manifest = V4.validatorManifest(root);
  assert.equal(manifest.validatorSha256, V4.validatorManifest(root).validatorSha256, 'deterministic');
  assert.ok(manifest.files.some(f => f.path === 'api/src/emr-runtime/checkpoint-v4.ts') && manifest.files.some(f => f.path.endsWith('migration.sql')));
  assert.deepEqual(manifest.files.map(f => f.path), [...manifest.files.map(f => f.path)].sort());
  const fullCheck = { checkedRoot: null, coverageSha256: 'a'.repeat(64), checkedRevision: '1', validatorSha256: manifest.validatorSha256, completedAt: '2026-10-22T00:00:00.000Z', dbWitnessSha256: 'b'.repeat(64) };
  const body = { format: 'KIN-EMR-STATE-V4', version: 4, layout: 1, validatorId: 'b2c-v4.1', validatorSha256: manifest.validatorSha256, revision: '1', generation: '1', lineageSha256: lineageSha, trees, stateTailSha256: null, transition: { previousRoot: null, kind: 'initialize', changes: null }, fullCheck };
  const rootSha = V4.writeRoot(v4, body);
  assert.equal(rootSha, H('KIN-EMR-V4/root', V4.canonical(body)));
  assert.ok(fs.existsSync(path.join(v4, 'roots', rootSha + '.json')));
  assert.deepEqual(V4.readRoot(v4, rootSha), body);
  assert.throws(() => V4.readRoot(v4, 'c'.repeat(64)), { code: 'SealCorrupt' });
  rejects(() => V4.validRootBody({ ...body, extra: 1 }), 'unknown root field');
  rejects(() => V4.validRootBody({ ...body, transition: { previousRoot: null, kind: 'patch', changes: { inline: [] } } }), 'patch without predecessor');
  rejects(() => V4.validRootBody({ ...body, trees: trees.slice(0, 7) }), 'seven trees');
  assert.throws(() => V4.validRootBody({ ...body, version: 5 }), { code: 'SealUnsupportedFormat' });
  // A renamed root file does not pass under another name; a changed byte fails its hash.
  fs.copyFileSync(path.join(v4, 'roots', rootSha + '.json'), path.join(v4, 'roots', 'd'.repeat(64) + '.json'));
  assert.throws(() => V4.readRoot(v4, 'd'.repeat(64)), { code: 'SealCorrupt' });
  const selectorFile = path.join(dir, 'settlement.json');
  const wal = V4.WalSegment.create(v4);
  const start = wal.append({ format: 'KIN-EMR-WAL', version: 4, segment: wal.segment, lsn: '1', previousSha256: V4.ZERO64, type: 'start', baseRoot: rootSha, previousSegment: null });
  const prepare = wal.append({ format: 'KIN-EMR-WAL', version: 4, segment: wal.segment, lsn: '2', previousSha256: start.sha256, type: 'prepare', previousRoot: rootSha, nextRoot: rootSha, transitionSha256: 'e'.repeat(64), tailBefore: null, tailAfter: null });
  const complete = wal.append({ format: 'KIN-EMR-WAL', version: 4, segment: wal.segment, lsn: '3', previousSha256: prepare.sha256, type: 'complete', prepareLsn: '2', nextRoot: rootSha });
  wal.close();
  const selector = { format: 'KIN-EMR-STATE-V4', version: 4, layout: 1, rootSha256: rootSha, revision: '1', wal: { segment: wal.segment, offset: String(complete.end), lsn: '3', previousSha256: complete.sha256 } };
  V4.writeSelector(selectorFile, selector);
  assert.deepEqual(V4.readSelector(selectorFile).body, selector);
  assert.ok(!fs.readdirSync(dir).some(n => n.startsWith('.tmp-')), 'no temporary selector left behind');
  const read = V4.WalSegment.read(wal.file, 0);
  assert.equal(read.records.length, 3); assert.equal(read.torn, null); assert.deepEqual(read.records.map(r => r.record.type), ['start', 'prepare', 'complete']);
  assert.equal(read.records[2].end, complete.end); assert.equal(V4.WalSegment.read(wal.file, complete.end).records.length, 0);
  fs.appendFileSync(wal.file, '{"body":{"format":"KIN-EMR-WAL"');
  const torn = V4.WalSegment.read(wal.file, 0); assert.equal(torn.records.length, 3); assert.ok(torn.torn && torn.torn.length > 0);
  fs.writeFileSync(selectorFile, '{"state":{"version":3}}');
  assert.throws(() => V4.readSelector(selectorFile), { code: 'SealUnsupportedFormat' }, 'a v3 checkpoint at the selector path is the other format, never corrupt');
  fs.writeFileSync(selectorFile, V4.envelope('KIN-EMR-V4/selector', { ...selector, rootSha256: 'f'.repeat(64) }).text.replace('"version":4', '"version":4 '));
  assert.throws(() => V4.readSelector(selectorFile), { code: 'SealCorrupt' });
  store.close();
});
