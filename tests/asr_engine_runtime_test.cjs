'use strict';
/* S3-ASR-U3 — hosted real-engine acceptance path.
 *
 * Runs INSIDE the shipped production image and drives the SHIPPED COMPILED modules out of
 * /app/dist over real Node/Nest HTTP sockets against a real, pinned, attested whisper.cpp
 * container. Nothing here re-implements or copies the service.
 *
 * Declared limits, also written into the evidence record:
 *   L-1 the bounded application registers only the shipped DictationController with the shipped
 *       AsrService and an INJECTED PacsService stand-in for the report gate and audit sink, plus
 *       an identity stand-in middleware. The global AuthGuard, StudyAccessInterceptor, Prisma and
 *       the real report gate are ABSENT: role/institution/REPORT_HELD/Unverified/preliminary
 *       refusals stay proved by tests/dictation_api_test.cjs and by the live battery, not here.
 *   L-2 three scenarios route through an in-process recording proxy so the exact upstream bytes,
 *       or their absence, can be captured: A-6 protocol capture, A-7 oversize body and A-8
 *       interrupted upload. Every other scenario connects directly to the engine container.
 *   L-3 a released KIN slot proves only that the KIN fetch settled. Nothing here claims that
 *       AbortController stopped native inference or freed engine memory.
 *   L-4 one CPU engine, one model, one synthetic non-clinical English sentence. No Korean, no
 *       clinical vocabulary, no microphone. NO recognition accuracy and NO latency bound is
 *       asserted anywhere: the transcript is recorded, never graded.
 */

require('/app/node_modules/reflect-metadata');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const { Module } = require('/app/node_modules/@nestjs/common');
const { NestFactory } = require('/app/node_modules/@nestjs/core');
const {
  AsrService, asrConfiguration, ASR_ENGINE_PIN, ASR_MODEL_PIN, ASR_TEXT_CAP, ASR_RESPONSE_CAP,
} = require('/app/dist/asr.service');
const { DictationController } = require('/app/dist/dictation.controller');
const { dictationParser } = require('/app/dist/dictation-parser');
const { PacsService } = require('/app/dist/pacs.service');
const { inspectDictationWav, DICTATION_AUDIO_MAX_BYTES } = require('/app/dist/dictation-audio');

const FIXTURE_DIR = process.env.KIN_ASR_FIXTURE_DIR || '/fixture';
const OUT_DIR = process.env.KIN_ASR_OUT_DIR || '/out';
const ENGINE_URL = process.env.KIN_ASR_ENGINE_URL || '';
const LANGUAGE = 'en';
const READY_DEADLINE_MS = Number(process.env.KIN_ASR_READY_MS || 300000);
const GENEROUS_TIMEOUT_MS = 120000;

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listenerNames = (emitter, event) =>
  emitter.listeners(event).map(fn => (fn && fn.name) || '(anonymous)');

// ---------------------------------------------------------------- generated isolated identities
const identity = {
  sub: `u3-sub-${crypto.randomUUID()}`,
  actor: `u3-actor-${crypto.randomUUID()}`,
  institution: `u3-inst-${crypto.randomUUID()}`,
  roles: ['radiologist'],
  kind: 'member',
};
const secrets = {
  cookie: `u3-cookie-${crypto.randomUUID()}`,
  bearer: `u3-bearer-${crypto.randomUUID()}`,
  patient: `u3-patient-${crypto.randomUUID()}`,
};
const STUDY_UID = `u3uid.${crypto.randomUUID().replace(/-/g, '')}`;
// Every one of these must be absent from whatever KIN sends upstream.
const FORBIDDEN_VALUES = [secrets.cookie, secrets.bearer, secrets.patient, STUDY_UID,
  identity.sub, identity.actor, identity.institution];

// ------------------------------------------------------------------------ injected stand-ins
const auditRows = [];
const gateCalls = [];
const standInAccess = [];
// Members whose use would mean dictation touched report state. A plain access is enough to fail.
const REPORT_MEMBERS = ['putReport', 'commitReport', 'scopeWrite', 'reportDraftGate',
  'reportLimitChecked', 'stashReport', 'prisma', 'audit', 'gate', 'prefs', 'bootstrap'];

