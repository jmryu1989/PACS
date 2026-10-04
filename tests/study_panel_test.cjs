// REQ-WS2/WS7 -> RISK-WS2/WS7 -> TEST-WS2/WS7 (D-01/04/05/06/07/10, A-01).
// This stand-in models DOM identity, bubbling and focus; browser geometry remains an integration check.
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
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) {
    for (let el = this; el; el = el.parentNode) {
      if (selector === '[hidden], [inert]' && (el.hidden || el.inert)) return el;
      if (selector === 'select, [aria-expanded="true"]' &&
          (el.tagName === 'SELECT' || el.getAttribute('aria-expanded') === 'true')) return el;
    }
    return null;
  }
  getClientRects() {
    if (!this.isConnected || this.closest('[hidden], [inert]')) return [];
    for (let el = this; el; el = el.parentNode) if (el.style.display === 'none') return [];
    return [{}];
  }
  focus() {
    const visibility = this.ownerDocument.defaultView.getComputedStyle(this).visibility;
    if (this.disabled || !this.getClientRects().length || ['hidden', 'collapse'].includes(visibility)) return;
    if (this.tabIndex < 0 && !this.attributes.has('tabindex')) return;
    this.ownerDocument.activeElement = this;
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
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
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
  assert.deepEqual(f.panel.snapshot(), { open: false, tab: 'images' });
  assert.equal(f.panel.element.hidden, true); assert.equal(f.panel.element.inert, true);
  assert.equal(f.panel.element.getAttribute('aria-label'), 'Study Panel');
  assert.equal(f.role('complementary').length, 1);
  assert.equal(f.role('tablist').length, 1); assert.equal(f.role('tab').length, 3); active(f, 'Images');
  assert.equal(f.doc.activeElement, f.opener);
  f.panel.open(); assert.equal(f.panel.element.hidden, false); assert.equal(f.doc.activeElement, f.tab('Images'));
  f.tab('Templates').dispatch('click'); active(f, 'Templates');
  f.close.dispatch('click'); assert.equal(f.panel.element.hidden, true); assert.equal(f.doc.activeElement, f.opener);
  f.panel.toggle(); active(f, 'Templates'); assert.equal(f.doc.activeElement, f.tab('Templates'));
  f.panel.toggle(); assert.equal(f.panel.snapshot().open, false);
  assert.deepEqual(f.changes.map(v => v.open), [true, true, false, true, false]);
});

test('A-01: 좌우 순환, Home/End 자동 활성화, Tab/Shift+Tab 비가로채기', () => {
  const f = fixture(); f.panel.open();
  for (const [key, expected] of [['ArrowLeft', 'Templates'], ['ArrowRight', 'Images'],
    ['ArrowRight', 'Info'], ['End', 'Templates'], ['Home', 'Images']]) {
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

test('D-04: 중복 열기/탭 변경 뒤에도 원래 편집기 선택·스크롤·본문 복원', () => {
  const f = fixture(); f.panel.open('info'); f.panel.open('templates');
  f.opener.setSelectionRange(0, 0, 'none'); f.opener.scrollTop = 0; f.opener.scrollLeft = 0;
  const event = f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
  assert.deepEqual([f.opener.selectionStart, f.opener.selectionEnd, f.opener.selectionDirection], [2, 7, 'backward']);
  assert.equal(f.opener.scrollTop, 123); assert.equal(f.opener.scrollLeft, 9); assert.equal(f.opener.value, 'KEEP DRAFT');
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
  const f = fixture(), initial = f.panel.snapshot(); initial.open = true; initial.tab = 'info';
  assert.equal(f.panel.snapshot().tab, 'images');
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
