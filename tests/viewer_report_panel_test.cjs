'use strict';
/* A3 unit 20 (card C-R01-139 steps 24-26): the viewer window's Report Editor tab, pure parts.
 * Which text the read-only mirror shows (hiding first, then Live > My Draft > saved), when a late answer is
 * dropped, how an Open in Reading Screen request and its answer are checked on both sides, and the dock's
 * stored panel value. The panel's DOM, the dock and the real channel run in viewer_report_panel_dom_test.py. */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const panel = require('../worklist-v0/hpacs-lite/viewer-report-panel.js');
const link = require('../worklist-v0/hpacs-lite/viewer-editor-link.js');
const windows = require('../worklist-v0/hpacs-lite/viewer-windows.js');

const UID = '1.2.826.0.1.3680043.10.7707.1', OTHER = '1.2.826.0.1.3680043.10.7707.2';
const KEY = 'SYN-INST|SYN-P-001';
const OWNER = JSON.stringify(['SYN-INST', 'SYN-SUB']);
const REQUEST = '11111111-2222-4333-8444-555555555555';
const row = state => ({ uid: UID, sourcePatientKey: KEY, name: 'SYN PATIENT', id: 'SYN-P-001', modality: 'MG',
  state: Object.assign({ rs: 'W', version: 0, findings: '', conclusion: '', recommendation: '', prelimHidden: false, draft: null,
    repDoc: null, confirm: null }, state) });
const text = (f, c = 'C', r = 'R') => ({ findings: f, conclusion: c, recommendation: r });

test('scopedRow keeps only the row of this study and this patient tab', () => {
  const ok = row({});
  assert.equal(panel.scopedRow([ok], UID, KEY), ok);
  assert.equal(panel.scopedRow([ok], OTHER, KEY), null, 'a UID the server did not answer shows nothing');
  assert.equal(panel.scopedRow([], UID, KEY), null);
  assert.equal(panel.scopedRow([{ ...ok, sourcePatientKey: 'SYN-INST|SYN-P-002' }], UID, KEY), null, 'another patient key');
  assert.equal(panel.scopedRow([{ ...ok, sourcePatientKey: null }], UID, KEY), null);
  assert.equal(panel.scopedRow([ok], UID, null), null, 'a tab without a key');
  assert.equal(panel.scopedRow(null, UID, KEY), null);
  assert.equal(panel.scopedRow([{ ...ok, state: null }], UID, KEY), null);
});

test('choose hides first, then shows Live, My Draft, the saved report or nothing', () => {
  const live = { uid: UID, editor: text('LIVE') };
  const draft = { ...text('DRAFT'), baseVersion: 1, at: '2026-11-11T03:04:00.000Z' };
  // Hidden preliminary: no Live, no draft, no saved text.
  const hidden = panel.choose({ uid: UID, row: row({ prelimHidden: true, rs: 'P', version: 2, findings: '', draft: null }), live });
  assert.equal(hidden.kind, 'hidden');
  assert.equal(hidden.source, 'Hidden — 다른 판독의의 예비 판독(RS: P)입니다');
  assert.deepEqual(hidden.fields, text('', '', ''));
  // No row (missing UID or another patient's key) shows nothing, even with a Live answer.
  const none = panel.choose({ uid: UID, row: null, live });
  assert.equal(none.kind, 'none');
  assert.deepEqual(none.fields, text('', '', ''));
  assert.equal(none.source, 'No Report — 이 검사에는 아직 판독문이 없습니다');
  // Live beats the draft and the saved version.
  const all = row({ version: 3, rs: 'T', ...text('SAVED'), draft });
  assert.deepEqual(panel.choose({ uid: UID, row: all, live }), { kind: 'live', source: 'Live — 판독 화면에서 쓰는 중인 글', fields: text('LIVE') });
  // A Live answer about another study is not this study's text.
  assert.equal(panel.choose({ uid: UID, row: all, live: { uid: OTHER, editor: text('X') } }).kind, 'draft');
  const mine = panel.choose({ uid: UID, row: all, live: null });
  assert.equal(mine.kind, 'draft');
  assert.match(mine.source, /^My Draft — 서버에 저장된 내 초안 \(저장 \d\d:\d\d\)$/);
  assert.deepEqual(mine.fields, text('DRAFT'));
  assert.equal(panel.choose({ uid: UID, row: row({ version: 3, rs: 'T', ...text('SAVED') }) }).source, 'Saved — v3');
  const approved = panel.choose({ uid: UID, row: row({ version: 2, rs: 'A', repDoc: 'SYN DOCTOR', confirm: '2026-11-10 09:00', ...text('FINAL') }) });
  assert.equal(approved.kind, 'approved');
  assert.equal(approved.source, 'Approved — SYN DOCTOR · 2026-11-10 09:00');
  assert.deepEqual(approved.fields, text('FINAL'));
  assert.equal(panel.choose({ uid: UID, row: row({}) }).kind, 'none');
  // Only the three fields are carried over.
  assert.deepEqual(Object.keys(panel.choose({ uid: UID, row: row({ draft: { ...draft, secret: 'x' } }) }).fields), panel.FIELDS);
});

