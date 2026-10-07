'use strict';
/* U5S-REQ-04/08/12: all Job requests pass the page transport. Only authenticated
 * session-end codes terminate the document, including a late response from a panel
 * that changed study or stopped. Ordinary failures preserve the document and inputs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { sessionWorld, response } = require('./viewer_session_fixture.cjs');
const JOBS = fs.readFileSync(process.env.KIN_VIEWER_JOBS_JS || path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'viewer-jobs.js'), 'utf8');
const STUDY = '1.2.840.99.1', OTHER_STUDY = '1.2.840.99.2';
const FIRST = { kind: 'member', institution: 'SYN-INST', sub: 'SYN-READER-1', roles: ['radiologist'] };
const OTHER = { ...FIRST, sub: 'SYN-READER-2' };
// viewer-jobs.js end() and run('list') wording.
const ENDED = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.';
const LISTED = '현재 판독 대상의 저장 작업 목록입니다.';
const element = tag => { const children = []; return { tagName: tag, children, style: {}, dataset: {}, textContent: '', value: '', checked: false,
  disabled: false, hidden: false, isConnected: true, id: '',
  append: (...items) => { children.push(...items); }, prepend: (...items) => { children.unshift(...items); }, insertBefore: item => { children.push(item); },
  replaceChildren: (...items) => { children.splice(0, children.length, ...items); }, setAttribute() {}, remove() {},
  querySelector: selector => children.find(c => c.tagName === selector) || null }; };
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

// A writer document (FIRST confirmed by the other panels) with the Job panel mounted and listing; `hold(url)` names the requests the
// case answers itself.
async function jobsWorld(source = JOBS) {
  const reasons = [], held = [], log = [];
  let hold = () => false;
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
  const world = sessionWorld(sandbox, fetch), session = world.session;
  assert.equal(session.note(FIRST), 'writer');
  session.onEnded(reason => reasons.push(reason));
  let enders = 0; session.writeModule.onEnd(() => { enders++; });
  vm.runInContext(source, world.context, { filename: 'viewer-jobs.js' });
  const grid = { getState: () => ({ viewports: new Map(), layout: { numRows: 1, numCols: 1 }, activeViewportId: null }) };
  const panel = sandbox.kinViewerJobs({ viewportGridService: grid, cornerstoneViewportService: {}, displaySetService: { getActiveDisplaySets: () => [] } },
    { scope: () => ({}) }, session.writeModule);
  panel.mount();
  await tick();
  const find = (root, match) => match(root) ? root : root.children.map(c => find(c, match)).find(Boolean) || null;
  const status = () => find(layout, e => e.id === 'kin-viewer-jobs-status').textContent;
  assert.equal(status(), LISTED, 'the panel works for the document\'s account');
  return { session, end: world.end, reasons, held, log, enders: () => enders, holdWhen: fn => { hold = fn; }, sandbox, panel, status,
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
// Lose the study, end the bound session, or exit the mode before the response arrives.
function letGo(w, drop) {
  if (drop === 'screen') w.sandbox.location.search = '?StudyInstanceUIDs=' + OTHER_STUDY;
  else if (drop === 'end') w.end();
  else w.panel.stop();
}

test('U5 Job: coded end on a late request ends the session once, even after panel departure', async () => {
  for (const drop of ['screen', 'end', 'exit']) {
    for (const [status, code] of [[401, 'AUTH_SESSION_ENDED'], [403, 'AUTH_SESSION_MISMATCH'], [409, 'AUTH_SESSION_MISMATCH']]) {
      for (const at of ['/me', 'list read']) {
        const w = await jobsWorld(), { run } = await heldRead(w, at);
        letGo(w, drop); await tick();
        const seen = w.view(), asked = w.log.length;
        w.held[0].release(status, { code }); await run; await tick();
        assert.equal(w.session.state(), 'refused', [drop, code, at].join('/'));
        assert.equal(w.reasons.length, 1);
        assert.equal(w.enders(), 1);
        assert.equal(w.log.length, asked);
        if (drop === 'screen') assert.equal(w.status(), ENDED);
        else assert.equal(w.view(), seen);
        assert.equal(w.session.writeModule.answer(FIRST), false);
      }
    }
  }
});

test('U5 Job: plain failures, including dropped answers, do not end the document and retry works', async () => {
  for (const departed of [false, true]) for (const at of ['/me', 'list read']) {
    for (const status of [401, 403, 409, 428, 500, 503]) {
      const w = await jobsWorld(), { run } = await heldRead(w, at);
      if (departed) letGo(w, 'screen');
      w.held[0].release(status, { message: 'Synthetic failure' }); await run; await tick();
      assert.deepEqual([w.session.state(), w.reasons.length, w.enders()], ['writer', 0, 0]);
      assert.notEqual(w.status(), ENDED, 'a plain refusal must not end the viewer panel');
      w.sandbox.location.search = '?StudyInstanceUIDs=' + STUDY;
      await w.refresh(); await tick();
      assert.equal(w.status(), LISTED);
    }
  }
});

test('U5 Job: a current matching identity proceeds; invalid or dropped identities never globally end work', async () => {
  for (const [body, bad] of [[FIRST, false], [{ ...FIRST, roles: ['clinician'] }, false], [OTHER, false], [null, true]]) {
    const w = await jobsWorld(), { run } = await heldRead(w, '/me');
    letGo(w, 'screen'); w.held[0].release(200, body, bad); await run; await tick();
    assert.deepEqual([w.session.state(), w.reasons.length, w.enders()], ['writer', 0, 0]);
  }
  const w = await jobsWorld(), { run } = await heldRead(w, '/me');
  w.held[0].release(200, FIRST); await run; await tick();
  assert.equal(w.status(), LISTED);
  assert.equal(w.session.state(), 'writer');
});

test('U5INT-F01: temporary coded refusal preserves the job panel and its retry', async () => {
  for (const code of ['AUTH_IDP_UNAVAILABLE', 'AUTH_SESSION_BUSY', 'AUTH_STORAGE_FAILURE']) {
    for (const at of ['/me', 'list read']) {
      const w = await jobsWorld(), { run } = await heldRead(w, at);
      w.held[0].release(403, { code }); await run; await tick();
      assert.match(w.status(), /연결을 확인하지 못했습니다/);
      assert.doesNotMatch(w.status(), /권한|거절/);
      assert.deepEqual([w.session.state(), w.enders()], ['writer', 0]);
      await w.refresh(); await tick();
      assert.equal(w.status(), LISTED);
    }
  }
});
