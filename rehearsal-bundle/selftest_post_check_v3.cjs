/* Pure synthetic tests for stage2_post_reflection_check_v3, covering the T1-T4 nits the
   independent review reproduced (Q10a health, Q10b unauthenticated, Q10c doctored preflight,
   Q10d/Q10e mutated counts, C8 before-phase selector, argv UID) plus the earlier P2/P7c
   regressions. Mocked fetch and literal payloads only: no network, server, database,
   container, browser or credential.
   Run: node selftest_post_check_v3.cjs */
'use strict';

const { createHash } = require('node:crypto');
const { chmodSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const check = require('./stage2_post_reflection_check_v3.cjs');

const failures = [];
function assert(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition || !detail ? '' : ' :: ' + detail));
  if (!condition) failures.push(name);
}
function throws(name, code, run) {
  try { run(); assert(name, false, 'no throw'); } catch (error) { assert(name, error.safeCode === code, String(error.safeCode)); }
}

const STUDY = '1.2.826.0.1.3680043.8.498.11111111111111111111111111111111';
const A = 'worklist-v0/hpacs-lite/viewer-findings.js';

/* T2 residual: the set digest is now RECOMPUTED from the per-asset digests, so a fixture can no
   longer pair the pinned strings with invented entries. The load path is therefore tested against
   the real preflight report (read-only, produced by the previous job), and synthetic consistent
   fixtures are used only where PINNED is temporarily overridden and restored. */
const REAL_PREFLIGHT_PATH = require('node:path').join(__dirname, 'preflight-report-for-tests.json');
const clone = value => JSON.parse(JSON.stringify(value));
const PREFLIGHT = JSON.parse(require('node:fs').readFileSync(REAL_PREFLIGHT_PATH, 'utf8'));

function setDigestOf(map) {
  return createHash('sha256').update(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, digest]) => path + ' ' + digest).join('\n'), 'utf8').digest('hex');
}

/** A consistent synthetic preflight plus the PINNED override it requires, for the mocked run. */
function consistentFixture(baselineMap, targetMap) {
  const fixture = {
    identity: { target_sha: check.TARGET_SHA, baseline_deployed_sha: check.BASELINE_SHA },
    baseline_findings_files: [], target_findings_files: ['api/src/finding.service.ts'],
    static_assets: {
      baseline_digests: baselineMap, target_digests: targetMap,
      baseline_set_digest: setDigestOf(baselineMap), target_set_digest: setDigestOf(targetMap),
    },
  };
  const saved = clone(check.PINNED);
  check.PINNED.before.setDigest = fixture.static_assets.baseline_set_digest;
  check.PINNED.after.setDigest = fixture.static_assets.target_set_digest;
  check.PINNED.before.served = Object.keys(baselineMap).filter(p => check.servedUrl(p)).length;
  check.PINNED.after.served = Object.keys(targetMap).filter(p => check.servedUrl(p)).length;
  const restore = () => {
    check.PINNED.before = saved.before;
    check.PINNED.after = saved.after;
  };
  return { fixture, restore };
}

/* ---------------------------------------------------------------- T2: pinned phase anchors */
function testPinnedAnchors() {
  const before = check.pinsForPhase(PREFLIGHT, 'before');
  const after = check.pinsForPhase(PREFLIGHT, 'after');
  assert('before pins 104 served assets and the baseline digest',
    Object.keys(before.served).length === 104 && before.setDigest === check.PINNED.before.setDigest);
  assert('after pins 108 served assets and the target digest',
    Object.keys(after.served).length === 108 && after.setDigest === check.PINNED.after.setDigest);
  assert('config/ohif.js is source-only in both phases',
    Object.keys(before.sourceOnly).join() === 'config/ohif.js' && !('config/ohif.js' in after.served));

  // Q10c: a doctored preflight inventing its own set digests must not be usable at all.
  const doctored = clone(PREFLIGHT);
  doctored.static_assets.target_set_digest = 'f'.repeat(64);
  throws('T2 an invented set digest is refused', 'PHASE_SET_DIGEST_INCONSISTENT',
    () => check.pinsForPhase(doctored, 'after'));

  // D1/D2 residual: pinned strings kept, every per-asset digest invented. Must not load.
  const forged = clone(PREFLIGHT);
  for (const path of Object.keys(forged.static_assets.target_digests)) {
    forged.static_assets.target_digests[path] = createHash('sha256').update('forged' + path).digest('hex');
  }
  throws('T2 a forged per-asset digest set with the pinned string is refused', 'PHASE_SET_DIGEST_INCONSISTENT',
    () => check.pinsForPhase(forged, 'after'));
  const oneChanged = clone(PREFLIGHT);
  const firstKey = Object.keys(oneChanged.static_assets.target_digests)[0];
  oneChanged.static_assets.target_digests[firstKey] = 'a'.repeat(64);
  throws('T2 even a single altered asset digest is refused', 'PHASE_SET_DIGEST_INCONSISTENT',
    () => check.pinsForPhase(oneChanged, 'after'));

  const short = clone(PREFLIGHT);
  delete short.static_assets.target_digests[firstKey];
  throws('T2 a short served set is refused', 'PHASE_SET_DIGEST_INCONSISTENT',
    () => check.pinsForPhase(short, 'after'));
  const wrongTarget = clone(PREFLIGHT);
  wrongTarget.identity = { target_sha: '0'.repeat(40), baseline_deployed_sha: check.BASELINE_SHA };
  throws('a preflight for another target is refused', 'PREFLIGHT_IDENTITY_MISMATCH',
    () => check.pinsForPhase(wrongTarget, 'after'));
}

