'use strict';
/**
 * REQ-S7-U4b-PANEL → RISK-S7-U4b-STALE-PANEL / RISK-S7-U4b-FAIL-AS-EMPTY → TEST-S7-U4b-MODEL (contract S7-U4p §7, §7.1, §8.1,
 * §9.1, §10; CC-S13 "the U4b model shares the key list or checks the same fixed list").
 *
 * The shipped client model (worklist-v0/hpacs-lite/clinical-context.js, KinClinicalContext) beside the compiled server shape
 * check (clinicalContextShapeError in api/src/clinical-context-policy.ts, compiled into kin-api:ci as
 * /app/dist/clinical-context-policy) over one set of answer vectors, tests/clinical_context_vectors.json:
 *   cm01  every valid vector: both checks accept, and the model's section states are the vector's.
 *   cm02  every malformed vector: both checks refuse (its derivedFrom original is accepted by both, cm01).
 *   cm02b every object of every valid vector with one unknown key added, or one of its keys removed: both refuse - the two
 *         key lists are the same without this file naming a key.
 *   cm03  "No clinical information provided." only when all four sections are absent (A-ABSENT4 vs A-TAGS-NC).
 *   cm04  the §8.1 stale table (stale_cases T-01..T-18), marks that stay until a new answer, and the direction of the
 *         multi-page limit D-1 (T-15): a list row that differs from the answer in either direction marks the section.
 *   cm05  the texts the model hands the page are the contract's (texts), and every failure reason has its own sentence.
 *   cm06  forbidden key fragments and exact keys (uxr-trace) at every layer: both refuse.
 *   cm07  the model runs in a context without browser globals, timers or KinAuth (purity by execution, not by reading it).
 *   cm08  request-context vectors (a valid answer about another study): both shape checks accept them - the request is
 *         matched by the page before painting (ABA-3, tests/clinical_context_dom_test.py cd17), not by the shape.
 *
 * Only the model's exported names are called; no source text is read for assertions. With KIN_CLINICAL_CONTEXT_SERVER set
 * (the runtime CI step) a missing server module fails this file; without it (a local run) the server halves are skipped
 * with that reason, like tests/admin_metrics_test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'clinical_context_vectors.json'), 'utf8'));
const MODEL_SOURCE = fs.readFileSync(path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'clinical-context.js'), 'utf8');
const SERVER_MODULE = process.env.KIN_CLINICAL_CONTEXT_SERVER;
const server = SERVER_MODULE ? require(SERVER_MODULE) : null;
const serverSkip = server ? false : 'KIN_CLINICAL_CONTEXT_SERVER is not set: the compiled server half runs in the runtime CI job';

// cm07: an ECMAScript-only global. A model that reached for window, document, fetch, storage, timers or KinAuth would throw.
const sandbox = vm.createContext({});
vm.runInContext(MODEL_SOURCE, sandbox, { filename: 'clinical-context.js' });
const model = sandbox.KinClinicalContext;
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => JSON.parse(JSON.stringify(value));
const VALID = VECTORS.answers.valid, MALFORMED = VECTORS.answers.malformed, CONTEXT = VECTORS.request_context;
const TEXTS = VECTORS.texts;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (all, name) => (name in values ? String(values[name]) : all));
const FORMAT = iso => '<' + iso + '>';

test('cm07 the model loads and runs in a context with no browser global, timer or session', () => {
  assert.ok(model, 'KinClinicalContext is defined on the context global');
  for (const name of ['window', 'document', 'fetch', 'localStorage', 'sessionStorage', 'indexedDB', 'setTimeout', 'setInterval',
    'requestAnimationFrame', 'queueMicrotask', 'KinAuth', 'BroadcastChannel', 'XMLHttpRequest']) {
    assert.equal(vm.runInContext('typeof ' + name, sandbox), 'undefined', name);
  }
  assert.ok(Object.isFrozen(model), 'the exported surface is frozen');
});

test('cm01 every valid vector: the client model accepts it and its section states are the vector states', () => {
  assert.ok(Object.keys(VALID).length >= 30);
  for (const [name, answer] of Object.entries(VALID)) {
    assert.equal(model.shapeError(clone(answer)), null, name);
    assert.deepEqual(plain(model.states(clone(answer), {})), VECTORS.expect[name].sections, name);
  }
});

test('cm01 every valid vector: the compiled server shape check accepts it', { skip: serverSkip }, () => {
  for (const [name, answer] of Object.entries(VALID)) assert.equal(server.clinicalContextShapeError(clone(answer)), null, name);
});

test('cm02 every malformed vector: the client model refuses it, and it is one change away from an accepted answer', () => {
  assert.ok(Object.keys(MALFORMED).length >= 25);
  for (const [name, entry] of Object.entries(MALFORMED)) {
    assert.ok(VALID[entry.derivedFrom], name + ' derives from a valid vector');
    assert.notEqual(model.shapeError(clone(entry.answer)), null, name);
    assert.notDeepEqual(entry.answer, VALID[entry.derivedFrom], name + ' is not its original');
  }
});

test('cm02 every malformed vector: the compiled server shape check refuses it', { skip: serverSkip }, () => {
  for (const [name, entry] of Object.entries(MALFORMED)) assert.notEqual(server.clinicalContextShapeError(clone(entry.answer)), null, name);
});

/** Every plain object inside a value, with the path that reaches it. */
function objects(value, at = 'answer', out = []) {
  if (Array.isArray(value)) value.forEach((item, i) => objects(item, at + '[' + i + ']', out));
  else if (value && typeof value === 'object') {
    out.push([at, value]);
    for (const [key, item] of Object.entries(value)) objects(item, at + '.' + key, out);
  }
  return out;
}
/** Run judge() on every one-key variant of every object of every valid vector: one unknown key added, one key removed. */
function eachVariant(visit) {
  for (const [name, original] of Object.entries(VALID)) {
    const answer = clone(original);
    for (const [at, object] of objects(answer)) {
      object.synUnknownKey = 'SYN';
      visit(name + ' ' + at + ' + synUnknownKey', answer);
      delete object.synUnknownKey;
      for (const key of Object.keys(object)) {
        const kept = object[key];
        delete object[key];
        visit(name + ' ' + at + ' - ' + key, answer);
        object[key] = kept;
      }
    }
    assert.deepEqual(answer, original, name + ' restored after its variants');
  }
}

