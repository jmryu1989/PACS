'use strict';
// D73: hashes assert the explicitly ordered move equivalence, not business rules.
// Byte pins (AGENTS §1-B.14): the service and declaration hashes are taken over the LF form of the text, so the same
// commit hashes alike in a Windows autocrlf (CRLF) checkout and on the Linux CI (LF); only the content is pinned.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Split phase (S9-U0b round 2): every original unit lives in its approved concern and is compared with its unchanged
// RELIST baseline through the bounded correspondence its entry records (pacs_split_contract.cjs); the facade and the
// concern files may hold nothing the spec does not name; Nest's DI and route metadata equal the snapshot taken from main
// before the split (spec.di_source). The counter-cases below each change one thing on synthetic sources and must be
// refused by their own check.
const { createSource, targets, sha256 } = require('./pacs_source.cjs');
const { assertContract, assertEntry, fingerprint, diSnapshot, historicalSource } = require('./pacs_split_contract.cjs');
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
test('U0B-STRUCT-NORMAL historical text/SQL proof and current ownership/forwarding both hold', () => {
  assert.equal(spec.phase, 'split');
  const source = createSource();
  // validate() also holds the facade (slots, composition, 64 forwarders, 13 re-exports) and the 16 concern files to the spec
  assert.deepEqual(source.validate(), { members: 125, declarations: 57 });
  assert.deepEqual(assertContract(historicalSource()), { members: 125, declarations: 57 });
  assert.equal(spec.facade.forwards.length, 64);
  assert.equal(spec.facade.slots.length, 15);
  assert.equal(spec.facade.reexports.length, 13);
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
    assert.deepEqual(createSource().validate(), { members: 125, declarations: 57 });
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

// ── facade and concern structure (order section 7 structure, M21 missing / M22 wrong forwarding / M23 decorator) ──
const facadeFile = 'api/src/pacs.service.ts';
const facadeText = (members = '', head = '', decorator = '@Injectable()') => [
  "import { Injectable, Scope } from '@nestjs/common';", "import { Worklist } from './pacs/worklist';", head, decorator,
  'export class PacsService {', '  private readonly worklistConcern: Worklist;', '  constructor() {', '    this.worklistConcern = new Worklist();', '  }',
  '  async list(uid: string, other: string) {', '    return this.worklistConcern.list(uid, other);', '  }', members, '}'].join('\n');
const concernText = 'export class Worklist { list(uid: string, other: string) { return uid + other; } }';
function facadeFixture({ facade = facadeText(), concern = concernText, change = () => {} } = {}) {
  const ctor = { id: 'member:constructor:Constructor', category: 'member', name: 'constructor', kind: 'Constructor', target: facadeFile,
    live: { file: facadeFile, owner: 'PacsService', name: 'constructor', kind: 'Constructor' } };
  const list = { id: 'member:list:MethodDeclaration', category: 'member', name: 'list', kind: 'MethodDeclaration', target: file,
    live: { file, owner: 'Worklist', name: 'list', kind: 'MethodDeclaration' } };
  const wanted = { schema: 1, phase: 'split', targets, entries: [ctor, list],
    facade: { file: facadeFile, class: 'PacsService', parameters: [],
      slots: [{ name: 'worklistConcern', class: 'Worklist', file, args: [] }],
      forwards: [{ name: 'list', slot: 'worklistConcern', signature_sha256: sha256('async list(uid: string, other: string)') }], reexports: [] },
    concerns: { [file]: { class: 'Worklist', parameters: [] } } };
  change(wanted);
  wanted.allocation_sha256 = sha256(JSON.stringify(wanted.entries.map(e => [e.id, e.target])));
  return createSource({ apiSrc, spec: wanted,
    overrides: { [path.join(apiSrc, relative)]: concern, [path.join(apiSrc, 'pacs.service.ts')]: facade } });
}
test('U0B-FACADE the exact forwarding facade and its concern pass; each structural deviation is refused on its own', () => {
  assert.deepEqual(facadeFixture().validate(), { members: 2, declarations: 0 });
  const refused = (options, pattern) => assert.throws(() => facadeFixture(options).validate(), pattern);
  // M22: the arguments reach the concern in another order, or another method answers
  refused({ facade: facadeText().replace('list(uid, other)', 'list(other, uid)') }, /Facade forwarding differs: list/);
  refused({ facade: facadeText().replace('this.worklistConcern.list(', 'this.worklistConcern.constructor(') }, /Facade forwarding differs: list/);
  // the public signature is the original one
  refused({ facade: facadeText().replace('async list(uid: string, other: string)', 'async list(uid: string, other?: string)') }, /Facade signature differs: list/);
  // M21: a public method is missing; an original body is left behind beside the forwarders
  refused({ facade: facadeText().replace(/  async list[\s\S]*?\n  \}\n/, '') }, /Missing facade forwarding/);
  refused({ facade: facadeText('  private visible(s: any) { return s; }') }, /Unlisted facade method: visible/);
  refused({ facade: facadeText('  private institutions: any[] = [];') }, /Unlisted facade field: institutions/);
  refused({ facade: facadeText('', 'export const leaked = 1;') }, /Unlisted facade statement/);
  refused({ change: wanted => { wanted.facade.reexports = ['qidoCount']; } }, /Facade re-exports differ/);
  // composition: once per slot, from the recorded references, with `new` of the concern class
  refused({ facade: facadeText().replace('    this.worklistConcern = new Worklist();', '    const made = new Worklist();\n    this.worklistConcern = made;') }, /Facade composition differs/);
  refused({ change: wanted => { wanted.facade.slots[0].args = ['prisma']; } }, /Facade composition differs: worklistConcern/);
  // M23 (static): the facade stays a default-scope Nest provider; a concern carries no decorator
  refused({ facade: facadeText('', '', '@Injectable({ scope: Scope.REQUEST })') }, /Facade class decorator differs/);
  refused({ concern: "import { Injectable } from '@nestjs/common';\n@Injectable()\n" + concernText }, /Concern decorator/);
  // a copy left in a concern file, or a concern constructor that does more than store references
  refused({ concern: concernText.replace(' } }', ' } visible(s: any) { return s; } }') }, /Unlisted member in api\/src\/pacs\/worklist.ts: visible/);
  refused({ concern: concernText.replace('export class Worklist {', 'export class Worklist { constructor() { console.log(1); }') }, /Concern constructor differs/);
});
test('U0B-CORRESPONDENCE a receiver is read back only as recorded: exact pair and count, nothing unrecorded', () => {
  const before = fixture('export class Worklist { list(uid: string) { return this.visible(uid); } visible(u: string) { return u; } }');
  const baseline = fingerprint(before, before.member('list'));
  const moved = fixture('export class Access { visible(u: string) { return u; } }\n' +
    'export class Worklist { constructor(private readonly access: Access) {} list(uid: string) { return this.access.visible(uid); } }');
  const entry = { ...moved.spec.entries[0], baseline, correspondence: { receivers: [{ field: 'access', member: 'visible', count: 1 }] } };
  assertEntry(moved, entry);
  assert.throws(() => assertEntry(moved, { ...entry, correspondence: null }), /Move equivalence/);
  assert.throws(() => assertEntry(moved, { ...entry, correspondence: { receivers: [{ field: 'access', member: 'visible', count: 2 }] } }), /Receiver correspondence/);
  const other = fixture('export class Access { gate(u: string) { return u; } }\n' +
    'export class Worklist { constructor(private readonly access: Access) {} list(uid: string) { return this.access.gate(uid); } }');
  assert.throws(() => assertEntry(other, { ...entry, live: other.spec.entries[0].live }), /Move equivalence/);
});

// ── Nest DI and routes (order section 7 DI/routes, M23/M24) ──
test('U0B-DI Nest metadata equals main before the split: tokens, constructor tokens, scopes, enhancers, middleware, 138 routes', () => {
  const now = diSnapshot();
  assert.deepEqual(now, spec.di);
  assert.equal(now.routes.length, 138);
  assert.deepEqual(now.injectables.PacsService.params, ['PrismaService', 'OrthancService', 'KeycloakService', 'StudyAccessService', 'FindingService']);
  // the concerns are plain objects the facade owns: no Nest metadata, not registered anywhere
  for (const [target, concern] of Object.entries(spec.concerns)) {
    if (!concern.class) continue;
    const cls = require('/app/dist/' + target.slice('api/src/'.length, -3))[concern.class];
    assert.equal(typeof cls, 'function', concern.class);
    assert.equal(Reflect.getMetadata('__injectable__', cls), undefined, concern.class);
    assert.equal(now.providers.includes(concern.class) || now.controllers.includes(concern.class), false, concern.class);
  }
});
test('U0B-DI-RUNTIME Nest builds one PacsService for its consumers and starts it once', async () => {
  diSnapshot();   // compiles api/src through the loader unless /app/dist exists
  const { NestFactory } = require('/app/node_modules/@nestjs/core');
  const { Module } = require('/app/node_modules/@nestjs/common');
  const { PacsService } = require('/app/dist/pacs.service');
  const { PrismaService } = require('/app/dist/prisma.service');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const { KeycloakService } = require('/app/dist/keycloak.service');
  const { StudyAccessService } = require('/app/dist/study-access.service');
  const { FindingService } = require('/app/dist/finding.service');
  const { ClinicalContextService } = require('/app/dist/clinical-context.service');
  const { ViewerContextEventService } = require('/app/dist/viewer-context-event.service');
  const calls = [];
  const prisma = { institution: { upsert: async () => { calls.push('upsert'); return {}; },
      findMany: async () => { calls.push('findMany'); return [{ id: 'syn-a', name: 'SYN A', type: 'hospital', dicomNames: 'SYN A HOSPITAL' }]; } },
    order: { count: async () => { calls.push('count'); return 1; }, updateMany: async () => { calls.push('updateMany'); return { count: 0 }; } } };
  class DiProbe {}
  Module({ providers: [PacsService, ClinicalContextService, ViewerContextEventService, { provide: PrismaService, useValue: prisma },
    { provide: OrthancService, useValue: {} }, { provide: KeycloakService, useValue: {} }, { provide: StudyAccessService, useValue: {} },
    { provide: FindingService, useValue: {} }] })(DiProbe);
  const log = console.log; console.log = () => {};
  let ctx;
  try { ctx = await NestFactory.createApplicationContext(DiProbe, { logger: false }); await ctx.init(); }
  finally { console.log = log; }
  try {
    const pacs = ctx.get(PacsService);
    assert.equal(ctx.get(PacsService), pacs, 'one instance');
    assert.ok(ctx.get(ClinicalContextService) && ctx.get(ViewerContextEventService), 'the consumers resolve against it');
    assert.equal(calls.filter(c => c === 'findMany').length, 1, 'onModuleInit ran once');
    assert.equal(calls.indexOf('findMany') > calls.lastIndexOf('upsert'), true, 'the seed runs before the cache is read');
    assert.equal(pacs.institutionName('syn-a'), 'SYN A', 'the started instance serves the cache it loaded');
  } finally { await ctx.close(); }
});

// ── recorder inputs (order section 9, M26): a run record that hashes the facade also hashes the code it forwards to ──
test('U0B-RECORDER-INPUTS every record-run that names the facade names all 16 concern files; the module suite has its own record', () => {
  const fs = require('node:fs');
  const modules = Object.keys(spec.concerns);
  assert.equal(modules.length, 16);
  let records = 0;
  for (const workflow of ['.github/workflows/validate.yml', '.github/workflows/gateway-e2e.yml']) {
    const lines = fs.readFileSync(path.resolve(__dirname, '..', workflow), 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.includes('scripts/record-run.py') || !line.includes(' --file api/src/pacs.service.ts ')) continue;
      records++;
      const missing = modules.filter(module => !line.includes(' --file ' + module + ' '));
      assert.deepEqual(missing, [], `${workflow}:${index + 1} hashes the facade without its concern files`);
    }
  }
  assert.ok(records >= 2, 'the facade is recorded somewhere');
  const validate = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/validate.yml'), 'utf8').replace(/\r\n/g, '\n');
  const own = validate.split('\n').filter(line => line.includes('--run-dir tmp/workspace-ui-ci/pacs-split-modules '));
  assert.equal(own.length, 1);
  assert.ok(own[0].includes(' --file tests/pacs_split_modules_test.cjs -- node --test --test-reporter=tap tests/pacs_split_modules_test.cjs'), own[0]);
});