/* ---------------------------------------------------------------- T3/T4: handshake selector */
function testSelector() {
  const dir = mkdtempSync(join(tmpdir(), 'stage2-sel-'));
  const good = join(dir, 'selector.json');
  writeFileSync(good, JSON.stringify({ studyUid: STUDY, synthetic: true, expectedFindings: 0 }));
  try { chmodSync(good, 0o600); } catch (_) { /* windows */ }
  assert('T4 a 0600 synthetic selector yields the study', check.loadHandshakeSelector(good) === STUDY);

  const clinical = join(dir, 'clinical.json');
  writeFileSync(clinical, JSON.stringify({ studyUid: STUDY, synthetic: false, expectedFindings: 0 }));
  throws('T4 a non-synthetic study is refused', 'SELECTOR_NOT_SYNTHETIC', () => check.loadHandshakeSelector(clinical));
  const populated = join(dir, 'populated.json');
  writeFileSync(populated, JSON.stringify({ studyUid: STUDY, synthetic: true, expectedFindings: 3 }));
  throws('T4 a study expected to hold findings is refused', 'SELECTOR_NOT_EMPTY_STUDY',
    () => check.loadHandshakeSelector(populated));
  const extra = join(dir, 'extra.json');
  writeFileSync(extra, JSON.stringify({ studyUid: STUDY, synthetic: true, expectedFindings: 0, note: 'x' }));
  throws('T4 an unexpected selector key is refused', 'SELECTOR_SHAPE', () => check.loadHandshakeSelector(extra));
  const badUid = join(dir, 'bad.json');
  writeFileSync(badUid, JSON.stringify({ studyUid: '../etc/passwd', synthetic: true, expectedFindings: 0 }));
  throws('T4 a non-UID selector is refused', 'SELECTOR_UID', () => check.loadHandshakeSelector(badUid));

  // T3: the before phase refuses a selector, and no phase accepts a UID on argv.
  const source = require('node:fs').readFileSync(require.resolve('./stage2_post_reflection_check_v3.cjs'), 'utf8');
  assert('T3 argv handshake-study is refused outright', source.includes('HANDSHAKE_STUDY_ON_ARGV_NOT_ACCEPTED'));
  assert('T3 a before-phase selector is refused', source.includes("phase === 'before' && args.has('handshake-selector')"));
  const pins = check.pinsForPhase(PREFLIGHT, 'before');
  throws('T3 a before-phase plan with a study is refused', 'BEFORE_PHASE_CREDENTIALED',
    () => check.planRequests('before', pins.served, STUDY));
}

/* ---------------------------------------------------------------- phases */
function testPhases() {
  const before = check.planRequests('before', check.pinsForPhase(PREFLIGHT, 'before').served, null);
  assert('before phase makes zero credentialed requests', before.filter(i => i.credential).length === 0);
  assert('before phase asks for no findings route', !before.some(i => i.path.includes('/findings')));
  const after = check.planRequests('after', check.pinsForPhase(PREFLIGHT, 'after').served, STUDY);
  assert('after phase makes exactly one credentialed request', after.filter(i => i.credential).length === 1);
  assert('every request in both phases is GET',
    before.every(i => i.method === 'GET') && after.every(i => i.method === 'GET'));
  const absence = check.baselineAbsence(PREFLIGHT);
  assert('baseline findings absence comes from the fixed source, not a 404',
    absence.findings_api_absent_at_baseline === true && absence.native_proof === false);
  assert('after handshake needs 200 plus schema 2',
    check.handshakeVerdict('after', 200, '2').ok && !check.handshakeVerdict('after', 404, null).ok
    && !check.handshakeVerdict('after', 200, '1').ok);
  assert('the handshake never reads a body', check.handshakeVerdict('after', 200, '2').body_read === false);
}