test('cm02b one key added or removed anywhere in a valid vector: the client model refuses every variant', () => {
  let variants = 0;
  eachVariant((label, answer) => { variants += 1; assert.notEqual(model.shapeError(answer), null, label); });
  assert.ok(variants > 1000, 'variants: ' + variants);
});

test('cm02b the same variants: the compiled server refuses every one, so the two closed key lists are one', { skip: serverSkip }, () => {
  eachVariant((label, answer) => {
    assert.notEqual(server.clinicalContextShapeError(answer), null, label);
    assert.notEqual(model.shapeError(answer), null, label);
  });
});

test('cm03 "No clinical information provided." is true only when all four sections were read and are absent', () => {
  for (const [name, answer] of Object.entries(VALID)) {
    assert.equal(model.noInformation(clone(answer), {}), VECTORS.expect[name].noInformation, name);
  }
  // the pair: the same answer but for one section that was not read (derived objects only)
  assert.equal(model.noInformation(clone(VALID['A-ABSENT4']), {}), true);
  assert.equal(model.noInformation(clone(VALID['A-TAGS-NC']), {}), false);
  // a stale absent section is not "none" either (CC-D02), whichever way it became stale
  for (const reason of ['list_changed', 'refresh_failed']) {
    assert.equal(model.noInformation(clone(VALID['A-ABSENT4']), { techNote: reason }), false, reason);
    assert.equal(plain(model.states(clone(VALID['A-ABSENT4']), { techNote: reason })).techNote, 'stale', reason);
  }
  assert.deepEqual(Object.entries(VECTORS.expect).filter(([, value]) => value.noInformation).map(([name]) => name), ['A-ABSENT4']);
});

test('cm04 the §8.1 comparison over every stale case, in the order the observations arrive', () => {
  assert.ok(VECTORS.stale_cases.length >= 25);
  for (const item of VECTORS.stale_cases) {
    const answer = clone(VALID[item.answer]);
    let stale = {};
    for (const listName of item.observations) stale = plain(model.staleAfter(answer, clone(VECTORS.lists[listName]), stale));
    const marks = Object.fromEntries(model.SECTIONS.map(name => [name, stale[name] || null]));
    assert.deepEqual(marks, item.expect, item.id);
    const shown = plain(model.states(answer, stale));
    for (const name of model.SECTIONS) {
      const expected = item.expect[name] ? 'stale' : VECTORS.expect[item.answer].sections[name];
      assert.equal(shown[name], expected, item.id + ' ' + name);
    }
    if (Object.values(item.expect).some(Boolean)) assert.equal(model.noInformation(answer, stale), false, item.id);
  }
});

