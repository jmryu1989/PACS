/* REQ-EMR-01/04/05/06/07/12/13/17/19/20 -> corresponding RISK-EMR IDs -> TEST-EMR-*-A below.
 * Signature byte equality is itself the interoperability contract (AGENTS 1-B.14).
 * Inventory uses Prisma's installed parser through its generator protocol and TypeScript AST,
 * never a handwritten schema/TS parser or a stale generated client's model list. Synthetic data only.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prisma invokes this file as a generator to supply freshly parsed DMMF, without generating a client.
if (process.argv.includes('--emr-inventory-generator')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    let result;
    if (request.method === 'getManifest') result = { manifest: { prettyName: 'EMR inventory', defaultOutput: './inventory.json' } };
    else if (request.method === 'generate') {
      fs.writeFileSync(request.params.generator.output.value, JSON.stringify(request.params.dmmf.datamodel));
      result = null;
    } else throw new Error(`Unexpected generator request: ${request.method}`);
    process.stderr.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
} else {
  const assert = require('node:assert/strict');
  const { test, beforeEach } = require('node:test');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const api = path.join(root, 'api');
  const ts = require(path.join(api, 'node_modules/typescript'));
  // Compile with the installed compiler; contract tests run the same TS module semantics as api/tsconfig.
  const originalTsLoader = require.extensions['.ts'];
  const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
    { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
  const M = require('../api/src/emr-contract/composition.ts');
  const C = require('../api/src/emr-contract/classification.ts');
  const R = require('../api/src/emr-contract/routes.ts');
  const D = require('../api/src/emr-contract/lawful-defaults.ts');
  const B = require('../api/src/emr-contract/legal-basis.ts');
  const A = require('../api/src/emr-contract/access-event.ts');
  const S = require('../api/src/emr-contract/signature.ts');
  const L = require('../api/src/emr-contract/report-lifecycle.ts');
  if (originalTsLoader) require.extensions['.ts'] = originalTsLoader; else delete require.extensions['.ts'];
  const clone = value => structuredClone(value);
  const t0 = '2026-10-05T00:00:00.000Z';
  const deadline = '2026-10-06T00:00:00.000Z';
  const identity = id => ({ id, issuer: 'https://identity.example.test', subject: `sub-${id}` });
  const patient = { linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' };
  const known = value => ({ status: 'known', value });
  const ref = versionId => ({ recordId: 'report-1', versionId, sha256: 'ab'.repeat(32) });
  // Synthetic storage capabilities are wired once; handlers use IDs or verified rows, not new readers.
  const storedRows = new Map(), dutyRows = new Map(), requestRows = new Map(), endRows = new Map(), resultRows = new Map(), intentRows = new Map();
  const holdIndex = new Map(), correctionRows = new Map();
  let incompleteHolds = false, clinicalStudyOverrides = {};
  const rawStoredReader = { load: (id, eid) => storedRows.get(id + ':' + eid) };
  const adapters = {
    stored: rawStoredReader,
    legal: { load: id => dutyRows.get(id), listHolds: id => ({ recordId: id, holdIds: holdIndex.get(id) || [], complete: !incompleteHolds }),
      loadAccessRequest: id => requestRows.get(id), loadCorrectionRequest: id => correctionRows.get(id),
      loadClauseVersions: key => key === 'synthetic-law:article-1' ? [{ law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2026-01-01', effectiveAt: '2026-01-01' }] : [] },
    purpose: { load: id => endRows.get(id), loadSignedResult: (id, vid) => resultRows.get(id + ':' + vid), loadIntentEndingFact: id => intentRows.get(id) },
    clinical: { loadStudy: studyId => ({ studyId, patientId: 'SYN-1', assigningAuthority: 'hospital-a', createdAt: deadline, ...clinicalStudyOverrides }),
      loadReportPatient: recordId => ({ recordId, patientId: 'SYN-1', assigningAuthority: 'hospital-a' }) },
  };
  const capabilities = M.composeEmrAdapters(adapters);
  const { stored: storedReader, legal: legalReader, purpose: endReader, clinical: clinicalCapability } = capabilities;
  beforeEach(() => { holdIndex.clear(); dutyRows.clear(); requestRows.clear(); correctionRows.clear(); incompleteHolds = false; });
  function resolveRow(facts, recordId = facts.recordId, eventId = facts.event.eventId) {
    storedRows.set(recordId + ':' + eventId, facts);
    return C.resolveStoredRecord(storedReader, recordId, eventId);
  }
  const fixtureRecords = new Map();
  function snapshotFor(record, at, extras = []) {
    const records = new Map([...extras, record].filter(Boolean).map(r => [r.recordId, r]));
    for (const unit of records.values()) for (const part of unit.parts) for (const c of part.evidence.event.components) {
      if (!records.has(c.recordId) && fixtureRecords.has(c.recordId)) records.set(c.recordId, fixtureRecords.get(c.recordId));
    }
    const references = [...records.values()].flatMap(r => r.parts.flatMap(p => p.evidence.event.components.map(c => ({
      fromRecordId: r.recordId, fromPartId: p.partId, toRecordId: c.recordId, toPartId: c.partId, relation: 'incorporation' }))));
    return graphOf([...records.values()], references, at);
  }
  function remember(record) { fixtureRecords.set(record.recordId, record); holdIndex.set(record.recordId, record.holds.map(h => h.holdId)); return record; }

  function modelInventory() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-schema-inventory-'));
    try {
    const output = path.join(dir, 'inventory.json');
    const provider = `"${process.execPath.replaceAll('\\', '/')}" "${__filename.replaceAll('\\', '/')}" --emr-inventory-generator`;
    const schema = `generator emr_contract_inventory {\n provider = ${JSON.stringify(provider)}\n output = ${JSON.stringify(output.replaceAll('\\', '/'))}\n}\n` +
      fs.readFileSync(path.join(api, 'prisma/schema.prisma'), 'utf8');
    fs.writeFileSync(path.join(dir, 'schema.prisma'), schema);
    const result = spawnSync(process.execPath, [path.join(api, 'node_modules/prisma/build/index.js'), 'generate', '--schema', path.join(dir, 'schema.prisma'), '--generator', 'emr_contract_inventory'],
      { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1',
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/never_connect' } });
    fs.writeFileSync(path.join(dir, 'stdout.log'), result.stdout || ''); fs.writeFileSync(path.join(dir, 'stderr.log'), result.stderr || '');
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(fs.readFileSync(output, 'utf8')).models;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  function routeInventory() {
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    // Resolve the actual Nest exports, including aliases; a same-named local decorator is not a route.
    const nestFile = program.getSourceFile(ts.resolveModuleName('@nestjs/common', path.join(api, 'src/app.module.ts'), parsed.options, ts.sys).resolvedModule.resolvedFileName);
    const resolve = symbol => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const nestDecorators = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(nestFile))
      .map(symbol => [resolve(symbol), symbol.name]));
    function decoratorName(call) {
      return nestDecorators.get(resolve(checker.getSymbolAtLocation(call.expression)));
    }
    function decorators(node) {
      return (ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []).map(d => d.expression).filter(ts.isCallExpression);
    }
    function paths(call) {
      if (!call.arguments.length) return [''];
      const argument = call.arguments[0];
      if (ts.isStringLiteralLike(argument)) return [argument.text];
      if (ts.isArrayLiteralExpression(argument)) return argument.elements.map(e => { assert(ts.isStringLiteralLike(e)); return e.text; });
      assert.fail('Route declaration requires a supported literal or independent Nest metadata inspection');
    }
    const routes = [];
    for (const file of program.getSourceFiles().filter(f => parsed.fileNames.includes(f.fileName))) {
      const visit = node => {
        if (ts.isClassDeclaration(node)) {
          const controller = decorators(node).find(d => decoratorName(d) === 'Controller');
          if (controller) for (const member of node.members) for (const d of decorators(member)) {
            const name = decoratorName(d);
            if (['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All', 'Search'].includes(name)) {
              for (const prefix of paths(controller)) for (const route of paths(d)) routes.push(`${name.toUpperCase()} ${[prefix, route].filter(Boolean).join('/')}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    assert(routes.length > 0);
    assert.equal(new Set(routes).size, routes.length, 'Duplicate actual API route');
    return routes.sort();
  }

  test('TEST-EMR-01-A: every freshly parsed Prisma model has an explicit classification', () => {
    const models = modelInventory();
    assert.deepEqual(models.map(m => m.name).sort(), Object.keys(C.MODEL_CLASSIFICATION).sort());
    for (const model of models) for (const kind of C.classifyModel(model.name)) assert(C.RECORD_CLASSIFICATION[kind]);
    assert.throws(() => C.classifyModel('NewUnclassifiedModel'));
    assert.throws(() => C.classifyModel('toString'));
  });
  test('TEST-EMR-01-A: all actual controller routes, including non-GET responses, are classified', () => {
    const routes = routeInventory();
    assert.deepEqual(routes, Object.keys(R.ROUTE_CLASSIFICATION).sort());
    assert.deepEqual(routes, Object.keys(R.ROUTE_CONTRACTS).sort());
    for (const route of routes) for (const kind of R.classifyRoute(route)) assert(C.RECORD_CLASSIFICATION[kind]);
    for (const route of routes) {
      const contract = R.routeContract(route);
      assert.deepEqual(contract.kinds, R.classifyRoute(route));
      assert(['read', 'write', 'export', 'auth'].includes(contract.operation));
      assert(contract.causes.length > 0);
      assert.equal(new Set(contract.causes).size, contract.causes.length);
      for (const cause of contract.causes) assert(['user-view', 'background-fetch', 'service-job'].includes(cause));
    }
    assert.equal(R.routeContract('POST dicom/lookup').operation, 'read');
    assert.equal(R.routeContract('POST studies/:uid/viewer-jobs/preview').operation, 'read');
    assert.equal(R.routeContract('GET studies/:uid/report-preview').operation, 'export');
    assert.equal(R.routeContract('GET authz/dicom').operation, 'auth');
    for (const route of ['POST auth/login', 'POST auth/register', 'POST auth/entry']) {
      assert.equal(R.routeContract(route).operation, 'auth');
      assert(R.classifyRoute(route).includes('authentication-session'));
    }
    assert(R.classifyRoute('GET me').includes('authentication-session'));
    assert.equal(R.routeContract('GET studies/:uid/draft').operation, 'read');
    assert.deepEqual(R.classifyRoute('GET studies/:uid/draft'), ['private-draft', 'report-evidence']);
    assert.deepEqual(R.routeContract('GET gateway/retry-requests').causes, ['service-job']);
    assert.throws(() => R.routeContract('GET unknown'));
    assert.throws(() => R.routeContract('toString'));
    assert.throws(() => R.classifyRoute('GET studies/:uid/new-record'));
    assert.throws(() => R.classifyRoute('POST studies/:uid/new-record'));
  });
  test('TEST-EMR-01-A: stored and served record coverage includes non-DB and mixed records', () => {
    const covered = new Set([...Object.values(C.MODEL_CLASSIFICATION), ...Object.values(R.ROUTE_CLASSIFICATION), ...Object.values(R.EXTERNAL_SURFACES)].flat());
    assert.deepEqual([...covered].sort(), Object.keys(C.RECORD_CLASSIFICATION).sort());
    for (const kind of ['clinical-answer', 'critical-result-ack', 'comparison-description', 'thumbnail', 'copy', 'external-sr-seg']) assert(covered.has(kind));
    assert(C.classifyModel('ViewerJob').includes('comparison-layout'));
    assert(C.classifyModel('ViewerJob').includes('comparison-description'));
  });
  function complete(value) {
    assert.notEqual(value, undefined, 'A resolved contract cannot contain undefined');
    if (value && typeof value === 'object') for (const child of Object.values(value)) complete(child);
  }
  test('TEST-EMR-17/19-A: defaults cover cited statutory floors and resolve every runtime field', () => {
    const defaults = D.tightenConfiguration();
    assert.deepEqual(defaults, D.DEFAULT_CONFIGURATION);
    assert.deepEqual(Object.keys(defaults).sort(), Object.keys(C.RECORD_CLASSIFICATION).sort());
    for (const value of [defaults, C.RECORD_CLASSIFICATION, D.PRODUCT_DEFAULTS, D.KEY_MANAGEMENT, B.LEGAL_SOURCES]) complete(value);
    // Independent legal expectations: verified 시행규칙 제15조①2/5/6 and 고시 제8조①2.
    for (const kind of ['image', 'report-head', 'report-version', 'manual-sr']) {
      assert.equal(defaults[kind].retentionYears, kind.startsWith('report-') ? 10 : 5);
      assert(C.RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.some(m => m.clauseId === 'medical-rules:15.1.6' && m.years === 5));
    }
    assert.equal(defaults['access-audit'].retentionYears, 2);
    for (const kind of ['clinical-question', 'clinical-answer', 'consultation', 'critical-result', 'finding', 'comparison-description']) {
      assert.equal(defaults[kind].retentionYears, 10);
      assert(C.RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.some(m => m.clauseId === 'medical-rules:15.1.2' && m.years === 10));
    }
    for (const [kind, row] of Object.entries(C.RECORD_CLASSIFICATION)) {
      for (const minimum of row.retention.statutoryMinimum) assert(defaults[kind].retentionYears >= minimum.years, kind);
      assert.equal(defaults[kind].accessYears, 2);
      assert.equal(row.preserveEarlierVersions, true); assert.equal(row.accessLogged, true); assert.equal(row.automaticDestruction, true);
      assert(Object.isFrozen(defaults[kind]));
    }
    assert.equal(D.PRODUCT_DEFAULTS.automaticDestruction, true);
    assert.equal(B.STATUTORY_MINIMUM.access.clauseId, 'access-safety:8.1.2');
    assert.equal(B.STATUTORY_MINIMUM.access.years, 2);
  });
  test('TEST-EMR-01/17-A: clinical candidates, operational placement and signature duties remain distinct', () => {
    for (const kind of ['report-version', 'private-draft', 'tech-note', 'clinical-question', 'clinical-answer', 'consultation',
      'critical-result', 'critical-result-ack', 'finding', 'measurement', 'key-image', 'manual-sr', 'external-sr-seg',
      'comparison-description', 'study-correction', 'patient-match']) assert.equal(C.RECORD_CLASSIFICATION[kind].clinicalAdoption, 'emr-candidate');
    for (const kind of ['assignment', 'comparison-layout', 'preferences']) assert.equal(C.RECORD_CLASSIFICATION[kind].clinicalAdoption, 'operational-record');
    for (const kind of ['report-head', 'report-version', 'clinical-question', 'clinical-answer', 'consultation', 'critical-result', 'finding', 'manual-sr', 'comparison-description']) {
      assert.equal(D.signatureRequired(kind), true);
      assert.throws(() => D.tightenConfiguration({ [kind]: { requireSignature: false } }));
    }
    for (const kind of ['private-draft', 'tech-note', 'critical-result-ack', 'measurement', 'key-image', 'image', 'external-sr-seg', 'patient-match', 'study-correction']) {
      assert.equal(D.signatureRequired(kind), false);
      assert.deepEqual(C.RECORD_CLASSIFICATION[kind].provenance, ['author', 'server-time', 'sha256']);
      assert.equal(D.signatureRequired(kind, 'clinical-entry'), true, 'Actual clinical entry cannot use the working-material exception');
    }
    assert.throws(() => D.signatureRequired('unknown')); assert.throws(() => D.signatureRequired('private-draft', 'anything'));
  });
  test('TEST-EMR-17/19-A: below-floor, unsafe and incomplete overrides are rejected', () => {
    for (const [kind, base] of Object.entries(D.DEFAULT_CONFIGURATION)) {
      for (const field of ['retentionYears', 'accessYears']) {
        for (const value of [base[field] - 1, -1, 0.5, NaN, Infinity, '10', null, undefined]) {
          assert.throws(() => D.tightenConfiguration({ [kind]: { [field]: value } }), `${kind}.${field}`);
        }
      }
      if (base.requireSignature) assert.throws(() => D.tightenConfiguration({ [kind]: { requireSignature: false } }));
    }
    for (const input of [null, [], { image: undefined }, { image: { requireSignature: undefined } }, { image: { accessLogged: false } },
      { image: { automaticDestruction: true } }, { image: { clinicalAdoption: 'operational-record' } }, { unknown: {} }, { image: { retentionYears: 10, accessYears: 5 } }])
      assert.throws(() => D.tightenConfiguration(input));
    assert.throws(() => D.tightenConfiguration({ image: { get retentionYears() { throw Error('getter must not run'); } } }));
    assert.throws(() => D.retentionFor(['image'], clone(D.DEFAULT_CONFIGURATION)), 'Unvalidated policy cannot bypass floors');
  });
  test('TEST-EMR-17/19-A: only security tightening is accepted; all duration settings are refused', () => {
    const settings = D.tightenConfiguration({ 'tech-note': { requireSignature: true }, 'private-draft': { requireSignature: true } });
    assert.deepEqual(settings['tech-note'], { retentionYears: 5, accessYears: 2, requireSignature: true });
    assert.deepEqual(D.retentionFor(['image', 'private-draft'], settings), { retentionYears: 5, accessYears: 2, requireSignature: true });
    assert.equal(D.retentionFor(['image', 'clinical-answer']).retentionYears, 10);
    assert.deepEqual(D.tightenConfiguration({}, settings), settings); complete(settings);
    for (const patch of [{ image: { retentionYears: 7 } }, { 'private-draft': { accessYears: 14 } }, { 'private-draft': { requireSignature: false } }])
      assert.throws(() => D.tightenConfiguration(patch, settings));
    for (const [kind, base] of Object.entries(settings)) for (const field of ['retentionYears', 'accessYears'])
      for (const years of [base[field], base[field] + 1, 100]) assert.throws(() => D.tightenConfiguration({ [kind]: { [field]: years } }));
    assert.equal(D.DEFAULT_CONFIGURATION.image.retentionYears, 5, 'Tightening never mutates defaults');
    assert.throws(() => D.retentionFor([])); assert.throws(() => D.retentionFor(['toString']));
  });
  test('TEST-EMR-01/19-A: navigation and derived records do not acquire independent clocks', () => {
    for (const kind of ['report-evidence', 'clinical-context', 'signature-evidence', 'thumbnail', 'pdf', 'copy', 'download', 'print', 'disclosure']) {
      assert.equal(C.RECORD_CLASSIFICATION[kind].retention.mode, 'source-record');
      assert.equal(D.retentionFor(['report-version', kind]).retentionYears, 10);
    }
    for (const kind of ['private-draft', 'dictation', 'study-organization', 'transfer-governance']) {
      assert.equal(C.RECORD_CLASSIFICATION[kind].retention.mode, 'purpose');
      assert.equal(D.DEFAULT_CONFIGURATION[kind].retentionYears, 0);
    }
    assert.equal(D.DEFAULT_CONFIGURATION['patient-match'].retentionYears, 5);
    assert.equal(D.retentionFor(['report-version', 'clinical-answer']).retentionYears, 10, 'One actual mixed chart must meet both obligations');
  });
  const baseRecord = () => addPart(makeRecord('synthetic-record', ['image'], t0, 'synthetic-original'), 'synthetic-amended', t0);
  const extension = (overrides = {}) => ({ cause: 'continuing-treatment', actorId: 'synthetic-reader', reason: '계속 진료 필요',
    at: '2031-10-04T00:00:00.000Z', until: '2036-10-05T00:00:00.000Z', ...overrides });
  const digest = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
  const fixtureModels = {
    image: ['DicomInstance', { sopClass: 'image' }], 'report-version': ['ReportVersion', {}],
    'clinical-answer': ['StudyQuestionEntry', { kind: 'answer' }], 'critical-result': ['CriticalResult', {}],
    'tech-note': ['TechNoteRevision', {}], 'image-request': ['StudyImageRequest', {}],
    'private-draft': ['ReportDraft', {}], dictation: ['Dictation', {}],
    'comparison-layout': ['ViewerJob', { title: '', description: '', clinicalEntry: false }],
    'study-organization': ['StudyTagCatalog', {}], 'reading-template': ['ReadingTemplate', {}],
    preferences: ['ReadingPreferences', {}], assignment: ['ReaderAssignment', {}],
    'identity-access': ['StudyAccessRevision', {}], 'authentication-session': ['AuthSession', {}],
    institution: ['Institution', {}], 'transfer-governance': ['TransferBasis', {}], 'system-operation': ['ViewerStorageBudget', {}],
  };
  function stored(kind, recordId, partId, at, options = {}) {
    const [model, row] = fixtureModels[kind] || [];
    assert(model, `Missing synthetic model fixture: ${kind}`);
    const signed = C.RECORD_CLASSIFICATION[kind].signature.rule === 'required';
    const hash = digest(recordId + ':' + partId);
    const event = { eventId: 'event:' + partId, recordId, versionId: partId, sha256: hash, contentSha256: hash, at,
      act: signed ? 'entry' : kind === 'image' ? 'acquisition' : 'creation',
      signature: signed ? { versionId: partId, sha256: hash, signedAt: at, verified: true } : null,
      predecessor: null, components: [], processing: null, ...options.event };
    const facts = { recordId, model, row: { ...row, ownerId: 'owner', draftBinding: { reportId: 'parent', intentId: 'intent:' + recordId, action: 'approve' }, ...options.row }, event };
    return resolveRow(facts);
  }
  function makeRecord(recordId, recordKinds, at, partId = recordId, options = {}) {
    if (recordKinds[0] === 'access-audit') return A.accessRetention(access({ eventId: recordId, occurredAt: at }));
    if (!Array.isArray(recordKinds) || recordKinds.length !== 1 || !fixtureModels[recordKinds[0]]) return D.newRetentionRecord(recordId, recordKinds, at);
    const source = stored(recordKinds[0], recordId, partId, at, options);
    const dependencies = source.event.components.map(c => fixtureRecords.get(c.recordId)).filter(Boolean);
    return remember(D.newRetentionRecord(source, options.graph ?? snapshotFor(null, at, dependencies)));
  }
  function addPart(record, partId, at, options = {}, graph) {
    const previous = record.parts.at(-1);
    return remember(D.recordVersionAdded(record, stored(record.kinds[0], record.recordId, partId, at, { ...options, event: {
      predecessor: { recordId: record.recordId, partId: previous.partId, sha256: previous.evidence.event.sha256 }, ...options.event } }), graph ?? snapshotFor(record, at)));
  }
  function purposeRecord(recordId, kind, ownerId, at, partIds, options = {}) {
    return D.newPurposeRecord(stored(kind, recordId, partIds[0], at, { ...options, row: { ownerId, ...options.row } }), partIds);
  }
  const graphOf = (records, references = [], checkedAt = t0) => ({ records, references, complete: true, revision: 'revision-1', checkedAt });
  function disposal(overrides = {}) {
    const record = overrides.record ?? baseRecord(), requestedAt = overrides.requestedAt ?? '2031-10-05T15:00:00.000Z';
    const graph = Object.hasOwn(overrides, 'graph') ? overrides.graph : graphOf([record]);
    return { record, versionIds: record.parts.map(p => p.partId), ...overrides, requestedAt,
      graph: graph && { ...graph, checkedAt: requestedAt } };
  }
  function expire(store, request, destroy) {
    return D.destroyAtExpiry({ withRetentionLock: async (id, at, work) => work(request.graph), ...store }, request, destroy);
  }
  function endPurpose(store, record, event, at, destroy) {
    return D.destroyAtPurposeEnd({ withPurposeLock: async (id, at, work) => work(record), ...store }, record, event, at, destroy);
  }
  async function refuseExpiry(request, code, extraStore = {}) {
    let deletes = 0; const journal = [];
    await assert.rejects(expire({ append: async e => { journal.push(e); return durable.append(e); }, ...extraStore }, request,
      async r => { deletes++; return destroyed(r); }), { code });
    assert.equal(deletes, 0); assert.equal(journal.filter(e => e.phase === 'started').length, 0);
  }
  const purposeEnd = (record, trigger = 'explicit-discard', at = deadline, options = {}) => {
    const b = record.source.row.draftBinding;
    const e = { eventId: 'end-1', recordId: record.recordId, trigger, actorId: record.ownerId, at, superseded: null,
      result: trigger === 'result-version-signed' ? { draftId: record.recordId, intentId: b.intentId, recordId: b.reportId,
        versionId: 'signed-result', signedAt: at, action: b.action, verified: true } : null, ...options };
    endRows.set(e.eventId, e);
    if (e.result) resultRows.set(e.result.recordId + ':' + e.result.versionId, e.result);
    if (e.superseded) intentRows.set(e.superseded.eventId, e.superseded);
    return D.resolvePurposeEnd(endReader, e.eventId);
  };
  async function refusePurpose(record, event, at, code, extraStore = {}) {
    let deletes = 0; const journal = [];
    await assert.rejects(endPurpose({ append: async e => { journal.push(e); return durable.append(e); }, ...extraStore }, record, event, at,
      async () => { deletes++; return { completedAt: at, method: 'irreversible-permanent-deletion' }; }), { code });
    assert.equal(deletes, 0); assert.equal(journal.filter(e => e.phase === 'started').length, 0);
  }
  const holdFacts = (recordId, overrides = {}) => ({ holdId: 'order-1', recordId, actorId: 'custodian', at: t0, release: null,
    basis: { type: 'court-order', clause: { law: 'synthetic-law', article: 'article-1', version: '2026-v1' },
      clauseId: 'synthetic-law:article-1', authorityKind: 'court', managingInstitutionId: 'hospital-a',
      requestId: 'verified-order-42', authorityId: 'court-1', scope: [recordId], verified: true,
      validity: { from: t0, until: null, condition: 'order-in-force' } }, ...overrides });
  const dutyReader = facts => { dutyRows.set(facts.holdId, facts); return legalReader; };
  const holdRecord = (record, facts = holdFacts(record.recordId), graph = snapshotFor(record, facts.at)) => remember(D.placeLegalHold(record, dutyReader(facts), facts.holdId, graph));
  function placePurposeHold(...args) { const record = D.placePurposeLegalHold(...args); holdIndex.set(record.recordId, record.holds.map(h => h.holdId)); return record; }
  function correctionRequest(hold) {
    hold.basis.validity.until = '2026-10-15T00:00:00.000Z';
    correctionRows.set(hold.basis.requestId, { requestId: hold.basis.requestId, recordIds: [hold.recordId], receivedAt: t0,
      responseDueAt: hold.basis.validity.until, resolution: null });
    return hold;
  }
  const releaseFacts = (hold, at, overrides = {}) => ({ ...hold, release: { holdId: hold.holdId, actorId: 'custodian', at,
    evidenceId: 'release-order-99', authorityVerified: true, reason: 'order-ended', ...overrides } });
  function pendingHold(recordId, at, until) {
    const h = holdFacts(recordId, { at });
    h.basis = { ...h.basis, type: 'pending-access-request', clauseId: 'privacy:35.3',
      clause: { law: 'privacy', article: '35.3', version: at < '2027-03-08T15:00:00.000Z' ? '21445' : '21910' }, authorityId: 'hospital-a', authorityKind: 'personal-information-controller',
      requestId: 'access:' + recordId, validity: { from: at, until, condition: 'request-pending' } };
    requestRows.set(h.basis.requestId, { requestId: h.basis.requestId, recordIds: [recordId], receivedAt: at, responseDueAt: until, resolution: null });
    return h;
  }
  const destroyed = request => ({ completedAt: request.requestedAt, method: 'irreversible-permanent-deletion' });
  const durable = { append: async e => ({ durableAt: `${e.day}T23:59:59.999Z` }) };
  test('TEST-EMR-19-A: every statutory record class has a fixed expiry and cited clause', () => {
    const expected = { patientRegister: [5, 1], chart: [10, 2], prescription: [2, 3], surgery: [10, 4],
      examination: [5, 5], imageReport: [5, 6], nursing: [5, 7], midwifery: [5, 8], certificateCopy: [3, 9] };
    for (const [kind, [years, clause]] of Object.entries(expected)) {
      assert.equal(B.STATUTORY_MINIMUM[kind].clauseId, `medical-rules:15.1.${clause}`);
      assert.equal(D.civilPeriodEnd(t0, years), `${2026 + years}-10-05T15:00:00.000Z`);
    }
    assert.throws(() => makeRecord('x', 'unknown', t0));
    assert.throws(() => makeRecord('x', 'toString', t0));
    assert.throws(() => D.parseRetentionRecord({ ...baseRecord(), retentionYears: 50 }));
    assert.throws(() => D.parseRetentionRecord({ ...baseRecord(), lastAccessAt: '2030-01-01T00:00:00.000Z' }));
  });
  test('TEST-EMR-19-A: continuing treatment permits one bounded, attributed extension without changing the start', () => {
    const original = baseRecord(), before = clone(original);
    const extended = D.extendRetention(original, extension());
    assert.equal(D.retentionDeadline(extended), '2036-10-05T00:00:00.000Z');
    assert.equal(extended.parts[0].startedAt, t0); assert.deepEqual(extended.extension, extension());
    assert.deepEqual(original, before); assert(Object.isFrozen(extended.extension));
    assert.throws(() => D.extendRetention(extended, extension()));
    const shorter = D.extendRetention(original, extension({ until: '2031-10-06T00:00:00.000Z' }));
    assert.throws(() => D.extendRetention(shorter, extension()), 'Even a one-day extension consumes the single allowance');
    assert.equal(D.retentionDeadline(D.extendRetention(makeRecord('chart', ['clinical-answer'], t0),
      extension({ at: '2036-10-04T00:00:00.000Z', until: '2046-10-05T00:00:00.000Z' }))), '2046-10-05T00:00:00.000Z');
  });
  test('TEST-EMR-19-A: requests, generic holds, overdue changes and missing reasons cannot extend retention', () => {
    for (const patch of [{ cause: 'patient-request' }, { cause: 'legal-hold' }, { actorId: '' }, { reason: ' ' },
      { at: '2031-10-05T15:00:00.000Z' }, { at: '2026-10-04T23:59:59.999Z' }, { until: '2031-10-05T15:00:00.000Z' },
      { until: '2036-10-05T15:00:00.001Z' }, { count: 2 }])
      assert.throws(() => D.extendRetention(baseRecord(), extension(patch)));
    assert.throws(() => D.extendRetention(baseRecord(), null));
    assert.throws(() => D.extendRetention(makeRecord('audit', ['access-audit'], t0), extension({ at: '2027-10-05T00:00:00.000Z', until: '2029-10-05T15:00:00.000Z' })));
  });
  test('TEST-EMR-19-A: expiry destroys every original/version, with durable nonpersonal completion only after deletion', async () => {
    const order = [], events = [];
    const store = { append: async e => { order.push(e.phase); events.push(clone(e)); return durable.append(e); } };
    const request = disposal();
    await refuseExpiry(disposal({ requestedAt: '2031-10-04T23:59:59.999Z' }), 'RetentionNotElapsed');
    for (const patch of [{ holdActive: true }, { lastAccessAt: t0 }, { linkedRetainUntil: ['2040-01-01T00:00:00.000Z'] },
      { versionIds: [] }, { versionIds: ['x', 'x'] }])
      await refuseExpiry(disposal(patch), Object.hasOwn(patch, 'versionIds') ? 'CompleteVersionSetRequired' : 'DisposalRequestInvalid');
    const result = await expire(store, request, async target => {
      assert.deepEqual(target, request); order.push('erase-original-and-amendment'); return destroyed(target);
    });
    assert.deepEqual(order, ['started', 'erase-original-and-amendment', 'completed']);
    assert.equal(result.phase, 'completed');
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['basis', 'classes', 'clauseIds', 'day', 'disposalUnitId', 'dueDay', 'expiryDay', 'extensionUsed', 'formatVersion', 'method', 'partCount', 'phase', 'timeliness']);
      assert.equal(event.disposalUnitId, request.record.disposalUnitId);
      assert.equal(event.partCount, 2);
      assert(!JSON.stringify(event).includes('synthetic'));
      assert.equal(event.method, 'irreversible-permanent-deletion'); complete(event);
    }
  });
  test('TEST-EMR-19-A: logging and deletion failures never manufacture successful destruction', async () => {
    await refuseExpiry(disposal(), 'DestructionJournalUnavailable', { append: async () => { throw Error('audit unavailable'); } });
    await refuseExpiry(disposal(), 'DestructionJournalReceiptInvalid', { append: async () => ({ durableAt: t0 }) });
    for (const callback of [async () => { throw Error('synthetic-private-error'); }, async () => ({ ...destroyed(disposal()), method: 'soft-delete' }),
      async () => ({ ...destroyed(disposal()), recordId: 'synthetic-record' }), async () => ({ ...destroyed(disposal()), completedAt: t0 })]) {
      const events = [];
      await assert.rejects(expire({ append: async e => { events.push(e); return durable.append(e); } }, disposal(), callback));
      assert.deepEqual(events.map(e => e.phase), ['started', 'failed']);
      assert(!JSON.stringify(events).includes('synthetic'));
    }
    let erased = 0;
    await assert.rejects(expire({ append: async e => {
      if (e.phase === 'completed') throw Error('completion journal unavailable'); return durable.append(e);
    } }, disposal(), async request => { erased++; return destroyed(request); }));
    assert.equal(erased, 1, 'Deletion cannot be undone by a completion log failure; B must reconcile it');
  });
  test('TEST-EMR-19-A: leap day and a used extension enforce exact expiry boundaries', async () => {
    const record = makeRecord('leap', ['image'], '2024-02-29T00:00:00.000Z');
    assert.equal(D.retentionDeadline(record), '2029-02-28T15:00:00.000Z');
    await refuseExpiry(disposal({ record, requestedAt: '2029-02-28T14:59:59.999Z' }), 'RetentionNotElapsed');
    await expire(durable, disposal({ record, requestedAt: '2029-02-28T15:00:00.000Z' }), async r => destroyed(r));
    const extended = D.extendRetention(baseRecord(), extension());
    await refuseExpiry(disposal({ record: extended }), 'RetentionNotElapsed');
    await expire(durable, disposal({ record: extended, requestedAt: '2036-10-05T00:00:00.000Z' }), async r => destroyed(r));
  });
  test('TEST-EMR-17-A: product key custody has complete defaults and recovery cannot resurrect revoked keys', () => {
    assert.equal(D.KEY_MANAGEMENT.operator, 'product'); assert.equal(D.KEY_MANAGEMENT.scope, 'per-doctor');
    assert.equal(D.KEY_MANAGEMENT.sharedPrivateKey, false); complete(D.KEY_MANAGEMENT);
    assert.equal(D.transitionSigningKey('active', 'revoke'), 'revoked');
    assert.equal(D.transitionSigningKey('active', 'suspend'), 'suspended');
    assert.equal(D.transitionSigningKey('suspended', 'recover'), 'retired');
    for (const state of ['retired', 'revoked']) assert.throws(() => D.transitionSigningKey(state, 'recover'));
    assert.throws(() => D.transitionSigningKey('unknown', 'recover'));
  });

  function access(overrides = {}) {
    return { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'event-1', userId: known(identity('reader-1')), rolesAtTime: known(['radiologist']),
      actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'), occurredAt: t0,
      trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member',
      targets: [{ kind: 'report-version', patientLinkSnapshot: known(patient), studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
      action: 'provide-prepared', result: 'prepared', requestId: 'request-1', auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
  }
  test('TEST-EMR-07-A: every required event and target field is checked at runtime', () => {
    const valid = access(); assert.equal(A.parseAccessEvent(valid).action, 'provide-prepared');
    for (const field of Object.keys(valid)) { const bad = clone(valid); delete bad[field]; assert.throws(() => A.parseAccessEvent(bad), field); }
    for (const field of Object.keys(valid.targets[0])) { const bad = clone(valid); delete bad.targets[0][field]; assert.throws(() => A.parseAccessEvent(bad), field); }
    for (const extra of [{ cookie: 'secret' }, { token: 'secret' }, { sessionId: 'secret' }]) assert.throws(() => A.parseAccessEvent({ ...valid, ...extra }));
  });
  test('TEST-EMR-07/19-A: access records expire independently, two years after each event', async () => {
    const event = access(), first = A.accessRetention(event);
    assert.equal(D.retentionDeadline(first), '2028-10-05T15:00:00.000Z');
    const late = A.accessRetention(access({ eventId: 'late-access', occurredAt: '2031-10-04T00:00:00.000Z' }));
    assert.equal(D.retentionDeadline(late), '2033-10-04T15:00:00.000Z');
    assert.equal(D.retentionDeadline(first), '2028-10-05T15:00:00.000Z');
    assert.equal(D.retentionDeadline(baseRecord()), '2031-10-05T15:00:00.000Z');
    await expire(durable, disposal({ record: first, requestedAt: '2028-10-05T15:00:00.000Z' }), async r => destroyed(r));
    await expire(durable, disposal(), async r => destroyed(r));
    await refuseExpiry(disposal({ record: late }), 'RetentionNotElapsed');
  });
  test('TEST-EMR-07-A: all requested action/cause categories remain distinct', () => {
    const expected = {
      write: ['write', 'additional-entry', 'modify', 'approve-sign', 'amend', 'addendum', 'cancel', 'release', 'draft-save', 'clear', 'discard', 'finalize', 'archive', 'resume-clinical-use', 'extend-retention', 'legal-hold', 'lift-legal-hold', 'destroy'],
      read: ['provide-prepared', 'transfer-ended', 'transfer-aborted', 'client-shown', 'explicit-ack'],
      export: ['print-opened', 'print-done', 'pdf', 'copy', 'download', 'disclosure'],
      failure: ['auth-refused', 'permission-refused', 'conflict', 'storage-failed', 'signature-failed'],
    };
    assert.deepEqual(A.ACCESS_ACTIONS, expected);
    for (const cause of ['user-view', 'background-fetch', 'service-job']) {
      assert.equal(A.parseAccessEvent(access({ cause, executor: cause === 'service-job' ? 'service' : 'member' })).cause, cause);
    }
    assert.throws(() => A.parseAccessEvent(access({ cause: 'service-job' })));
    assert.throws(() => A.parseAccessEvent(access({ action: 'client-shown', result: 'succeeded', relatedEventId: 'prepared-1' })));
    assert.throws(() => A.parseAccessEvent(access({ action: 'explicit-ack', result: 'succeeded' })));
    assert.equal(A.parseAccessEvent(access({ action: 'explicit-ack', result: 'succeeded', relatedEventId: 'prepared-1' })).targets[0].versionId.value, 'version-1');
  });
  test('TEST-EMR-07-A: unverified identities are not fabricated; UTC/proxy/audit-link validated', () => {
    const unresolved = { status: 'unresolved', reason: 'not-authenticated' };
    const denied = access({ action: 'auth-refused', result: 'refused', executor: 'unauthenticated', userId: unresolved, rolesAtTime: unresolved,
      actingInstitution: unresolved, managingInstitution: { status: 'unresolved', reason: 'not-resolved' }, targets: [] });
    assert.equal(A.parseAccessEvent(denied).userId.status, 'unresolved');
    for (const bad of [{ userId: unresolved }, { occurredAt: '2026-10-05T09:00:00+09:00' }, { occurredAt: '2026-02-30T00:00:00.000Z' },
      { trustedProxyIp: known({ address: 'attacker,192.0.2.1', source: 'trusted-proxy' }) }, { auditLinkId: 'session-cookie' }]) assert.throws(() => A.parseAccessEvent(access(bad)));
    for (const action of ['auth-refused', 'permission-refused', 'conflict', 'storage-failed', 'signature-failed']) assert.equal(A.accessPersistence(action), 'independent-failure');
    assert.equal(A.accessPersistence('approve-sign'), 'business-transaction');
    assert.equal(A.accessPersistence('transfer-aborted'), 'independent-followup');
  });
  test('TEST-EMR-06/07-A: a body cannot precede durable append or survive append failure', async () => {
    const event = access(), order = [];
    const store = { append: async e => { order.push('durable'); return { eventId: e.eventId, durableAt: t0 }; } };
    assert.equal(await A.provideAfterDurableEvent(store, event, async () => { order.push('body'); return 'body'; }), 'body');
    assert.deepEqual(order, ['durable', 'body']);
    let sent = false;
    await assert.rejects(A.provideAfterDurableEvent({ append: async () => { throw new Error('storage failed'); } }, event, async () => { sent = true; }));
    await assert.rejects(A.provideAfterDurableEvent({ append: async () => ({ eventId: 'wrong', durableAt: t0 }) }, event, async () => { sent = true; }));
    assert.equal(sent, false);
  });

  function payload() { return { formatVersion: 'emr-signature/1', text: { kind: 'report', findings: ' 한글\r\n e\u0301 ', conclusion: '', recommendation: '\t' },
    patient: clone(patient), studyId: 'study-1', managingInstitutionId: 'hospital-a', actingInstitutionId: 'hospital-b', recordKind: 'report-version',
    recordId: 'report-1', versionId: 'v2', author: identity('reader-1'), signer: identity('reader-1'), identityRegistrationId: 'registration-1', action: 'amend',
    serverTime: t0, previousVersion: ref('v1'), attachments: [{ kind: 'key-image', recordId: 'key-1', versionId: 'r1', sha256: '12'.repeat(32) }], reason: null }; }
  const reverseKeys = v => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
  test('TEST-EMR-04-A: canonical UTF-8 vector and nested field order are byte-stable', () => {
    const p = payload(), bytes = S.canonicalPayload(p);
    assert.deepEqual(bytes, S.canonicalPayload(p)); assert.deepEqual(bytes, S.canonicalPayload(reverseKeys(p)));
    // This independently ordered fixture is the specified v1 wire format, not a source-code pin.
    assert.equal(bytes.toString('utf8'), JSON.stringify(p));
    assert.deepEqual(JSON.parse(bytes.toString('utf8')).text, p.text);
    assert.notEqual(bytes[0], 0xef); assert.notEqual(bytes[bytes.length - 1], 10);
    const composed = clone(p); composed.text.findings = composed.text.findings.normalize('NFC');
    assert.notDeepEqual(bytes, S.canonicalPayload(composed));
    const trimmed = clone(p); trimmed.text.findings = trimmed.text.findings.trim(); assert.notDeepEqual(bytes, S.canonicalPayload(trimmed));
    assert.deepEqual(p, payload(), 'Canonicalization does not mutate input');
  });
  test('TEST-EMR-04-A: every binding changes the signed bytes; malformed inputs fail closed', () => {
    const p = payload(), bytes = S.canonicalPayload(p);
    for (const field of Object.keys(p)) { const bad = clone(p); delete bad[field]; assert.throws(() => S.canonicalPayload(bad), field); }
    for (const field of ['studyId', 'recordId', 'versionId', 'managingInstitutionId', 'actingInstitutionId', 'identityRegistrationId']) {
      const changed = clone(p); changed[field] += '-other';
      if (field === 'recordId') changed.previousVersion.recordId = changed.recordId;
      assert.notDeepEqual(bytes, S.canonicalPayload(changed), field);
    }
    for (const field of ['author', 'signer']) { const changed = clone(p); changed[field] = identity('other'); assert.notDeepEqual(bytes, S.canonicalPayload(changed)); }
    const badUnicode = clone(p); badUnicode.text.findings = '\ud800'; assert.throws(() => S.canonicalPayload(badUnicode));
    assert.throws(() => S.canonicalPayload({ ...p, attachments: [...p.attachments, ...p.attachments] }));
    assert.throws(() => S.canonicalPayload({ ...p, previousVersion: null }));
    assert.throws(() => S.canonicalPayload({ ...p, action: 'cancel', reason: ' ' }));
    assert.throws(() => S.canonicalPayload({ ...p, unknown: 'must not silently disappear' }));
  });
  test('TEST-EMR-05-A: envelope rejects algorithm substitution and noncanonical bytes', () => {
    const p = payload();
    const header = { alg: 'ES256', kid: 'reader-1-key-1', typ: 'emr-signature+jws' };
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const envelope = { protected: b64(header), payload: S.canonicalPayload(p).toString('base64url'), signature: Buffer.alloc(64, 1).toString('base64url') };
    assert.equal(S.inspectSignatureEnvelope(envelope).keyId, header.kid); // Structural only: dummy signature is NOT cryptographically verified.
    for (const alg of ['none', 'HS256', 'RS256']) assert.throws(() => S.inspectSignatureEnvelope({ ...envelope, protected: b64({ ...header, alg }) }));
    assert.throws(() => S.inspectSignatureEnvelope({ ...envelope, protected: b64({ ...header, jku: 'https://untrusted.example/key' }) }));
    assert.throws(() => S.inspectSignatureEnvelope({ ...envelope, payload: b64(reverseKeys(p)) }));
    assert.throws(() => S.inspectSignatureEnvelope({ ...envelope, signature: Buffer.alloc(63).toString('base64url') }));
    assert.throws(() => S.inspectSignatureEnvelope({ ...envelope, payload: envelope.payload + '=' }));
  });

  const reader = id => ({ id, kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true });
  function command(facts, action, overrides = {}) { return { action, actor: reader('reader-1'), at: t0,
    expectedClaimGeneration: facts.claimGeneration, expectedPublishedVersionId: facts.publishedVersion?.versionId ?? null, ...overrides }; }
  function step(facts, action, overrides) { return L.transitionReport(facts, command(facts, action, overrides)); }
  function inProgress() { return step(L.newReportFacts('report-1', 'study-1'), 'start').facts; }
  function approved() { return step(inProgress(), 'approve', { version: ref('v1') }).facts; }
  function finalized() { return step(approved(), 'finalize', { actor: { ...reader('finalizer'), kind: 'service' }, at: deadline }).facts; }
  const archiveCommand = (overrides = {}) => ({ actor: reader('reader-1'), at: deadline, reason: '진료 목적 종료 확인',
    purpose: 'clinical-purpose-ended', expectedPublishedVersionId: 'v1', ...overrides });
  test('TEST-EMR-13/19-A: only an explicit purpose-end archive of stored finalization separates retention-only records', () => {
    for (const f of [inProgress(), approved(), finalized()]) {
      assert.deepEqual(L.reportRetentionAccess(f, null), { state: 'normal-retention', ordinaryClinicalAccess: true, separateStorage: false });
    }
    for (const f of [inProgress(), approved()]) assert.throws(() => L.archiveFinalizedReport(f, archiveCommand()));
    const f = clone(finalized()), before = clone(f), recordBefore = baseRecord();
    const archive = L.archiveFinalizedReport(f, archiveCommand());
    assert.equal(archive.actorId, 'reader-1'); assert.equal(archive.reason, '진료 목적 종료 확인');
    assert.deepEqual(L.reportRetentionAccess(f, archive), { state: 'retention-only', ordinaryClinicalAccess: false, separateStorage: true });
    assert.deepEqual(f, before); assert.equal(Object.isFrozen(f.publishedVersion), false);
    assert.equal(D.retentionDeadline(recordBefore), '2031-10-05T15:00:00.000Z', 'Archive cannot reset retention');
    for (const patch of [{ reason: '' }, { at: t0 }, { purpose: 'timer-elapsed' }, { expectedPublishedVersionId: 'stale' },
      { actor: { ...reader('service'), kind: 'service' } }, { actor: { ...reader('reader-1'), canReadStudy: false } },
      { actor: { ...reader('admin'), roles: ['admin'] } }]) assert.throws(() => L.archiveFinalizedReport(f, archiveCommand(patch)));
    for (const patch of [{ recordId: 'other' }, { version: ref('other') }, { finalizedAt: t0 }, { reason: '' }])
      assert.throws(() => L.reportRetentionAccess(f, { ...archive, ...patch }));
    const added = step(f, 'addendum', { at: deadline, version: ref('v2') }).facts;
    assert.equal(L.reportRetentionAccess(added, archive).state, 'normal-retention');
  });
  test('TEST-EMR-13/19-A: statutory expiry requires destruction with or without a purpose-end event', async () => {
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand());
    for (const e of [null, archive]) {
      L.reportRetentionAccess(f, e);
      const result = await expire(durable, disposal(), async r => destroyed(r));
      assert.equal(result.phase, 'completed');
    }
  });
  test('TEST-EMR-12/13-A: first typing claims; Save remains private; another reader releases without deleting drafts', () => {
    const f = inProgress(); assert.equal(f.state, 'In Progress'); assert.equal(f.claimantId, 'reader-1');
    const saved = step(f, 'save'); assert.deepEqual(saved.facts, f); assert(saved.effects.includes('append-private-revision'));
    const released = step(f, 'release', { actor: reader('reader-2') });
    assert.equal(released.facts.state, 'Unread'); assert.equal(released.facts.claimantId, null); assert.equal(released.facts.claimGeneration, f.claimGeneration + 1);
    assert(released.effects.includes('preserve-private-drafts')); assert(released.effects.includes('notify-draft-presence-only'));
    const claimedAgain = step(released.facts, 'start').facts;
    for (const action of ['save', 'renew-claim']) assert.throws(() => step(claimedAgain, action, { expectedClaimGeneration: f.claimGeneration }));
  });
  test('TEST-EMR-13-A: approval publishes immediately, fixes time and signer, preserves subsequent input', () => {
    const result = step(inProgress(), 'approve', { version: ref('v1') });
    assert.equal(result.facts.state, 'Approved'); assert.equal(result.facts.firstApprovedAt, t0); assert.equal(result.facts.amendUntil, deadline);
    assert.equal(result.facts.originalSignerId, 'reader-1'); assert.deepEqual(result.facts.publishedVersion, ref('v1'));
    assert(result.effects.includes('publish-immediately')); assert(result.effects.includes('preserve-subsequent-input'));
    for (const action of ['save', 'approve', 'release', 'reset', 'start']) assert.throws(() => step(result.facts, action, { version: ref('v2'), reason: 'reason' }), action);
  });
  test('TEST-EMR-13-A: amendment uses original signer, strict deadline, and never renews window', () => {
    const f = approved();
    const changed = step(f, 'amend', { at: '2026-10-05T23:59:59.999Z', version: ref('v2') }).facts;
    assert.equal(changed.firstApprovedAt, t0); assert.equal(changed.amendUntil, deadline); assert.equal(changed.state, 'Approved');
    for (const at of [deadline, '2026-10-06T12:00:00.000Z']) assert.throws(() => step(f, 'amend', { at, version: ref('v2') }));
    assert.throws(() => step(f, 'amend', { actor: reader('reader-2'), version: ref('v2') }));
    assert.throws(() => step(changed, 'amend', { expectedPublishedVersionId: 'v1', version: ref('v3') }));
    assert.throws(() => L.validateReportFacts({ ...changed, amendUntil: '2026-10-07T00:00:00.000Z' }));
  });
  test('TEST-EMR-13-A: another reader addendum is retained through body amendment and finalization', () => {
    const f = approved();
    const added = step(f, 'addendum', { actor: reader('reader-2'), version: ref('v2') }).facts;
    const amended = step(added, 'amend', { version: ref('v3') }).facts;
    assert.deepEqual(amended.addenda, [{ authorId: 'reader-2', version: ref('v2') }]); assert.deepEqual(amended.bodyVersion, ref('v3'));
    const service = { ...reader('finalizer'), kind: 'service', roles: [] };
    assert.throws(() => step(amended, 'finalize', { actor: service }));
    const finalized = step(amended, 'finalize', { actor: service, at: '2026-10-06T01:00:00.000Z' }).facts;
    assert.equal(finalized.state, 'Finalized'); assert.deepEqual(finalized.publishedVersion, amended.publishedVersion);
    assert.deepEqual(finalized.finalized, { effectiveAt: deadline, processedAt: '2026-10-06T01:00:00.000Z' });
    for (const action of ['amend', 'approve', 'save', 'release', 'reset']) assert.throws(() => step(finalized, action, { at: deadline, version: ref('v4') }));
    assert.equal(step(finalized, 'addendum', { at: deadline, version: ref('v4') }).facts.state, 'Finalized');
  });
  test('TEST-EMR-13-A: reasoned cancellation preserves signed publication/history and never returns to Unread', () => {
    const f = approved();
    assert.throws(() => step(f, 'cancel', { version: ref('v2'), eventId: 'cancel-1' }));
    const cancelled = step(f, 'cancel', { reason: '잘못된 검사', eventId: 'cancel-1', version: ref('v2') }).facts;
    assert.equal(cancelled.state, 'Cancelled'); assert.equal(cancelled.firstApprovedAt, f.firstApprovedAt); assert.equal(cancelled.amendUntil, f.amendUntil);
    assert.deepEqual(cancelled.publishedVersion, f.publishedVersion); assert.equal(cancelled.cancellation.reason, '잘못된 검사');
    for (const action of ['start', 'release', 'save', 'approve', 'reset', 'amend']) assert.throws(() => step(cancelled, action, { version: ref('v3') }));
    assert.throws(() => L.validateReportFacts({ ...cancelled, state: 'Unread' }));
  });
  test('TEST-EMR-02/13-A: admin alone cannot sign; Preliminary retains independent designated reviewer boundary', () => {
    const f = inProgress();
    assert.throws(() => step(f, 'approve', { actor: { ...reader('reader-1'), roles: ['admin'] }, version: ref('v1') }));
    assert.throws(() => step(f, 'approve', { actor: { ...reader('reader-1'), canSign: false }, version: ref('v1') }));
    assert.throws(() => step(f, 'approve', { actor: { ...reader('reader-1'), canReadStudy: false }, version: ref('v1') }));
    const p = step(f, 'preliminary', { reviewerId: 'reader-2', version: ref('pre-1') }).facts;
    assert.equal(step(p, 'save').facts.state, 'Preliminary');
    assert.throws(() => step(p, 'approve', { version: ref('v1') }));
    assert.throws(() => step(p, 'save', { actor: reader('reader-3') }));
    assert.equal(step(p, 'approve', { actor: reader('reader-2'), version: ref('v1') }).facts.originalSignerId, 'reader-2');
  });
  test('TEST-EMR-13-A: table is pure, ignores no body/TTL guesses, and rejects malformed stored facts', () => {
    const original = clone(inProgress()), before = clone(original);
    step(original, 'approve', { version: ref('v1') }); assert.deepEqual(original, before);
    const mutableApproved = clone(approved());
    step(mutableApproved, 'amend', { version: ref('v2') });
    assert.equal(Object.isFrozen(mutableApproved.bodyVersion), false);
    assert.equal(Object.isFrozen(mutableApproved.addenda), false);
    const mutableAdded = clone(step(approved(), 'addendum', { version: ref('v2') }).facts);
    step(mutableAdded, 'addendum', { version: ref('v3') });
    assert.equal(Object.isFrozen(mutableAdded.addenda[0].version), false);
    assert.throws(() => L.validateReportFacts({ ...L.newReportFacts('report-1', 'study-1'), state: 'Approved' }));
    assert.throws(() => step(approved(), 'amend', { version: { ...ref('v2'), recordId: 'other-report' } }));
    assert.throws(() => L.validateReportFacts({ ...approved(), lastEditedAt: t0 }));
  });
  test('TEST-EMR-19-A F01: classification alone gives reports ten years and prevents class substitution', async () => {
    const report = makeRecord('report-1', ['report-version'], t0, 'v1');
    assert.equal(D.retentionDeadline(report), '2036-10-05T15:00:00.000Z');
    assert.deepEqual(D.statutoryClasses(report.kinds), ['chart', 'examination', 'imageReport']);
    assert.deepEqual(D.statutoryClasses(['clinical-answer', 'consultation']), ['chart']);
    for (const wrong of ['prescription', 'access', ['prescription'], ['access'], ['report-version', 'thumbnail'], ['private-draft']])
      assert.throws(() => makeRecord('report-1', wrong, t0));
    assert.throws(() => D.parseRetentionRecord({ ...report, recordClass: 'access' }));
    await refuseExpiry(disposal({ record: report }), 'RetentionNotElapsed');
    assert.equal((await expire(durable, disposal({ record: report, requestedAt: '2036-10-05T15:00:00.000Z' }), async r => destroyed(r))).phase, 'completed');
  });
  const edge = (from, to, relation = 'incorporation') => ({ fromRecordId: from.recordId, fromPartId: from.parts[0].partId,
    toRecordId: to.recordId, toPartId: to.parts[0].partId, relation });
  const component = record => ({ recordId: record.recordId, partId: record.parts[0].partId, sha256: record.parts[0].evidence.event.sha256 });
  test('TEST-EMR-19-A R2-01: complete delta bases retained by own CVR period, never inherited periods', async () => {
    const image = makeRecord('image', ['image'], t0, 'i1');
    const report = makeRecord('report', ['report-version'], t0, 'v1', { event: { components: [component(image)] } });
    const cvr = makeRecord('cvr', ['critical-result'], '2030-10-05T00:00:00.000Z', 'c1', { event: { components: [component(report), component(image)] } });
    const later = makeRecord('later', ['report-version'], '2033-10-05T00:00:00.000Z', 'v2');
    const graph = graphOf([image, report, cvr, later], [edge(cvr, report), edge(cvr, image), edge(report, image), edge(later, cvr, 'navigation')]);
    for (const record of [image, report, cvr]) {
      assert.equal(D.retentionDeadline(record, graph), '2040-10-05T15:00:00.000Z');
      await refuseExpiry(disposal({ record, graph, requestedAt: '2037-10-05T15:00:00.000Z' }), 'RetentionNotElapsed');
      if (record !== cvr) await refuseExpiry(disposal({ record, graph, requestedAt: '2040-10-05T15:00:00.000Z' }), 'IncorporatorStillPresent');
      else assert.equal((await expire(durable, disposal({ record, graph, requestedAt: '2040-10-05T15:00:00.000Z' }), async r => destroyed(r))).phase, 'completed');
    }
    // Storage chains must be flattened, not truncated to one hop.
    const incomplete = { ...graph, references: graph.references.filter(r => !(r.fromRecordId === 'cvr' && r.toRecordId === 'image')) };
    await refuseExpiry(disposal({ record: image, graph: incomplete }), 'ComponentManifestIncomplete');
    assert.throws(() => makeRecord('incomplete-cvr', ['critical-result'], '2030-10-05T00:00:00.000Z', 'c2', { event: { components: [component(report)] } }), { code: 'ComponentManifestIncomplete' });
    // A corrupted persisted manifest must also fail closed at destruction.
    const badSource = stored('critical-result', 'incomplete-cvr', 'c2', '2030-10-05T00:00:00.000Z', { event: { components: [component(report)] } });
    const missingBase = D.parseRetentionRecord({ ...cvr, recordId: 'incomplete-cvr', holds: D.reloadLegalHolds('incomplete-cvr'), parts: [{ partId: 'c2', startedAt: badSource.event.at, evidence: badSource }] });
    await refuseExpiry(disposal({ record: image, graph: graphOf([image, report, missingBase], [edge(report, image), edge(missingBase, report)]) }), 'ComponentManifestIncomplete');
    // A separate record retaining the whole report unit must not re-propagate its inherited deadline to unrelated bytes of another part.
    const ownText = addPart(report, 'own-text', t0);
    const newest = D.extendRetention(makeRecord('newest', ['critical-result'], '2035-10-05T00:00:00.000Z', 'c3', { event: { components: [{ recordId: 'report', partId: 'own-text', sha256: ownText.parts[1].evidence.event.sha256 }] } }),
      extension({ at: '2040-10-05T00:00:00.000Z', until: '2050-10-05T15:00:00.000Z' }));
    const bounded = graphOf([image, ownText, newest], [edge(ownText, image), { ...edge(newest, ownText), toPartId: 'own-text' }]);
    assert.equal(D.retentionDeadline(ownText, bounded), '2050-10-05T15:00:00.000Z');
    assert.equal(D.retentionDeadline(image, bounded), '2036-10-05T15:00:00.000Z');
  });
  test('TEST-EMR-19-A R2-01: thirty annual comparison citations cannot keep the first report or image forever', async () => {
    const records = Array.from({ length: 30 }, (_, i) => makeRecord('followup-' + i, ['report-version'], `${2026 + i}-10-05T00:00:00.000Z`));
    const image = makeRecord('old-image', ['image'], t0);
    const graph = graphOf([image, ...records], [edge(records[0], image, 'navigation'), ...records.slice(1).map((r, i) => edge(r, records[i], 'navigation'))]);
    assert.equal(D.retentionDeadline(records[0], graph), '2036-10-05T15:00:00.000Z');
    assert.equal(D.retentionDeadline(image, graph), '2031-10-05T15:00:00.000Z');
    await expire(durable, disposal({ record: records[0], graph, requestedAt: '2036-10-05T15:00:00.000Z' }), async r => destroyed(r));
  });
  test('TEST-EMR-19-A R2-02: missing incomplete stale and unlocked reverse snapshots refuse before destruction', async () => {
    const record = baseRecord();
    for (const graph of [null, undefined, {}]) await refuseExpiry(disposal({ record, graph }), 'ReferenceSnapshotRequired');
    await refuseExpiry(disposal({ record, graph: { ...graphOf([record]), complete: false } }), 'ReferenceSnapshotIncomplete');
    await refuseExpiry(disposal({ record, graph: graphOf([]) }), 'ReferenceSnapshotStale');
    const request = disposal({ record });
    await refuseExpiry(request, 'ReferenceSnapshotStale', { withRetentionLock: async (id, at, work) => work({ ...request.graph, revision: 'new-revision' }) });
    await refuseExpiry(request, 'ReferenceSnapshotStale', { withRetentionLock: async (id, at, work) => work({ ...request.graph, checkedAt: t0 }) });
    await refuseExpiry(request, 'ReferenceSnapshotRequired', { withRetentionLock: async (id, at, work) => work(null) });
    await refuseExpiry(request, 'RetentionLockRequired', { withRetentionLock: null });
    let locked = false;
    await expire({ ...durable, withRetentionLock: async (id, at, work) => { locked = true; try { return await work(request.graph); } finally { locked = false; } },
      append: async e => { assert.equal(locked, true); return durable.append(e); } }, request, async r => { assert.equal(locked, true); return destroyed(r); });
    assert.equal(locked, false);
  });
  test('TEST-EMR-19-A F03: late Addendum or correction retains every part until the latest part expires', async () => {
    const original = makeRecord('report', ['report-version'], t0, 'v1');
    const added = addPart(original, 'addendum', '2036-09-01T00:00:00.000Z');
    const corrected = addPart(added, 'correction', '2036-09-02T00:00:00.000Z');
    assert.equal(D.retentionDeadline(corrected), '2046-09-02T15:00:00.000Z');
    assert.equal(D.retentionDeadline(original), '2036-10-05T15:00:00.000Z');
    await refuseExpiry(disposal({ record: corrected, requestedAt: '2036-10-05T15:00:00.000Z' }), 'RetentionNotElapsed');
    await refuseExpiry(disposal({ record: corrected, versionIds: ['v1'], requestedAt: '2046-09-02T15:00:00.000Z' }), 'CompleteVersionSetRequired');
    assert.equal((await expire(durable, disposal({ record: corrected, requestedAt: '2046-09-02T15:00:00.000Z' }), async r => destroyed(r))).partCount, 3);
    const note = addPart(makeRecord('note', ['tech-note'], t0, 'n1'), 'n2', '2031-09-01T00:00:00.000Z');
    assert.equal(D.retentionDeadline(note), '2036-09-01T15:00:00.000Z');
    assert.throws(() => addPart(added, 'addendum', '2036-09-02T00:00:00.000Z'));
    assert.throws(() => addPart(added, 'earlier', t0));
  });
  test('TEST-EMR-19-A F04: Seoul civil-day expiry excludes the initial day except midnight, including leap years', async () => {
    const cases = [
      ['2026-10-04T15:00:00.000Z', '2031-10-04T15:00:00.000Z'], // 00:00 KST
      ['2026-10-04T15:01:00.000Z', '2031-10-05T15:00:00.000Z'], // 00:01 KST
      ['2026-10-05T14:59:00.000Z', '2031-10-05T15:00:00.000Z'], // 23:59 KST
      ['2024-02-28T15:00:00.000Z', '2029-02-28T15:00:00.000Z'], // Feb 29 midnight
      ['2024-02-29T14:59:00.000Z', '2029-02-28T15:00:00.000Z'],
      ['2026-12-31T14:59:59.999Z', '2031-12-31T15:00:00.000Z'],
    ];
    for (const [start, end] of cases) {
      const record = makeRecord('civil', ['image'], start);
      assert.equal(D.retentionDeadline(record), end);
      await refuseExpiry(disposal({ record, requestedAt: new Date(Date.parse(end) - 1).toISOString() }), 'RetentionNotElapsed');
      assert.equal((await expire(durable, disposal({ record, requestedAt: end }), async r => destroyed(r))).phase, 'completed');
    }
    const record = baseRecord(), end = D.retentionDeadline(record);
    assert.equal(D.extendRetention(record, extension({ at: new Date(Date.parse(end) - 1).toISOString() })).extension.at, '2031-10-05T14:59:59.999Z');
    assert.throws(() => D.extendRetention(record, extension({ at: end })));
  });
  test('TEST-EMR-06/07-A F05: hash chain detects mutation, internal omission and missing tail; expiry checkpoint preserves verification', () => {
    const pos = e => ({ sequence: e.sequence, hash: e.hash });
    const a = A.sealAccessEvent(A.ACCESS_CHAIN_GENESIS, access());
    const b = A.sealAccessEvent(pos(a), access({ eventId: 'event-2' }));
    assert.equal(b.previousHash, a.hash);
    assert(A.verifyAccessChain(A.ACCESS_CHAIN_GENESIS, [a, b], pos(b)));
    const changed = clone(b); changed.payload.event.targets[0].versionId.value = 'changed';
    assert.equal(A.verifyAccessChain(A.ACCESS_CHAIN_GENESIS, [a, changed], pos(b)), false);
    assert.equal(A.verifyAccessChain(A.ACCESS_CHAIN_GENESIS, [b], pos(b)), false);
    assert.equal(A.verifyAccessChain(A.ACCESS_CHAIN_GENESIS, [a], pos(b)), false);
    const checkpoint = A.sealAccessExpiry(pos(b), pos(a), 1, '2028-10-05T15:00:00.000Z');
    assert(A.verifyAccessChain(pos(a), [b, checkpoint], pos(checkpoint)));
    assert(!JSON.stringify(checkpoint.payload).includes('SYN-1'));
    assert.throws(() => A.sealAccessExpiry(pos(a), pos(b), 2, t0));
  });
  test('TEST-EMR-07-A P06-success-with-unresolved-target: each required success fact must resolve', () => {
    assert(A.parseAccessEvent(access()));
    for (const field of ['patientLinkSnapshot', 'studyId', 'recordId', 'versionId']) {
      const bad = access(); bad.targets[0][field] = { status: 'unresolved', reason: 'not-resolved' };
      assert.throws(() => A.parseAccessEvent(bad), field);
      assert(A.parseAccessEvent({ ...bad, action: 'permission-refused', result: 'refused' }));
    }
  });
  test('TEST-EMR-07-A F06: non-record exemptions are closed; free text never replaces patient/version evidence', () => {
    for (const kind of Object.keys(C.RECORD_CLASSIFICATION)) {
      const event = access(); event.targets[0].kind = kind;
      event.surface = Object.keys(R.ROUTE_CONTRACTS).find(r => R.ROUTE_CONTRACTS[r].kinds.includes(kind)) ||
        Object.keys(R.EXTERNAL_SURFACES).find(r => R.EXTERNAL_SURFACES[r].includes(kind));
      for (const field of ['patientLinkSnapshot', 'studyId', 'recordId', 'versionId']) event.targets[0][field] = { status: 'not-applicable', reason: 'non-record-target' };
      if (['preferences', 'reading-template', 'institution', 'identity-access', 'authentication-session', 'system-operation'].includes(kind))
        assert(A.parseAccessEvent(event, [stored(kind, 'non-record', 'setting-v1', t0)]));
      else assert.throws(() => A.parseAccessEvent(event), kind);
    }
    const event = access(); event.targets[0].patientLinkSnapshot = { status: 'not-applicable', reason: 'I cannot find the patient' };
    assert.throws(() => A.parseAccessEvent(event));
    assert.deepEqual(A.parseAccessEvent(access({ targets: [] })).targets, []);
  });
  test('TEST-EMR-07-A P09-success-with-unresolved-proxy-ip: member success always needs a trusted proxy', () => {
    assert(A.parseAccessEvent(access()));
    assert.throws(() => A.parseAccessEvent(access({ trustedProxyIp: { status: 'unresolved', reason: 'not-observed' } })));
    assert(A.parseAccessEvent(access({ action: 'permission-refused', result: 'refused', trustedProxyIp: { status: 'unresolved', reason: 'not-observed' } })));
  });
  test('TEST-EMR-07-A P08-print-done-without-preceding-event: print completion is linked to its opened event', () => {
    const event = access({ action: 'print-done', result: 'reported', relatedEventId: 'print-opened-1' });
    assert(A.parseAccessEvent(event));
    assert.throws(() => A.parseAccessEvent({ ...event, relatedEventId: null }));
  });
  test('TEST-EMR-19-A P10-access-record-extendable: refusal is within the access retention window', () => {
    const record = makeRecord('access', ['access-audit'], t0);
    const validTiming = extension({ at: '2027-10-05T00:00:00.000Z', until: '2029-10-05T15:00:00.000Z' });
    assert(validTiming.at > t0 && validTiming.at < D.retentionDeadline(record));
    assert(validTiming.until > D.retentionDeadline(record) && validTiming.until <= D.civilPeriodEnd(D.retentionDeadline(record), 2));
    assert.throws(() => D.extendRetention(record, validTiming));
    assert(D.extendRetention(baseRecord(), extension({ at: validTiming.at })));
  });
  test('TEST-EMR-19-A F07: Tech Notes and worklist image requests have five-year statutory units', () => {
    for (const [kind, clause] of [['tech-note', 'medical-rules:15.1.5'], ['image-request', 'medical-rules:15.1.1']]) {
      const record = makeRecord(kind, [kind], t0);
      assert.equal(D.retentionDeadline(record), '2031-10-05T15:00:00.000Z');
      assert(C.RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.some(m => m.clauseId === clause));
      assert.throws(() => purposeRecord('x', kind, 'owner', t0, ['v1']));
    }
  });
  test('TEST-EMR-12/19-A R2-09: each purpose kind ends at its own stored event; owner guard is observable', async () => {
    for (const [kind, row] of Object.entries(C.RECORD_CLASSIFICATION).filter(([, r]) => r.retention.mode === 'purpose')) {
      assert(row.retention.purposeEnds.length > 0);
      for (const trigger of row.retention.purposeEnds) {
        const record = purposeRecord('private', kind, 'owner', t0, ['private-v1', 'private-v2']);
        const end = purposeEnd(record, trigger, deadline, trigger === 'intent-superseded' ? { superseded: {
          eventId: 'another-approval', reportId: 'parent', at: deadline, action: 'approve', authorId: 'another-reader', draftId: 'another-draft', versionId: 'approved-v1' } } : {});
        const events = [];
        const result = await endPurpose({ append: async e => { events.push(e); return durable.append(e); } }, record, end, deadline,
          async target => { assert.deepEqual(target.partIds, record.partIds); return { completedAt: deadline, method: 'irreversible-permanent-deletion' }; });
        assert.equal(result.phase, 'completed'); assert.deepEqual(events.map(e => e.phase), ['started', 'completed']);
        await refusePurpose(record, purposeEnd(record, 'arbitrary-timer'), deadline, 'PurposeBindingRefused');
      }
    }
    const draft = purposeRecord('draft', 'private-draft', 'owner', t0, ['v1']);
    await refusePurpose(draft, purposeEnd(draft, 'explicit-discard', deadline, { actorId: 'other' }), deadline, 'PurposeOwnerRefused');
    await refusePurpose(draft, purposeEnd(draft, 'owner-deleted'), deadline, 'PurposeBindingRefused');
    assert(step(inProgress(), 'approve', { version: ref('v1') }).effects.includes('end-private-draft-purpose'));
    assert(!step(approved(), 'finalize', { actor: { ...reader('finalizer'), kind: 'service' }, at: deadline }).effects.includes('end-private-draft-purpose'));
  });
  test('TEST-EMR-13-A F08: cancelled study gets a fresh report unit without rewriting or reopening the cancelled unit', () => {
    const cancelled = step(finalized(), 'cancel', { at: '2026-10-07T00:00:00.000Z', reason: 'wrong study', eventId: 'cancel', version: ref('cancel-v') }).facts;
    const before = clone(cancelled), at = '2026-10-08T00:00:00.000Z';
    const next = L.newReportAfterCancellation(cancelled, 'report-2', reader('reader-1'), at);
    assert.equal(next.studyId, cancelled.studyId); assert.equal(next.previousCancelledRecordId, cancelled.recordId);
    const active = step(next, 'start', { at }).facts;
    const published = step(active, 'approve', { at, version: { ...ref('new-v1'), recordId: 'report-2' } }).facts;
    assert.equal(published.firstApprovedAt, at); assert.equal(published.amendUntil, '2026-10-09T00:00:00.000Z');
    assert.deepEqual(cancelled, before);
    assert.throws(() => step(cancelled, 'amend', { at, version: ref('forbidden') }));
    assert.throws(() => L.newReportAfterCancellation(cancelled, 'report-1', reader('reader-1'), at));
  });
  test('TEST-EMR-13/19-A P07-archive-ignores-content-hash: same version id with another digest is rejected', () => {
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand());
    assert.equal(L.reportRetentionAccess(f, archive).state, 'retention-only');
    assert.throws(() => L.reportRetentionAccess(f, { ...archive, version: { ...archive.version, sha256: 'cd'.repeat(32) } }));
    const added = step(f, 'addendum', { at: deadline, version: ref('v2') }).facts;
    assert.equal(L.reportRetentionAccess(added, archive).state, 'normal-retention');
    assert.throws(() => L.reportRetentionAccess(added, { ...archive, version: { ...archive.version, sha256: 'cd'.repeat(32) } }));
  });
  const clinicalStudyReader = (overrides = {}) => { clinicalStudyOverrides = overrides; return clinicalCapability; };
  test('TEST-EMR-13/19-A R2-05: resume requires an authorized reader and a stored new study of the same patient', () => {
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand()), retention = baseRecord(), expiry = D.retentionDeadline(retention);
    const command = { actor: reader('reader-1'), at: deadline, basis: 'new-study-same-patient', studyId: 'new-study' };
    const resume = L.resumeClinicalUse(f, archive, command, clinicalStudyReader());
    assert.equal(L.reportRetentionAccess(f, archive, resume).state, 'normal-retention');
    assert.equal(L.reportRetentionAccess(f, archive).state, 'retention-only');
    for (const actor of [{ ...reader('admin'), roles: ['admin'] }, { ...reader('svc'), kind: 'service' }, { ...reader('x'), canReadStudy: false }])
      assert.throws(() => L.resumeClinicalUse(f, archive, { ...command, actor }, clinicalStudyReader()), { code: 'ClinicalResumeAuthorityRefused' });
    assert.throws(() => L.resumeClinicalUse(f, archive, { ...command, at: t0 }, clinicalStudyReader()), { code: 'ClinicalResumeAuthorityRefused' });
    for (const basis of ['legal-preservation', 'lawful-addendum', 'lawful-correction', 'hospital-default'])
      assert.throws(() => L.resumeClinicalUse(f, archive, { ...command, basis }, clinicalStudyReader()), { code: 'ClinicalResumeBasisRefused' });
    for (const patch of [{ patientId: 'other' }, { assigningAuthority: 'other' }, { studyId: 'other' }, { createdAt: t0 }])
      assert.throws(() => L.resumeClinicalUse(f, archive, command, clinicalStudyReader(patch)), { code: 'ClinicalResumePatientBindingRefused' });
    assert.throws(() => L.resumeClinicalUse(f, archive, command, { ...clinicalStudyReader(), loadStudy: () => null }));
    assert.throws(() => L.reportRetentionAccess(f, archive, { ...resume, recordId: 'wrong' }));
    assert.equal(D.retentionDeadline(retention), expiry);
  });
  test('TEST-EMR-19-A R2-08: verified hold remains active years after expiry, including its complete components', async () => {
    const image = makeRecord('incorporated-image', ['image'], t0);
    const record = makeRecord('held-report', ['report-version'], t0, 'held-v1', { event: { components: [component(image)] } });
    const hold = holdFacts(record.recordId), held = holdRecord(record, hold), now = '2045-10-05T00:00:00.000Z';
    assert.equal(D.retentionState(held).state, 'legal-hold');
    const graph = graphOf([held, image], [edge(held, image)]);
    await refuseExpiry(disposal({ record: held, graph, requestedAt: now }), 'LegalHoldActive');
    await refuseExpiry(disposal({ record: image, graph, requestedAt: now }), 'LegalHoldActive');
    const lifted = D.liftLegalHold(held, hold.holdId, dutyReader(releaseFacts(hold, now)));
    assert.equal(D.retentionDeadline(lifted), D.retentionDeadline(record));
    assert.equal((await expire(durable, disposal({ record: lifted, graph: graphOf([lifted, image], [edge(lifted, image)]), requestedAt: now }), async r => destroyed(r))).phase, 'completed');
    assert.throws(() => D.liftLegalHold(lifted, hold.holdId, dutyReader(releaseFacts(hold, now))), { code: 'HoldReleaseBindingRefused' });
  });
  test('TEST-EMR-19-A F11: destruction names opaque units and classes, flags overdue execution, and confirms completed batches', async () => {
    const record = baseRecord(), run = requestedAt => expire(durable, disposal({ record, requestedAt }), async r => destroyed(r));
    const timely = await run('2031-10-05T15:00:00.000Z');
    assert.equal(timely.timeliness, 'within-five-days'); assert.equal(timely.expiryDay, '2031-10-05');
    assert.deepEqual(timely.classes, ['examination', 'imageReport']);
    assert.equal(timely.disposalUnitId, record.disposalUnitId);
    const overdue = await run('2034-10-05T15:00:00.000Z');
    assert.equal(overdue.timeliness, 'overdue');
    assert.equal((await run('2031-10-10T14:59:59.999Z')).timeliness, 'within-five-days');
    assert.equal((await run('2031-10-10T15:00:00.000Z')).timeliness, 'overdue');
    const confirmed = D.confirmDestruction('batch-1', [timely], 'privacy-officer', '2031-10-06T01:00:00.000Z');
    assert.deepEqual(confirmed.disposalUnitIds, [record.disposalUnitId]);
    assert.throws(() => D.confirmDestruction('batch-1', [{ ...timely, phase: 'failed' }], 'privacy-officer', '2031-10-06T01:00:00.000Z'));
    for (const text of [record.recordId, ...record.parts.map(p => p.partId), 'SYN-1']) assert(!JSON.stringify([timely, overdue, confirmed]).includes(text));
  });
  test('TEST-EMR-07-A F12: in-process jobs log lifecycle success with explicit statutory act mappings', () => {
    const noProxy = { status: 'not-applicable', reason: 'in-process-service' };
    for (const action of ['finalize', 'archive', 'resume-clinical-use', 'extend-retention', 'legal-hold', 'lift-legal-hold', 'destroy']) {
      assert(A.parseAccessEvent(access({ action, result: 'succeeded', executor: 'service', cause: 'service-job', trustedProxyIp: noProxy })));
      assert.equal(A.STATUTORY_ACT[action], 'none');
    }
    for (const [action, act] of [['write', '기재'], ['approve-sign', '기재'], ['additional-entry', '추가기재'], ['addendum', '추가기재'], ['modify', '수정'], ['amend', '수정'], ['cancel', '수정'], ['provide-prepared', '열람'], ['client-shown', '열람']]) assert.equal(A.STATUTORY_ACT[action], act);
    for (const action of Object.values(A.ACCESS_ACTIONS).flat()) assert(A.STATUTORY_ACT[action]);
    assert.throws(() => A.parseAccessEvent(access({ trustedProxyIp: noProxy })));
    assert.throws(() => A.parseAccessEvent(access({ executor: 'service', cause: 'background-fetch', trustedProxyIp: noProxy })));
  });
  test('TEST-EMR-17-A F14: signature tightening is limited to human clinical authors', () => {
    for (const [kind, row] of Object.entries(C.RECORD_CLASSIFICATION)) {
      if (['required', 'clinical-entry-only'].includes(row.signature.rule)) assert.equal(D.signatureRequired(kind, 'described-content', D.tightenConfiguration({ [kind]: { requireSignature: true } })), true);
      else assert.throws(() => D.tightenConfiguration({ [kind]: { requireSignature: true } }), kind);
    }
    for (const kind of ['image', 'thumbnail', 'access-audit', 'system-operation']) assert.equal(D.signatureRequired(kind), false);
  });

  test('TEST-EMR-19-A R2-03: private-draft hold and release timing refuse without delete or started records', async () => {
    const draft = purposeRecord('draft', 'private-draft', 'owner', t0, ['v1']), hold = holdFacts('draft');
    const held = placePurposeHold(draft, dutyReader(hold), hold.holdId), end = purposeEnd(draft, 'result-version-signed');
    await refusePurpose(held, end, deadline, 'LegalHoldActive');
    const releasedAt = '2026-10-07T00:00:00.000Z';
    const lifted = D.liftPurposeLegalHold(held, hold.holdId, dutyReader(releaseFacts(hold, releasedAt)));
    await refusePurpose(lifted, end, deadline, 'RetentionNotElapsed');
    assert.equal((await endPurpose(durable, lifted, end, releasedAt,
      async () => ({ completedAt: releasedAt, method: 'irreversible-permanent-deletion' }))).phase, 'completed');
  });

  test('TEST-EMR-19-A R2-04: only a new lawful content event changes the clock; expired units cannot revive', () => {
    const record = makeRecord('report', ['report-version'], t0, 'v1'), late = '2035-01-01T00:00:00.000Z';
    for (const act of ['read', 'resign', 'migration', 'bookkeeping', 'acquisition'])
      assert.throws(() => addPart(record, 'v2', late, { event: { act } }), { code: 'NewLawfulRecordEventRequired' });
    assert.throws(() => addPart(record, 'v2', late, { event: { signature: null } }), { code: 'NewLawfulRecordEventRequired' });
    assert.throws(() => addPart(record, 'v2', late, { event: { contentSha256: record.parts[0].evidence.event.contentSha256 } }), { code: 'UnchangedContentRefused' });
    assert.throws(() => addPart(record, 'v2', late, { event: { predecessor: { ...component(record), sha256: 'ab'.repeat(32) } } }), { code: 'PredecessorBindingRefused' });
    assert.throws(() => D.recordVersionAdded(record, stored('report-version', 'other', 'v2', late)), { code: 'RecordEventBindingRefused' });
    for (const at of [D.retentionDeadline(record), '2037-01-01T00:00:00.000Z'])
      assert.throws(() => addPart(record, 'v2', at), { code: 'ExpiredUnitCannotResume' });
    const source = stored('report-version', 'report', 'v2', late);
    for (const patch of [{ at: t0 }, { versionId: 'wrong' }, { sha256: 'cd'.repeat(32) }])
      assert.throws(() => resolveRow({ recordId: 'report', model: source.model, row: source.row, event: { ...source.event, ...patch } }), { code: 'SignatureBindingRefused' });
    assert.equal(D.retentionDeadline(makeRecord('new-unit', ['report-version'], '2037-01-01T00:00:00.000Z')), '2047-01-01T15:00:00.000Z');
    assert.equal(D.retentionDeadline(addPart(record, 'v2', late, { event: { act: 'additional-entry' } })), '2045-01-01T15:00:00.000Z');
  });
  test('TEST-EMR-13/19-A R2-04/05: a held correction needs independent authority and preserves separated access', () => {
    const record = makeRecord('report-1', ['report-version'], t0, 'v1'), held = holdRecord(record), at = '2040-01-01T00:00:00.000Z';
    const processing = { basisId: 'verified-correction-request', authorized: true, preservesOriginals: true, separateManagement: true, permittedHoldIds: ['order-1'] };
    const options = { event: { act: 'correction', processing } };
    const corrected = addPart(held, 'v2', at, options);
    assert.equal(D.retentionDeadline(corrected), '2050-01-01T15:00:00.000Z');
    assert.deepEqual(corrected.parts[0], held.parts[0]); assert.equal(D.retentionState(corrected).state, 'legal-hold');
    for (const patch of [{ authorized: false }, { preservesOriginals: false }, { separateManagement: false }, { permittedHoldIds: [] }])
      assert.throws(() => addPart(held, 'v2', at, { event: { act: 'correction', processing: { ...processing, ...patch } } }), { code: 'HeldCorrectionAuthorityRequired' });
    assert.throws(() => addPart(held, 'v2', at), { code: 'HeldCorrectionAuthorityRequired' });
    assert.throws(() => addPart(held, 'v2', at, { event: { ...options.event, contentSha256: held.parts[0].evidence.event.contentSha256 } }), { code: 'UnchangedContentRefused' });
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand()), evidence = corrected.parts[1].evidence;
    const output = step(f, 'addendum', { at, version: { recordId: 'report-1', versionId: 'v2', sha256: evidence.event.sha256 }, preservationCorrection: evidence });
    assert.deepEqual(L.reportRetentionAccess(output.facts, archive), { state: 'retention-only', ordinaryClinicalAccess: false, separateStorage: true });
    assert(!output.effects.includes('publish-immediately'));
  });
  test('TEST-EMR-01/19-A R2-06: server row lookup fixes model and kinds; a report cannot become access or an image', () => {
    const report = stored('report-version', 'report-1', 'v1', t0);
    for (const input of ['report-1', { ...report, kinds: ['access-audit'] }, { ...report, model: 'DicomInstance' }, clone(report)])
      assert.throws(() => D.newRetentionRecord(input), { code: 'StoredRecordRequired' });
    for (const kind of ['access-audit', 'image', 'preferences']) assert.throws(() => D.newRetentionRecord('report-1', [kind], t0), { code: 'StoredRecordRequired' });
    const record = D.newRetentionRecord(report);
    assert.throws(() => D.parseRetentionRecord({ ...record, kinds: ['image'] }), { code: 'RecordKindBindingRefused' });
    assert.throws(() => D.parseRetentionRecord({ ...record, kinds: ['access-audit'] }), { code: 'RecordKindBindingRefused' });
    assert.throws(() => resolveRow({ recordId: 'different-row', model: report.model, row: report.row, event: report.event }, 'report-1'), { code: 'RecordEventBindingRefused' });
    for (const kind of ['report-version', 'image', 'clinical-answer']) assert.throws(() => D.statutoryClasses(['access-audit', kind]), { code: 'AccessUnitMixed' });
    const waived = access({ targets: [{ kind: 'preferences', ...Object.fromEntries(['patientLinkSnapshot', 'studyId', 'recordId', 'versionId'].map(k => [k, { status: 'not-applicable', reason: 'non-record-target' }])) }] });
    assert.throws(() => A.parseAccessEvent(waived));
    assert(A.parseAccessEvent({ ...waived, surface: 'GET reading-preferences' }));
  });
  function modelSource(model, row, act = 'creation', recordId = 'model-row', options = {}) {
    const seed = stored('report-version', recordId, 'model-v1', t0, options);
    const event = { ...seed.event, act, signature: row.clinicalEntry === true || ['entry', 'additional-entry', 'correction'].includes(act) ? seed.event.signature : null };
    return resolveRow({ recordId, model, row, event });
  }
  test('TEST-EMR-01/19-A R2-06: every stored model resolves to a statutory, purpose, source or access path', () => {
    const rows = {
      StudyState: { change: 'acquisition' }, Order: { origin: 'product-authored' }, Transfer: { localPatientId: null },
      ViewerItem: { snapshot: { type: 'measurement' } }, ViewerRevision: { snapshot: { type: 'key-image' } },
      ViewerJob: { title: '', description: '', clinicalEntry: false }, ViewerJobRevision: { title: 'followup', description: 'clinical', clinicalEntry: true },
      StudyQuestionEntry: { kind: 'answer' }, CriticalResultEvent: { recordId: 'model-row', event: 'created' },
    };
    for (const model of Object.keys(C.MODEL_CLASSIFICATION)) {
      const clinicalModels = ['Report', 'ReportVersion', 'Order', 'Finding', 'FindingRevision', 'ManualSr', 'ViewerJobRevision',
        'StudyConsultation', 'StudyQuestion', 'StudyQuestionEntry', 'CriticalResult', 'CriticalResultEvent'];
      const deliveries = ['GatewayReceipt', 'GatewayRetryRequest', 'ViewerRequest', 'StudyImageRequestReceipt', 'CriticalResultReceipt'];
      const act = clinicalModels.includes(model) ? 'entry' : deliveries.includes(model) ? 'delivery' : model === 'AuditLog' ? 'access' : model === 'StudyState' ? 'acquisition' : 'creation';
      const source = modelSource(model, { ownerId: 'owner', draftBinding: { reportId: 'parent', intentId: 'intent', action: 'approve' }, ...rows[model] }, act);
      const disposition = C.retentionDisposition(source);
      if (disposition === 'statutory') assert(D.newRetentionRecord(source).parts.length === 1, model);
      else if (disposition === 'purpose') assert(D.newPurposeRecord(source, ['model-v1']).kind, model);
      else if (disposition === 'access-event') assert.equal(D.retentionDeadline(A.deliveryRetention(source)), '2028-10-05T15:00:00.000Z', model);
      else { assert.equal(disposition, 'source-record'); assert.equal(source.row.sourceRecordId, 'source'); }
    }
    const layout = modelSource('ViewerJob', { title: 'layout name', description: '', clinicalEntry: false });
    assert.equal(C.retentionDisposition(layout), 'purpose');
    assert.throws(() => D.newPurposeRecord({ ...layout }, ['model-v1']), { code: 'StoredRecordRequired' });
  });
  test('TEST-EMR-01/19-A R2-07: clinical handoff ACK belongs to CVR; delivery and access keep separate two-year clocks', async () => {
    const report = makeRecord('pinned-report', ['report-version'], t0, 'v1');
    const cvr = makeRecord('cvr', ['critical-result'], t0, 'c1', { event: { components: [component(report)] } });
    const at = '2026-10-06T00:00:00.000Z', pin = component(report), hash = digest('ack');
    const facts = { recordId: cvr.recordId, model: 'CriticalResultEvent', row: { recordId: cvr.recordId, event: 'ack',
      acknowledgedVersion: pin, actorId: 'recipient', recipientId: 'recipient' }, event: {
      eventId: 'ack', recordId: cvr.recordId, versionId: 'ack-v1', sha256: hash, contentSha256: hash, at,
      act: 'handoff-ack', signature: null, predecessor: component(cvr), components: [pin], processing: null } };
    const ack = resolveRow(facts);
    assert.throws(() => D.newRetentionRecord(ack), { code: 'CvrParentRequired' });
    const complete = D.recordVersionAdded(cvr, ack, snapshotFor(cvr, at)), graph = graphOf([report, complete], [edge(complete, report), { ...edge(complete, report), fromPartId: 'ack-v1' }]);
    assert.equal(D.retentionDeadline(complete), '2036-10-06T15:00:00.000Z');
    assert.equal(D.retentionDeadline(report, graph), '2036-10-06T15:00:00.000Z');
    await refuseExpiry(disposal({ record: complete, graph, requestedAt: '2028-10-06T15:00:00.000Z' }), 'RetentionNotElapsed');
    for (const model of ['CriticalResultReceipt', 'StudyImageRequestReceipt', 'GatewayReceipt']) {
      const source = modelSource(model, { action: 'ack' }, 'delivery');
      assert.throws(() => D.newRetentionRecord(source), { code: 'AccessRetentionConstructorRequired' });
      assert.equal(D.retentionDeadline(A.deliveryRetention(source)), '2028-10-05T15:00:00.000Z');
    }
    assert.equal(D.retentionDeadline(A.accessRetention(access({ action: 'explicit-ack', result: 'succeeded', relatedEventId: 'prepared' }))), '2028-10-05T15:00:00.000Z');
    assert.throws(() => resolveRow({ ...facts, row: { ...facts.row, actorId: 'someone-else' } }), { code: 'CvrAckBindingRefused' });
  });
  test('TEST-EMR-19-A R2-08: hold basis and release bind verified clause, version, request, scope and validity', async () => {
    const record = baseRecord(), good = holdFacts(record.recordId);
    for (const field of ['type', 'clause', 'requestId', 'authorityId', 'scope', 'verified', 'validity']) {
      const bad = clone(good); delete bad.basis[field];
      assert.throws(() => holdRecord(record, bad), field);
    }
    for (const patch of [{ type: 'hospital-policy' }, { verified: false }, { requestId: '' }, { scope: ['another-record'] },
      { clause: { law: 'law', article: '', version: 'v1' } }, { clause: { law: 'law', article: '1', version: '' } },
      { validity: { from: t0, until: null, condition: 'internal-retention-policy' } }]) assert.throws(() => holdRecord(record, { ...good, basis: { ...good.basis, ...patch } }));
    // A verified statutory obligation may be registered by the institution itself.
    const statutory = { ...good, basis: { ...good.basis, type: 'statutory-duty', clauseId: 'privacy:36.2',
      clause: { law: 'privacy', article: '36.2', version: '21445' }, authorityId: 'hospital-a', authorityKind: 'personal-information-controller', validity: { ...good.basis.validity, condition: 'duty-active' } } };
    assert.equal(D.retentionState(holdRecord(record, correctionRequest(statutory))).state, 'legal-hold');
    const held = holdRecord(record), at = '2038-01-01T00:00:00.000Z';
    for (const patch of [{ holdId: 'another-hold' }, { authorityVerified: false }, { evidenceId: '' }])
      assert.throws(() => D.liftLegalHold(held, good.holdId, dutyReader(releaseFacts(good, at, patch))));
    const until = '2031-10-10T00:00:00.000Z';
    const limited = pendingHold(record.recordId, '2031-10-01T00:00:00.000Z', until);
    const pending = holdRecord(record, limited);
    await refuseExpiry(disposal({ record: pending, requestedAt: until }), 'HoldReleaseRequired');
    requestRows.get(limited.basis.requestId).resolution = { eventId: 'request-resolution', at: until, outcome: 'fulfilled' };
    const released = D.liftLegalHold(pending, good.holdId, dutyReader(releaseFacts(limited, until, { reason: 'request-fulfilled', evidenceId: 'request-resolution' })));
    assert.equal((await expire(durable, disposal({ record: released, requestedAt: until }), async r => destroyed(r))).phase, 'completed');
  });
  test('TEST-EMR-12/19-A R2-09: Addendum draft ends only at its own signed Addendum or its own explicit discard after creation', async () => {
    const createdAt = '2030-01-01T00:00:00.000Z', at = '2030-01-02T00:00:00.000Z';
    const draft = purposeRecord('addendum-draft', 'private-draft', 'owner', createdAt, ['d1', 'd2'], {
      row: { draftBinding: { reportId: 'parent', intentId: 'addendum-2030', action: 'addendum' } } });
    const end = purposeEnd(draft, 'result-version-signed', at);
    for (const event of [purposeEnd(draft, 'report-approved', at), purposeEnd(draft, 'report-finalized', at),
      purposeEnd(draft, 'result-version-signed', t0), purposeEnd(draft, 'result-version-signed', createdAt),
      purposeEnd(draft, 'explicit-discard', createdAt), { ...end, at: '2030-01-03T00:00:00.000Z' }])
      await refusePurpose(draft, event, at, 'PurposeBindingRefused');
    for (const patch of [{ draftId: 'other' }, { intentId: 'parent-approval-2026' }, { recordId: 'another-report' }, { action: 'approve' }])
      await refusePurpose(draft, purposeEnd(draft, 'result-version-signed', at, { result: { ...end.result, ...patch } }), at, 'PurposeBindingRefused');
    assert.throws(() => purposeEnd(draft, 'result-version-signed', at, { result: { ...end.result, signedAt: t0 } }), { code: 'PurposeBindingRefused' });
    endRows.set(end.eventId, { ...end, result: { ...end.result, versionId: 'another-result-version' } });
    resultRows.set(end.result.recordId + ':another-result-version', end.result);
    assert.throws(() => D.resolvePurposeEnd(endReader, end.eventId), { code: 'PurposeBindingRefused' });
    for (const event of [end, purposeEnd(draft, 'explicit-discard', at)]) {
      let deletes = 0;
      assert.equal((await endPurpose(durable, draft, event, at, async () => { deletes++; return { completedAt: at, method: 'irreversible-permanent-deletion' }; })).phase, 'completed');
      assert.equal(deletes, 1);
    }
  });

  test('TEST-EMR-19-A R3-01: verified holds attach to every extant unit, coexist, and outlast other retention bases', async () => {
    const report = makeRecord('hold-report', ['report-version'], t0);
    const cvr = makeRecord('hold-cvr', ['critical-result'], '2030-01-01T00:00:00.000Z', 'c1', { event: { components: [component(report)] } });
    const at = '2037-01-01T00:00:00.000Z', originalGraph = snapshotFor(report, at, [cvr]);
    const order = holdFacts(report.recordId, { at });
    const held = holdRecord(report, order, originalGraph);
    assert.equal(D.retentionDeadline(held), D.retentionDeadline(report));
    await refuseExpiry(disposal({ record: held, graph: snapshotFor(held, at, [cvr]), requestedAt: '2040-01-02T00:00:00.000Z' }), 'LegalHoldActive');
    const second = holdFacts(report.recordId, { holdId: 'order-2', at: '2038-01-01T00:00:00.000Z' });
    const twice = holdRecord(held, second, snapshotFor(held, second.at, [cvr]));
    const lifted = D.liftLegalHold(twice, order.holdId, dutyReader(releaseFacts(order, '2039-01-01T00:00:00.000Z')));
    assert.equal(lifted.holds.length, 2);
    await refuseExpiry(disposal({ record: lifted, requestedAt: '2045-01-01T00:00:00.000Z' }), 'LegalHoldActive');
    const bare = makeRecord('expired-not-destroyed', ['image'], t0), dayAfter = '2031-10-06T15:00:00.000Z';
    assert.equal(D.retentionState(holdRecord(bare, holdFacts(bare.recordId, { at: dayAfter }))).state, 'legal-hold');
    const destroyedRecord = D.parseRetentionRecord({ ...bare, destroyedAt: D.retentionDeadline(bare) });
    assert.throws(() => holdRecord(destroyedRecord, holdFacts(bare.recordId, { at: dayAfter })), { code: 'RecordDestroyed' });
    assert.throws(() => addPart(destroyedRecord, 'new', dayAfter), { code: 'RecordDestroyed' });
    await refuseExpiry(disposal({ record: destroyedRecord, requestedAt: dayAfter }), 'RecordDestroyed');
    assert.throws(() => D.placeLegalHold(report, dutyReader(order), order.holdId), { code: 'ReferenceSnapshotRequired' });
    const source = stored('report-version', report.recordId, 'a2', at, { event: { act: 'additional-entry', predecessor: component(report) } });
    assert.throws(() => D.recordVersionAdded(report, source), { code: 'ReferenceSnapshotRequired' });
    // Independent no-hold storage scenario for the CVR retention basis.
    holdIndex.set(report.recordId, []);
    assert.equal(D.retentionDeadline(D.recordVersionAdded(report, source, originalGraph)), '2047-01-01T15:00:00.000Z');
  });

  test('TEST-EMR-19-A R3-01/08 X2: retention changes and deletion recheck snapshot contents under the same lock', async () => {
    const report = makeRecord('snapshot-report', ['report-version'], t0);
    const cvr = makeRecord('snapshot-cvr', ['critical-result'], '2030-01-01T00:00:00.000Z', 'c1', { event: { components: [component(report)] } });
    const request = disposal({ record: report, requestedAt: '2037-01-01T00:00:00.000Z' });
    const current = snapshotFor(report, request.requestedAt, [cvr]);
    assert.equal(current.revision, request.graph.revision);
    await refuseExpiry(request, 'ReferenceSnapshotStale', { withRetentionLock: async (id, at, work) => work(current) });
    let persisted = 0, locked = false;
    const store = { withRetentionLock: async (id, at, work) => { locked = true; try { return await work(current); } finally { locked = false; } } };
    await assert.rejects(D.withRetentionChange(store, report, request.graph, request.requestedAt, async () => { persisted++; }), { code: 'ReferenceSnapshotStale' });
    assert.equal(persisted, 0);
    const order = holdFacts(report.recordId, { at: request.requestedAt });
    const held = await D.withRetentionChange(store, report, current, request.requestedAt, async snapshot => {
      assert(locked); const result = D.placeLegalHold(report, dutyReader(order), order.holdId, snapshot); persisted++; return result;
    });
    assert.equal(persisted, 1); assert.equal(locked, false); assert.equal(held.holds.length, 1);
  });

  const processingFor = (holdIds, extra = {}) => ({ basisId: 'independent-processing-duty', authorized: true,
    preservesOriginals: true, separateManagement: false, permittedHoldIds: holdIds, ...extra });
  test('TEST-EMR-01/13/19-A R3-02: hold preserves lawful Addendum acquisition ACK and unsigned correction rules', () => {
    const at = '2027-01-02T00:00:00.000Z';
    for (const [kind, act] of [['report-version', 'additional-entry'], ['image', 'acquisition'], ['image', 'correction'], ['tech-note', 'correction'], ['image-request', 'correction']]) {
      const record = makeRecord('lawful-' + kind + act, [kind], t0);
      const hold = pendingHold(record.recordId, '2027-01-01T00:00:00.000Z', '2027-01-11T00:00:00.000Z');
      const ordinary = addPart(record, 'part2', at, { event: { act } });
      const held = holdRecord(record, hold), processing = processingFor([hold.holdId]);
      const added = addPart(held, 'part2', at, { event: { act, processing } });
      assert.equal(D.retentionDeadline(added), D.retentionDeadline(ordinary));
      assert.deepEqual(added.parts[0], record.parts[0]);
      assert.equal(added.parts[1].evidence.event.signature !== null, kind === 'report-version');
      for (const patch of [{ authorized: false }, { preservesOriginals: false }, { permittedHoldIds: [] }])
        assert.throws(() => addPart(held, 'bad', at, { event: { act, processing: { ...processing, ...patch } } }), { code: 'HeldCorrectionAuthorityRequired' });
      for (const denied of ['read', 'resign', 'migration', 'bookkeeping'])
        assert.throws(() => addPart(held, 'bad', at, { event: { act: denied, processing } }), { code: 'NewLawfulRecordEventRequired' });
    }
    const report = makeRecord('ack-report', ['report-version'], t0);
    const cvr = makeRecord('ack-cvr', ['critical-result'], t0, 'c1', { event: { components: [component(report)] } });
    const heldCvr = holdRecord(cvr), pin = component(report), hash = digest('held-ack');
    const ack = resolveRow({ recordId: cvr.recordId, model: 'CriticalResultEvent', row: { recordId: cvr.recordId, event: 'ack',
      acknowledgedVersion: pin, actorId: 'recipient', recipientId: 'recipient' }, event: {
      eventId: 'held-ack', recordId: cvr.recordId, versionId: 'a1', sha256: hash, contentSha256: hash, at, act: 'handoff-ack',
      signature: null, predecessor: component(cvr), components: [pin], processing: processingFor(['order-1']) } });
    assert.equal(D.recordVersionAdded(heldCvr, ack, snapshotFor(heldCvr, at)).parts.length, 2);
    const graph = snapshotFor(report, at, [heldCvr]);
    assert.throws(() => addPart(report, 'r2', at, { event: { act: 'additional-entry' } }, graph), { code: 'HeldCorrectionAuthorityRequired' });
    assert.equal(addPart(report, 'r2', at, { event: { act: 'additional-entry', processing: processingFor(['order-1']) } }, graph).parts.length, 2);
  });

  test('TEST-EMR-13/19-A R3-02: combined lifecycle and retention accept the same held clinical Addendum', () => {
    const at = '2027-01-02T00:00:00.000Z', report = makeRecord('report-1', ['report-version'], t0, 'v1');
    const held = holdRecord(report, pendingHold(report.recordId, '2027-01-01T00:00:00.000Z', '2027-01-11T00:00:00.000Z'));
    const source = stored('report-version', report.recordId, 'v2', at, { event: {
      act: 'additional-entry', predecessor: component(report), processing: processingFor(['order-1']) } });
    const f = finalized(), command = { action: 'addendum', actor: reader('reader-1'), at, expectedClaimGeneration: f.claimGeneration,
      expectedPublishedVersionId: f.publishedVersion.versionId, version: { recordId: report.recordId, versionId: 'v2', sha256: source.event.sha256 } };
    const output = L.transitionRetainedReport(f, command, held, source, snapshotFor(held, at));
    assert(output.effects.includes('publish-immediately')); assert.equal(output.retention.parts.length, 2);
    assert.equal(L.reportRetentionAccess(output.facts, null).ordinaryClinicalAccess, true);
    const denied = stored('report-version', report.recordId, 'v2', at, { event: { act: 'additional-entry', predecessor: component(report) } });
    assert.throws(() => L.transitionRetainedReport(f, command, held, denied, snapshotFor(held, at)), { code: 'HeldCorrectionAuthorityRequired' });
  });

  test('TEST-EMR-19-A R3-03/08 X6: signing validates complete live component bytes and never revives expired content', async () => {
    const image = makeRecord('manifest-image', ['image'], t0);
    const report = makeRecord('manifest-report', ['report-version'], t0, 'v1', { event: { components: [component(image)] } });
    const at = '2030-01-01T00:00:00.000Z', graph = snapshotFor(report, at);
    const cvr = components => stored('critical-result', 'manifest-cvr', 'c1', at, { event: { components } });
    assert.throws(() => D.newRetentionRecord(cvr([component(report)]), graph), { code: 'ComponentManifestIncomplete' });
    assert.equal(D.newRetentionRecord(cvr([component(report), component(image)]), graph).parts.length, 1);
    const wrong = { ...component(image), sha256: 'ff'.repeat(32) };
    assert.throws(() => D.newRetentionRecord(cvr([wrong]), graph), { code: 'ComponentMissing' });
    const corruptSource = stored('report-version', 'corrupt-report', 'bad', t0, { event: { components: [wrong] } });
    const corrupt = D.parseRetentionRecord({ ...report, recordId: 'corrupt-report', holds: D.reloadLegalHolds('corrupt-report'), parts: [{ partId: 'bad', startedAt: t0, evidence: corruptSource }] });
    await refuseExpiry(disposal({ record: image, graph: graphOf([image, corrupt], [edge(corrupt, image)]) }), 'ComponentMissing');
    const old = makeRecord('expired-component', ['image'], t0), late = '2033-01-01T00:00:00.000Z';
    const lateSource = stored('report-version', 'late-incorporator', 'v1', late, { event: { components: [component(old)] } });
    assert.throws(() => D.newRetentionRecord(lateSource, snapshotFor(old, late)), { code: 'ComponentExpired' });
    // Even a transaction-local candidate must not supply the basis for admitting its own expired component.
    const candidate = D.parseRetentionRecord({ ...report, recordId: lateSource.recordId, holds: D.reloadLegalHolds(lateSource.recordId),
      parts: [{ partId: lateSource.event.versionId, startedAt: late, evidence: lateSource }] });
    assert.throws(() => D.newRetentionRecord(lateSource, graphOf([old, candidate], [edge(candidate, old)], late)), { code: 'ComponentAdmissionSnapshotRefused' });
    const destroyed = D.parseRetentionRecord({ ...old, destroyedAt: D.retentionDeadline(old) });
    assert.throws(() => D.newRetentionRecord(lateSource, snapshotFor(destroyed, late)), { code: 'ComponentDestroyed' });
    const held = holdRecord(old, holdFacts(old.recordId, { at: '2030-01-01T00:00:00.000Z' }));
    assert.throws(() => D.newRetentionRecord(lateSource, snapshotFor(held, late)), { code: 'ComponentProcessingBasisRequired' });
    assert.throws(() => D.newRetentionRecord(lateSource), { code: 'ReferenceSnapshotRequired' });
  });

  test('TEST-EMR-12/19-A R3-04: overtaken approval cancellation and closed amendment each explicitly end draft intent', async () => {
    const at = deadline;
    const scenarios = [
      ['approve', { eventId: 'other-sign', reportId: 'parent', at, action: 'approve', authorId: 'other-reader', draftId: 'other-draft', versionId: 'approved-v1' }],
      ['addendum', { eventId: 'cancelled', reportId: 'parent', at, action: 'cancel', versionId: 'cancel-v1', reason: '취소 근거' }],
      ['amend', { eventId: 'window-ended', reportId: 'parent', at, action: 'amend-window-closed', firstApprovedAt: t0, amendUntil: at }],
    ];
    for (const [action, fact] of scenarios) {
      const draft = purposeRecord('overtaken-' + action, 'private-draft', 'owner', t0, ['d1'], { row: { draftBinding: { reportId: 'parent', intentId: action + '-intent', action } } });
      const end = purposeEnd(draft, 'intent-superseded', at, { superseded: fact });
      let deletes = 0;
      const result = await endPurpose(durable, draft, end, at, async () => { deletes++; return { completedAt: at, method: 'irreversible-permanent-deletion' }; });
      assert.equal(deletes, 1); assert.equal(result.phase, 'completed'); assert.equal(result.expiryDay, '2026-10-06');
      await refusePurpose(draft, purposeEnd(draft, 'intent-superseded', at, { superseded: { ...fact, reportId: 'other-parent' } }), at, 'PurposeBindingRefused');
      await refusePurpose(draft, purposeEnd(draft, 'report-finalized', at), at, 'PurposeBindingRefused');
      await refusePurpose(draft, purposeEnd(draft, 'release', at), at, 'PurposeBindingRefused');
      await refusePurpose(draft, purposeEnd(draft, 'intent-superseded', at), at, 'PurposeBindingRefused');
    }
    const draft = purposeRecord('later-addendum', 'private-draft', 'owner', '2030-01-01T00:00:00.000Z', ['d1'], {
      row: { draftBinding: { reportId: 'parent', intentId: 'addendum-2030', action: 'addendum' } } });
    await refusePurpose(draft, purposeEnd(draft, 'intent-superseded', at, { superseded: scenarios[0][1] }), '2030-01-02T00:00:00.000Z', 'PurposeBindingRefused');
    const late = '2030-01-02T00:00:00.000Z';
    await refusePurpose(draft, purposeEnd(draft, 'intent-superseded', late, { superseded: { ...scenarios[0][1], at: late } }), late, 'PurposeBindingRefused');
    assert.throws(() => purposeEnd(draft, 'intent-superseded', late, { superseded: { ...scenarios[2][1], at: late, amendUntil: late } }), { code: 'PurposeBindingRefused' });
    const valid = purposeEnd(draft, 'intent-superseded', late, { superseded: { ...scenarios[1][1], at: late } });
    intentRows.set(valid.superseded.eventId, { ...valid.superseded, versionId: 'wrong-version' });
    assert.throws(() => D.resolvePurposeEnd(endReader, valid.eventId), { code: 'PurposeBindingRefused' });
  });

  test('TEST-EMR-19-A R3-05/08 X3 X11: fixed duty clause authority and release reason reject free text', () => {
    const record = baseRecord(), good = holdFacts(record.recordId);
    assert.throws(() => holdRecord(record, { ...good, basis: { ...good.basis, clause: 'hospital-policy' } }), { code: 'HoldClauseRequired' });
    const statutory = { ...good, basis: { ...good.basis, type: 'statutory-duty', clauseId: 'privacy:36.2',
      clause: { law: 'privacy', article: '36.2', version: '21445' }, authorityKind: 'personal-information-controller', authorityId: 'hospital-a',
      validity: { ...good.basis.validity, condition: 'duty-active' } } };
    assert.equal(holdRecord(record, correctionRequest(statutory)).holds.length, 1);
    for (const patch of [{ clauseId: 'internal-rule' }, { clause: { law: 'hospital-policy', article: '36.2', version: '21445' } },
      { clause: { law: 'privacy', article: '36.2', version: 'unknown' } }])
      assert.throws(() => holdRecord(record, { ...statutory, basis: { ...statutory.basis, ...patch } }), { code: 'HoldClauseRequired' });
    for (const patch of [{ authorityKind: 'administrator' }, { authorityId: 'another-hospital' }])
      assert.throws(() => holdRecord(record, { ...statutory, basis: { ...statutory.basis, ...patch } }), { code: 'HoldAuthorityRefused' });
    const held = holdRecord(record);
    assert.throws(() => D.liftLegalHold(held, good.holdId, dutyReader(releaseFacts(good, deadline, { reason: 'keep-until-we-want' }))), { code: 'HoldReleaseReasonRefused' });
    assert.equal(D.liftLegalHold(held, good.holdId, dutyReader(releaseFacts(good, deadline))).holds[0].release.reason, 'order-ended');
  });

  test('TEST-EMR-19-A R3-05: request resolution bounds the hold even before its response deadline', async () => {
    const record = baseRecord(), from = '2031-10-04T00:00:00.000Z', until = '2031-10-14T00:00:00.000Z', at = '2031-10-06T00:00:00.000Z';
    const hold = pendingHold(record.recordId, from, until);
    assert.throws(() => holdRecord(record, { ...hold, basis: { ...hold.basis, validity: { ...hold.basis.validity, until: null } } }), { code: 'HoldValidityRefused' });
    assert.throws(() => holdRecord(record, { ...hold, basis: { ...hold.basis, validity: { ...hold.basis.validity, until: '2031-10-15T00:00:00.000Z' } } }), { code: 'HoldValidityRefused' });
    const held = holdRecord(record, hold);
    await refuseExpiry(disposal({ record: held, requestedAt: at }), 'LegalHoldActive');
    requestRows.get(hold.basis.requestId).resolution = { eventId: 'response-done', at, outcome: 'fulfilled' };
    await refuseExpiry(disposal({ record: held, requestedAt: at }), 'HoldReleaseRequired');
    assert.throws(() => D.liftLegalHold(held, hold.holdId, dutyReader(releaseFacts(hold, at, { reason: 'request-fulfilled' }))), { code: 'HoldReleaseBindingRefused' });
    const released = D.liftLegalHold(held, hold.holdId, dutyReader(releaseFacts(hold, at, { reason: 'request-fulfilled', evidenceId: 'response-done' })));
    assert.equal((await expire(durable, disposal({ record: released, requestedAt: at }), async r => destroyed(r))).phase, 'completed');
    await refuseExpiry(disposal({ record: holdRecord(record), requestedAt: '2045-01-01T00:00:00.000Z' }), 'LegalHoldActive');
  });

  test('TEST-EMR-01/19-A R3-06: received RIS order and StudyState correction bind their generating events', () => {
    const seed = stored('report-version', 'ris-order', 'o1', t0);
    const source = resolveRow({ recordId: 'ris-order', model: 'Order', row: { origin: 'received-ris', receiptEventId: seed.event.eventId,
      sourceSystem: 'verified-ris', sourceSignatureEvidence: 'unchanged-source-envelope' }, event: { ...seed.event, act: 'receipt', signature: null } });
    const order = D.newRetentionRecord(source);
    assert.equal(D.retentionDeadline(order), '2036-10-05T15:00:00.000Z'); assert.equal(order.parts[0].evidence.event.signature, null);
    const receivedAccess = access({ surface: 'GET bootstrap', targets: [{ ...access().targets[0], kind: 'received-order', recordId: known('ris-order'), versionId: known('o1') }] });
    assert(A.parseAccessEvent(receivedAccess, [source]));
    assert.equal(order.parts[0].evidence.row.sourceSignatureEvidence, 'unchanged-source-envelope');
    const authored = resolveRow({ recordId: 'ris-order', model: 'Order', row: { origin: 'product-authored' }, event: { ...seed.event, signature: null } });
    assert.throws(() => D.newRetentionRecord(authored), { code: 'NewLawfulRecordEventRequired' });
    assert(D.newRetentionRecord(resolveRow({ recordId: 'ris-order', model: 'Order', row: { origin: 'product-authored' }, event: seed.event })));
    assert.throws(() => resolveRow({ recordId: 'ris-order', model: 'Order', row: { ...source.row, receiptEventId: 'wrong-event' }, event: source.event }), { code: 'OrderReceiptRequired' });
    const metadata = modelSource('StudyState', { change: 'acquisition' }, 'acquisition', 'metadata');
    const unit = D.newRetentionRecord(metadata), at = '2030-01-01T00:00:00.000Z';
    const correctionSeed = stored('tech-note', 'metadata', 'corrected', at);
    const correction = resolveRow({ recordId: 'metadata', model: 'StudyState', row: { change: 'correction', sourceRecordId: 'metadata', orig: '원래 인적사항' },
      event: { ...correctionSeed.event, act: 'correction', predecessor: component(unit) } });
    const corrected = D.recordVersionAdded(unit, correction, snapshotFor(unit, at));
    assert.equal(D.retentionDeadline(corrected), '2035-01-01T15:00:00.000Z'); assert.deepEqual(corrected.parts[0], unit.parts[0]);
    assert.equal(corrected.parts[1].evidence.event.signature, null);
    assert.throws(() => D.newRetentionRecord(correction), { code: 'CorrectionSourceRequired' });
    assert.throws(() => D.statutoryClasses(['thumbnail']), { code: 'IndependentStatutoryClockRefused' });
  });

  test('TEST-EMR-01/07/19-A R3-07: unregistered readers and mixed-route target relabelling cannot choose a waiver', () => {
    const report = modelSource('Report', {}, 'entry', 'report-1');
    assert.throws(() => C.resolveStoredRecord({ load: () => ({ ...report, model: 'DicomInstance', row: { sopClass: 'image' } }) }, report.recordId, report.event.eventId), { code: 'StoredReaderRequired' });
    const record = D.newRetentionRecord(report), hold = holdFacts(record.recordId);
    assert.throws(() => D.placeLegalHold(record, { load: () => hold }, hold.holdId, snapshotFor(record, t0)), { code: 'VerifiedHoldBasisRequired' });
    assert.throws(() => D.resolvePurposeEnd({ load: () => ({}), loadSignedResult: () => ({}) }, 'end'), { code: 'PurposeReaderRequired' });
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand());
    assert.throws(() => L.resumeClinicalUse(f, archive, { actor: reader('reader-1'), at: deadline, basis: 'new-study-same-patient', studyId: 'new-study' }, {
      loadStudy: () => ({}), loadReportPatient: () => ({}) }), { code: 'ClinicalResumeBasisRefused' });
    const originalLoad = rawStoredReader.load; rawStoredReader.load = () => null;
    assert.deepEqual(C.resolveStoredRecord(storedReader, report.recordId, report.event.eventId).kinds, ['report-head']);
    rawStoredReader.load = originalLoad;
    assert(Object.isFrozen(storedReader));
    const waived = access({ surface: 'GET bootstrap', targets: [{ kind: 'preferences', ...Object.fromEntries(
      ['patientLinkSnapshot', 'studyId', 'recordId', 'versionId'].map(k => [k, { status: 'not-applicable', reason: 'non-record-target' }])) }] });
    assert.throws(() => A.parseAccessEvent(waived), { code: 'ServedRecordManifestRequired' });
    assert.throws(() => A.parseAccessEvent(waived, [report]), { code: 'AccessTargetBindingRefused' });
    assert.throws(() => A.parseAccessEvent(waived, [{ ...report, kinds: ['preferences'] }]), { code: 'StoredRecordRequired' });
    const preference = stored('preferences', 'settings', 's1', t0);
    assert(A.parseAccessEvent(waived, [preference]));
    const real = access({ surface: 'GET bootstrap', targets: [{ ...access().targets[0], kind: 'report-head', versionId: known(report.event.versionId) }] });
    assert.equal(A.parseAccessEvent(real, [report]).targets[0].kind, 'report-head');
    assert(A.accessRetention(A.parseAccessEvent(real, [report])));
    assert(A.parseAccessEvent({ ...waived, surface: 'GET reading-preferences' }));
  });

  test('TEST-EMR-12/19-A R3-08 X8: a concurrent purpose hold is detected before journal and deletion', async () => {
    const draft = purposeRecord('concurrent-draft', 'private-draft', 'owner', t0, ['d1']);
    const end = purposeEnd(draft), hold = holdFacts(draft.recordId);
    const held = placePurposeHold(draft, dutyReader(hold), hold.holdId);
    await refusePurpose(draft, end, deadline, 'PurposeSnapshotStale', { withPurposeLock: async (id, at, work) => work(held) });
    await refusePurpose(held, end, deadline, 'LegalHoldActive');
  });

  test('TEST-EMR-13/19-A R3-08 X10: preservation lifecycle checks signature authority originals and separation independently', () => {
    const f = finalized(), at = '2040-01-01T00:00:00.000Z', processing = processingFor(['order-1'], { separateManagement: true });
    for (const patch of [{ signature: null }, ...[{ authorized: false }, { preservesOriginals: false }, { separateManagement: false }].map(p => ({ processing: { ...processing, ...p } }))]) {
      const source = stored('report-version', 'report-1', 'v2', at, { event: { act: 'correction', processing, ...patch } });
      assert.throws(() => step(f, 'addendum', { at, version: { recordId: 'report-1', versionId: 'v2', sha256: source.event.sha256 }, preservationCorrection: source }), { code: 'HeldCorrectionAuthorityRequired' });
    }
    const source = stored('report-version', 'report-1', 'v2', at, { event: { act: 'correction', processing } });
    const outcome = step(f, 'addendum', { at, version: { recordId: 'report-1', versionId: 'v2', sha256: source.event.sha256 }, preservationCorrection: source });
    assert(!outcome.effects.includes('publish-immediately'));
    assert.equal(L.reportRetentionAccess(outcome.facts, L.archiveFinalizedReport(f, archiveCommand())).state, 'retention-only');
  });

  test('TEST-EMR-13/19-A R3-02: lawful preservation Addendum also survives expiry without restoring clinical access', () => {
    const report = makeRecord('report-1', ['report-version'], t0, 'v1'), held = holdRecord(report);
    const at = '2040-01-01T00:00:00.000Z', f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand());
    const source = stored('report-version', 'report-1', 'p2', at, { event: { act: 'additional-entry', predecessor: component(report),
      processing: processingFor(['order-1'], { separateManagement: true }) } });
    const command = { action: 'addendum', actor: reader('reader-1'), at, expectedClaimGeneration: f.claimGeneration,
      expectedPublishedVersionId: f.publishedVersion.versionId, version: { recordId: 'report-1', versionId: 'p2', sha256: source.event.sha256 }, preservationEntry: source };
    const output = L.transitionRetainedReport(f, command, held, source, snapshotFor(held, at), archive);
    assert.equal(output.retention.parts.length, 2); assert(!output.effects.includes('publish-immediately'));
    assert.equal(L.reportRetentionAccess(output.facts, archive).state, 'retention-only');
    assert.deepEqual(output.retention.parts[0], report.parts[0]);
    for (const patch of [{ authorized: false }, { preservesOriginals: false }, { separateManagement: false }]) {
      const bad = stored('report-version', 'report-1', 'p2', at, { event: { ...source.event, processing: { ...source.event.processing, ...patch } } });
      assert.throws(() => L.transitionRetainedReport(f, { ...command, preservationEntry: bad }, held, bad, snapshotFor(held, at), archive), { code: 'HeldEntryAuthorityRequired' });
    }
  });
  test('TEST-EMR-12/19-A R3-01: purpose holds attach before destruction and recheck completed destruction under lock', async () => {
    const draft = purposeRecord('purpose-not-destroyed', 'private-draft', 'owner', t0, ['d1']);
    const end = purposeEnd(draft), at = '2026-10-07T00:00:00.000Z', hold = holdFacts(draft.recordId, { at });
    let locked = false, persisted = 0;
    const held = await D.withPurposeChange({ withPurposeLock: async (id, time, work) => { locked = true; try { return await work(draft); } finally { locked = false; } } }, draft, at, async current => {
      assert(locked); persisted++; return placePurposeHold(current, dutyReader(hold), hold.holdId);
    });
    assert.equal(persisted, 1); assert.equal(locked, false);
    await refusePurpose(held, end, at, 'LegalHoldActive');
    const destroyed = { ...draft, destroyedAt: deadline };
    assert.throws(() => placePurposeHold(destroyed, dutyReader(hold), hold.holdId), { code: 'RecordDestroyed' });
    await refusePurpose(destroyed, end, at, 'RecordDestroyed');
    await assert.rejects(D.withPurposeChange({ withPurposeLock: async (id, time, work) => work(destroyed) }, draft, at, async () => { persisted++; }), { code: 'PurposeSnapshotStale' });
    assert.equal(persisted, 1);
  });

  // R4 maintains REQ-EMR-01/12/13/19 -> RISK-EMR-01/12/13/19 -> TEST-EMR-*-A.
  test('TEST-EMR-19-A R4-01: storage round-trip reloads active and released holds without moving clocks', async () => {
    const record = makeRecord('reload-record', ['image'], t0), at = '2035-01-01T00:00:00.000Z';
    const first = holdFacts(record.recordId), second = holdFacts(record.recordId, { holdId: 'order-2' });
    const held = holdRecord(holdRecord(record, first), second);
    const partlyReleased = D.liftLegalHold(held, second.holdId, dutyReader(releaseFacts(second, deadline)));
    const serialized = JSON.parse(JSON.stringify(partlyReleased));
    const reloaded = D.reloadRetentionRecord(serialized);
    assert.deepEqual(reloaded, partlyReleased);
    assert.equal(D.retentionDeadline(reloaded), D.retentionDeadline(record));
    await refuseExpiry(disposal({ record: reloaded, requestedAt: at }), 'LegalHoldActive');
    assert.throws(() => D.parseRetentionRecord({ ...reloaded, holds: [] }), { code: 'HoldSetIncomplete' });
    // Even an old, formerly complete capability must be compared with storage under the lock.
    await refuseExpiry(disposal({ record, requestedAt: at }), 'HoldSetIncomplete');
    assert.throws(() => addPart(record, 'missed-hold', deadline), { code: 'HoldSetIncomplete' });
    let changed = 0;
    const graph = snapshotFor(record, at);
    await assert.rejects(D.withRetentionChange({ withRetentionLock: async (id, time, fn) => fn(graph) }, record, graph, at,
      async () => { changed++; }), { code: 'HoldSetIncomplete' });
    assert.equal(changed, 0);
    incompleteHolds = true;
    assert.throws(() => D.reloadRetentionRecord(serialized), { code: 'HoldSetIncomplete' });
    assert.throws(() => makeRecord('unloaded', ['image'], t0), { code: 'HoldSetIncomplete' });
    incompleteHolds = false;
    const lifted = D.liftLegalHold(reloaded, first.holdId, dutyReader(releaseFacts(first, at)));
    const restored = D.reloadRetentionRecord(JSON.parse(JSON.stringify(lifted)));
    assert.equal((await expire(durable, disposal({ record: restored, requestedAt: at }), destroyed)).phase, 'completed');
  });
  test('TEST-EMR-12/19-A R4-01: purpose holds reload with release history and refuse omitted storage facts', async () => {
    const draft = purposeRecord('reload-draft', 'private-draft', 'owner', t0, ['d1']);
    const hold = holdFacts(draft.recordId), held = placePurposeHold(draft, dutyReader(hold), hold.holdId);
    const restored = D.reloadPurposeRecord(JSON.parse(JSON.stringify(held))), end = purposeEnd(draft);
    assert.deepEqual(restored, held);
    await refusePurpose(restored, end, deadline, 'LegalHoldActive');
    await refusePurpose(draft, end, deadline, 'HoldSetIncomplete');
    const released = D.liftPurposeLegalHold(restored, hold.holdId, dutyReader(releaseFacts(hold, deadline)));
    const loaded = D.reloadPurposeRecord(JSON.parse(JSON.stringify(released)));
    assert.deepEqual(loaded, released);
    assert.equal((await endPurpose(durable, loaded, end, deadline,
      async () => ({ completedAt: deadline, method: 'irreversible-permanent-deletion' }))).phase, 'completed');
  });
  test('TEST-EMR-19-A R4-02: either batch input order destroys incorporators then components at the shared deadline', async () => {
    for (const reversed of [false, true]) {
      const image = makeRecord('batch-image-' + reversed, ['image'], t0);
      const report = makeRecord('batch-report-' + reversed, ['report-version'], t0, 'v1', { event: { components: [component(image)] } });
      const cvr = makeRecord('batch-cvr-' + reversed, ['critical-result'], t0, 'c1', { event: { components: [component(report), component(image)] } });
      const at = D.retentionDeadline(cvr), remaining = new Map([image, report, cvr].map(r => [r.recordId, r])), deleted = [];
      const graph = () => snapshotFor(null, at, [...remaining.values()]);
      for (const r of [image, report]) await refuseExpiry(disposal({ record: r, graph: graph(), requestedAt: at }), 'IncorporatorStillPresent');
      const queue = reversed ? [cvr, report, image] : [image, report, cvr];
      while (queue.length) {
        const r = queue.shift();
        try {
          await expire(durable, disposal({ record: r, graph: graph(), requestedAt: at }), async request => {
            deleted.push(r.recordId);
            remaining.set(r.recordId, D.parseRetentionRecord({ ...r, destroyedAt: at }));
            return destroyed(request);
          });
        } catch (e) { assert.equal(e.code, 'IncorporatorStillPresent'); queue.push(r); }
        assert(queue.length + deleted.length === 3);
      }
      assert.deepEqual(deleted, [cvr.recordId, report.recordId, image.recordId]);
    }
  });
  test('TEST-EMR-13/19-A R4-02: missing own components and unrelated corrupt manifests cannot refuse a hold or Addendum', async () => {
    const image = makeRecord('gone-component', ['image'], t0);
    const report = makeRecord('defective-report', ['report-version'], t0, 'v1', { event: { components: [component(image)] } });
    const unrelated = makeRecord('unrelated-defect', ['report-version'], t0, 'u1', { event: { components: [component(image)] } });
    const at = '2027-01-01T00:00:00.000Z';
    for (const records of [[report], [report, { ...image, destroyedAt: deadline }, unrelated]]) {
      const graph = graphOf(records, [], at), h = holdFacts(report.recordId, { at });
      const held = holdRecord(report, h, graph);
      const heldGraph = { ...graph, records: records.map(r => r === report ? held : r) };
      assert.equal(addPart(held, 'a2', at, { event: { act: 'additional-entry', processing: processingFor([h.holdId]) } }, heldGraph).parts.length, 2);
      // Destruction of an incorporator itself does not depend on its already missing outgoing bytes.
      const released = D.liftLegalHold(held, h.holdId, dutyReader(releaseFacts(h, at)));
      const expiry = D.retentionDeadline(released);
      assert.equal((await expire(durable, disposal({ record: released, graph: graphOf([released]), requestedAt: expiry }), destroyed)).phase, 'completed');
    }
  });
  test('TEST-EMR-19-A R4-03: a held expired component needs a named independent basis and inherits only direct own periods', async () => {
    const image = makeRecord('held-source', ['image'], t0), hold = holdFacts(image.recordId);
    const held = holdRecord(image, hold), at = '2033-01-01T00:00:00.000Z';
    const make = processing => stored('report-version', 'lawful-incorporator', 'r1', at, { event: { components: [component(image)], processing } });
    for (const processing of [null, processingFor([hold.holdId]), processingFor([hold.holdId], { componentRecordIds: ['wrong-record'] }),
      processingFor([], { componentRecordIds: [image.recordId] }), processingFor([hold.holdId], { componentRecordIds: [image.recordId], authorized: false }),
      processingFor([hold.holdId], { componentRecordIds: [image.recordId], preservesOriginals: false })])
      assert.throws(() => D.newRetentionRecord(make(processing), snapshotFor(held, at)), { code: 'ComponentProcessingBasisRequired' });
    const source = make(processingFor([hold.holdId], { componentRecordIds: [image.recordId] }));
    const report = remember(D.newRetentionRecord(source, snapshotFor(held, at)));
    const releaseAt = '2034-01-01T00:00:00.000Z';
    const released = remember(D.liftLegalHold(held, hold.holdId, dutyReader(releaseFacts(hold, releaseAt))));
    assert.equal(D.retentionDeadline(released, snapshotFor(released, releaseAt, [report])), '2043-01-01T15:00:00.000Z');
    const textOnly = addPart(report, 'text-only', releaseAt);
    const later = makeRecord('later-cvr', ['critical-result'], '2035-01-01T00:00:00.000Z', 'c1', { event: {
      components: [{ recordId: report.recordId, partId: 'text-only', sha256: textOnly.parts[1].evidence.event.sha256 }] } });
    const graph = snapshotFor(released, later.parts[0].startedAt, [textOnly, later]);
    assert.equal(D.retentionDeadline(textOnly, graph), '2045-01-01T15:00:00.000Z');
    assert.equal(D.retentionDeadline(released, graph), '2044-01-01T15:00:00.000Z');
    const imageExpiry = D.retentionDeadline(released, graph);
    assert.equal((await expire(durable, disposal({ record: released, graph, requestedAt: imageExpiry }), destroyed)).phase, 'completed');
    const afterImage = { ...graph, records: graph.records.map(r => r.recordId === released.recordId ? { ...released, destroyedAt: imageExpiry } : r) };
    await refuseExpiry(disposal({ record: textOnly, graph: afterImage, requestedAt: imageExpiry }), 'RetentionNotElapsed');
  });
  test('TEST-EMR-13/19-A R4-04: ended unreleased holds report a release gap but do not block lawful additions or incorporation', async () => {
    for (const byResolution of [false, true]) {
      for (const [kind, act] of [['report-version', 'additional-entry'], ['image', 'acquisition']]) {
        const record = makeRecord('ended-' + kind + byResolution, [kind], t0);
        const at = '2027-01-05T00:00:00.000Z', h = pendingHold(record.recordId, t0, byResolution ? '2027-01-10T00:00:00.000Z' : deadline);
        const held = holdRecord(record, h);
        if (byResolution) requestRows.get(h.basis.requestId).resolution = { eventId: 'resolved', at: deadline, outcome: 'fulfilled' };
        const loaded = D.reloadRetentionRecord(JSON.parse(JSON.stringify(held)));
        const state = D.retentionState(loaded, snapshotFor(loaded, at), at);
        assert.equal(state.state, 'retained'); assert.deepEqual(state.releaseNotRecorded, [h.holdId]);
        assert.equal(state.destroyNotBefore, null);
        const added = addPart(loaded, 'a2', at, { event: { act } });
        assert.equal(added.parts.length, 2);
        const incorporator = stored('report-version', 'ended-consumer', 'r1', at, { event: { components: [component(loaded)] } });
        assert(D.newRetentionRecord(incorporator, snapshotFor(loaded, at)));
        await refuseExpiry(disposal({ record: loaded, requestedAt: '2045-01-01T00:00:00.000Z' }), 'HoldReleaseRequired');
      }
    }
  });
  test('TEST-EMR-13/19-A R4-05: a clinical Addendum ends archive without a false separation claim under an active hold', () => {
    const report = makeRecord('report-1', ['report-version'], t0, 'v1'), held = holdRecord(report);
    const f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand()), at = '2027-01-01T00:00:00.000Z';
    const source = stored('report-version', report.recordId, 'a2', at, { event: { act: 'additional-entry', predecessor: component(report), processing: processingFor(['order-1']) } });
    const cmd = command(f, 'addendum', { at, version: { recordId: report.recordId, versionId: 'a2', sha256: source.event.sha256 } });
    const outcome = L.transitionRetainedReport(f, cmd, held, source, snapshotFor(held, at), archive);
    assert(outcome.effects.includes('publish-immediately'));
    assert.deepEqual(L.reportRetentionAccess(outcome.facts, archive), { state: 'normal-retention', ordinaryClinicalAccess: true, separateStorage: false });
    assert.equal(source.event.processing.separateManagement, false);
    assert.throws(() => L.transitionRetainedReport(f, { ...cmd, preservationEntry: source }, held, source, snapshotFor(held, at), archive), { code: 'HeldEntryAuthorityRequired' });
  });
  test('TEST-EMR-19-A R4-06: correction duty requires a finite stored request and its matching resolution', async () => {
    const record = makeRecord('correction-duty', ['image'], t0), h = correctionRequest(holdFacts(record.recordId));
    h.basis = { ...h.basis, type: 'statutory-duty', clauseId: 'privacy:36.2', clause: { law: 'privacy', article: '36.2', version: '21445' },
      authorityId: 'hospital-a', authorityKind: 'personal-information-controller', validity: { ...h.basis.validity, condition: 'duty-active' } };
    assert.throws(() => holdRecord(record, { ...h, basis: { ...h.basis, validity: { ...h.basis.validity, until: null } } }), { code: 'HoldValidityRefused' });
    assert.throws(() => holdRecord(record, { ...h, basis: { ...h.basis, requestId: 'missing' } }), { code: 'CorrectionRequestBindingRefused' });
    assert.throws(() => holdRecord(record, { ...h, basis: { ...h.basis, validity: { ...h.basis.validity, until: '2026-10-16T00:00:00.000Z' } } }), { code: 'HoldValidityRefused' });
    const held = holdRecord(record, h), at = deadline;
    correctionRows.get(h.basis.requestId).resolution = { eventId: 'corrected', at, outcome: 'fulfilled' };
    assert.deepEqual(D.retentionState(held, undefined, at).releaseNotRecorded, [h.holdId]);
    await refuseExpiry(disposal({ record: held, requestedAt: at }), 'HoldReleaseRequired');
    assert.throws(() => D.liftLegalHold(held, h.holdId, dutyReader(releaseFacts(h, at, { reason: 'duty-ended' }))), { code: 'HoldReleaseBindingRefused' });
    const released = D.liftLegalHold(held, h.holdId, dutyReader(releaseFacts(h, at, { reason: 'duty-ended', evidenceId: 'corrected' })));
    assert.equal((await expire(durable, disposal({ record: released, requestedAt: D.retentionDeadline(released) }), destroyed)).phase, 'completed');
    assert.throws(() => holdRecord(record, { ...h, at }), { code: 'HoldReleaseRequired' });
  });
  test('TEST-EMR-19-A R4-07: stable clause keys select the registration version and old holds remain reloadable and liftable', () => {
    const record = makeRecord('versioned-hold', ['image'], t0);
    const old = pendingHold(record.recordId, t0, '2027-04-10T00:00:00.000Z'), held = holdRecord(record, old);
    const at = '2027-04-01T00:00:00.000Z', fresh = pendingHold(record.recordId, at, '2027-04-10T00:00:00.000Z');
    fresh.holdId = 'new-publication'; fresh.basis.requestId = 'new-request';
    requestRows.set('new-request', { requestId: 'new-request', recordIds: [record.recordId], receivedAt: at, responseDueAt: fresh.basis.validity.until, resolution: null });
    // Keep the old stored request independent of the newer registration.
    requestRows.set(old.basis.requestId, { requestId: old.basis.requestId, recordIds: [record.recordId], receivedAt: t0, responseDueAt: old.basis.validity.until, resolution: null });
    const both = holdRecord(held, fresh);
    assert.equal(both.holds[1].basis.clause.version, '21910');
    for (const version of ['21445', 'unknown']) assert.throws(() => holdRecord(held,
      { ...fresh, basis: { ...fresh.basis, clause: { ...fresh.basis.clause, version } } }), { code: 'HoldClauseRequired' });
    dutyReader(fresh);
    const reloaded = D.reloadRetentionRecord(JSON.parse(JSON.stringify(both)));
    requestRows.get(old.basis.requestId).resolution = { eventId: 'old-resolved', at, outcome: 'fulfilled' };
    const lifted = D.liftLegalHold(reloaded, old.holdId, dutyReader(releaseFacts(old, at, { reason: 'request-fulfilled', evidenceId: 'old-resolved' })));
    assert.equal(lifted.holds[0].basis.clause.version, '21445');
    assert.equal(D.retentionDeadline(lifted), D.retentionDeadline(record));
    const versions = B.HOLD_CLAUSE_VERSIONS['privacy:36.2'];
    assert.equal(B.clauseVersionAt(versions, '2027-03-08T14:59:59.999Z').publication, '21445');
    assert.equal(B.clauseVersionAt(versions, '2027-03-08T15:00:00.000Z').publication, '21910');
  });
  test('TEST-EMR-01/19-A R4-08 Y5b: received and system events refuse product person signatures', () => {
    const signed = stored('report-version', 'received-signed', 'r1', t0).event;
    const facts = { recordId: signed.recordId, model: 'Order', row: { origin: 'received-ris', receiptEventId: signed.eventId,
      sourceSystem: 'RIS', sourceSignatureEvidence: 'source-original-signature' }, event: { ...signed, act: 'receipt' } };
    assert.throws(() => D.newRetentionRecord(resolveRow(facts)), { code: 'ProductSignatureRefused' });
    const received = D.newRetentionRecord(resolveRow({ ...facts, event: { ...facts.event, signature: null } }));
    assert.equal(received.parts[0].evidence.row.sourceSignatureEvidence, 'source-original-signature');
    for (const [model, row, act] of [['DicomInstance', { sopClass: 'image' }, 'acquisition'], ['AuditLog', {}, 'access'], ['GatewayReceipt', {}, 'delivery']]) {
      const source = resolveRow({ recordId: signed.recordId, model, row, event: { ...signed, act } });
      assert.throws(() => model === 'DicomInstance' ? D.newRetentionRecord(source) : A.deliveryRetention(source), { code: 'ProductSignatureRefused' });
    }
    const clinical = resolveRow({ recordId: signed.recordId, model: 'Order', row: { origin: 'product-authored' }, event: signed });
    assert(D.newRetentionRecord(clinical));
    const humanNote = resolveRow({ recordId: signed.recordId, model: 'TechNoteRevision', row: { clinicalEntry: true }, event: signed });
    assert(D.newRetentionRecord(humanNote));
    const report = makeRecord('signature-pin', ['report-version'], t0);
    const cvr = makeRecord('signature-cvr', ['critical-result'], t0, 'c1', { event: { components: [component(report)] } });
    const pin = component(report), at = deadline, hash = digest('signed-ack');
    const ack = resolveRow({ recordId: cvr.recordId, model: 'CriticalResultEvent', row: { recordId: cvr.recordId, event: 'ack',
      acknowledgedVersion: pin, actorId: 'recipient', recipientId: 'recipient' }, event: {
      eventId: 'signed-ack', recordId: cvr.recordId, versionId: 'a1', sha256: hash, contentSha256: hash, at, act: 'handoff-ack',
      signature: { versionId: 'a1', sha256: hash, signedAt: at, verified: true }, predecessor: component(cvr), components: [pin], processing: null } });
    assert.throws(() => D.recordVersionAdded(cvr, ack, snapshotFor(cvr, at)), { code: 'ProductSignatureRefused' });
  });
  test('TEST-EMR-01/19-A R4-09: only one server composition can mint readers', () => {
    assert.throws(() => M.composeEmrAdapters(adapters), { code: 'EmrAdaptersAlreadyComposed' });
    assert.equal(M.emrAdapters(), capabilities);
    for (const module of [C, D, L, M]) assert.equal(Object.keys(module).some(k => k.startsWith('bind')), false);
    assert.throws(() => C.resolveStoredRecord({ ...storedReader }, 'row', 'event'), { code: 'StoredReaderRequired' });
  });
  test('TEST-EMR-01/19-A R4-09: modules load independently before server composition', () => {
    const script = `const fs = require('node:fs'), ts = require('./api/node_modules/typescript');
      require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'),
        { compilerOptions: ${JSON.stringify(parsed.options)}, fileName: file }).outputText, file);
      for (const name of ['classification', 'lawful-defaults', 'access-event', 'report-lifecycle', 'composition'])
        require('./api/src/emr-contract/' + name + '.ts');`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
  test('TEST-EMR-01/19-A R4-09: TypeScript symbols restrict adapter composition calls to the server composition module', () => {
    const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
    const resolve = symbol => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const file = program.getSourceFiles().find(f => f.fileName.replaceAll('\\', '/').endsWith('/emr-contract/composition.ts'));
    const compose = checker.getExportsOfModule(checker.getSymbolAtLocation(file)).find(s => s.name === 'composeEmrAdapters');
    assert(compose);
    for (const source of program.getSourceFiles().filter(f => parsed.fileNames.includes(f.fileName))) {
      const visit = node => {
        if (ts.isCallExpression(node) && resolve(checker.getSymbolAtLocation(node.expression)) === compose) assert.equal(source, file);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });
  test('TEST-EMR-13/19-A R4-11 Y2c: full processing claims cannot publish a clinical Addendum after expiry under a hold', () => {
    const report = makeRecord('report-1', ['report-version'], t0, 'v1'), held = holdRecord(report);
    const at = '2040-01-01T00:00:00.000Z', f = finalized(), archive = L.archiveFinalizedReport(f, archiveCommand());
    const source = stored('report-version', report.recordId, 'a2', at, { event: { act: 'additional-entry', predecessor: component(report),
      processing: processingFor(['order-1'], { separateManagement: true }) } });
    const before = clone(f), cmd = command(f, 'addendum', { at, version: { recordId: report.recordId, versionId: 'a2', sha256: source.event.sha256 } });
    assert.throws(() => L.transitionRetainedReport(f, cmd, held, source, snapshotFor(held, at), archive), { code: 'HeldCorrectionAuthorityRequired' });
    assert.deepEqual(f, before);
    assert.equal(f.publishedVersion.versionId, 'v1');
    const preserved = L.transitionRetainedReport(f, { ...cmd, preservationEntry: source }, held, source, snapshotFor(held, at), archive);
    assert(!preserved.effects.includes('publish-immediately'));
    assert.equal(L.reportRetentionAccess(preserved.facts, archive).ordinaryClinicalAccess, false);
  });
  test('TEST-EMR-12/19-A D593: parent cancellation ends an Addendum draft, parent approval and amend window never do', async () => {
    const draft = purposeRecord('addendum-d593', 'private-draft', 'owner', t0, ['d1'], {
      row: { draftBinding: { reportId: 'parent', intentId: 'addendum-purpose', action: 'addendum' } } });
    for (const fact of [{ eventId: 'parent-approved', reportId: 'parent', at: deadline, action: 'approve', authorId: 'other', draftId: 'other-draft', versionId: 'v1' },
      { eventId: 'window-end', reportId: 'parent', at: deadline, action: 'amend-window-closed', firstApprovedAt: t0, amendUntil: deadline }])
      await refusePurpose(draft, purposeEnd(draft, 'intent-superseded', deadline, { superseded: fact }), deadline, 'PurposeBindingRefused');
    const cancel = { eventId: 'parent-cancelled', reportId: 'parent', at: deadline, action: 'cancel', versionId: 'v2', reason: '검사 연결 정정' };
    const result = await endPurpose(durable, draft, purposeEnd(draft, 'intent-superseded', deadline, { superseded: cancel }), deadline,
      async () => ({ completedAt: deadline, method: 'irreversible-permanent-deletion' }));
    assert.equal(result.phase, 'completed');
  });
}
