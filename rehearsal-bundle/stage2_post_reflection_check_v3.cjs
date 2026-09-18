/* Stage-2 option-B PRE/POST reflection check, v3. GET-only, read-only, dry-run by default.
   Prepared for Astra; never executed against a server by its author.

   v3 applies the independent review's tool nits before any operational use:
     T1 --compare now requires a healthy /api/health and a refused unauthenticated /api/me in
        BOTH phases, and execute mode exits non-zero on any of its own failures instead of
        always exiting 0;
     T2 the phase set digests, served asset counts and 0/1 credential budgets are constants of
        this rollout (PINNED). A doctored preflight inventing its own digests cannot pass;
     T3 a handshake study on argv is refused outright and the before phase refuses a selector;
     T4 the after-phase target is a designated SYNTHETIC study with no findings, read from a
        0600 selector file, never a clinical UID typed on the command line.

   It supersedes stage2-transition-fix-opus-02/stage2_post_reflection_check_v2.cjs, which
   itself corrected the original (B2). The baseline 17980d5 contains ZERO findings code, so the
   pre-v2 before phase could only 404 and abort. Retained corrections:
     - the BEFORE phase makes zero credentialed findings calls and documents the baseline's
       absence of findings from the FIXED SOURCE (the preflight's git reading), never from a
       live 404 and never as a native proof;
     - the AFTER phase makes exactly ONE credentialed request: a findings schema handshake on a
       single operator-designated study. Its BODY IS NEVER READ: only status and header. No
       report text, finding text, characteristics or broad clinical list is fetched or hashed;
     - static assets are compared against the digests OF THAT PHASE (baseline digests before,
       target digests after), so a delivery that did not change the served bytes is caught;
     - config/ohif.js is injected by the Orthanc OHIF plugin, not byte-served, so it is recorded
       as source-verified by the runner and is never claimed over HTTP;
     - --compare refuses a wrong phase, two reports of the same phase, a target_sha mismatch and
       an incomplete report, so AFTER-versus-AFTER can no longer print CONSISTENT.

   Credentials: an operator-held file with exactly one key, {"authorization": "<REDACTED>"} or
   {"cookie": "<REDACTED>"}. Never printed, never stored, never logged. */
'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync, writeFileSync } = require('node:fs');

const ORIGIN = 'https://pacs.koreaimagingnetwork.com';
const SCHEMA_HEADER = 'x-kin-finding-schema';
const EXPECTED_SCHEMA = '2';
const TARGET_SHA = '5dd76a6318cb751c531b2e61f9f0d4f94577c5fd';
const BASELINE_SHA = '17980d522b260b59fa97c96924f96038b63551ae';
const PHASES = ['before', 'after'];
// T2: the phase pins are constants of this rollout, not values a supplied preflight may invent.
// A doctored preflight with two made-up set digests must not be able to pass --compare.
const PINNED = {
  before: { setDigest: '0c78f9b735a7e2f1c6aacfc7fe8b393f84b9bc371c5cfc67a055f6780c776673', served: 104, credentialed: 0 },
  after: { setDigest: 'e3f82481108fd52710c8b8719f54fb6226a270d1823e1244789cc7cd47933496', served: 108, credentialed: 1 },
};
const SOURCE_PREFIX = 'worklist-v0/';
const URL_PREFIX = '/worklist/';
const SOURCE_ONLY = 'config/ohif.js';
const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_BODY = 8 * 1024 * 1024;

function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }

/* ---------------------------------------------------------------- pure helpers */

/** Served URL of a repository asset, or null when the path is not byte-served. */
function servedUrl(sourcePath) {
  if (sourcePath === SOURCE_ONLY) return null;
  if (!sourcePath.startsWith(SOURCE_PREFIX)) return null;
  return URL_PREFIX + sourcePath.slice(SOURCE_PREFIX.length);
}