const pacsTarget = {
  async dictationGate(uid, caller) {
    gateCalls.push({ uid, actor: caller && caller.actor, roles: caller && caller.roles,
      institution: caller && caller.institution, at: Date.now() });
  },
  async dictationAudit(uid, caller, detail) {
    auditRows.push({ uid, actor: caller && caller.actor, keys: Object.keys(detail),
      detail: { ...detail }, at: Date.now() });
  },
};
const pacsStandIn = new Proxy(pacsTarget, {
  get(target, property, receiver) {
    if (typeof property === 'string') standInAccess.push(property);
    return Reflect.get(target, property, receiver);
  },
});

// -------------------------------------------------------------- harness-only lifecycle recorder
let current = null;

function instrument(req, res, next) {
  const scenario = current;
  if (!scenario) return next();
  scenario.req = req;
  scenario.res = res;
  const at = () => Date.now() - scenario.startedAt;
  const push = (source, event) => scenario.events.push({
    source, event, ms: at(), reqAborted: req.aborted === true, reqComplete: req.complete === true,
    resWritableEnded: res.writableEnded === true, resDestroyed: res.destroyed === true,
  });
  // Observation only: no 'error' listener is attached, so no product error routing changes.
  for (const event of ['aborted', 'close', 'end']) req.on(event, () => push('req', event));
  for (const event of ['close', 'finish']) res.on(event, () => push('res', event));
  setTimeout(() => {
    scenario.midflightListeners = {
      reqAborted: listenerNames(req, 'aborted'), resClose: listenerNames(res, 'close'),
    };
  }, 250).unref();
  res.on('finish', () => {
    scenario.afterFinishListeners = {
      reqAborted: listenerNames(req, 'aborted'), resClose: listenerNames(res, 'close'),
    };
  });
  next();
}

function identityStandIn(req, _res, next) {
  // Stands in for the absent global AuthGuard (L-1). Values are generated per run.
  Object.assign(req, identity);
  next();
}

// ------------------------------------------------------------------------ recording proxy (L-2)
const captures = [];
let proxyServer = null;
let proxyUrl = '';

function startProxy(engineOrigin) {
  const target = new URL(engineOrigin);
  proxyServer = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size <= 4 * 1024 * 1024) chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      captures.push({
        at: Date.now(), method: req.method, url: req.url, httpVersion: req.httpVersion,
        headerNames: Object.keys(headers), headers, rawHeaders: req.rawHeaders.slice(),
        bodyBytes: body.length, bodySha256: sha256(body),
        multipart: parseMultipart(body, headers['content-type']),
        forbiddenHits: forbiddenHits(req.rawHeaders.join('\n'), body),
      });
      const forward = { ...headers, host: target.host, 'content-length': String(body.length) };
      delete forward['transfer-encoding'];
      delete forward.connection;
      const upstream = http.request({
        host: target.hostname, port: target.port || 80, method: req.method, path: req.url,
        headers: forward,
      }, answer => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { res.destroy(); });
      // Mirror a direct connection: losing the KIN side closes the engine side the same way.
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(body);
    });
  });
  return new Promise(resolve => proxyServer.listen(0, '127.0.0.1', () => {
    proxyUrl = `http://127.0.0.1:${proxyServer.address().port}/inference`;
    resolve(proxyUrl);
  }));
}

function forbiddenHits(headerText, body) {
  const haystack = `${headerText}\n${body.toString('latin1')}`;
  return FORBIDDEN_VALUES.filter(value => haystack.includes(value));
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { error: 'no boundary in content-type', contentType: contentType || null };
  const boundary = (match[1] || match[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.concat([Buffer.from('\r\n'), delimiter]);
  const parts = [];
  if (body.indexOf(delimiter) !== 0) return { error: 'body does not open with the boundary', boundary };
  let index = delimiter.length;
  for (;;) {
    const marker = body.slice(index, index + 2).toString('latin1');
    if (marker === '--') return { boundary, terminated: true, parts };
    if (marker !== '\r\n') return { error: 'malformed delimiter', boundary, parts };
    index += 2;
    const headerEnd = body.indexOf('\r\n\r\n', index, 'latin1');
    if (headerEnd < 0) return { error: 'unterminated part headers', boundary, parts };
    const headerText = body.slice(index, headerEnd).toString('utf8');
    const start = headerEnd + 4;
    const next = body.indexOf(closing, start);
    if (next < 0) return { error: 'unterminated part body', boundary, parts };
    const content = body.slice(start, next);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    const name = /name="([^"]*)"/.exec(disposition);
    const filename = /filename="([^"]*)"/.exec(disposition);
    parts.push({
      name: name ? name[1] : null, filename: filename ? filename[1] : null, headers,
      bytes: content.length, sha256: sha256(content),
      text: content.length <= 256 ? content.toString('utf8') : null,
    });
    index = next + closing.length;
  }
}