test('cm04 a mark stays until a new answer; a failed re-read marks only sections that were read', () => {
  const answer = clone(VALID['A-PRESENT-OWNER']);
  const changed = plain(model.staleAfter(answer, clone(VECTORS.lists['L-Y-ADDENDUM']), {}));
  const back = plain(model.staleAfter(answer, clone(VECTORS.lists['L-SAME-LATER']), changed));
  assert.deepEqual(back, changed, 'a later observation back at the old values does not unmark (T-16)');
  const mixed = clone(VALID['A-MIXED']);   // present requestTags, absent techNote, not_configured prior, failed history
  const kept = plain(model.refreshFailed(mixed, {}));
  assert.deepEqual(Object.fromEntries(model.SECTIONS.map(name => [name, kept[name] || null])),
    { priorReports: null, history: null, requestTags: 'refresh_failed', techNote: 'refresh_failed' });
  // a section already marked by the list keeps that cause
  const both = plain(model.refreshFailed(answer, { history: 'list_changed' }));
  assert.equal(both.history, 'list_changed');
  assert.equal(both.priorReports, 'refresh_failed');
});

test('cm04 D-1 (T-15): a list row that differs from the answer in either direction marks the section - no change is hidden', () => {
  const answer = clone(VALID['A-PRESENT-OWNER']);
  const base = VECTORS.lists['L-SAME'];
  for (const item of answer.sections.history.items) {
    for (const [field, values] of [['version', [item.reading.reportVersion - 1, item.reading.reportVersion + 1]],
      ['rs', ['W', 'T', 'P', 'H', 'A'].filter(rs => rs !== item.reading.rs)]]) {
      for (const value of values) {
        const list = clone(base);
        list.studies.find(row => row.uid === item.studyUid).state[field] = value;
        const marks = plain(model.staleAfter(answer, list, {}));
        assert.equal(marks.history, 'list_changed', item.studyUid + ' ' + field + ' ' + value);
        if (item.reading.signed) assert.equal(marks.priorReports, 'list_changed', item.studyUid + ' ' + field + ' ' + value);
      }
    }
  }
  // the same observation read at or before the answer is not compared
  const early = clone(base);
  early.observation.observedAt = answer.observedAt;
  early.studies[1].state.version = 99;
  assert.deepEqual(plain(model.staleAfter(answer, early, {})), {});
});

