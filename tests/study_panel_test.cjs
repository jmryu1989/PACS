// REQ-WS2/WS7 -> RISK-WS2/WS7 -> TEST-WS2/WS7 (D-01/04/05/06/07/10, A-01).
// This stand-in keeps text selection across blur/focus like a browser; geometry remains an integration check.
const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../worklist-v0/hpacs-lite/study-panel.js');

class Element {
  constructor(doc, tag, type = 1) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = type;
    this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.inert = false; this.disabled = false; this.style = {};
    this.scrollTop = 0; this.scrollLeft = 0; this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
  }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  get hidden() { return this._hidden; }
  set hidden(value) {
    this._hidden = Boolean(value);
    if (value && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  contains(el) { return el === this || this.children.some(child => child.contains(el)); }
  append(el) { el.remove(); this.children.push(el); el.parentNode = this; }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(el, before) {
    el.remove(); const i = this.children.indexOf(before); assert.ok(i >= 0);
    this.children.splice(i, 0, el); el.parentNode = this;
  }
  replaceChild(el, before) { this.insertBefore(el, before); before.remove(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) {
    if (['hidden', 'inert', 'disabled'].includes(name) && this[name]) return '';
    return this.attributes.get(name) ?? null;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim();
      if (/^[a-z][a-z0-9-]*$/i.test(simple)) return this.tagName === simple.toUpperCase();
      const attr = /^\[([\w-]+)(?:\s*=\s*"([^"]*)")?\]$/.exec(simple);
      if (!attr) throw new Error('Unsupported stand-in selector: ' + simple);
      const value = this.getAttribute(attr[1]);
      return attr[2] === undefined ? value !== null : value === attr[2];
    });
  }
  closest(selector) {
    for (let el = this; el; el = el.parentNode) {
      if (el.matches(selector)) return el;
    }
    return null;
  }
  getClientRects() {
    if (!this.isConnected || this.closest('[hidden], [inert]')) return [];
    for (let el = this; el; el = el.parentNode) if (el.style.display === 'none') return [];
    return [{}];
  }
  focus(options) {
    this.lastFocusOptions = options;
    const visibility = this.ownerDocument.defaultView.getComputedStyle(this).visibility;
    if (this.disabled || !this.getClientRects().length || ['hidden', 'collapse'].includes(visibility)) return;
    if (!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) && this.tabIndex < 0 && !this.attributes.has('tabindex')) return;
    const previous = this.ownerDocument.activeElement;
    if (previous === this) return;
    previous?.dispatch('focusout', { relatedTarget: this });
    this.ownerDocument.activeElement = this;
    this.dispatch('focusin', { relatedTarget: previous === this.ownerDocument.body ? null : previous });
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.dispatch('focusout', { relatedTarget: null });
    this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, properties = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    for (let el = this; el; el = el.parentNode) {
      for (const fn of el.listeners.get(type) || []) fn(event);
      if (event.stopped) break;
    }
    return event;
  }
}
function fixture(options = {}) {
  const doc = { createElement: tag => new Element(doc, tag), createComment: () => new Element(doc, '#comment', 8) };
  doc.defaultView = { getComputedStyle(el) {
    for (let at = el; at; at = at.parentNode) if (at.style.visibility) return { visibility: at.style.visibility };
    return { visibility: 'visible' };
  } };
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body');
  doc.documentElement.append(doc.body); doc.activeElement = doc.body;
  const attach = (tag, parent = doc.body) => { const el = doc.createElement(tag); parent.append(el); return el; };
  const opener = attach('textarea'); opener.value = 'KEEP DRAFT'; opener.setSelectionRange(2, 7, 'backward');
  opener.scrollTop = 123; opener.scrollLeft = 9;
  const fallback = attach('button'), original = attach('div'), host = attach('div'); host.id = 'study-tools';
  const content = Object.fromEntries(['images', 'info', 'templates'].map(name => {
    const el = attach('div', original); el.id = name + '-existing'; return [name, el];
  }));
  const input = attach('input', content.templates), changes = [];
  opener.focus();
  const panel = create({ host, content, fallbackFocus: fallback, onChange: value => changes.push(value), ...options });
  const all = el => [el, ...el.children.flatMap(all)];
  const role = name => all(panel.element).filter(el => (el.getAttribute('role') || (el.tagName === 'ASIDE' ? 'complementary' : null)) === name);
  const tab = name => role('tab').find(el => el.textContent === name);
  const close = all(panel.element).find(el => el.tagName === 'BUTTON' && el.textContent === 'Close');
  return { doc, attach, opener, fallback, original, host, content, input, changes, panel, role, tab, close, all };
}
// The browser's sequential focus (Tab) order inside a subtree: elements with tabIndex >= 0 that can take focus
// (not disabled, rendered, outside hidden/inert subtrees, visible), positive tabIndex first, then document order.
function tabOrder(f, root) {
  const canFocus = el => !el.disabled && el.getClientRects().length > 0
    && !['hidden', 'collapse'].includes(f.doc.defaultView.getComputedStyle(el).visibility);
  const stops = f.all(root).filter(el => el.nodeType === 1 && el.tabIndex >= 0 && canFocus(el));
  return [...stops.filter(el => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...stops.filter(el => el.tabIndex === 0)];
}
function active(f, label) {
  assert.deepEqual(f.role('tab').filter(el => el.getAttribute('aria-selected') === 'true').map(el => el.textContent), [label]);
  assert.deepEqual(f.role('tab').filter(el => el.tabIndex === 0).map(el => el.textContent), [label]);
  const visible = f.role('tabpanel').filter(el => !el.hidden && !el.inert);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, f.tab(label).getAttribute('aria-controls'));
  assert.equal(visible[0].getAttribute('aria-labelledby'), f.tab(label).id);
}