/* ---------------------------------------------------------------- T1/T2 in compare */
function report(phase, over) {
  const pin = check.PINNED[phase];
  return Object.assign({
    schema: 2, tool: 'stage2_post_reflection_check_v3', phase, target_sha: check.TARGET_SHA,
    baseline_sha: check.BASELINE_SHA, expected_set_digest: pin.setDigest,
    credentialed_requests: pin.credentialed,
    health: { status: 200, ok: true, auth: true },
    unauthenticated: { status: 401, refused: true },
    assets: { served_matches_phase: true, mismatched: [], absent: [], checked: pin.served },
    handshake: phase === 'before' ? { performed: false, ok: true }
                                  : { performed: true, ok: true, body_read: false, status: 200, header: '2' },
    findings_source_statement: { findings_api_absent_at_baseline: true, native_proof: false },
  }, over);
}

function testCompare() {
  const ok = check.compareReports(report('before'), report('after'));
  assert('an honest before/after pair is CONSISTENT', ok.verdict === 'CONSISTENT', JSON.stringify(ok.problems));

  // Q10a / Q10b: health and unauthenticated are now decisive in both phases.
  const sick = check.compareReports(report('before'), report('after', { health: { status: 503, ok: false } }));
  assert('T1 a 503 health answer is refused', sick.problems.includes('AFTER_HEALTH_NOT_OK'));
  const open = check.compareReports(report('before', { unauthenticated: { status: 200, refused: false } }), report('after'));
  assert('T1 an /api/me answering without a credential is refused',
    open.problems.includes('BEFORE_UNAUTHENTICATED_NOT_REFUSED'));

  // Q10d / Q10e: mutated counts and digests.
  const wrongDigest = check.compareReports(report('before'), report('after', { expected_set_digest: 'a'.repeat(64) }));
  assert('T2 an unpinned set digest is refused', wrongDigest.problems.includes('AFTER_SET_DIGEST_NOT_PINNED'));
  const wrongCount = check.compareReports(report('before'), report('after', { assets: { served_matches_phase: true, mismatched: [], absent: [], checked: 7 } }));
  assert('T2 a mutated asset count is refused', wrongCount.problems.includes('AFTER_ASSET_COUNT_NOT_PINNED'));
  const wrongCred = check.compareReports(report('before', { credentialed_requests: 1 }), report('after'));
  assert('T2 a credentialed before phase is refused', wrongCred.problems.includes('BEFORE_CREDENTIALED_COUNT_WRONG'));
  const noCred = check.compareReports(report('before'), report('after', { credentialed_requests: 0 }));
  assert('T2 an after phase with no handshake credential is refused',
    noCred.problems.includes('AFTER_CREDENTIALED_COUNT_WRONG'));

  // P7c and the other structural refusals.
  const p7c = check.compareReports(report('after'), report('after'));
  assert('AFTER versus AFTER is refused', p7c.verdict === 'HOLD' && p7c.problems.includes('SAME_PHASE_TWICE'));
  assert('BEFORE versus BEFORE is refused', check.compareReports(report('before'), report('before')).verdict === 'HOLD');
  assert('a swapped pair is refused', check.compareReports(report('after'), report('before')).verdict === 'HOLD');
  assert('a target_sha mismatch is refused',
    check.compareReports(report('before'), report('after', { target_sha: '0'.repeat(40) })).problems.includes('AFTER_TARGET_SHA_MISMATCH'));
  assert('an incomplete report is refused',
    check.compareReports({ phase: 'before' }, report('after')).problems.includes('BEFORE_REPORT_INCOMPLETE'));
  const missingKey = report('before');
  delete missingKey.credentialed_requests;
  assert('a report missing credentialed_requests is incomplete',
    check.compareReports(missingKey, report('after')).problems.includes('BEFORE_REPORT_INCOMPLETE'));
  assert('a stale after asset set is refused',
    check.compareReports(report('before'), report('after', { assets: { served_matches_phase: false, mismatched: [A], absent: [], checked: check.PINNED.after.served } })).problems.includes('AFTER_ASSETS_NOT_TARGET'));
  assert('a read handshake body is refused',
    check.compareReports(report('before'), report('after', { handshake: { performed: true, ok: true, body_read: true } })).problems.includes('AFTER_BODY_WAS_READ'));
  assert('a before phase that called findings is refused',
    check.compareReports(report('before', { handshake: { performed: true, ok: true } }), report('after')).problems.includes('BEFORE_MADE_A_FINDINGS_CALL'));
  assert('no finding row is compared', ok.note.includes('vacuous'));
}