test('current drops an answer when any of uid, sequence, request, session or list changed', () => {
  const ticket = { uid: UID, sequence: 4, request: 7, session: '["S"]', list: 'g l' };
  assert.equal(panel.current(ticket, { ...ticket }), true);
  for (const [key, value] of [['uid', OTHER], ['sequence', 5], ['request', 8], ['session', '["T"]'], ['list', 'g m']])
    assert.equal(panel.current(ticket, { ...ticket, [key]: value }), false, key);
  assert.equal(panel.current(ticket, null), false);
  assert.equal(panel.current(null, ticket), false);
  assert.equal(panel.current({ ...ticket, uid: null }, { ...ticket, uid: null }), false);
});

test('heading, state word and the Open in Reading Screen sentences', () => {
  assert.equal(panel.heading({ name: 'PARK JIYOUNG', id: 'SYN-P-001' }, { modality: 'MG' }), 'PARK JIYOUNG · SYN-P-001 · MG');
  assert.equal(panel.heading({ name: 'PARK JIYOUNG', id: 'SYN-P-001' }, null), 'PARK JIYOUNG · SYN-P-001');
  assert.deepEqual(['W', 'T', 'P', 'H', 'A'].map(rs => panel.word({ state: { rs } })), ['Unread', 'In Progress', 'Preliminary', 'On Hold', 'Approved']);
  assert.equal(panel.openText({ ok: true }, 'PARK JIYOUNG'), '판독 화면이 PARK JIYOUNG 검사로 옮겨졌습니다 — 판독 화면 창에서 입력하세요.');
  assert.equal(panel.openText({ ok: false, reason: 'missing' }), '연결된 판독 화면이 없습니다. 목록 창에서 이 검사를 고르면 판독문을 쓸 수 있습니다.');
  assert.match(panel.openText({ ok: false, reason: 'timeout' }), /^판독 화면의 응답이 없습니다\./);
  assert.equal(panel.openText({ ok: false, reason: 'saving' }), '판독 화면이 검사를 옮기지 못했습니다 (쓰던 글 저장 대기·거절). 판독 화면에서 확인하세요.');
  assert.equal(panel.openText({ ok: false, reason: 'invalid' }), '판독 화면이 검사를 옮기지 못했습니다 (확인할 수 없는 답). 판독 화면에서 확인하세요.');
  for (const reason of link.OPEN_REFUSALS) assert.ok(panel.OPEN_REASONS[reason], reason);
});

test('validOpened reads only the answer to this request, owner and study', () => {
  const expected = { request: REQUEST, owner: OWNER, uid: UID };
  const answer = extra => Object.assign({ type: 'kin-editor-opened', request: REQUEST, owner: OWNER, uid: UID, result: 'ok', reason: null }, extra);
  assert.deepEqual(link.validOpened(answer(), expected), { ok: true });
  assert.deepEqual(link.validOpened(answer({ result: 'refused', reason: 'saving' }), expected), { ok: false, reason: 'saving' });
  assert.deepEqual(link.validOpened(answer({ result: 'refused', reason: 'nonsense' }), expected), { ok: false, reason: 'invalid' });
  for (const extra of [{ type: 'kin-editor-reply' }, { request: 'x' }, { owner: '["A","B"]' }, { uid: OTHER }, { result: 'maybe' }, { uid: undefined }])
    assert.deepEqual(link.validOpened(answer(extra), expected), { ok: false, reason: 'invalid' }, JSON.stringify(extra));
  assert.deepEqual(link.validOpened(null, expected), { ok: false, reason: 'invalid' });
  assert.deepEqual(link.validOpened(answer(), null), { ok: false, reason: 'invalid' });
  const hostile = { get type() { throw new Error('boom'); } };
  assert.deepEqual(link.validOpened(hostile, expected), { ok: false, reason: 'invalid' });
});