test('D-01/A-01: 기본 닫힘, 세 탭 중 하나 활성, 열기/닫기와 마지막 탭', () => {
  const f = fixture();
  assert.deepEqual(f.panel.snapshot(), { open: false, tab: 'info' });
  assert.equal(f.panel.element.hidden, true); assert.equal(f.panel.element.inert, true);
  assert.equal(f.panel.element.getAttribute('aria-label'), 'Study Panel');
  assert.equal(f.role('complementary').length, 1);
  assert.equal(f.role('tablist').length, 1); assert.equal(f.role('tab').length, 3); active(f, 'Info');
  assert.equal(f.doc.activeElement, f.opener);
  f.panel.open(); assert.equal(f.panel.element.hidden, false); assert.equal(f.doc.activeElement, f.tab('Info'));
  f.tab('Templates').dispatch('click'); active(f, 'Templates');
  f.close.dispatch('click'); assert.equal(f.panel.element.hidden, true); assert.equal(f.doc.activeElement, f.opener);
  f.panel.toggle(); active(f, 'Templates'); assert.equal(f.doc.activeElement, f.tab('Templates'));
  f.panel.toggle(); assert.equal(f.panel.snapshot().open, false);
  assert.deepEqual(f.changes.map(v => v.open), [true, true, false, true, false]);
});

test('A-01: 좌우 순환, Home/End 자동 활성화, Tab/Shift+Tab 비가로채기', () => {
  const f = fixture(); f.panel.open();
  for (const [key, expected] of [['ArrowLeft', 'Images'], ['ArrowLeft', 'Templates'],
    ['ArrowRight', 'Images'], ['ArrowRight', 'Info'], ['End', 'Templates'], ['Home', 'Images']]) {
    const event = f.doc.activeElement.dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    active(f, expected); assert.equal(f.doc.activeElement, f.tab(expected));
  }
  for (const properties of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'ArrowDown' },
    { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', isComposing: true }]) {
    const event = f.doc.activeElement.dispatch('keydown', properties);
    assert.equal(event.defaultPrevented, false); active(f, 'Images');
  }
  f.opener.focus(); assert.equal(f.doc.activeElement, f.opener); assert.equal(f.panel.snapshot().open, true);
});

test('D-04: drawer 내부에서 중복 열기/탭 변경 뒤 편집기 자체의 최신 위치 보존', () => {
  const f = fixture(); f.panel.open('info'); f.panel.open('templates');
  f.opener.setSelectionRange(0, 0, 'none'); f.opener.scrollTop = 0; f.opener.scrollLeft = 0;
  const event = f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
  assert.deepEqual([f.opener.selectionStart, f.opener.selectionEnd, f.opener.selectionDirection], [0, 0, 'none']);
  assert.equal(f.opener.scrollTop, 0); assert.equal(f.opener.scrollLeft, 0); assert.equal(f.opener.value, 'KEEP DRAFT');
});

function editorState(el) {
  return [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection, el.scrollTop, el.scrollLeft];
}
function typeText(el, text) {
  const start = el.selectionStart;
  el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd);
  el.setSelectionRange(start + text.length, start + text.length, 'none');
}
function resumeEditing(f) {
  f.opener.focus(); f.opener.setSelectionRange(10, 10, 'none'); typeText(f.opener, ' typed');
  f.opener.scrollTop = 400; f.opener.scrollLeft = 25;
}

test('W3M-F01: 편집기로 돌아와 입력 후 모든 닫힘 경로에서 최신 본문·caret·선택·스크롤 보존', () => {
  const endings = [f => f.panel.toggle(), f => f.panel.close(),
    f => f.close.dispatch('click'),
    f => { f.close.focus(); f.close.dispatch('click'); },
    f => { f.tab('Info').focus(); f.tab('Info').dispatch('keydown', { key: 'Escape' }); },
    f => f.panel.restore({ open: false, tab: 'images' }), f => f.panel.destroy()];
  for (const end of endings) for (const selection of [false, true]) {
    const f = fixture(); f.panel.open('info'); resumeEditing(f);
    if (selection) f.opener.setSelectionRange(9, 14, 'backward');
    const before = editorState(f.opener); end(f);
    assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
    assert.deepEqual(editorState(f.opener), before);
    if (!selection) { typeText(f.doc.activeElement, '!'); assert.equal(f.opener.value, before[0] + '!'); }
  }
});

test('W3M-F01: 다른 입력란에서 toggle/restore/destroy해도 포커스·선택 유지', () => {
  for (const end of [f => f.panel.toggle(), f => f.panel.restore({ open: false, tab: 'info' }),
    f => f.panel.destroy()]) {
    const f = fixture(), search = f.attach('input');
    search.value = 'query'; search.setSelectionRange(1, 3, 'forward');
    f.panel.open(); search.focus(); const before = editorState(f.opener), searchBefore = editorState(search);
    end(f); assert.equal(f.doc.activeElement, search);
    assert.deepEqual(editorState(f.opener), before); assert.deepEqual(editorState(search), searchBefore);
    // A later open must not reuse the editor record discarded by closing.
    if (f.panel.open()) { f.panel.close(); assert.equal(f.doc.activeElement, search); }
  }
});

test('W3M-F01: 재진입·중복 open·select·restore(open)는 최신 외부 opener를 기록', () => {
  for (const enter of [f => f.tab('Info').focus(), f => f.panel.open('info'),
    f => f.panel.select('templates'), f => f.panel.restore({ open: true, tab: 'templates' })]) {
    const f = fixture(); f.panel.open('info'); resumeEditing(f);
    const before = editorState(f.opener); enter(f); f.panel.close();
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    f.panel.open(); const search = f.attach('input'); search.value = 'search'; search.focus();
    enter(f); f.panel.close(); assert.equal(f.doc.activeElement, search);
  }
  const f = fixture(); f.panel.open();
  f.opener.setSelectionRange(8, 8, 'none'); f.opener.scrollTop = 200;
  const before = editorState(f.opener); f.panel.open('templates'); f.panel.close();
  assert.deepEqual(editorState(f.opener), before);
});

test('W3M-F01/D-12: Templates 삽입 뒤 Esc/Close로 닫아도 다음 입력은 삽입문 뒤에 위치', () => {
  for (const end of [f => { f.tab('Templates').focus(); f.tab('Templates').dispatch('keydown', { key: 'Escape' }); },
    f => { f.close.focus(); f.close.dispatch('click'); }, f => f.panel.toggle()]) {
    const f = fixture(); f.opener.value = 'Findings: no acute abnormality.\n';
    f.opener.setSelectionRange(f.opener.value.length, f.opener.value.length, 'none');
    const insert = f.attach('button', f.content.templates);
    insert.addEventListener('click', () => { f.opener.focus(); typeText(f.opener, 'Impression: normal.\n'); });
    f.panel.open('templates'); insert.focus(); insert.dispatch('click');
    const before = editorState(f.opener); end(f);
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    typeText(f.doc.activeElement, 'Recommendation: none.');
    assert.equal(f.opener.value, 'Findings: no acute abnormality.\nImpression: normal.\nRecommendation: none.');
  }
});