test('cm05 the section texts, labels and permission badges are the contract texts', () => {
  const T = TEXTS;
  const view = (name, stale) => plain(model.view(clone(VALID[name]), stale || {}, { format: FORMAT, actor: value => value }));
  const main = view('A-PRESENT-OWNER');
  assert.deepEqual(main.sections.map(s => s.title), Object.values(T.sectionTitles));
  assert.deepEqual(main.sections.map(s => s.count), ['(2)', '(3)', '(2)', '(1)']);
  for (const section of main.sections) {
    const source = VALID['A-PRESENT-OWNER'].sections[section.name];
    assert.equal(section.label, '', section.name);
    assert.equal(section.description, fill(T.present, { observedAt: FORMAT(source.observedAt), sourceLabel: T.sourceLabels[section.name] }));
  }
  assert.deepEqual(view('A-TRUNC').sections.slice(0, 2).map(s => s.count), ['(10+)', '(200+)']);
  const absent = view('A-ABSENT4');
  for (const section of absent.sections) {
    assert.equal(section.label, T.stateLabels.absent);
    assert.equal(section.description, fill(T.absent, { observedAt: FORMAT(VALID['A-ABSENT4'].sections[section.name].observedAt) }));
  }
  assert.ok(absent.sections[2].checked.startsWith(T.checkedPrefix));
  const nokey = view('A-NOKEY').sections;
  assert.deepEqual([nokey[0].label, nokey[0].description], [T.stateLabels.not_configured, T.notConfigured.no_patient_key]);
  const tagsNc = view('A-TAGS-NC').sections[2];
  assert.deepEqual([tagsNc.label, tagsNc.description, tagsNc.checked], [T.stateLabels.not_configured,
    T.notConfigured.no_original_instance, null]);
  const failedTexts = ['UNAVAILABLE', 'INVALID', 'ROWMISSING'].map(suffix => {
    const section = view('A-FAILED-PH-' + suffix).sections[0];
    assert.equal(section.label, T.stateLabels.failed);
    assert.equal(section.retry, true);
    assert.ok(section.description.startsWith(T.failed + ' '), section.description);
    return section.description;
  });
  assert.equal(new Set(failedTexts).size, 3, 'each source failure reason has its own sentence');
  for (const cause of ['list_changed', 'refresh_failed']) {
    const stale = view('A-PRESENT-OWNER', { history: cause }).sections[1];
    assert.equal(stale.label, T.stateLabels.stale);
    assert.equal(stale.description, fill(T.stale, { observedAt: FORMAT(VALID['A-PRESENT-OWNER'].sections.history.observedAt),
      cause: T.staleCauses[cause] }));
  }
  // permission basis: every item of the four sections, owner and tele, with the anchor institution in the tooltip
  for (const [name, access] of [['A-PRESENT-OWNER', 'owner'], ['A-PRESENT-TELE', 'tele']]) {
    const badge = { text: T.access[access].label, title: fill(T.access[access].title, { institutionName: VALID[name].anchor.institutionName }), badge: true };
    for (const section of view(name).sections) {
      for (const item of section.items) assert.deepEqual([...item.line, ...item.source].filter(part => part.badge), [badge], name + ' ' + section.name);
    }
  }
  // a header has no recording time: "-" with the reason as its tooltip
  const tagItem = view('A-PRESENT-OWNER').sections[2].items[0];
  assert.ok(tagItem.source.some(part => part.text.endsWith(' -') && part.title === T.recordedAtNone), JSON.stringify(tagItem.source));
  // D8 marker sentence and the row marks (K-8)
  for (const [name, fields] of [['A-CONFLICT-BIRTH', 'birth'], ['A-CONFLICT-SEX', 'sex'], ['A-CONFLICT-BOTH', 'both']]) {
    const shown = view(name);
    assert.deepEqual(shown.conflict, { title: T.conflictTitle, text: fill(T.conflict, { fields: T.conflictFields[fields] }) }, name);
    const rowMarks = shown.sections[1].items.flatMap(item => item.marks);
    if (fields !== 'sex') assert.ok(rowMarks.includes(T.marks.birth), name);
    if (fields !== 'birth') assert.ok(rowMarks.includes(T.marks.sex), name);
  }
  assert.equal(view('A-PRESENT-OWNER').conflict, null);
  assert.ok(view('A-TAG-NOTTEXT').sections[2].items[0].line[0].text.endsWith(': ' + T.tagNotes.not_text));
  assert.ok(view('A-TAG-TOOLONG').sections[2].items[0].line[0].text.endsWith(': ' + T.tagNotes.too_long));
  assert.ok(view('A-TAG-MAXLEN').sections[2].items[0].line[0].text.endsWith(': ' + VALID['A-TAG-MAXLEN'].sections.requestTags.items[0].value));
  assert.ok(view('A-TN-EMPTY').sections[3].items[0].line.some(part => part.text === T.noText));
  assert.ok(!view('A-PRESENT-OWNER').sections[3].items[0].line.some(part => part.text === T.noText));
});

test('cm05 whole-answer failures: the closed reasons, OP-1 for the statuses §7.1 does not name, and one sentence each', () => {
  const cases = [
    [{ status: 404 }, 'not_visible', false], [{ status: 403, code: 'CLINICAL_CONTEXT_ROLE' }, 'forbidden', false],
    [{ status: 403, code: 'CLINICIAN_ROUTE_DENIED' }, 'forbidden', false],
    [{ status: 409, code: 'CLINICAL_CONTEXT_CHANGED' }, 'changed', false], [{ status: 409, code: 'STUDY_ACCESS_CHANGED' }, 'changed', false],
    [{ status: 503, code: 'CLINICAL_CONTEXT_BUSY' }, 'busy', true], [{ status: 503 }, 'busy', true],
    [{ status: 500 }, 'network', true], [{ status: 502 }, 'network', true], [{ status: 504 }, 'network', true],
    [{ status: 400, code: 'CLINICAL_CONTEXT_INPUT_INVALID' }, 'malformed', false], [{ status: 422 }, 'malformed', false],
    [Object.assign(new TypeError('Failed to fetch')), 'network', true],
    [Object.assign(new SyntaxError('Unexpected token')), 'malformed', false],
  ];
  const sentences = new Map();
  for (const [error, reason, keep] of cases) {
    const failed = plain(model.failure(error));
    assert.deepEqual([failed.reason, failed.keep], [reason, keep], JSON.stringify(error) + ' ' + error.name);
    const summary = plain(model.failedSummary(failed));
    assert.equal(summary.label, TEXTS.stateLabels.failed);
    if (error.status) assert.ok(summary.text.includes('HTTP ' + error.status), summary.text);
    if (error.code) assert.ok(summary.text.includes(error.code), summary.text);
    sentences.set(reason, summary.text.replace(/ \(.*\)$/, ''));
  }
  assert.equal(sentences.get('changed'), TEXTS.changed);
  assert.equal(new Set(sentences.values()).size, 6, 'six screen reasons, six sentences');
  const avoided = new RegExp(TEXTS.avoided, 'i');
  for (const text of sentences.values()) assert.doesNotMatch(text, avoided, text);
  // after a failed re-read the kept answer says so, and the empty sentence never stands for it
  const kept = plain(model.summary(clone(VALID['A-ABSENT4']), model.refreshFailed(clone(VALID['A-ABSENT4']), {}), model.failure({ status: 503 })));
  assert.equal(kept.label, TEXTS.stateLabels.stale);
  assert.notEqual(kept.text, TEXTS.noInformation);
  assert.equal(plain(model.summary(clone(VALID['A-ABSENT4']), {}, null)).text, TEXTS.noInformation);
});