/** Digests that must be served in `phase`, split into byte-served and source-only. */
function pinsForPhase(preflight, phase) {
  if (!PHASES.includes(phase)) fail('PHASE');
  const assets = preflight && preflight.static_assets;
  if (!assets || !assets.baseline_digests || !assets.target_digests) fail('PREFLIGHT_REPORT_SHAPE');
  if (!preflight.identity || preflight.identity.target_sha !== TARGET_SHA
      || preflight.identity.baseline_deployed_sha !== BASELINE_SHA) fail('PREFLIGHT_IDENTITY_MISMATCH');
  const source = phase === 'before' ? assets.baseline_digests : assets.target_digests;
  const setDigest = phase === 'before' ? assets.baseline_set_digest : assets.target_set_digest;
  const served = {}, sourceOnly = {};
  for (const [path, digest] of Object.entries(source)) {
    if (!HEX64.test(digest)) fail('PINNED_DIGEST_SHAPE');
    (servedUrl(path) ? served : sourceOnly)[path] = digest;
  }
  if (!Object.keys(served).length) fail('ASSETS_EMPTY');
  // T2 residual: the declared digest is only a string in the same file. RECOMPUTE it from the
  // per-asset digests that are actually compared, using the preflight's own formula, so a report
  // that keeps the pinned strings while inventing every digest cannot load.
  const recomputed = createHash('sha256').update(
    Object.entries(source).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, digest]) => path + ' ' + digest).join('\n'), 'utf8').digest('hex');
  if (recomputed !== setDigest) fail('PHASE_SET_DIGEST_INCONSISTENT');
  // T2: anchor the supplied preflight to this rollout's own constants.
  if (setDigest !== PINNED[phase].setDigest) fail('PHASE_SET_DIGEST_NOT_PINNED');
  if (Object.keys(served).length !== PINNED[phase].served) fail('PHASE_SERVED_COUNT_NOT_PINNED');
  return { served, sourceOnly, setDigest };
}

/** T4: the after-phase target is a designated synthetic study read from a 0600 selector file. */
function loadHandshakeSelector(path) {
  const info = statSync(path);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('SELECTOR_PERMISSIONS');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'expectedFindings,studyUid,synthetic') fail('SELECTOR_SHAPE');
  if (typeof value.studyUid !== 'string' || !UID.test(value.studyUid) || value.studyUid.length > 64) fail('SELECTOR_UID');
  if (value.synthetic !== true) fail('SELECTOR_NOT_SYNTHETIC');
  if (value.expectedFindings !== 0) fail('SELECTOR_NOT_EMPTY_STUDY');
  return value.studyUid;
}

/** The fixed, GET-only request plan. The before phase never carries a credential. */
function planRequests(phase, servedPins, handshakeStudy) {
  if (!PHASES.includes(phase)) fail('PHASE');
  const plan = [{ method: 'GET', path: '/api/health', kind: 'health', credential: false },
                { method: 'GET', path: '/api/me', kind: 'unauthenticated', credential: false }];
  for (const path of Object.keys(servedPins).sort()) {
    plan.push({ method: 'GET', path: servedUrl(path), kind: 'asset', credential: false, asset: path });
  }
  // A handshake target supplied for the before phase is a mistake, not something to ignore.
  if (phase === 'before' && handshakeStudy !== undefined && handshakeStudy !== null) fail('BEFORE_PHASE_CREDENTIALED');
  if (phase === 'after' && handshakeStudy !== undefined && handshakeStudy !== null) {
    if (typeof handshakeStudy !== 'string' || !UID.test(handshakeStudy) || handshakeStudy.length > 64) fail('HANDSHAKE_STUDY');
    plan.push({ method: 'GET', path: '/api/studies/' + handshakeStudy + '/findings?limit=1',
                kind: 'handshake', credential: true });
  }
  if (plan.some(item => item.method !== 'GET')) fail('NON_GET_PLANNED');
  const credentialed = plan.filter(item => item.credential).length;
  if (phase === 'before' && credentialed !== 0) fail('BEFORE_PHASE_CREDENTIALED');
  if (credentialed > 1) fail('TOO_MANY_CREDENTIALED');
  return plan;
}