test('W3M-F01: 닫기 전에 이미 body로 떠난 포커스는 빼앗지 않음', () => {
  const f = fixture(); f.panel.open(); f.doc.activeElement = f.doc.body;
  f.panel.close(); assert.equal(f.doc.activeElement, f.doc.body);
});

test('W3M-F02: body/documentElement/null에서 열었으면 안정 fallback으로 복귀', () => {
  for (const empty of ['body', 'documentElement', null]) {
    const f = fixture(); f.doc.activeElement = empty ? f.doc[empty] : null;
    f.panel.open(); f.panel.close(); assert.equal(f.doc.activeElement, f.fallback);
  }
});

test('W3M-F05: 같은 drawer 요소로 정보 없이 복귀 후 Esc는 편집기 caret과 다음 입력 보존', () => {
  for (const source of [null, undefined, 'body', 'documentElement', 'detached', 'comment']) {
    const f = fixture(); f.opener.setSelectionRange(10, 10, 'none');
    f.panel.open('info');
    const tab = f.tab('Info');
    f.opener.setSelectionRange(0, 0, 'none'); f.opener.scrollTop = 0;
    const before = editorState(f.opener);
    const relatedTarget = source === 'detached' ? f.doc.createElement('input')
      : source === 'comment' ? f.doc.createComment('unknown') : typeof source === 'string' ? f.doc[source] : source;
    tab.dispatch('focusin', { relatedTarget });
    assert.equal(f.doc.activeElement, tab);
    const event = tab.dispatch('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true); assert.equal(f.doc.activeElement, f.opener);
    assert.deepEqual(editorState(f.opener), before);
    typeText(f.doc.activeElement, '!'); assert.equal(f.opener.value, '!KEEP DRAFT');
  }
});

test('W3M-F05: API 재진입의 알 수 없는 포커스도 opener·선택을 지우지 않음', () => {
  for (const empty of ['body', 'documentElement', null]) {
    for (const enter of [f => f.panel.open('info'), f => f.panel.select('info'),
      f => f.panel.restore({ open: true, tab: 'info' })]) {
      const f = fixture(), before = editorState(f.opener); f.panel.open('templates');
      f.doc.activeElement = empty ? f.doc[empty] : null; enter(f);
      f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
      assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    }
  }
});

test('W3M-F07: 편집 후 body를 거쳐 relatedTarget null로 drawer 복귀, Esc 다음 입력은 끝에 이어짐', () => {
  const f = fixture(); f.opener.value = 'Findings: no acute abnormality.\n';
  f.opener.setSelectionRange(10, 10, 'none'); f.panel.open('info');
  f.opener.focus(); f.opener.setSelectionRange(f.opener.value.length, f.opener.value.length, 'none');
  typeText(f.opener, 'Impression: normal.\n');
  f.opener.scrollTop = 400; f.opener.scrollLeft = 25;
  const before = editorState(f.opener); f.opener.blur();
  assert.equal(f.doc.activeElement, f.doc.body);
  const tab = f.tab('Info'), sources = [];
  tab.addEventListener('focusin', event => sources.push(event.relatedTarget));
  tab.focus(); assert.deepEqual(sources, [null]);
  assert.equal(tab.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
  assert.deepEqual(f.opener.lastFocusOptions, { preventScroll: true });
  typeText(f.doc.activeElement, 'Recommendation: none.');
  assert.equal(f.opener.value, 'Findings: no acute abnormality.\nImpression: normal.\nRecommendation: none.');
});

test('W3M-F07: 모든 닫힘 경로는 요소 선택·스크롤 쓰기 없이 필요한 포커스만 복귀', () => {
  const endings = {
    Escape: f => f.doc.activeElement.dispatch('keydown', { key: 'Escape' }),
    Close: f => f.close.dispatch('click'), close: f => f.panel.close(), toggle: f => f.panel.toggle(),
    restore: f => f.panel.restore({ open: false, tab: 'info' }),
    unavailable: f => f.panel.setAvailable([]), destroy: f => f.panel.destroy(),
  };
  for (const [name, end] of Object.entries(endings)) {
    for (const destination of ['editor', 'other', 'vanished', 'hidden', 'body', 'outside']) {
      const f = fixture(), other = f.attach('input'), writes = [];
      other.value = 'search'; other.setSelectionRange(1, 4, 'backward');
      // Observe browser APIs on all elements, including fallback and drawer controls.
      for (const el of f.all(f.doc.documentElement)) {
        const selection = el.setSelectionRange;
        el.setSelectionRange = function (...args) { writes.push('setSelectionRange'); selection.apply(this, args); };
        for (const key of ['selectionStart', 'selectionEnd', 'selectionDirection', 'scrollTop', 'scrollLeft']) {
          let value = el[key];
          Object.defineProperty(el, key, { configurable: true, get: () => value,
            set: next => { writes.push(key); value = next; } });
        }
        el.scrollTo = () => writes.push('scrollTo');
      }
      if (destination === 'body') f.opener.blur();
      f.panel.open('info');
      if (destination === 'other') { other.focus(); f.tab('Info').focus(); }
      if (destination === 'vanished') f.opener.remove();
      if (destination === 'hidden') f.opener.hidden = true;
      if (name === 'Close') f.close.focus();
      if (destination === 'outside') other.focus();
      const before = [editorState(f.opener), editorState(other)];
      end(f);
      assert.deepEqual(writes, [], name + '/' + destination);
      assert.deepEqual([editorState(f.opener), editorState(other)], before);
      const expected = ['other', 'outside'].includes(destination) ? other
        : ['vanished', 'hidden', 'body'].includes(destination) ? f.fallback : f.opener;
      assert.equal(f.doc.activeElement, expected, name + '/' + destination);
      assert.equal(f.panel.snapshot().open, name === 'Escape' && destination === 'outside');
      if (destination !== 'outside') assert.deepEqual(expected.lastFocusOptions, { preventScroll: true });
    }
  }
});

test('W3M-F06: Technician 왕복은 저장된 Templates 유지, 표시·포커스만 복귀하고 onChange 없음', () => {
  for (const open of [false, true]) for (const outside of [false, true]) {
    const f = fixture(); f.panel.restore({ open, tab: 'templates' });
    if (open) f.input.focus();
    if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    f.panel.setAvailable(['images', 'info']); active(f, 'Images');
    assert.deepEqual(f.panel.snapshot(), { open, tab: 'templates' });
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.deepEqual(f.panel.snapshot(), { open, tab: 'templates' });
    assert.equal(f.changes.length, count);
    assert.equal(f.doc.activeElement, open && !outside ? f.tab('Templates') : f.opener);
    assert.deepEqual(editorState(f.opener), before);
  }
});

test('W3M-F06: 현재 비가용 탭 기록도 복원 수용, 대체 표시 후 선호 탭 재표시·알림 횟수', () => {
  for (const open of [false, true]) {
    const f = fixture({ available: ['images', 'info'] }), record = { open, tab: 'templates' };
    assert.equal(f.panel.restore(record), true); assert.deepEqual(f.panel.snapshot(), record);
    assert.equal(f.panel.element.hidden, !open); active(f, 'Images');
    assert.equal(f.doc.activeElement, open ? f.tab('Images') : f.opener);
    assert.deepEqual(f.changes, [record]);
    assert.equal(f.panel.restore(record), true); assert.equal(f.changes.length, 1);
    for (const tab of [null, undefined, '', 'Templates', 'bad']) {
      assert.equal(f.panel.restore({ open, tab }), false);
      assert.deepEqual(f.panel.snapshot(), record); assert.equal(f.changes.length, 1);
    }
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.deepEqual(f.panel.snapshot(), record); assert.equal(f.changes.length, 1);
    assert.equal(f.doc.activeElement, open ? f.tab('Templates') : f.opener);
  }
});

test('W3M-F06: 기본 open/toggle은 선호 유지, 명시 비가용 요청은 거절하고 실제 선택만 저장', () => {
  const calls = [], f = fixture({ available: ['images', 'info'], focusTarget: (tab, panel) => { calls.push([tab, panel]); } });
  f.panel.restore({ open: false, tab: 'templates' });
  assert.equal(f.panel.open(), true); active(f, 'Images');
  assert.equal(calls.at(-1)[0], 'images'); assert.equal(calls.at(-1)[1].hidden, false);
  assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
  assert.equal(f.changes.length, 2);
  assert.equal(f.panel.open(), true); assert.equal(f.changes.length, 2);
  for (const tab of ['templates', null, 'bad']) for (const method of ['open', 'select']) {
    assert.equal(f.panel[method](tab), false); assert.equal(f.doc.activeElement, f.tab('Images'));
    assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' }); assert.equal(f.changes.length, 2);
  }
  f.panel.toggle(); f.panel.toggle(); active(f, 'Images'); assert.equal(f.changes.length, 4);
  assert.deepEqual(f.changes.map(value => value.tab), ['templates', 'templates', 'templates', 'templates']);
  f.tab('Images').dispatch('click'); assert.deepEqual(f.changes.at(-1), { open: true, tab: 'images' });
  assert.equal(f.changes.length, 5); f.tab('Images').dispatch('click'); assert.equal(f.changes.length, 5);
  f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Images'); assert.equal(f.changes.length, 5);
  assert.equal(f.panel.open('info'), true); active(f, 'Info'); assert.equal(f.changes.length, 6);
  assert.deepEqual(f.changes.at(-1), { open: true, tab: 'info' });
});

test('W3M-F03/D-08: 생성 시 가용 탭만 표시·순환하며 사용 불가 탭 API는 부작용 없이 거절', () => {
  const f = fixture({ available: ['images', 'info'] });
  assert.equal(f.tab('Templates').hidden, true); f.panel.open('info');
  for (const [key, expected] of [['ArrowRight', 'Images'], ['ArrowLeft', 'Info'], ['Home', 'Images'], ['End', 'Info']]) {
    f.doc.activeElement.dispatch('keydown', { key }); active(f, expected);
    assert.equal(f.doc.activeElement, f.tab(expected));
  }
  const before = f.panel.snapshot(), count = f.changes.length, focused = f.doc.activeElement;
  for (const call of [() => f.panel.open('templates'), () => f.panel.select('templates')]) {
    assert.equal(call(), false); assert.deepEqual(f.panel.snapshot(), before);
    assert.equal(f.changes.length, count); assert.equal(f.doc.activeElement, focused);
  }
  const info = fixture({ available: ['info'] }); active(info, 'Info'); info.panel.open();
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    info.doc.activeElement.dispatch('keydown', { key }); active(info, 'Info');
  }
});

test('W3M-F03/F06: 현재 탭 제외 시 첫 가용 탭 표시·저장 알림 없음, 외부 편집 포커스 보존', () => {
  for (const outside of [false, true]) {
    const f = fixture(); f.panel.open('templates'); f.input.focus();
    if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    assert.equal(f.panel.setAvailable(['info', 'images']), true);
    active(f, 'Images'); assert.equal(f.tab('Templates').hidden, true);
    assert.equal(f.changes.length, count); assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
    assert.equal(f.doc.activeElement, outside ? f.opener : f.tab('Images'));
    assert.deepEqual(editorState(f.opener), before);
    f.panel.setAvailable(['images', 'info']); assert.equal(f.changes.length, count);
    f.panel.close(); assert.equal(f.doc.activeElement, f.opener);
  }
  const closed = fixture(); closed.panel.select('templates'); const count = closed.changes.length;
  closed.panel.setAvailable(['info']); assert.deepEqual(closed.panel.snapshot(), { open: false, tab: 'templates' });
  assert.equal(closed.changes.length, count); assert.equal(closed.doc.activeElement, closed.opener);
});

test('W3M-F03/F06: 가용 탭 0개는 닫힘·열기 거절, 유효 기록 수용과 선호 보존', () => {
  for (const outside of [false, true]) {
    const f = fixture(); f.panel.open('templates'); if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    f.panel.setAvailable([]); assert.equal(f.changes.length, count + 1);
    assert.equal(f.panel.snapshot().open, false); assert.equal(f.panel.element.hidden, true);
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    assert.ok(f.role('tab').every(tab => tab.hidden && tab.tabIndex === -1 && tab.getAttribute('aria-selected') === 'false'));
    assert.ok(f.role('tabpanel').every(panel => panel.hidden && panel.inert));
    assert.equal(f.panel.open(), false); assert.equal(f.panel.toggle(), false);
    assert.equal(f.panel.restore({ open: true, tab: 'templates' }), true);
    assert.deepEqual(f.panel.snapshot(), { open: false, tab: 'templates' });
    assert.equal(f.changes.length, count + 1);
    f.panel.setAvailable(['info']); active(f, 'Info'); assert.equal(f.panel.open(), true);
    assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.equal(f.changes.length, count + 2);
  }
  const f = fixture({ available: [] }); assert.equal(f.panel.open(), false);
  for (const invalid of [null, 'info', ['bad'], ['images', null]]) {
    assert.equal(f.panel.setAvailable(invalid), false); assert.equal(f.panel.open(), false);
    assert.throws(() => fixture({ available: invalid }), TypeError);
  }
  f.panel.destroy(); assert.equal(f.panel.setAvailable(['info']), false);
});

test('W3M-F04: stand-in selector는 공백·쉼표·개별 closest 호출과 무관한 DOM 속성 판정', () => {
  const f = fixture(), wrap = f.attach('div'), child = f.attach('input', wrap);
  wrap.setAttribute('data-state', 'open'); wrap.hidden = true;
  for (const selector of ['[hidden],[inert]', ' [hidden] , [inert] ', '[hidden]']) assert.equal(child.closest(selector), wrap);
  assert.equal(child.closest('[data-state="open"]'), wrap); assert.equal(child.closest('div'), wrap);
  assert.equal(child.closest('[data-state="closed"]'), null); assert.equal(child.closest('select'), null);
  wrap.setAttribute('aria-expanded', 'true');
  assert.equal(child.closest('select,[aria-expanded="true"]'), wrap);
  assert.equal(child.closest('select') || child.closest('[aria-expanded="true"]'), wrap);
});

test('D-05: opener 제거/숨김/비활성 때 안정된 fallback으로 복귀', () => {
  for (const invalidate of [f => f.opener.remove(), f => { f.opener.hidden = true; },
    f => { f.opener.style.display = 'none'; }, f => { f.opener.style.visibility = 'hidden'; },
    f => { f.opener.disabled = true; }, f => { const wrap = f.attach('div'); wrap.append(f.opener); wrap.inert = true; }]) {
    const f = fixture(); f.panel.open(); invalidate(f); f.close.dispatch('click');
    assert.equal(f.doc.activeElement, f.fallback);
  }
  let fallback;
  const f = fixture({ fallbackFocus: () => fallback }); fallback = f.fallback;
  f.panel.open(); f.opener.remove(); f.panel.close(); assert.equal(f.doc.activeElement, fallback);
});

test('D-06/07: Esc는 외부 포커스·내부 취소·전파중단·IME·native select·popup에 양보', () => {
  const f = fixture(); f.panel.open('templates'); f.opener.focus();
  assert.equal(f.opener.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  const stale = f.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(stale.defaultPrevented, false); assert.equal(f.panel.snapshot().open, true);
  f.input.focus();
  for (const extra of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    f.input.dispatch('keydown', { key: 'Escape', ...extra }); assert.equal(f.panel.snapshot().open, true);
  }
  const stop = event => event.stopPropagation(); f.input.addEventListener('keydown', stop);
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.removeEventListener('keydown', stop);
  f.input.dispatch('compositionstart');
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.dispatch('compositionend');
  const select = f.attach('select', f.content.templates); select.focus();
  assert.equal(select.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true);
  f.input.setAttribute('aria-expanded', 'true'); f.input.focus();
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.setAttribute('aria-expanded', 'false');
  f.input.dispatch('keydown', { key: 'Escape' }); assert.equal(f.panel.snapshot().open, false);
});

test('D-06/10: 통합 측 Esc 우선권·초기 포커스 확장점', () => {
  let claimed = true, target;
  const f = fixture({ escapeClaimed: () => claimed,
    focusTarget: tab => tab === 'templates' ? target : null });
  target = f.input;
  f.panel.open('templates'); assert.equal(f.doc.activeElement, f.input);
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); claimed = false;
  f.input.dispatch('keydown', { key: 'Escape' }); assert.equal(f.doc.activeElement, f.opener);
});

test('상태 export/restore는 분리된 값이며 잘못된 입력은 현재 상태 보존', () => {
  const f = fixture(), initial = f.panel.snapshot(); initial.open = true; initial.tab = 'images';
  assert.equal(f.panel.snapshot().tab, 'info');
  assert.equal(f.panel.restore({ open: false, tab: 'info' }), true);
  assert.equal(f.doc.activeElement, f.opener); active(f, 'Info');
  f.panel.toggle(); assert.equal(f.doc.activeElement, f.tab('Info'));
  assert.equal(f.panel.restore({ open: true, tab: 'templates' }), true); active(f, 'Templates');
  const before = f.panel.snapshot();
  for (const invalid of [null, [], {}, { open: 'true', tab: 'images' }, { open: true, tab: 'bad' },
    { open: true, tab: 'info', extra: true }]) {
    assert.equal(f.panel.restore(invalid), false); assert.deepEqual(f.panel.snapshot(), before);
  }
  assert.equal(f.panel.open('bad'), false); assert.equal(f.panel.select('bad'), false);
  assert.deepEqual(f.panel.snapshot(), before);
  f.panel.restore({ open: false, tab: 'images' }); assert.equal(f.doc.activeElement, f.opener);
});

test('기존 content element·id·listener·값 동일성 및 destroy의 원위치 복귀/해제', () => {
  const f = fixture(); let clicks = 0; f.input.value = 'template query';
  f.input.addEventListener('click', () => { clicks++; });
  for (const [name, el] of Object.entries(f.content)) {
    assert.equal(f.panel.element.contains(el), true); assert.equal(el.id, name + '-existing');
    assert.equal(f.original.contains(el), false);
  }
  f.panel.open('templates'); f.input.dispatch('click'); assert.equal(clicks, 1);
  const root = f.panel.element, tab = f.tab('Images'), close = f.close;
  const created = f.all(root).filter(el => !Object.values(f.content).some(content => content.contains(el)));
  f.panel.destroy(); assert.equal(f.doc.activeElement, f.opener); assert.equal(root.isConnected, false);
  assert.deepEqual(f.original.children, Object.values(f.content)); assert.equal(f.input.value, 'template query');
  f.input.dispatch('click'); assert.equal(clicks, 2);
  const count = f.changes.length;
  tab.dispatch('click'); close.dispatch('click'); tab.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.changes.length, count); assert.equal(f.panel.snapshot().open, false);
  for (const el of created) for (const listeners of el.listeners.values()) assert.equal(listeners.size, 0);
  assert.equal(f.panel.open(), false); assert.equal(f.panel.select('info'), false);
  assert.equal(f.panel.restore({ open: true, tab: 'info' }), false); f.panel.destroy();
});

