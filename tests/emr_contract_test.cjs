/* REQ-EMR-01/04/05/06/07/12/13/17/19/20 -> corresponding RISK-EMR IDs -> TEST-EMR-*-A below.
 * Signature byte equality is itself the interoperability contract (AGENTS 1-B.14).
 * Inventory uses Prisma's installed parser through its generator protocol and TypeScript AST,
 * never a handwritten schema/TS parser or a stale generated client's model list. Synthetic data only.
 */
const fs = require('node:fs');
const path = require('node:path');

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
  const { test } = require('node:test');
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

  function modelInventory() {
    const parent = path.join(root, 'tmp/emr-a'); fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, 'schema-inventory-'));
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
      assert.equal(defaults[kind].retentionYears, 5);
      assert(C.RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.some(m => m.basis === '의료법 시행규칙 제15조①6' && m.years === 5));
    }
    assert.equal(defaults['access-audit'].retentionYears, 2);
    for (const kind of ['private-draft', 'tech-note', 'clinical-question', 'clinical-answer', 'consultation', 'critical-result',
      'critical-result-ack', 'finding', 'comparison-description', 'study-correction', 'patient-match']) {
      assert.equal(defaults[kind].retentionYears, 10);
      assert(C.RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.some(m => m.basis === '의료법 시행규칙 제15조①2' && m.years === 10));
    }
    for (const [kind, row] of Object.entries(C.RECORD_CLASSIFICATION)) {
      for (const minimum of row.retention.statutoryMinimum) assert(defaults[kind].retentionYears >= minimum.years, kind);
      assert.equal(defaults[kind].accessYears, Math.max(2, defaults[kind].retentionYears));
      assert.equal(row.preserveEarlierVersions, true); assert.equal(row.accessLogged, true); assert.equal(row.automaticDestruction, false);
      assert(Object.isFrozen(defaults[kind]));
    }
    assert.equal(D.PRODUCT_DEFAULTS.automaticDestruction, false);
    assert.equal(B.STATUTORY_MINIMUM.access.basis, '개인정보의 안전성 확보조치 기준 제8조①2');
    assert.equal(B.STATUTORY_MINIMUM.access.years, 2);
  });
  test('TEST-EMR-01/17-A: clinical candidates, operational placement and signature duties remain distinct', () => {
    for (const kind of ['report-version', 'private-draft', 'tech-note', 'clinical-question', 'clinical-answer', 'consultation',
      'critical-result', 'critical-result-ack', 'finding', 'measurement', 'key-image', 'manual-sr', 'external-sr-seg',
      'comparison-description', 'study-correction', 'patient-match']) assert.equal(C.RECORD_CLASSIFICATION[kind].clinicalAdoption, 'emr-candidate');
    for (const kind of ['assignment', 'comparison-layout', 'preferences']) assert.equal(C.RECORD_CLASSIFICATION[kind].clinicalAdoption, 'operational-record');
    for (const kind of ['report-head', 'report-version', 'clinical-question', 'clinical-answer', 'consultation', 'critical-result', 'finding', 'manual-sr', 'comparison-description']) {
      assert.equal(D.signatureRequired(kind), true);
      assert.equal(C.RECORD_CLASSIFICATION[kind].signature.basis, '의료법 제22조①·제23조①');
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
  test('TEST-EMR-17/19-A: tightening is accepted, propagates to evidence, and cannot subsequently be loosened', () => {
    const settings = D.tightenConfiguration({ image: { retentionYears: 8 }, 'private-draft': { retentionYears: 12, accessYears: 15, requireSignature: true } });
    assert.deepEqual(settings.image, { retentionYears: 8, accessYears: 8, requireSignature: false });
    assert.deepEqual(D.retentionFor(['image', 'private-draft'], settings), { retentionYears: 12, accessYears: 15, requireSignature: true });
    assert.equal(D.retentionFor(['image', 'clinical-answer']).retentionYears, 10);
    assert.deepEqual(D.tightenConfiguration({}, settings), settings); complete(settings);
    for (const patch of [{ image: { retentionYears: 7 } }, { 'private-draft': { accessYears: 14 } }, { 'private-draft': { requireSignature: false } }])
      assert.throws(() => D.tightenConfiguration(patch, settings));
    assert.equal(D.DEFAULT_CONFIGURATION.image.retentionYears, 5, 'Tightening never mutates defaults');
    assert.throws(() => D.retentionFor([])); assert.throws(() => D.retentionFor(['toString']));
  });
  function disposal(overrides = {}) {
    return { recordId: 'synthetic-record', versionIds: ['v1', 'v2'], kinds: ['report-version'], lastVersionOrClinicalUseAt: t0,
      lastAccessAt: t0, linkedRetainUntil: [], requestedAt: '2031-10-05T00:00:00.000Z', actorId: 'records-operator',
      reason: '보존기간 경과 및 보유 목적 종료 확인', legalBasisReference: 'synthetic-reviewed-disposal-basis', holdActive: false, ...overrides };
  }
  test('TEST-EMR-19-A: destruction requires expiry, explicit reason, hold clearance and durable logging', async () => {
    let destroyed = 0; const order = [];
    const store = { append: async e => { order.push('durable'); return { eventId: e.eventId, durableAt: e.request.requestedAt }; } };
    const destroy = async e => { complete(e); order.push('destroy'); destroyed++; };
    for (const patch of [{ requestedAt: '2031-10-04T23:59:59.999Z' }, { holdActive: true }, { holdActive: undefined },
      { reason: '' }, { actorId: '' }, { legalBasisReference: '' }, { versionIds: [] }, { lastAccessAt: '2030-01-01T00:00:00.000Z' },
      { linkedRetainUntil: ['2032-01-01T00:00:00.000Z'] }, { kinds: ['report-version', 'clinical-context'] }])
      await assert.rejects(D.destroyAfterDurableEvent(store, disposal(patch), 'disposal-1', destroy));
    await assert.rejects(D.destroyAfterDurableEvent({ append: async () => { throw Error('audit unavailable'); } }, disposal(), 'disposal-1', destroy));
    await assert.rejects(D.destroyAfterDurableEvent({ append: async () => ({ eventId: 'wrong', durableAt: t0 }) }, disposal(), 'disposal-1', destroy));
    assert.equal(destroyed, 0);
    await D.destroyAfterDurableEvent(store, disposal(), 'disposal-1', destroy);
    assert.equal(destroyed, 1); assert.deepEqual(order, ['durable', 'destroy']);
  });
  test('TEST-EMR-19-A: leap day and tightened periods never allow early disposal', async () => {
    const store = { append: async e => ({ eventId: e.eventId, durableAt: e.request.requestedAt }) };
    const request = disposal({ lastVersionOrClinicalUseAt: '2024-02-29T00:00:00.000Z', lastAccessAt: '2024-02-29T00:00:00.000Z', requestedAt: '2029-02-28T23:59:59.999Z' });
    await assert.rejects(D.destroyAfterDurableEvent(store, request, 'leap', async () => assert.fail('early deletion')));
    await D.destroyAfterDurableEvent(store, { ...request, requestedAt: '2029-03-01T00:00:00.000Z' }, 'leap', async e => assert.equal(e.retainUntil, '2029-03-01T00:00:00.000Z'));
    await assert.rejects(D.destroyAfterDurableEvent(store, disposal(), 'tightened', async () => assert.fail('shortened deletion'),
      D.tightenConfiguration({ 'report-version': { retentionYears: 6 } })));
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
    return { formatVersion: 1, eventId: 'event-1', userId: known(identity('reader-1')), rolesAtTime: known(['radiologist']),
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
  test('TEST-EMR-07-A: all requested action/cause categories remain distinct', () => {
    const expected = {
      write: ['write', 'additional-entry', 'modify', 'approve-sign', 'amend', 'addendum', 'cancel', 'release', 'draft-save', 'clear', 'discard'],
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
  function inProgress() { return step(L.newReportFacts('report-1'), 'start').facts; }
  function approved() { return step(inProgress(), 'approve', { version: ref('v1') }).facts; }
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
    assert.throws(() => L.validateReportFacts({ ...L.newReportFacts('report-1'), state: 'Approved' }));
    assert.throws(() => step(approved(), 'amend', { version: { ...ref('v2'), recordId: 'other-report' } }));
    assert.throws(() => L.validateReportFacts({ ...approved(), lastEditedAt: t0 }));
  });
}