/** What the fixed source says about findings at each end. Not a live observation. */
function baselineAbsence(preflight) {
  const before = preflight && preflight.baseline_findings_files;
  const after = preflight && preflight.target_findings_files;
  if (!Array.isArray(before) || !Array.isArray(after)) fail('PREFLIGHT_REPORT_SHAPE');
  return { source: 'fixed source at ' + BASELINE_SHA, baseline_findings_files: before.length,
           target_findings_files: after.length, findings_api_absent_at_baseline: before.length === 0,
           native_proof: false,
           note: 'the baseline serves no findings route or UI, so the before phase asks for none; '
                 + 'absence is read from the repository, never inferred from a 404' };
}

function assetVerdict(observed, pinned) {
  const mismatched = [], absent = [];
  for (const [path, expected] of Object.entries(pinned)) {
    if (!(path in observed)) { absent.push(path); continue; }
    if (observed[path] !== expected) mismatched.push(path);
  }
  return { served_matches_phase: mismatched.length === 0 && absent.length === 0,
           mismatched, absent, checked: Object.keys(pinned).length };
}

function handshakeVerdict(phase, status, headerValue) {
  const header = headerValue === null || headerValue === undefined ? null : String(headerValue);
  if (phase === 'before') {
    return { performed: false, header: null, status: null, ok: true,
             reason: 'baseline has no findings route; no credentialed call is made' };
  }
  return { performed: true, status, header, expected: EXPECTED_SCHEMA,
           ok: status === 200 && header === EXPECTED_SCHEMA, body_read: false };
}

const REQUIRED_KEYS = ['schema', 'tool', 'phase', 'target_sha', 'baseline_sha', 'assets', 'handshake',
                       'findings_source_statement', 'expected_set_digest', 'credentialed_requests',
                       'health', 'unauthenticated'];

function reportComplete(report) {
  return !!report && typeof report === 'object'
    && REQUIRED_KEYS.every(key => Object.prototype.hasOwnProperty.call(report, key))
    && report.tool === 'stage2_post_reflection_check_v3';
}

/** B2: a wrong phase, a repeated phase, a target mismatch or an incomplete report never passes. */
function compareReports(before, after) {
  const problems = [];
  if (!reportComplete(before)) problems.push('BEFORE_REPORT_INCOMPLETE');
  if (!reportComplete(after)) problems.push('AFTER_REPORT_INCOMPLETE');
  if (!problems.length) {
    if (before.phase !== 'before') problems.push('FIRST_REPORT_IS_NOT_BEFORE');
    if (after.phase !== 'after') problems.push('SECOND_REPORT_IS_NOT_AFTER');
    if (before.phase === after.phase) problems.push('SAME_PHASE_TWICE');
    for (const [label, report] of [['BEFORE', before], ['AFTER', after]]) {
      if (report.target_sha !== TARGET_SHA) problems.push(label + '_TARGET_SHA_MISMATCH');
      if (report.baseline_sha !== BASELINE_SHA) problems.push(label + '_BASELINE_SHA_MISMATCH');
    }
    if (before.expected_set_digest === after.expected_set_digest) problems.push('PHASE_PINS_IDENTICAL');
    // T2: both reports must carry this rollout's own pinned digests, counts and credential budget.
    for (const [label, report] of [['BEFORE', before], ['AFTER', after]]) {
      const pin = PINNED[report.phase === 'before' ? 'before' : 'after'];
      if (report.expected_set_digest !== pin.setDigest) problems.push(label + '_SET_DIGEST_NOT_PINNED');
      if (report.assets.checked !== pin.served) problems.push(label + '_ASSET_COUNT_NOT_PINNED');
      if (report.credentialed_requests !== pin.credentialed) problems.push(label + '_CREDENTIALED_COUNT_WRONG');
      // T1: a 503 health answer or an /api/me that answers without a credential is never CONSISTENT.
      if (!report.health || report.health.ok !== true) problems.push(label + '_HEALTH_NOT_OK');
      if (!report.unauthenticated || report.unauthenticated.refused !== true) problems.push(label + '_UNAUTHENTICATED_NOT_REFUSED');
    }
    if (!before.assets.served_matches_phase) problems.push('BEFORE_ASSETS_NOT_BASELINE');
    if (!after.assets.served_matches_phase) problems.push('AFTER_ASSETS_NOT_TARGET');
    if (!after.handshake.ok) problems.push('AFTER_HANDSHAKE_FAILED');
    if (after.handshake.performed && after.handshake.body_read !== false) problems.push('AFTER_BODY_WAS_READ');
    if (before.handshake.performed) problems.push('BEFORE_MADE_A_FINDINGS_CALL');
  }
  return { verdict: problems.length ? 'HOLD' : 'CONSISTENT', problems: problems.sort(),
           target_sha: TARGET_SHA, baseline_sha: BASELINE_SHA,
           delivery_observed: !problems.length,
           note: 'no finding row is compared: the baseline has no findings table exposure, so a '
                 + 'before/after row comparison would be vacuous' };
}