// Pilot D1160: Text Size, Default and the resize edge. The drawer reports the reader's input; the page owns the
// geometry (axis, bounds) and the stored choice, so these cases check what the drawer shows and reports.
const control = (f, tag, text) => f.all(f.panel.element).find(el => el.tagName === tag && (text === undefined || el.textContent === text));

test('D1160-P1: Text Size는 세 단계(영어 이름·한국어 설명), 독자의 변경만 알리고 잘못된 값은 거절', () => {
  const texts = [], f = fixture({ onText: value => texts.push(value) });
  const select = control(f, 'SELECT'), reset = control(f, 'BUTTON', 'Default');
  assert.equal(select.getAttribute('aria-label'), 'Text Size'); assert.match(select.title, /[가-힣]/);
  assert.match(reset.title, /[가-힣]/);
  assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [['0', 'Normal'], ['1', 'Large'], ['2', 'Larger']]);
  assert.equal(select.value, '0');
  f.panel.open(); select.value = '2'; select.dispatch('change');
  assert.deepEqual(texts, [2]); assert.equal(select.value, '2');
  select.dispatch('change'); assert.deepEqual(texts, [2], 'the same step is not a change');
  select.value = '7'; select.dispatch('change'); assert.deepEqual(texts, [2]); assert.equal(select.value, '2');
  assert.equal(f.panel.setText(1), true); assert.equal(select.value, '1');
  assert.deepEqual(texts, [2], 'the page restoring a stored step is not the reader changing it');
  for (const bad of [3, -1, 1.5, '1', null, undefined, NaN]) {
    assert.equal(f.panel.setText(bad), false); assert.equal(select.value, '1');
  }
  // A native select keeps its own Escape (D-06/07); the drawer stays open.
  select.focus(); assert.equal(select.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true);
  f.panel.destroy(); assert.equal(f.panel.setText(0), false);
});