/* ---------------------------------------------------------------- mocked run */
async function testRun() {
  const oldBody = Buffer.from('// old\n'), newBody = Buffer.from('// new\n');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const baselineMap = { [A]: sha(oldBody), 'worklist-v0/hpacs-lite/viewer-jobs.js': sha(oldBody),
                        'config/ohif.js': sha(Buffer.from('old ohif')) };
  const targetMap = { [A]: sha(newBody), 'worklist-v0/hpacs-lite/viewer-jobs.js': sha(newBody),
                      'config/ohif.js': sha(Buffer.from('new ohif')) };
  const { fixture: pre, restore } = consistentFixture(baselineMap, targetMap);
  let served = 'baseline';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers });
    if (url.endsWith('/api/health')) return { status: 200, json: async () => ({ ok: true, auth: true }) };
    if (url.endsWith('/api/me')) return { status: 401, json: async () => ({}) };
    if (url.includes('/findings')) {
      return { status: 200, headers: { get: n => (n === 'x-kin-finding-schema' ? '2' : null) },
               json: async () => { throw new Error('the checker must never read this body'); } };
    }
    return { status: 200, arrayBuffer: async () => (served === 'baseline' ? oldBody : newBody) };
  };

  const before = await check.run({ phase: 'before', pins: check.pinsForPhase(pre, 'before'),
    handshakeStudy: null, session: null, absence: check.baselineAbsence(pre) }, fetchImpl);
  assert('P2 the before phase completes at the corrected baseline with 0 credentialed calls',
    before.credentialed_requests === 0 && before.assets.served_matches_phase === true);
  assert('P2 it never touches /findings', !calls.some(i => i.url.includes('/findings')));

  served = 'target';
  calls.length = 0;
  const after = await check.run({ phase: 'after', pins: check.pinsForPhase(pre, 'after'),
    handshakeStudy: STUDY, session: { header: 'Authorization', value: 'Bearer REDACTED-PLACEHOLDER' },
    absence: check.baselineAbsence(pre) }, fetchImpl);
  assert('the after phase matches the target bytes and the handshake',
    after.assets.served_matches_phase === true && after.handshake.ok === true);
  assert('exactly one credentialed call, on the findings route',
    calls.filter(i => i.headers.Authorization).length === 1
    && calls.filter(i => i.headers.Authorization).every(i => i.url.includes('/findings')));
  assert('every call is GET on the pinned origin',
    calls.every(i => i.method === 'GET' && i.url.startsWith(check.ORIGIN)));
  assert('config/ohif.js is declared source-verified by the runner, not over HTTP',
    after.assets.source_only.length === 1 && after.assets.source_only[0].verified_via.includes('not byte-served'));
  const serialized = JSON.stringify(after) + JSON.stringify(before);
  for (const secret of ['REDACTED-PLACEHOLDER', STUDY, 'Bearer']) {
    assert('output never leaks ' + secret.slice(0, 18), !serialized.includes(secret));
  }
  assert('the mocked pair compares CONSISTENT', check.compareReports(before, after).verdict === 'CONSISTENT',
    JSON.stringify(check.compareReports(before, after).problems));

  served = 'baseline';
  const stale = await check.run({ phase: 'after', pins: check.pinsForPhase(pre, 'after'),
    handshakeStudy: STUDY, session: { header: 'Authorization', value: 'Bearer REDACTED-PLACEHOLDER' },
    absence: check.baselineAbsence(pre) }, fetchImpl);
  assert('an after phase still serving the baseline bytes fails',
    stale.assets.served_matches_phase === false
    && check.compareReports(before, stale).problems.includes('AFTER_ASSETS_NOT_TARGET'));
  restore();
  assert('the rollout pins are restored after the fixture override',
    check.PINNED.after.setDigest === 'e3f82481108fd52710c8b8719f54fb6226a270d1823e1244789cc7cd47933496'
    && check.PINNED.after.served === 108);
}

async function main() {
  testPinnedAnchors();
  testSelector();
  testPhases();
  testCompare();
  await testRun();
  console.log('FAILURES=' + failures.length + (failures.length ? ' ' + failures.join(',') : ''));
  process.exit(failures.length ? 1 : 0);
}

main();