function reader(overrides = {}) {
  const calls = [];
  const state = { owner: OWNER, target: OTHER, listed: [UID, OTHER], modal: false, usable: true, busy: false };
  const field = { id: 'findings' };
  const value = {
    calls, state,
    owner: () => state.owner, busy: () => state.busy, listed: uid => state.listed.includes(uid), modal: () => state.modal,
    target: () => state.target, field: id => (id === 'findings' ? field : null), usable: () => state.usable,
    select: uid => { calls.push(['select', uid]); state.target = uid; return { status: 'clear', uid }; },
    focus: () => calls.push(['focus']),
  };
  return Object.assign(value, overrides);
}
const open = extra => Object.assign({ type: 'kin-editor-open', request: REQUEST, owner: OWNER, uid: UID, list: 'L' }, extra);

test('editorOpen moves through the page select and focuses Findings only after a real move', async () => {
  const r = reader();
  assert.deepEqual(await windows.editorOpen(open(), r), { type: 'kin-editor-opened', request: REQUEST, owner: OWNER, uid: UID, result: 'ok', reason: null });
  assert.deepEqual(r.calls, [['select', UID], ['focus']]);
  // A select that waits for the save and then moves (saved), or a study already selected (same).
  for (const status of ['saved', 'same']) {
    const waits = reader({ select: async uid => { waits.state.target = uid; return { status, uid }; } });
    assert.equal((await windows.editorOpen(open(), waits)).result, 'ok', status);
  }
});

test('editorOpen refuses with the reason and never focuses', async () => {
  const cases = [
    ['session', r => { r.state.owner = '["X","Y"]'; }],
    ['busy', r => { r.state.busy = true; }],
    ['unlisted', r => { r.state.listed = [OTHER]; }],
    ['modal', r => { r.state.modal = true; }],
  ];
  for (const [reason, change] of cases) {
    const r = reader(); change(r);
    assert.deepEqual(await windows.editorOpen(open(), r), { type: 'kin-editor-opened', request: REQUEST, owner: OWNER, uid: UID, result: 'refused', reason });
    assert.deepEqual(r.calls, [], reason + ' asks nothing of the page');
  }
  const statuses = { composing: 'composing', refused: 'saving', unknown: 'saving', conflict: 'saving', owner: 'saving', stale: 'stale',
    stayed: 'stale', unresolved: 'unresolved', gone: 'gone', weird: 'unavailable' };
  for (const [status, reason] of Object.entries(statuses)) {
    const r = reader({ select: uid => { r.calls.push(['select', uid]); return { status, uid }; } });
    const answer = await windows.editorOpen(open(), r);
    assert.deepEqual([answer.result, answer.reason], ['refused', reason], status);
    assert.deepEqual(r.calls, [['select', UID]], status + ' does not focus');
  }
  // Moved, but the target is another study now (a later selection), or the login changed while it waited.
  const elsewhere = reader({ select: () => ({ status: 'clear', uid: UID }) });
  assert.equal((await windows.editorOpen(open(), elsewhere)).reason, 'stale');
  const loggedOut = reader({ select: uid => { loggedOut.state.target = uid; loggedOut.state.owner = '["X","Y"]'; return { status: 'clear' }; } });
  assert.equal((await windows.editorOpen(open(), loggedOut)).reason, 'session');
  const unusable = reader(); unusable.state.usable = false;
  assert.equal((await windows.editorOpen(open(), unusable)).reason, 'unavailable');
  const throws = reader({ select: () => { throw new Error('x'); } });
  assert.equal((await windows.editorOpen(open(), throws)).reason, 'unavailable');
  assert.equal(throws.calls.length, 0);
});

test('editorOpen ignores a malformed request', async () => {
  for (const extra of [{ type: 'kin-editor-request' }, { request: 'not-a-uuid' }, { owner: '' }, { owner: 3 }, { uid: 'abc' }, { uid: '1.' + '2'.repeat(70) }]) {
    const r = reader();
    assert.equal(await windows.editorOpen(open(extra), r), null, JSON.stringify(extra));
    assert.deepEqual(r.calls, []);
  }
  assert.equal(await windows.editorOpen(null, reader()), null);
});

test('the dock stores panel 2 (Report Editor) and still refuses other values', () => {
  global.window = {};
  require('../worklist-v0/hpacs-lite/viewer-workspace-dock.js');
  const normalize = global.window.KinViewerWorkspaceDock.normalize;
  for (const panelValue of [-1, 0, 1, 2])
    assert.deepEqual(normalize({ version: 2, placement: 'bottom', panel: panelValue, autoHide: false }),
      { version: 2, placement: 'bottom', panel: panelValue, autoHide: false });
  for (const panelValue of [3, -2, '2', 1.5, null])
    assert.equal(normalize({ version: 2, placement: 'bottom', panel: panelValue, autoHide: false }), null, String(panelValue));
  delete global.window;
});