test('D1160-P2: 크기 조절 경계는 page가 정한 축·범위 안에서 키보드로 조절하고 결과만 알림', () => {
  const sizes = [], f = fixture({ onResize: (value, phase) => sizes.push([value, phase]) });
  const grip = f.role('separator')[0];
  assert.equal(f.role('separator').length, 1); assert.equal(grip.hidden, true, 'no edge until the page names it');
  assert.equal(grip.tabIndex, 0); assert.equal(grip.getAttribute('aria-controls'), f.panel.element.id);
  // AGENTS §4 wording contract: the control's name is English, its explanation (tooltip) Korean (W3R7-01).
  assert.equal(grip.getAttribute('aria-label'), 'Study Panel Size'); assert.match(grip.title, /[가-힣]/);
  f.panel.open();
  assert.equal(f.panel.setSize({ axis: 'x', value: 360, min: 320, max: 900 }), true);
  assert.equal(grip.hidden, false);
  assert.deepEqual(['aria-orientation', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(name => grip.getAttribute(name)),
    ['vertical', '360', '320', '900']);
  grip.focus(); assert.equal(f.doc.activeElement, grip);
  const key = (name, extra = {}) => grip.dispatch('keydown', { key: name, ...extra });
  for (const [name, extra, expected] of [['ArrowRight', {}, 370], ['ArrowLeft', {}, 350], ['ArrowRight', { shiftKey: true }, 400],
    ['ArrowLeft', { shiftKey: true }, 320], ['Home', {}, 320], ['End', {}, 900]]) {
    const event = key(name, extra);
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.deepEqual(sizes.at(-1), [expected, 'end'], name);
  }
  const count = sizes.length;
  for (const [name, extra] of [['ArrowUp', {}], ['ArrowDown', {}], ['Enter', {}], ['ArrowRight', { ctrlKey: true }],
    ['ArrowRight', { altKey: true }], ['ArrowRight', { metaKey: true }], ['ArrowRight', { isComposing: true }],
    ['ArrowRight', { keyCode: 229 }], ['ArrowRight', { defaultPrevented: true }]]) key(name, extra);
  assert.equal(sizes.length, count, 'other keys, chords and IME input change nothing');
  f.panel.setSize({ axis: 'x', value: 895, min: 320, max: 900 });
  key('ArrowRight', { shiftKey: true }); assert.deepEqual(sizes.at(-1), [900, 'end'], 'never past the page bound');
  f.panel.setSize({ axis: 'y', value: 600, min: 240, max: 1300 });
  assert.equal(grip.getAttribute('aria-orientation'), 'horizontal');
  key('ArrowDown'); assert.deepEqual(sizes.at(-1), [610, 'end']);
  key('ArrowUp'); assert.deepEqual(sizes.at(-1), [590, 'end']);
  const before = sizes.length; key('ArrowLeft'); assert.equal(sizes.length, before);
  for (const bad of [{ axis: 'z', value: 1, min: 0, max: 2 }, { axis: 'x', value: NaN, min: 0, max: 2 },
    { axis: 'x', value: 1, min: 3, max: 2 }, { axis: 'x' }, 'x', undefined]) assert.equal(f.panel.setSize(bad), false);
  assert.equal(grip.getAttribute('aria-orientation'), 'horizontal'); assert.equal(grip.getAttribute('aria-valuenow'), '600');
  // Escape on the edge closes the drawer like anywhere inside it.
  key('Escape'); assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.panel.setSize(null), true); assert.equal(grip.hidden, true);
});

