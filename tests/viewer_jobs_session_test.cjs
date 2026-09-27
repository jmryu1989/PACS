'use strict';
/* S5-U2c fix4 (Astra S5-U2c-C-R-001 F01) at the Job panel's own requests (worklist-v0/hpacs-lite/viewer-jobs.js api()).
 * fix3's rule for the viewer document's session: a 401, or a /me answer of another account than the document's first one, is the
 * document's end whichever part of the viewer asked it and whether or not that part still uses the answer. Here the answer reaches
 * a panel that let its request go: the viewer shows other studies (live() false, the panel not ended yet), the document refused
 * this account first (another panel's /me 403 ends the panel in place), or mode exit stopped the panel. The document's login ends
 * ('unauthorized' / 'account-changed', promoted once over the refusal); the panel applies none of it, a panel that ended or was
 * stopped shows nothing new, and the write modules' in-place end (enders) is not run again.
 * The shipped viewer-jobs.js runs in a vm realm with a minimal DOM (the shape tests/viewer_volume_job_capture_test.cjs printWorld
 * mounts it with), handed the shipped kinViewerSession.writeModule sliced from config/ohif.js. The transport holds the requests a
 * case names and does not honour the panel's abort, so an answer already on the wire when the panel let it go still arrives.
 * tests/viewer_note_connection_test.cjs requires this file, so its hosted Validate step runs these cases too. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONFIG = fs.readFileSync(path.join(ROOT, 'config', 'ohif.js'), 'utf8');
const JOBS = fs.readFileSync(path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'viewer-jobs.js'), 'utf8');
const STUDY = '1.2.840.99.1', OTHER_STUDY = '1.2.840.99.2';
const FIRST = { kind: 'member', institution: 'SYN-INST', sub: 'SYN-READER-1', roles: ['radiologist'] };
const OTHER = { ...FIRST, sub: 'SYN-READER-2' };
// viewer-jobs.js end() and run('list') wording.
const ENDED = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.';
const LISTED = '현재 판독 대상의 저장 작업 목록입니다.';
const LATE = { '401': [401, { message: 'SYN unauthorized' }, 'unauthorized'], 'another account': [200, OTHER, 'account-changed'] };

// config/ohif.js kinViewerSession as shipped, in a context without a window or fetch (its logout receivers and decide()'s read stay off).
function viewerSession() {
  const from = CONFIG.indexOf('function kinViewerClinicianOnly('), to = CONFIG.indexOf('function kinCreateViewerLayout()');
  assert.ok(from > 0 && to > from, 'the session anchors are present');
  const context = vm.createContext({});
  vm.runInContext(CONFIG.slice(from, to), context);
  return vm.runInContext('kinViewerSession', context);
}
const element = tag => { const children = []; return { tagName: tag, children, style: {}, dataset: {}, textContent: '', value: '', checked: false,
  disabled: false, hidden: false, isConnected: true, id: '',
  append: (...items) => { children.push(...items); }, prepend: (...items) => { children.unshift(...items); }, insertBefore: item => { children.push(item); },
  replaceChildren: (...items) => { children.splice(0, children.length, ...items); }, setAttribute() {}, remove() {},
  querySelector: selector => children.find(c => c.tagName === selector) || null }; };
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

// A writer document (FIRST confirmed by the other panels) with the Job panel mounted and listing; `hold(url)` names the requests the
// case answers itself.
async function jobsWorld(source = JOBS) {
  const session = viewerSession(), reasons = [], held = [], log = [];
  assert.equal(session.note(FIRST), 'writer');
  session.onEnded(reason => { reasons.push(reason); });
  // Another write module of the document: its in-place end runs once, at the document's first refusal or end.
  let enders = 0; session.writeModule.onEnd(() => { enders++; });
  let hold = () => false;
  const response = (status, body, bad) => ({ status, ok: status >= 200 && status < 300,
    json: async () => { if (bad) throw new SyntaxError('SYN not JSON'); return JSON.parse(JSON.stringify(body)); } });
  const answer = url => url === '/api/me' ? response(200, FIRST)
    : url.startsWith('/api/studies/' + STUDY + '/viewer-jobs?') ? response(200, { jobs: [] }) : response(404, { message: 'SYN not here' });
  const fetch = async url => {
    log.push(url);
    if (!hold(url)) return answer(url);
    return new Promise(resolve => { held.push({ url, release: (status, body, bad) => resolve(response(status, body, bad)) }); });
  };
  const layout = element('details'); layout.append(element('summary'));
  const sandbox = { document: { createElement: element, head: element('head'), querySelector: selector => selector === '#kin-viewer-layout' ? layout : null,
      addEventListener() {}, removeEventListener() {} },
    location: { search: '?StudyInstanceUIDs=' + STUDY, origin: 'https://kin.test', hash: '' }, fetch, crypto, AbortController, URL, URLSearchParams,
    setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; }, clearTimeout,
    // The panel's 1 s check never runs on its own here: a case that leaves the screen sees the answer before any tick would end it.
    setInterval: () => 0, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
  sandbox.window = sandbox.top = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'viewer-jobs.js' });
  const grid = { getState: () => ({ viewports: new Map(), layout: { numRows: 1, numCols: 1 }, activeViewportId: null }) };
  const panel = sandbox.kinViewerJobs({ viewportGridService: grid, cornerstoneViewportService: {}, displaySetService: { getActiveDisplaySets: () => [] } },
    { scope: () => ({}) }, session.writeModule);
  panel.mount();
  await tick();
  const find = (root, match) => match(root) ? root : root.children.map(c => find(c, match)).find(Boolean) || null;
  const status = () => find(layout, e => e.id === 'kin-viewer-jobs-status').textContent;
  assert.equal(status(), LISTED, 'the panel works for the document\'s account');
  return { session, reasons, held, log, enders: () => enders, holdWhen: fn => { hold = fn; }, sandbox, panel, status,
    // Everything the panel shows (texts, values, disabled and hidden controls), as one comparable value.
    view: () => JSON.stringify(layout),
    refresh: () => find(layout, e => e.tagName === 'button' && e.textContent === 'Refresh Jobs').onclick() };
}
// The panel's Refresh Jobs held at its /me or at its list read. Its pending run is handed back inside an object: an async function
// that returned it would itself wait for it.
async function heldRead(w, at) {
  w.holdWhen(at === '/me' ? url => url === '/api/me' : url => url.startsWith('/api/studies/' + STUDY + '/viewer-jobs?'));
  const run = w.refresh(); await tick();
  assert.deepEqual([w.held.length, w.held[0].url.startsWith(at === '/me' ? '/api/me' : '/api/studies/')], [1, true], at);
  w.holdWhen(() => false);
  return { run };
}
// How the panel lets the held request go: the viewer shows other studies (the panel not ended), the document refuses this account
// (another panel's /me 403, which ends the panel in place), or mode exit stops the panel.
function letGo(w, drop) {
  if (drop === 'screen') w.sandbox.location.search = '?StudyInstanceUIDs=' + OTHER_STUDY;
  else if (drop === 'refusal') w.session.refuse('forbidden');
  else w.panel.stop();
}

test('S5-U2c fix4 (a)(b): a late 401 or another account reaching a Job panel that let its request go is the document\'s end; the panel applies none of it', async () => {
  for (const drop of ['screen', 'refusal', 'exit']) {
    for (const late of ['401', 'another account']) {
      for (const at of late === '401' ? ['/me', 'list read'] : ['/me']) {
        const label = [drop, late, at].join(' / ');
        const w = await jobsWorld();
        const { run } = await heldRead(w, at);
        letGo(w, drop); await tick();
        assert.deepEqual([w.session.state(), w.reasons.join(), w.enders()], drop === 'refusal' ? ['refused', 'forbidden', 1] : ['writer', '', 0], label);
        const [status, body, reason] = LATE[late];
        const seen = w.view(), asked = w.log.length;
        w.held[0].release(status, body); await run; await tick();
        assert.deepEqual([w.session.state(), w.reasons.join(), w.enders(), w.log.length],
          ['refused', drop === 'refusal' ? 'forbidden,' + reason : reason, 1, asked], label);
        if (drop === 'screen') assert.equal(w.status(), ENDED, label + ': the document\'s end reaches the panel still mounted');
        else assert.equal(w.view(), seen, label + ': the panel that had ended or stopped shows nothing new');
        const later = []; w.session.onEnded(r => { later.push(r); });
        assert.deepEqual([later.join(), w.enders(), w.session.writeModule.answer(FIRST)], [reason, 1, false], label);
      }
    }
  }
});

test('S5-U2c fix4 (c): what else a dropped answer says changes nothing, and the answers the panel uses go as before', async () => {
  // Off the screen it was asked for: a dropped /me of the document's own account (a writer, or clinician-only) gives no verdict; a
  // dropped /me 403, 500 or body that is not JSON, and a dropped list read's 403, end nothing. Back on that screen the panel lists.
  const cases = [['/me', 200, FIRST, false, 'same account'], ['/me', 200, { ...FIRST, roles: ['clinician'] }, false, 'same account, clinician-only'],
    ['/me', 403, { message: 'SYN forbidden' }, false, '/me 403'], ['/me', 500, { message: 'SYN' }, false, '/me 500'],
    ['/me', 200, null, true, '/me not JSON'], ['list read', 403, { message: 'SYN forbidden' }, false, 'list 403']];
  for (const [at, status, body, bad, label] of cases) {
    const w = await jobsWorld();
    const { run } = await heldRead(w, at);
    letGo(w, 'screen');
    w.held[0].release(status, body, bad); await run; await tick();
    assert.deepEqual([w.session.state(), w.reasons.join(), w.enders()], ['writer', '', 0], label);
    w.sandbox.location.search = '?StudyInstanceUIDs=' + STUDY;
    await w.refresh(); await tick();
    assert.equal(w.status(), LISTED, label + ': the panel works again on its screen');
  }
  // The answers the panel uses: Refresh Jobs' /me answering 401, 403 or another account ends the document with that reason once
  // (the panel in place, nothing more asked); the same account lists.
  for (const [status, body, reason] of [[401, { message: 'SYN' }, 'unauthorized'], [403, { message: 'SYN' }, 'forbidden'], [200, OTHER, 'account-changed']]) {
    const w = await jobsWorld();
    const { run } = await heldRead(w, '/me'), asked = w.log.length;
    w.held[0].release(status, body); await run; await tick();
    assert.deepEqual([w.session.state(), w.reasons.join(), w.enders(), w.status(), w.log.length], ['refused', reason, 1, ENDED, asked], reason);
  }
  const same = await jobsWorld();
  const { run } = await heldRead(same, '/me');
  same.held[0].release(200, FIRST); await run; await tick();
  assert.deepEqual([same.session.state(), same.reasons.join(), same.enders(), same.status(), same.log.at(-1).startsWith('/api/studies/' + STUDY + '/viewer-jobs?')],
    ['writer', '', 0, LISTED, true]);
});

test('S5-U2c fix4 control: with the panel dropping those answers unread (the file before fix4), the late 401 or account is lost', async () => {
  let text = JOBS;
  for (const at of ['if (!live()) throw await drop();', 'if (!live()) throw await drop(value);']) {
    assert.equal(text.split(at).length - 1, 1, at);
    text = text.replace(at, "if (!live()) throw new Error('화면이 변경되었습니다.');");
  }
  for (const [drop, late, at, before] of [['screen', '401', '/me', ['writer', '', 0]], ['screen', '401', 'list read', ['writer', '', 0]],
    ['refusal', '401', '/me', ['refused', 'forbidden', 1]], ['exit', 'another account', '/me', ['writer', '', 0]]]) {
    const w = await jobsWorld(text);
    const { run } = await heldRead(w, at);
    letGo(w, drop); await tick();
    w.held[0].release(...LATE[late].slice(0, 2)); await run; await tick();
    assert.deepEqual([w.session.state(), w.reasons.join(), w.enders()], before, [drop, late, at].join(' / '));
  }
});
