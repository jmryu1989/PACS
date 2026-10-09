'use strict';
// D73: hashes assert the explicitly ordered move equivalence, not business rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSource, targets, sha256 } = require('./pacs_source.cjs');
const { assertContract, assertEntry, fingerprint } = require('./pacs_split_contract.cjs');
const spec = require('./pacs_split_spec.json');
const apiSrc = path.resolve(__dirname, '../tmp/s9-u0b-relist/virtual-api');
const file = 'api/src/pacs/worklist.ts', relative = file.slice('api/src/'.length);
const plain = 'export class Worklist { list(uid: string) { return uid; } }';
function fixture(text = plain, change = () => {}, extra = {}) {
  const entry = { id: 'member:list:MethodDeclaration', category: 'member', name: 'list', kind: 'MethodDeclaration', target: file,
    live: { file, owner: 'Worklist', name: 'list', kind: 'MethodDeclaration' } };
  const wanted = { schema: 1, phase: 'split', targets, entries: [entry] };
  wanted.allocation_sha256 = sha256(JSON.stringify(wanted.entries.map(e => [e.id, e.target])));
  change(wanted);
  return createSource({ apiSrc, spec: wanted, overrides: { [path.join(apiSrc, relative)]: text, ...extra } });
}
test('U0B-STRUCT-NORMAL all 125 members and 57 declarations resolve with unchanged text and SQL bindings', () => {
  const source = createSource();
  assert.deepEqual(assertContract(source), { members: 125, declarations: 57 });
  assert.equal(source.sourceFiles().find(f => f.file === 'api/src/pacs.service.ts').sha256, spec.service_sha256);
});
test('U0B-STRUCT-SPLIT explicit moved location and re-export resolve in one Program', () => {
  const source = fixture(plain, () => {}, { [path.join(apiSrc, 'pacs.service.ts')]: "export { Worklist } from './pacs/worklist';" });
  assert.deepEqual(source.validate(), { members: 1, declarations: 0 });
  assert.equal(source.sourceFiles().length, 2);
  assert.equal(source.member('list').getSourceFile().fileName.replace(/\\/g, '/').endsWith('/pacs/worklist.ts'), true);
});
test('U0B-M21 missing member is rejected by declaration resolution', () => {
  assert.deepEqual(fixture().validate(), { members: 1, declarations: 0 });
  assert.throws(() => fixture('export class Worklist {}').validate(), /Missing declaration/);
});
test('U0B-M22 duplicate member is rejected rather than choosing the first declaration', () => {
  assert.deepEqual(fixture().validate(), { members: 1, declarations: 0 });
  assert.throws(() => fixture('export class Worklist { list(uid: string) { return uid; } list(uid: string) { return uid; } }').validate(), /Ambiguous or duplicate declaration/);
});
test('U0B-AMBIGUOUS same-name accessors require an explicit declaration kind', () => {
  const source = fixture('export class Worklist { get value() { return 1; } set value(n: number) {} }', wanted => {
    wanted.entries = ['GetAccessor', 'SetAccessor'].map(kind => ({ id: `member:value:${kind}`, category: 'member', name: 'value', kind,
      target: file, live: { file, owner: 'Worklist', name: 'value', kind } }));
    wanted.allocation_sha256 = sha256(JSON.stringify(wanted.entries.map(e => [e.id, e.target])));
  });
  assert.deepEqual(source.validate(), { members: 2, declarations: 0 });
  assert.throws(() => source.member('value'), /ambiguous member name/);
  assert.equal(source.member('value', 'GetAccessor').name.text, 'value');
});
test('U0B-UNRESOLVED spec entry never falls back to a facade declaration', () => {
  const source = fixture(plain, wanted => { wanted.entries[0].live.owner = 'AbsentOwner'; });
  assert.throws(() => source.validate(), /Missing or ambiguous owner/);
});
test('U0B-UNRESOLVED-IMPORT an unresolved relative module cannot disappear from the source corpus', () => {
  assert.throws(() => fixture("import { gone } from './missing'; " + plain), /Unresolved module/);
});