// ------------------------------------------------------------------------------- HTTP client
let appPort = 0;

function post(options = {}) {
  const bytes = options.bytes || Buffer.alloc(0);
  const declared = options.declaredLength === undefined ? bytes.length : options.declaredLength;
  return new Promise(resolve => {
    const started = Date.now();
    const settle = value => resolve({ ms: Date.now() - started, ...value });
    const request = http.request({
      host: '127.0.0.1', port: appPort, method: 'POST', agent: false,
      path: `/api/studies/${encodeURIComponent(options.uid || STUDY_UID)}/dictation`,
      headers: {
        'content-type': options.contentType || 'audio/wav',
        'content-length': String(declared),
        'x-kin-csrf': '1',
        cookie: `kin_session=${secrets.cookie}`,
        authorization: `Bearer ${secrets.bearer}`,
        'x-kin-patient': secrets.patient,
        ...(options.headers || {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* recorded verbatim below */ }
        settle({ status: response.statusCode, text, json, code: json && json.code });
        // A refusal that arrives before the declared body was written leaves the request open.
        request.destroy();
      });
    });
    request.on('error', error => settle({ status: null, error: error.code || String(error) }));
    if (options.writeThenDestroy) {
      request.write(bytes.slice(0, options.writeThenDestroy.bytes));
      setTimeout(() => request.destroy(), options.writeThenDestroy.afterMs).unref();
    } else {
      request.end(bytes);
      if (options.destroyAfterMs !== undefined) {
        setTimeout(() => request.destroy(), options.destroyAfterMs).unref();
      }
    }
  });
}

// ------------------------------------------------------------------------------- scenario book
const scenarios = [];

function begin(name, transport) {
  current = {
    name, transport, startedAt: Date.now(), events: [],
    auditFrom: auditRows.length, captureFrom: captures.length,
  };
  scenarios.push(current);
  return current;
}

function finish(scenario, extra = {}) {
  scenario.ms = Date.now() - scenario.startedAt;
  scenario.audits = auditRows.slice(scenario.auditFrom).map(row => ({ ...row }));
  scenario.captures = captures.slice(scenario.captureFrom).map(capture => ({
    method: capture.method, url: capture.url, headerNames: capture.headerNames,
    bodyBytes: capture.bodyBytes, bodySha256: capture.bodySha256,
    multipart: capture.multipart, forbiddenHits: capture.forbiddenHits,
  }));
  Object.assign(scenario, extra);
  delete scenario.req;
  delete scenario.res;
  current = null;
  return scenario;
}

async function waitForAudit(scenario, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (auditRows.length === scenario.auditFrom && Date.now() < until) await delay(50);
  return auditRows.slice(scenario.auditFrom);
}

// ------------------------------------------------------------------------------------ fixtures
let application = null;
let fixture = null;
let audio = null;
let fixtureReport = null;
let attestation = null;
let engineStart = null;
let baselineMs = 0;
let transcript = null;
let duplicateTargets = null;