test('D1160-P3: 끌기는 움직임을 미리 보이고 놓을 때 한 번 저장; 움직임 없는 누름·취소·다른 포인터·닫힌 drawer는 저장 없음', () => {
  const sizes = [], resets = [];
  const f = fixture({ onResize: (value, phase) => sizes.push([value, phase]), onReset: () => resets.push(true) });
  const grip = f.role('separator')[0], reset = control(f, 'BUTTON', 'Default');
  f.panel.setSize({ axis: 'x', value: 360, min: 320, max: 900 });
  grip.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 5 });
  grip.dispatch('pointermove', { pointerId: 1, clientX: 150, clientY: 5 }); grip.dispatch('pointerup', { pointerId: 1, clientX: 150 });
  reset.dispatch('click'); grip.dispatch('dblclick');
  assert.deepEqual(sizes, []); assert.deepEqual(resets, [], 'a closed drawer takes no input');
  f.panel.open();
  assert.equal(grip.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 100, clientY: 5 }).defaultPrevented, true);
  grip.dispatch('pointermove', { pointerId: 7, clientX: 100, clientY: 50 });
  grip.dispatch('pointermove', { pointerId: 8, clientX: 300, clientY: 5 });
  grip.dispatch('pointermove', { pointerId: 7, clientX: 130, clientY: 5 });
  grip.dispatch('pointermove', { pointerId: 7, clientX: 160, clientY: 5 });
  grip.dispatch('pointerup', { pointerId: 8, clientX: 999, clientY: 5 });
  grip.dispatch('pointerup', { pointerId: 7, clientX: 175, clientY: 5 });
  assert.deepEqual(sizes, [[390, 'move'], [420, 'move'], [435, 'end']]);
  grip.dispatch('lostpointercapture', { pointerId: 7, clientX: 175 }); assert.equal(sizes.length, 3);
  // A press without movement (a click, or each click of a double-click) stores nothing.
  grip.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 200 }); grip.dispatch('pointerup', { pointerId: 9, clientX: 200 });
  grip.dispatch('pointerdown', { button: 2, pointerId: 10, clientX: 200 }); grip.dispatch('pointermove', { pointerId: 10, clientX: 260 });
  grip.dispatch('pointerup', { pointerId: 10, clientX: 260 });
  assert.equal(sizes.length, 3);
  // A cancelled drag (or a lost capture) hands the stored size back to the page.
  f.panel.setSize({ axis: 'y', value: 600, min: 240, max: 1300 });
  grip.dispatch('pointerdown', { button: 0, pointerId: 11, clientX: 0, clientY: 300 });
  grip.dispatch('pointermove', { pointerId: 11, clientX: 50, clientY: 260 }); grip.dispatch('pointercancel', { pointerId: 11 });
  grip.dispatch('pointerdown', { button: 0, pointerId: 12, clientX: 0, clientY: 300 });
  grip.dispatch('pointermove', { pointerId: 12, clientX: 0, clientY: 310 }); grip.dispatch('lostpointercapture', { pointerId: 12 });
  assert.deepEqual(sizes.slice(3), [[560, 'move'], [600, 'cancel'], [610, 'move'], [600, 'cancel']]);
  grip.dispatch('dblclick'); reset.dispatch('click'); assert.deepEqual(resets, [true, true]);
  f.panel.destroy();
  grip.dispatch('pointerdown', { button: 0, pointerId: 13, clientY: 300 }); grip.dispatch('pointermove', { pointerId: 13, clientY: 340 });
  reset.dispatch('click'); assert.equal(sizes.length, 7); assert.equal(resets.length, 2);
});