for (const [label, statement] of [
  ['import', name => `import { ${name} as value } from './values'; export class Worklist { list(uid: string) { return value(uid); } }`],
  ['re-export', name => `export { ${name} as value } from './values'; ${plain}`],
]) test(`U0B-R01 missing named ${label} from an existing module is rejected`, () => {
  const extra = { [path.join(apiSrc, 'pacs/values.ts')]: 'export function present(uid: string) {return uid;}' };
  assert.deepEqual(fixture(statement('present'), () => {}, extra).validate(), { members: 1, declarations: 0 });
  // Sol's counterexample: the module exists, but the requested export does not.
  assert.throws(() => fixture(statement('absent'), () => {}, extra).validate(), /Unresolved named export: absent/);
});

for (const [field, value] of [['name', 'gatewayReceiptt'], ['kind', 'PropertyDeclaration'],
  ['id', 'member:gatewayReceiptt:MethodDeclaration'], ['category', 'declaration'], ['live.kind', undefined]]) {
  test(`U0B-R02 spec ${field} must describe the resolved declaration`, () => {
    assert.deepEqual(assertContract(createSource()), { members: 125, declarations: 57 });
    const wrong = structuredClone(spec);
    const entry = wrong.entries.find(item => item.name === 'gatewayReceipt');
    if (field === 'live.kind') delete entry.live.kind;
    else entry[field] = value;
    // Keep the allocation internally valid so the identity assertion is the oracle.
    wrong.allocation_sha256 = sha256(JSON.stringify(wrong.entries.map(e => [e.id, e.target])));
    assert.throws(() => assertContract(createSource({ spec: wrong })), /Inconsistent spec identity/);
  });
}
test('U0B-DUPLICATE-OLD an old unremoved implementation is rejected outside the live spec location', () => {
  const normal = fixture();
  const baseline = fingerprint(normal, normal.member('list'));
  normal.spec.entries[0].baseline = baseline;
  assert.deepEqual(normal.validate(), { members: 1, declarations: 0 });
  const wrong = fixture(plain, wanted => { wanted.entries[0].baseline = baseline; },
    { [path.join(apiSrc, 'pacs.service.ts')]: 'export class OldOwner { list(uid: string) { return uid; } }' });
  assert.throws(() => wrong.validate(), /Duplicate unmapped implementation/);
});
test('U0B-MISNAMED target typo and wrong approved concern are independently rejected', () => {
  assert.throws(() => fixture(plain, wanted => { wanted.targets = [...targets, 'api/src/pacs/worklists.ts']; }).validate(), /Misnamed target/);
  assert.throws(() => fixture(plain, wanted => { wanted.entries[0].target = 'api/src/pacs/hold.ts'; }).validate(), /Target allocation differs/);
});
test('U0B-M22-ARGS wrong argument forwarding fails the explicit movement equivalence', () => {
  const original = fixture('export class Worklist { send(left: string, right: string) { return [left, right]; } list(uid: string) { return this.send(uid, "fixed"); } }');
  const entry = original.spec.entries[0]; entry.baseline = fingerprint(original, original.locate(entry.live));
  assertEntry(original, entry);
  const wrong = fixture('export class Worklist { send(left: string, right: string) { return [left, right]; } list(uid: string) { return this.send("fixed", uid); } }');
  assert.throws(() => assertEntry(wrong, entry), /Move equivalence/);
});
for (const [name, altered] of [
  ['text', 'export class Worklist { list(uid: string, other: string, tx: any) { return tx.$queryRaw`SELECT changed WHERE uid = ${uid}`; } }'],
  ['binding', 'export class Worklist { list(uid: string, other: string, tx: any) { return tx.$queryRaw`SELECT name WHERE uid = ${other}`; } }'],
  ['receiver', 'export class Worklist { list(uid: string, other: string, tx: any, root: any) { return root.$queryRaw`SELECT name WHERE uid = ${uid}`; } }'],
]) test(`U0B-M25-${name} SQL provenance detects its own independent mutation`, () => {
  const original = fixture('export class Worklist { list(uid: string, other: string, tx: any) { return tx.$queryRaw`SELECT name WHERE uid = ${uid}`; } }');
  const entry = original.spec.entries[0]; entry.baseline = fingerprint(original, original.locate(entry.live));
  assertEntry(original, entry);
  assert.throws(() => assertEntry(fixture(altered), entry), /SQL text\/binding provenance/);
});