/* ---------------------------------------------------------------- execution */

function loadSession(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(value);
  if (keys.length !== 1 || !['authorization', 'cookie'].includes(keys[0]) || typeof value[keys[0]] !== 'string'
      || !value[keys[0]].length || value[keys[0]].length > 16384) fail('SESSION_FILE_SHAPE');
  return { header: keys[0] === 'authorization' ? 'Authorization' : 'Cookie', value: value[keys[0]] };
}

async function run(options, fetchImpl) {
  const { phase, pins, handshakeStudy, session, absence } = options;
  const plan = planRequests(phase, pins.served, phase === 'after' ? handshakeStudy : null);
  const observed = {};
  let health = null, unauthenticated = null, handshake = handshakeVerdict(phase);
  for (const request of plan) {
    if (request.method !== 'GET') fail('NON_GET_ATTEMPTED');
    const headers = { Accept: request.kind === 'asset' ? '*/*' : 'application/json' };
    if (request.kind === 'handshake') {
      headers['X-KIN-Finding-Schema'] = EXPECTED_SCHEMA;
      if (!session) fail('SESSION_REQUIRED');
      headers[session.header] = session.value;
    }
    const response = await fetchImpl(ORIGIN + request.path, { method: 'GET', headers, redirect: 'manual' });
    if (request.kind === 'health') {
      const body = await response.json();
      health = { status: response.status, ok: !!(body && body.ok === true), auth: !!(body && body.auth === true) };
    } else if (request.kind === 'unauthenticated') {
      unauthenticated = { status: response.status, refused: response.status === 401 };
    } else if (request.kind === 'asset') {
      if (response.status !== 200) fail('ASSET_HTTP');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BODY) fail('ASSET_TOO_LARGE');
      observed[request.asset] = createHash('sha256').update(bytes).digest('hex');
    } else {
      // Handshake only: the body is deliberately never read, parsed or hashed.
      handshake = handshakeVerdict('after', response.status, response.headers.get(SCHEMA_HEADER));
    }
  }
  return {
    schema: 2, tool: 'stage2_post_reflection_check_v3', phase, target_sha: TARGET_SHA, baseline_sha: BASELINE_SHA,
    origin: ORIGIN, requests: plan.length, method_set: ['GET'], wrote_anything: false,
    credentialed_requests: plan.filter(item => item.credential).length,
    expected_set_digest: pins.setDigest, health, unauthenticated, handshake,
    findings_source_statement: absence,
    assets: Object.assign(assetVerdict(observed, pins.served), {
      source_only: Object.keys(pins.sourceOnly).map(path => ({
        path, verified_via: 'runner source comparison of the orthanc bind mount; not byte-served over HTTP' })),
    }),
  };
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeOnce(path, value) {
  if (existsSync(path)) fail('OUT_EXISTS');
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

async function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1]);
  if (args.has('compare')) {
    const at = argv.indexOf('--compare');
    const verdict = compareReports(readJson(argv[at + 1]), readJson(argv[at + 2]));
    if (args.get('out')) writeOnce(args.get('out'), verdict);
    console.log(JSON.stringify(verdict));
    return verdict.verdict === 'CONSISTENT' ? 0 : 3;
  }
  const phase = args.get('phase');
  if (!PHASES.includes(phase)) fail('PHASE');
  const preflight = args.get('preflight') ? readJson(args.get('preflight')) : fail('PREFLIGHT_REQUIRED');
  const pins = pinsForPhase(preflight, phase);
  const absence = baselineAbsence(preflight);
  // T3/T4: no clinical UID on argv. The after phase reads a 0600 selector file naming a
  // designated synthetic study with no findings; the before phase refuses a selector outright.
  if (args.has('handshake-study')) fail('HANDSHAKE_STUDY_ON_ARGV_NOT_ACCEPTED');
  if (phase === 'before' && args.has('handshake-selector')) fail('BEFORE_PHASE_CREDENTIALED');
  const handshakeStudy = phase === 'after' && args.has('handshake-selector')
    ? loadHandshakeSelector(args.get('handshake-selector')) : null;
  if (!args.has('execute')) {
    const plan = planRequests(phase, pins.served, phase === 'after' ? handshakeStudy : null);
    console.log(JSON.stringify({ dry_run: true, phase, target_sha: TARGET_SHA, baseline_sha: BASELINE_SHA,
      origin: ORIGIN, planned_requests: plan.length, methods: [...new Set(plan.map(item => item.method))],
      credentialed_requests: plan.filter(item => item.credential).length,
      served_assets: Object.keys(pins.served).length, source_only_assets: Object.keys(pins.sourceOnly).length,
      expected_set_digest: pins.setDigest, findings_api_absent_at_baseline: absence.findings_api_absent_at_baseline,
      executed: false }));
    return 0;
  }
  const session = phase === 'after' && handshakeStudy ? loadSession(args.get('session') || fail('SESSION_REQUIRED')) : null;
  const result = await run({ phase, pins, handshakeStudy, session, absence }, globalThis.fetch);
  if (args.get('out')) writeOnce(args.get('out'), result);
  // T1: execute mode no longer always exits 0. A failing health answer, an /api/me that is not
  // refused, a served set that is not this phase's, a failed handshake or a wrong credential
  // budget is a non-zero exit at the phase that produced it, not something only compare sees.
  const problems = [];
  if (!(result.health && result.health.ok)) problems.push('HEALTH_NOT_OK');
  if (!(result.unauthenticated && result.unauthenticated.refused)) problems.push('UNAUTHENTICATED_NOT_REFUSED');
  if (!result.assets.served_matches_phase) problems.push('ASSETS_NOT_PHASE');
  if (!result.handshake.ok) problems.push('HANDSHAKE_FAILED');
  if (result.credentialed_requests !== PINNED[phase].credentialed) problems.push('CREDENTIALED_COUNT_WRONG');
  console.log(JSON.stringify({ phase, requests: result.requests, credentialed_requests: result.credentialed_requests,
    health_ok: !!(result.health && result.health.ok), unauthenticated_refused: !!(result.unauthenticated && result.unauthenticated.refused),
    assets_match_phase: result.assets.served_matches_phase, handshake_ok: result.handshake.ok,
    problems: problems.sort() }));
  return problems.length ? 3 : 0;
}

module.exports = { servedUrl, pinsForPhase, planRequests, baselineAbsence, assetVerdict, handshakeVerdict,
                   compareReports, reportComplete, loadSession, loadHandshakeSelector, run, main,
                   ORIGIN, TARGET_SHA, BASELINE_SHA, EXPECTED_SCHEMA, PINNED };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    console.error(JSON.stringify({ error_code: error.safeCode || 'UNEXPECTED', executed: false }));
    process.exit(4);
  });
}