// Pointer capture as a browser keeps it: release fires lostpointercapture on the element.
function captureGrip(grip) {
  let captured = null;
  grip.setPointerCapture = id => { captured = id; };
  grip.hasPointerCapture = id => captured === id;
  grip.releasePointerCapture = id => { if (captured !== id) return; captured = null; grip.dispatch('lostpointercapture', { pointerId: id }); };
  return () => captured;
}

test('W3R7-02: 끌기는 시작한 경계(방향·차원)에 묶임; page가 다른 경계를 알리면 결과 없이 끝나고 capture를 놓음', () => {
  const sizes = [], f = fixture({ onResize: (value, phase) => sizes.push([value, phase]) });
  const grip = f.role('separator')[0], captured = captureGrip(grip);
  f.panel.open();
  // The page names the edge; echoing the same edge with a previewed value keeps the drag.
  f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 360, min: 320, max: 900 });
  grip.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 5 });
  grip.dispatch('pointermove', { pointerId: 1, clientX: 180, clientY: 5 });
  f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 440, min: 320, max: 900 });
  grip.dispatch('pointermove', { pointerId: 1, clientX: 190, clientY: 5 });
  assert.deepEqual(sizes, [[440, 'move'], [450, 'move']]); assert.equal(captured(), 1);
  // The window turns under the pointer: another orientation's edge on another axis.
  f.panel.setSize({ axis: 'y', key: 'portrait:height', value: 1056, min: 240, max: 1500 });
  assert.equal(captured(), null, 'capture released');
  grip.dispatch('pointermove', { pointerId: 1, clientX: 260, clientY: 90 });
  grip.dispatch('pointerup', { pointerId: 1, clientX: 260, clientY: 90 });
  grip.dispatch('pointercancel', { pointerId: 1 }); grip.dispatch('lostpointercapture', { pointerId: 1 });
  assert.deepEqual(sizes, [[440, 'move'], [450, 'move']], 'the old gesture never reaches the new edge');
  // The same axis with another logical orientation (a stacked band turning into a landscape band) also ends it.
  f.panel.setSize({ axis: 'y', key: 'portrait:height', value: 600, min: 240, max: 900 });
  grip.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 300 });
  grip.dispatch('pointermove', { pointerId: 2, clientX: 0, clientY: 340 });
  f.panel.setSize({ axis: 'y', key: 'landscape:height', value: 500, min: 240, max: 800 });
  grip.dispatch('pointerup', { pointerId: 2, clientX: 0, clientY: 380 });
  assert.deepEqual(sizes.slice(2), [[640, 'move']]);
  // After the switch a new drag on the new edge works as usual, from the size shown there.
  grip.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 300 });
  grip.dispatch('pointermove', { pointerId: 3, clientX: 0, clientY: 320 }); grip.dispatch('pointerup', { pointerId: 3, clientX: 0, clientY: 330 });
  assert.deepEqual(sizes.slice(3), [[520, 'move'], [530, 'end']]);
  // A press that has not moved yet starts from what the page shows when it moves (an account layout applied
  // under the pointer), and a cancelled drag still hands back its start.
  grip.dispatch('pointerdown', { button: 0, pointerId: 4, clientX: 0, clientY: 300 });
  f.panel.setSize({ axis: 'y', key: 'landscape:height', value: 450, min: 240, max: 800 });
  grip.dispatch('pointermove', { pointerId: 4, clientX: 0, clientY: 310 }); grip.dispatch('pointercancel', { pointerId: 4 });
  assert.deepEqual(sizes.slice(5), [[460, 'move'], [450, 'cancel']]);
  for (const bad of [{ axis: 'x', key: 7, value: 1, min: 0, max: 2 }, { axis: 'x', key: null, value: 1, min: 0, max: 2 }]) {
    assert.equal(f.panel.setSize(bad), false);
  }
  f.panel.destroy();
});