before(async () => {
  assert.ok(ENGINE_URL, 'KIN_ASR_ENGINE_URL must name the attested engine container');
  fixture = fs.readFileSync(`${FIXTURE_DIR}/dictation.wav`);
  fixtureReport = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/fixture-report.json`, 'utf8'));
  attestation = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/attestation.json`, 'utf8'));
  engineStart = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/engine-start.json`, 'utf8'));
  audio = inspectDictationWav(fixture);

  process.env.KIN_ASR_ENGINE = ASR_ENGINE_PIN;
  process.env.KIN_ASR_MODEL = ASR_MODEL_PIN;
  process.env.KIN_ASR_LANGUAGE = LANGUAGE;
  process.env.KIN_ASR_TIMEOUT_MS = String(GENEROUS_TIMEOUT_MS);
  process.env.KIN_ASR_URL = ENGINE_URL;

  class HarnessModule {}
  Module({
    controllers: [DictationController],
    providers: [AsrService, { provide: PacsService, useValue: pacsStandIn }],
  })(HarnessModule);
  application = await NestFactory.create(HarnessModule, { rawBody: true, logger: false });
  application.use(instrument);
  application.use(dictationParser());
  application.use(identityStandIn);
  application.setGlobalPrefix('api');
  await application.listen(0, '127.0.0.1');
  appPort = application.getHttpServer().address().port;
  await startProxy(ENGINE_URL);

  const origin = new URL(ENGINE_URL).origin;
  const until = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    try {
      const answer = await fetch(`${origin}/`, { redirect: 'manual' });
      if (answer.status) { await answer.arrayBuffer().catch(() => {}); break; }
    } catch { /* the engine is still loading the pinned model */ }
    assert.ok(Date.now() < until, 'the pinned engine never began listening');
    await delay(1000);
  }
});

after(async () => {
  const record = {
    unit: 'S3-ASR-U3', recorded_at_utc: new Date().toISOString(),
    limits: {
      'L-1': 'bounded Nest app: shipped DictationController + shipped AsrService + INJECTED ' +
        'PacsService gate/audit stand-in and identity stand-in; no AuthGuard, no interceptor, ' +
        'no Prisma, no real report gate. Auth/institution/report refusals are not proved here.',
      'L-2': 'three scenarios are proxied for byte capture (A-6 p-out-protocol, ' +
        'A-7 oversize-body, A-8 upload-interrupted); the others connect directly',
      'L-3': 'KIN slot release is not evidence that native inference stopped or memory was freed',
      'L-4': 'one engine, one model, one synthetic non-clinical English sentence; no accuracy, ' +
        'no clinical suitability and no latency bound is asserted',
      'A-12': 'induced KIN timeout: KIN_ASR_TIMEOUT_MS is lowered below the observed baseline; ' +
        'the engine itself is never stalled, and no malformed, 5xx or oversize upstream response ' +
        'is injected against the real engine here (deferred)',
    },
    engine_url: ENGINE_URL, proxy_url: proxyUrl, study_uid: STUDY_UID,
    identity: { ...identity }, forbidden_values_count: FORBIDDEN_VALUES.length,
    pins: { enginePin: ASR_ENGINE_PIN, modelPin: ASR_MODEL_PIN, textCap: ASR_TEXT_CAP,
      responseCap: ASR_RESPONSE_CAP, wavCap: DICTATION_AUDIO_MAX_BYTES, language: LANGUAGE },
    attestation_status: attestation && attestation.status,
    attested_engine_commit: attestation && attestation.engine_provenance
      && attestation.engine_provenance.source && attestation.engine_provenance.source.commit,
    attested_model_sha256: attestation && attestation.model && attestation.model.sha256,
    engine_started_at: engineStart && engineStart.started_at,
    engine_started_image: engineStart && engineStart.image,
    attested_engine_image_id: attestation && attestation.images && attestation.images.engine
      && attestation.images.engine.id,
    fixture: fixtureReport && fixtureReport.fixture,
    validated: audio,
    baseline_ms: baselineMs,
    transcript_observed: transcript,
    transcript_note: 'recorded verbatim as raw evidence; never graded for accuracy',
    audit_rows: auditRows, gate_calls: gateCalls.length,
    stand_in_property_access: Array.from(new Set(standInAccess)),
    scenarios,
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(`${OUT_DIR}/asr-engine-record.json`, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    console.error(`could not write the evidence record: ${error && error.message}`);
  }
  if (proxyServer) await new Promise(resolve => proxyServer.close(resolve));
  if (application) await application.close();
});

// ------------------------------------------------------------------------------------ A-1..A-4
test('A-1/A-2/A-3/A-4 provenance is attested, complete and consistent before any engine call',
  () => {
    assert.equal(attestation.status, 'ATTESTED');
    assert.deepEqual(attestation.problems, []);
    assert.equal(attestation.engine_started, false);
    // A-1: the engine container may only have started after the attestation was written.
    assert.ok(Date.parse(engineStart.started_at) >= Date.parse(attestation.generated_at_utc),
      `engine started ${engineStart.started_at} before attestation ${attestation.generated_at_utc}`);
    // A-1: the container that was started runs exactly the image that was attested.
    assert.equal(engineStart.image, attestation.images.engine.id,
      'the started engine container does not run the attested engine image');
    assert.equal(attestation.model.sha256, attestation.model.expected_sha256);
    assert.equal(attestation.model.bytes, attestation.model.expected_bytes);
    assert.ok(attestation.images.engine.id && attestation.images.api.id);

    // A-2: the fixture is the generated one, with its full generator/resampler provenance.
    assert.equal(sha256(fixture), fixtureReport.fixture.sha256);
    assert.equal(fixtureReport.fixture.sha256, attestation.fixture.sha256);
    assert.ok(fixtureReport.resampler.sha256);
    assert.ok(attestation.generator.command.includes(attestation.pins.generator_sentence));

    // A-3: the SHIPPED compiled validator accepts it, and seconds derive from validated data.
    assert.equal(audio.ok, true);
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.channels, 1);
    assert.equal(audio.bitsPerSample, 16);
    assert.equal(audio.seconds, audio.frames / 16000);
    assert.equal(audio.byteLength, fixtureReport.fixture.bytes);

    // A-4: configured labels are consistent with the attested identity. Labels remain labels.
    assert.ok(ASR_ENGINE_PIN.includes(attestation.engine_provenance.source.commit),
      `${ASR_ENGINE_PIN} does not name the attested engine commit`);
    assert.ok(ASR_MODEL_PIN.includes(attestation.model.sha256),
      `${ASR_MODEL_PIN} does not name the attested model SHA-256`);
    assert.equal(asrConfiguration().available, true);
  });

// -------------------------------------------------------------------------------- A-5 and A-10
test('A-5 a normal completed body yields a real bounded transcript and causes no abort',
  { timeout: 600000 }, async () => {
    const scenario = begin('normal-completed-body', 'direct');
    const answer = await post({ bytes: fixture });
    await delay(300);
    const holders = scenario;
    duplicateTargets = { req: scenario.req, res: scenario.res };
    finish(scenario, { answer: { status: answer.status, ms: answer.ms, code: answer.code } });
    baselineMs = answer.ms;

    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(),
      ['enginePin', 'languagePin', 'modelPin', 'seconds', 'text']);
    assert.equal(typeof answer.json.text, 'string');
    // A real, bounded, non-empty transcript. Its CONTENT is never asserted.
    assert.ok(answer.json.text.length > 0, 'the engine returned no transcript');
    assert.ok(answer.json.text.length <= ASR_TEXT_CAP);
    assert.equal(answer.json.enginePin, ASR_ENGINE_PIN);
    assert.equal(answer.json.modelPin, ASR_MODEL_PIN);
    assert.equal(answer.json.languagePin, LANGUAGE);
    assert.equal(answer.json.seconds, audio.frames / 16000);
    transcript = { text: answer.json.text, utf16_length: answer.json.text.length,
      sha256: sha256(Buffer.from(answer.json.text, 'utf8')) };
    scenario.transcript_utf16_length = answer.json.text.length;

    // The completed body must not have been read as a cancellation (binding A-3 rule). Node
    // emits close on a normal completion too, so the evidence is: close events were observed,
    // and every response close carried writableEnded === true.
    const responseCloses = scenario.events.filter(
      event => event.source === 'res' && event.event === 'close');
    assert.ok(scenario.events.some(event => event.source === 'res' && event.event === 'finish'),
      `no response finish was observed: ${JSON.stringify(scenario.events)}`);
    assert.ok(responseCloses.length > 0, 'no response close event was observed at all');
    assert.ok(responseCloses.every(event => event.resWritableEnded === true),
      `a response close arrived unwritten: ${JSON.stringify(responseCloses)}`);
    const audits = scenario.audits;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detail.outcome, 'success');

    // A-10 part one: while inference was pending the product's listeners were attached, and by
    // the time the response finished they were gone. Both halves matter: the "gone" half alone
    // would pass vacuously if the compiled names ever changed.
    assert.ok(holders.midflightListeners, 'no mid-flight listener snapshot was taken');
    assert.ok(holders.midflightListeners.reqAborted.includes('lostUpload'),
      `mid-flight req 'aborted' listeners: ${holders.midflightListeners.reqAborted}`);
    assert.ok(holders.midflightListeners.resClose.includes('lostResponse'),
      `mid-flight res 'close' listeners: ${holders.midflightListeners.resClose}`);
    assert.ok(holders.afterFinishListeners, 'no post-response listener snapshot was taken');
    assert.ok(!holders.afterFinishListeners.reqAborted.includes('lostUpload'));
    assert.ok(!holders.afterFinishListeners.resClose.includes('lostResponse'));
  });

test('A-10 duplicate close/aborted delivery after a success changes nothing', async () => {
  const scenario = begin('duplicate-cleanup', 'none');
  assert.ok(duplicateTargets && duplicateTargets.req && duplicateTargets.res,
    'the completed request objects were not retained');
  const auditsBefore = auditRows.length;
  const delivered = [];
  let raised = null;
  try {
    // The controller's finally already ran. Re-delivering the very events the binding rule warns
    // about must be inert: no abort, no second audit row, no throw.
    // Exactly the two events the product subscribes to, delivered twice each.
    for (let round = 0; round < 2; round += 1) {
      duplicateTargets.req.emit('aborted');
      delivered.push('req:aborted');
      duplicateTargets.res.emit('close');
      delivered.push('res:close');
    }
  } catch (error) { raised = String(error && error.message ? error.message : error); }
  await delay(200);
  finish(scenario, { raised, delivered, auditRowsBefore: auditsBefore,
    auditRowsAfter: auditRows.length,
    listenersNow: {
      reqAborted: listenerNames(duplicateTargets.req, 'aborted'),
      resClose: listenerNames(duplicateTargets.res, 'close'),
    } });
  assert.equal(raised, null);
  assert.equal(auditRows.length, auditsBefore, 'a duplicate event produced another audit row');
  assert.equal(scenario.listenersNow.reqAborted.includes('lostUpload'), false);
  assert.equal(scenario.listenersNow.resClose.includes('lostResponse'), false);
});

// --------------------------------------------------------------------------------------- A-6
test('A-6 the upstream request carries exactly the pinned protocol and no identifiers',
  { timeout: 600000 }, async () => {
    const scenario = begin('p-out-protocol', 'proxy');
    process.env.KIN_ASR_URL = proxyUrl;
    const answer = await post({ bytes: fixture });
    process.env.KIN_ASR_URL = ENGINE_URL;
    await delay(200);
    finish(scenario, { answer: { status: answer.status, ms: answer.ms } });

    assert.equal(answer.status, 200, answer.text);
    assert.equal(scenario.captures.length, 1, 'expected exactly one upstream request');
    const capture = scenario.captures[0];
    assert.equal(capture.method, 'POST');
    assert.equal(capture.url, '/inference');
    assert.equal(capture.multipart.error, undefined);
    assert.equal(capture.multipart.terminated, true);
    assert.deepEqual(capture.multipart.parts.map(part => part.name),
      ['file', 'response_format', 'language']);
    const [file, format, language] = capture.multipart.parts;
    assert.equal(file.filename, 'dictation.wav');
    assert.equal(file.bytes, fixture.length);
    // P-out file bytes are byte-identical to P-in.
    assert.equal(file.sha256, sha256(fixture));
    assert.equal(file.sha256, fixtureReport.fixture.sha256);
    assert.equal(format.text, 'json');
    assert.equal(language.text, LANGUAGE);
    assert.equal(format.filename, null);
    assert.equal(language.filename, null);
    for (const banned of ['detect_language', 'temperature', 'prompt', 'model']) {
      assert.ok(!capture.multipart.parts.some(part => part.name === banned),
        `${banned} must not be in the request allowlist`);
    }
    for (const header of ['cookie', 'authorization', 'x-kin-csrf', 'x-kin-patient']) {
      assert.ok(!capture.headerNames.includes(header), `${header} was forwarded upstream`);
    }
    assert.deepEqual(capture.forbiddenHits, [],
      'a uid, actor, institution, token, cookie or patient value reached the engine');
  });

// --------------------------------------------------------------------------------- A-7 and A-8
test('A-7 an oversize body is refused on its declared length and never reaches the engine',
  { timeout: 120000 }, async () => {
    const scenario = begin('oversize-body', 'proxy');
    process.env.KIN_ASR_URL = proxyUrl;
    // The refusal is decided from the declared content-length before any byte is buffered, but
    // body-parser 1.20.4 then drains the rest of the request and calls next(error) only once the
    // request has finished (lib/read.js dump + on-finished). The 413 is therefore observable only
    // after the whole body was sent, so the complete maxBytes + 1 body is sent here. A client that
    // stalls mid-body is a different case: see A-8.
    const answer = await post({ bytes: Buffer.alloc(DICTATION_AUDIO_MAX_BYTES + 1) });
    process.env.KIN_ASR_URL = ENGINE_URL;
    await delay(200);
    finish(scenario, { answer: { status: answer.status, ms: answer.ms, code: answer.code,
      error: answer.error } });
    assert.equal(answer.status, 413, answer.text || answer.error);
    assert.equal(answer.code, 'DICTATION_AUDIO_TOO_LARGE');
    assert.equal(scenario.captures.length, 0, 'an oversize body reached the engine');
    assert.equal(scenario.audits.length, 1);
    assert.equal(scenario.audits[0].detail.outcome, 'DICTATION_AUDIO_TOO_LARGE');
    // On refusal the shipped parser hands the controller an empty body, so the audit says 0.
    assert.equal(scenario.audits[0].detail.bytes, 0);
  });

test('A-8 an interrupted upload never reaches the engine and frees the slot',
  { timeout: 120000 }, async () => {
    const scenario = begin('upload-interrupted', 'proxy');
    process.env.KIN_ASR_URL = proxyUrl;
    const answer = await post({
      bytes: fixture, declaredLength: fixture.length + 400000,
      writeThenDestroy: { bytes: 1024, afterMs: 250 },
    });
    const audits = await waitForAudit(scenario);
    process.env.KIN_ASR_URL = ENGINE_URL;
    finish(scenario, { answer: { status: answer.status, ms: answer.ms, error: answer.error } });

    assert.equal(scenario.captures.length, 0, 'a lost upload still reached the engine');
    assert.equal(audits.length, 1, 'the interrupted upload produced no audit row');
    assert.equal(audits[0].detail.outcome, 'DICTATION_AUDIO_INVALID');
    assert.equal(audits[0].detail.bytes, 0);
    // Observed, not assumed: whichever signal this Node/Express build actually delivers for a
    // lost upload, the request must never have completed.
    assert.ok(scenario.events.some(event => event.event === 'aborted'
      || (event.source === 'req' && event.event === 'close' && event.reqComplete === false)),
      `no lost upload was observed: ${JSON.stringify(scenario.events)}`);
  });

// --------------------------------------------------------------------------------------- A-11
test('A-11 the busy slot is finite: a concurrent request is refused, a later one succeeds',
  { timeout: 900000 }, async () => {
    const scenario = begin('busy-slot', 'direct');
    const first = post({ bytes: fixture });
    await delay(600);
    const second = await post({ bytes: fixture });
    const firstAnswer = await first;
    const third = await post({ bytes: fixture });
    await delay(200);
    finish(scenario, {
      first: { status: firstAnswer.status, ms: firstAnswer.ms },
      second: { status: second.status, code: second.code, ms: second.ms },
      third: { status: third.status, ms: third.ms },
    });
    assert.equal(second.status, 503);
    assert.equal(second.code, 'DICTATION_BUSY');
    // Refused by the slot, not by waiting on the engine.
    assert.ok(second.ms < 5000, `a busy refusal took ${second.ms} ms`);
    assert.equal(firstAnswer.status, 200, firstAnswer.text);
    assert.equal(third.status, 200, third.text);
    assert.ok(third.json.text.length > 0);
  });

// --------------------------------------------------------------------------------------- A-9
test('A-9 losing the response channel during inference settles KIN early and frees the slot',
  { timeout: 900000 }, async () => {
    assert.ok(baselineMs > 0, 'the baseline scenario must run first');
    const cut = Math.min(Math.max(Math.floor(baselineMs / 2), 300), 10000);
    const scenario = begin('response-disconnect-during-inference', 'direct');
    const answer = await post({ bytes: fixture, destroyAfterMs: cut });
    const audits = await waitForAudit(scenario, 60000);
    finish(scenario, { cut_after_ms: cut,
      answer: { status: answer.status, ms: answer.ms, error: answer.error } });

    assert.equal(audits.length, 1);
    assert.equal(audits[0].detail.outcome, 'DICTATION_ENGINE_FAILED');
    assert.ok(audits[0].detail.ms < baselineMs,
      `KIN settled in ${audits[0].detail.ms} ms, not earlier than the ${baselineMs} ms baseline`);
    assert.ok(scenario.events.some(
      event => event.source === 'res' && event.event === 'close' && event.resWritableEnded === false),
      'no response-channel loss was observed');

    // L-3: what the engine did with the orphaned inference is recorded, never asserted.
    const followUp = begin('after-disconnect', 'direct');
    const recovered = await post({ bytes: fixture });
    finish(followUp, { answer: { status: recovered.status, ms: recovered.ms, code: recovered.code } });
    assert.equal(recovered.status, 200, recovered.text);
    assert.ok(recovered.json.text.length > 0);
  });

// --------------------------------------------------------------------------------------- A-12
test('A-12 an induced KIN timeout refuses; the next request outcome is recorded as observed',
  { timeout: 900000 }, async () => {
    assert.ok(baselineMs > 0, 'the baseline scenario must run first');
    // Induced KIN timeout: KIN's own ceiling is lowered below the observed inference time. The
    // engine is working normally, it is never stalled, and no malformed, 5xx or oversize upstream
    // response is injected against the real engine here.
    const ceiling = Math.min(Math.max(Math.floor(baselineMs / 4), 200), 4000);
    const scenario = begin('induced-kin-timeout', 'direct');
    process.env.KIN_ASR_TIMEOUT_MS = String(ceiling);
    const timedOut = await post({ bytes: fixture });
    process.env.KIN_ASR_TIMEOUT_MS = String(GENEROUS_TIMEOUT_MS);
    finish(scenario, { configured_timeout_ms: ceiling, baseline_ms: baselineMs,
      timeout_kind: 'induced KIN timeout (lowered KIN_ASR_TIMEOUT_MS); engine not stalled',
      answer: { status: timedOut.status, code: timedOut.code, ms: timedOut.ms } });
    assert.equal(timedOut.status, 503, timedOut.text);
    assert.equal(timedOut.code, 'DICTATION_TIMEOUT');
    assert.ok(timedOut.ms >= ceiling,
      `KIN settled in ${timedOut.ms} ms, before its own ${ceiling} ms ceiling`);

    // KIN abandoned its request; whether the engine was still working on it is not known here.
    // Whatever the next request does is DATA: no engine cancellation policy is asserted here or
    // anywhere else.
    const next = begin('second-request-after-induced-timeout', 'direct');
    const answer = await post({ bytes: fixture });
    finish(next, { observed: { status: answer.status, code: answer.code || null, ms: answer.ms },
      note: 'observed outcome of the request that follows an induced KIN timeout' });
    const named = [200, 503].includes(answer.status)
      && (answer.status === 200 || ['DICTATION_TIMEOUT', 'DICTATION_ENGINE_FAILED', 'DICTATION_BUSY']
        .includes(answer.code));
    assert.ok(named, `unnamed second-request outcome ${answer.status} ${answer.code}: ${answer.text}`);
  });

// --------------------------------------------------------------------------------------- A-13
test('A-13 the report was never touched and the audit stays metadata-only', () => {
  const touched = REPORT_MEMBERS.filter(member => standInAccess.includes(member));
  assert.deepEqual(touched, [], `dictation reached report state: ${touched}`);
  assert.ok(standInAccess.includes('dictationGate') && standInAccess.includes('dictationAudit'));
  assert.ok(auditRows.length > 0);
  for (const row of auditRows) {
    assert.deepEqual(row.keys.slice().sort(), ['bytes', 'engine', 'ms', 'outcome', 'seconds']);
    assert.equal(row.detail.engine, ASR_ENGINE_PIN);
    assert.equal(row.actor, identity.actor);
  }
  const serialized = JSON.stringify(auditRows);
  assert.ok(transcript && transcript.text);
  assert.equal(serialized.includes(transcript.text.trim().slice(0, 12)), false,
    'a transcript fragment was written into the audit detail');
});