test('cm05 the panel\'s own sentences use no avoided word (DICOM keywords, tag values and report text are source strings)', () => {
  const avoided = new RegExp(TEXTS.avoided, 'i');
  const keywords = ['ReasonForStudy', 'ReasonForTheRequestedProcedure', 'AdditionalPatientHistory', 'AdmittingDiagnosesDescription', 'StudyComments'];
  const scrub = text => keywords.reduce((out, keyword) => out.split(keyword).join(''), text);
  for (const [name, answer] of Object.entries(VALID)) {
    for (const stale of [{}, model.refreshFailed(clone(answer), {})]) {
      const shown = plain(model.view(clone(answer), stale, { format: FORMAT }));
      const own = [shown.conflict && shown.conflict.text, shown.conflict && shown.conflict.title];
      for (const section of shown.sections) {
        own.push(section.title, section.label, section.description, section.checked && scrub(section.checked));
        for (const item of section.items) for (const part of [...item.line, ...item.source]) if (part.badge) own.push(part.text, part.title);
      }
      for (const text of own.filter(Boolean)) assert.doesNotMatch(text, avoided, name + ': ' + text);
    }
  }
});

test('cm06 forbidden key fragments and exact keys at every layer: the client model refuses them', () => {
  for (const [label, answer] of forbiddenVariants()) assert.notEqual(model.shapeError(answer), null, label);
  assert.equal(model.shapeError(clone(VALID['A-PRESENT-OWNER'])), null);
});

test('cm06 the same variants: the compiled server refuses them', { skip: serverSkip }, () => {
  for (const [label, answer] of forbiddenVariants()) assert.notEqual(server.clinicalContextShapeError(answer), null, label);
  assert.equal(server.clinicalContextShapeError(clone(VALID['A-PRESENT-OWNER'])), null);
});

function forbiddenVariants() {
  const out = [];
  const keys = [...TEXTS.forbiddenKeyFragments.flatMap(fragment => [fragment, 'syn' + fragment[0].toUpperCase() + fragment.slice(1)]),
    ...TEXTS.forbiddenKeysExact];
  const layers = [['answer', a => a], ['anchor', a => a.anchor], ['sections', a => a.sections], ['history', a => a.sections.history],
    ['history item', a => a.sections.history.items[0]], ['history study', a => a.sections.history.items[0].study],
    ['prior item', a => a.sections.priorReports.items[0]], ['prior report', a => a.sections.priorReports.items[0].report],
    ['tag item', a => a.sections.requestTags.items[0]], ['tech note item', a => a.sections.techNote.items[0]],
    ['provenance', a => a.sections.history.items[0].provenance]];
  assert.equal(keys.length, 26);
  for (const key of keys) {
    for (const [layer, pick] of layers) {
      const answer = clone(VALID['A-PRESENT-OWNER']);
      pick(answer)[key] = 'SYN-ORDER-SENTINEL';
      out.push([layer + ' ' + key, answer]);
    }
  }
  return out;
}

test('cm08 request-context vectors: a valid answer about another study is accepted by the client shape check', () => {
  assert.ok(Object.keys(CONTEXT).length >= 1);
  for (const [name, entry] of Object.entries(CONTEXT)) {
    assert.equal(model.shapeError(clone(entry.answer)), null, name);
    assert.notEqual(entry.answer.uid, entry.requestedUid, name + ' is about another study than the request');
    assert.equal(VALID[entry.derivedFrom].uid, entry.requestedUid, name + ' derives from the requested study\'s answer');
  }
});

test('cm08 the same vectors: the compiled server shape check accepts them too', { skip: serverSkip }, () => {
  for (const [name, entry] of Object.entries(CONTEXT)) assert.equal(server.clinicalContextShapeError(clone(entry.answer)), null, name);
});