test('W3R7-06: Default와 경계 double-click은 진행 중 끌기를 먼저 취소(미리보기 반환)하고, 이후 그 포인터의 해제는 아무것도 저장하지 않음', () => {
  const calls = [];
  const f = fixture({ onResize: (value, phase) => calls.push([value, phase]), onReset: () => calls.push('reset') });
  const grip = f.role('separator')[0], reset = control(f, 'BUTTON', 'Default'), captured = captureGrip(grip);
  f.panel.open(); f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 360, min: 320, max: 900 });
  reset.focus();
  grip.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 5 });
  grip.dispatch('pointermove', { pointerId: 1, clientX: 260, clientY: 5 });
  reset.dispatch('click');
  assert.deepEqual(calls, [[520, 'move'], [360, 'cancel'], 'reset']); assert.equal(captured(), null);
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) grip.dispatch(type, { pointerId: 1, clientX: 260 });
  assert.deepEqual(calls, [[520, 'move'], [360, 'cancel'], 'reset'], 'a later release never stores the dragged size');
  assert.equal(f.doc.activeElement, reset, 'focus stays on Default');
  // Default during a press without movement: nothing to hand back; Default alone, and the edge's double-click.
  grip.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 5 }); reset.dispatch('click');
  grip.dispatch('pointerup', { pointerId: 2, clientX: 140 });
  reset.dispatch('click'); grip.dispatch('dblclick');
  assert.deepEqual(calls.slice(3), ['reset', 'reset', 'reset']);
  f.panel.destroy();
});

test('W3R7-05: 경계에 닿은 키는 크기를 바꾸지 못하므로 알리지 않음(기본에서 ArrowRight가 줄이지 않음)', () => {
  const sizes = [], f = fixture({ onResize: (value, phase) => sizes.push([value, phase]) });
  const grip = f.role('separator')[0];
  f.panel.open(); grip.focus();
  const key = (name, extra = {}) => grip.dispatch('keydown', { key: name, ...extra });
  f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 343, min: 320, max: 343 });
  for (const name of ['ArrowRight', 'End']) assert.equal(key(name).defaultPrevented, true);
  key('ArrowRight', { shiftKey: true });
  assert.deepEqual(sizes, [], 'at the largest size nothing grows, nothing shrinks, nothing is stored');
  key('ArrowLeft'); assert.deepEqual(sizes, [[333, 'end']]);
  f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 320, min: 320, max: 343 });
  key('Home'); key('ArrowLeft'); assert.equal(sizes.length, 1);
  key('End'); assert.deepEqual(sizes.at(-1), [343, 'end']);
  f.panel.destroy();
});

test('W3R7-04: 패널 안 알림 줄은 처음 쓸 때 생기고(role status, 한국어), 비우면 숨김; 잘못된 값·destroy 뒤는 거절', () => {
  const f = fixture();
  const before = f.all(f.panel.element).length;
  assert.deepEqual(f.role('status'), [], 'an unused panel has no notice line');
  f.panel.open();
  assert.equal(f.panel.setNotice(null), true); assert.equal(f.all(f.panel.element).length, before);
  assert.equal(f.panel.setNotice('배치 저장 안 됨 · 이 창에서만 유지'), true);
  const [line] = f.role('status');
  assert.equal(line.textContent, '배치 저장 안 됨 · 이 창에서만 유지'); assert.equal(line.getAttribute('lang'), 'ko'); assert.equal(line.hidden, false);
  assert.equal(f.panel.setNotice('배치 저장됨 · 이 브라우저'), true);
  assert.deepEqual(f.role('status').map(el => el.textContent), ['배치 저장됨 · 이 브라우저'], 'one line, replaced');
  for (const bad of [7, {}, undefined]) assert.equal(f.panel.setNotice(bad), false);
  assert.equal(f.panel.setNotice(''), true); assert.equal(line.hidden, true);
  // The edge stays the drawer's last keyboard stop with the notice shown or hidden: the notice line is never a
  // Tab stop, and Tab on the edge is left to the browser, which moves focus out of the drawer (W3R8-01).
  // The edge is shown once the page gives it a size, as the reading page does on open.
  const grip = f.role('separator')[0];
  f.panel.setSize({ axis: 'x', key: 'landscape:width', value: 360, min: 320, max: 900 });
  for (const notice of ['배치 저장 안 됨 · 이 창에서만 유지', '']) {
    assert.equal(f.panel.setNotice(notice), true); assert.equal(line.hidden, !notice);
    const stops = tabOrder(f, f.panel.element);
    assert.equal(stops.at(-1), grip); assert.equal(stops.includes(line), false);
    grip.focus(); assert.equal(f.doc.activeElement, grip);
    assert.equal(grip.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  }
  f.panel.destroy(); assert.equal(f.panel.setNotice('x'), false);
});

test('content provider는 한 번 평가, 잘못된 content는 이동 전에 거절', () => {
  const f = fixture(); f.panel.destroy(); let calls = 0;
  const provided = Object.fromEntries(Object.entries(f.content).map(([name, el]) => [name, () => { calls++; return el; }]));
  const p = create({ host: f.host, content: provided, fallbackFocus: f.fallback });
  p.open(); p.close(); p.open('info'); assert.equal(calls, 3); p.destroy();
  const original = [...f.original.children];
  for (const content of [{ ...f.content, templates: null }, { ...f.content, info: f.content.images },
    { ...f.content, images: f.doc.body }]) {
    assert.throws(() => create({ host: f.host, content, fallbackFocus: f.fallback }), TypeError);
    assert.deepEqual(f.original.children, original); assert.equal(f.host.children.length, 0);
  }
});
