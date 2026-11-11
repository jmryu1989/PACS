// The heading of each viewer cell (worklist-v0/hpacs-lite/viewer-info-bar.js) at its DOM/native-service ports.
// Without a rendered identity a cell given images says Loading and a cell given none says No image: an empty cell of a
// 1x2 layout no longer reads 'Loading / No image' after everything has loaded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.textContent = ''; this.title = ''; this.parentElement = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parentElement = this; this.children.push(n); } }
  prepend(...nodes) { this.append(...nodes); this.children = [...nodes, ...this.children.filter(n => !nodes.includes(n))]; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node.tag === 'body'; }
  closest(selector) { return selector === '[data-cy="viewport-pane"]' && this.attrs['data-cy'] === 'viewport-pane' ? this : this.parentElement?.closest(selector) ?? null; }
}

function fixture() {
  const body = new Element('body'), panes = ['A', 'B'].map(() => { const pane = new Element(); pane.setAttribute('data-cy', 'viewport-pane'); body.append(pane); return pane; });
  const document = new EventTarget();
  Object.assign(document, { body, createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '[data-cy="viewport-grid"] [data-cy="viewport-pane"]' ? [...panes] : [] });
  const Status = { LOADING: 'loading', PRE_RENDER: 'preRender', RESIZE: 'resize', RENDERED: 'rendered', NO_DATA: 'noData' };
  const instance = { StudyInstanceUID: '1.2', SeriesInstanceUID: '1.2.1', PatientName: { Alphabetic: 'SYN^MRSEQ' }, PatientSex: 'F',
    PatientAge: '046Y', PatientID: 'SYN-1', StudyDate: '20261111', StudyTime: '081500', StudyDescription: 'MR BRAIN' };
  const image = { imageId: 'frame-1' };
  const viewport = { type: 'stack', viewportStatus: Status.LOADING, element: (() => { const e = new Element('canvas'); panes[0].append(e); return e; })(),
    getCurrentImageId: () => 'frame-1', getCornerstoneImage: () => viewport.viewportStatus === Status.RENDERED ? image : undefined };
  const set = { displaySetInstanceUID: 'ds-1', StudyInstanceUID: '1.2', SeriesInstanceUID: '1.2.1' };
  const state = { layout: { layoutType: 'grid', numRows: 1, numCols: 2 },
    viewports: new Map([['A', { displaySetInstanceUIDs: ['ds-1'] }], ['B', { displaySetInstanceUIDs: [] }]]) };
  const views = new Map([['A', viewport]]);
  const services = { viewportGridService: { getState: () => state },
    cornerstoneViewportService: { getCornerstoneViewport: id => views.get(id) || null },
    displaySetService: { getDisplaySetByUID: id => id === 'ds-1' ? set : undefined } };
  const window = { cornerstone: { Enums: { Events: { IMAGE_RENDERED: 'rendered' }, ViewportStatus: Status },
    metaData: { get: (type, id) => type === 'instance' && id === 'frame-1' ? instance : undefined }, cache: { getVolume: () => null } } };
  const context = vm.createContext({ window, document, WeakMap, Map });
  vm.runInContext(fs.readFileSync('worklist-v0/hpacs-lite/viewer-info-bar.js', 'utf8'), context, { filename: 'viewer-info-bar.js' });
  const bar = window.KinViewerInfoBar.mount({ services, studyActions: { available: () => false, hidden: () => false } });
  const heading = index => panes[index].children.find(n => n.dataset.kinUxOwned !== undefined)?.children[0].textContent;
  const render = () => { viewport.viewportStatus = Status.RENDERED; document.dispatchEvent(Object.assign(new Event('rendered'), { detail: { viewportId: 'A' } })); };
  return { bar, heading, render, state, views, viewport, Status };
}

test('a cell given images says Loading until its image renders; a cell given none says No image', () => {
  const f = fixture();
  f.bar.refresh();
  assert.deepEqual([f.heading(0), f.heading(1)], ['Loading', 'No image']);
  f.render(); f.bar.refresh();
  assert.equal(f.heading(0), 'SYN^MRSEQ | F | 046Y | SYN-1 | 20261111 081500 | MR BRAIN');
  assert.equal(f.heading(1), 'No image', 'the empty cell stays No image after the other cell has loaded');
});

test('a grid change drops only a patient heading at once; the empty cell keeps No image', () => {
  const f = fixture();
  f.render(); f.bar.refresh();
  f.bar.invalidate();
  assert.deepEqual([f.heading(0), f.heading(1)], ['Loading', 'No image']);
  f.bar.refresh();
  assert.equal(f.heading(0).startsWith('SYN^MRSEQ'), true);
});

test('a cell emptied of its images says No image', () => {
  const f = fixture();
  f.render(); f.bar.refresh();
  f.state.viewports.set('A', { displaySetInstanceUIDs: [] }); f.views.delete('A');
  f.bar.invalidate(); f.bar.refresh();
  assert.deepEqual([f.heading(0), f.heading(1)], ['No image', 'No image']);
});
