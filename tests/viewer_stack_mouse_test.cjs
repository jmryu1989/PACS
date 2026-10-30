// The served configuration's mode lifecycle talks to native tool-group ports.
// Actual drag/wheel/render behavior is covered by test_viewer_tools.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

async function fixture() {
  const pending = new Map(), events = new EventTarget(); let frame = 0;
  const views = new Map([
    ['left', { id: 'left', type: 'stack', renderingEngineId: 'engine' }],
    ['right', { id: 'right', type: 'stack', renderingEngineId: 'engine' }],
    ['mpr', { id: 'mpr', type: 'orthographic', renderingEngineId: 'engine' }],
  ]);
  function group(ids) {
    const toolOptions = {
      WindowLevel: { mode: 'Active', bindings: [{ mouseButton: 1 }] },
      Pan: { mode: 'Active', bindings: [{ mouseButton: 4 }] },
      Zoom: { mode: 'Active', bindings: [{ mouseButton: 2 }] },
      StackScroll: { mode: 'Active', bindings: [{ mouseButton: 524288 }] },
      Length: { mode: 'Passive', bindings: [] },
    };
    return { toolOptions,
      hasTool: name => !!toolOptions[name],
      getViewportsInfo: () => ids.map(viewportId => ({ viewportId, renderingEngineId: 'engine' })),
      getActivePrimaryMouseButtonTool: () => Object.keys(toolOptions).find(name =>
        toolOptions[name].mode === 'Active' && toolOptions[name].bindings.some(b => b.mouseButton === 1 && !b.modifierKey)),
      setToolPassive(name, { removeAllBindings = [{ mouseButton: 1 }] } = {}) {
        const option = toolOptions[name];
        option.bindings = option.bindings.filter(binding => !removeAllBindings.some(b =>
          b.mouseButton === binding.mouseButton && b.modifierKey === binding.modifierKey));
        option.mode = option.bindings.length ? 'Active' : 'Passive';
      },
      setToolActive(name, { bindings }) {
        const option = toolOptions[name]; option.mode = 'Active';
        for (const binding of bindings) if (!option.bindings.some(b =>
          b.mouseButton === binding.mouseButton && b.modifierKey === binding.modifierKey)) option.bindings.push(binding);
      },
    };
  }
  const stack = group(['left', 'right']), mpr = group(['mpr']);
  const listeners = new Set();
  const service = () => ({ EVENTS: { changed: 'changed' }, subscribe(event, fn) {
    listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } };
  } });
  const services = {
    viewportGridService: { ...service(), getState: () => ({ viewports: views }), getActiveViewportId: () => 'left' },
    cornerstoneViewportService: { ...service(), getCornerstoneViewport: id => views.get(id) },
    toolbarService: { refreshToolbarState() {} },
  };
  const window = { top: {},
    cornerstone: { eventTarget: events, Enums: { Events: { ELEMENT_ENABLED: 'enabled' } },
      getRenderingEngine: () => ({ getViewport: id => views.get(id) }) },
    cornerstoneTools: { Enums: { MouseBindings: { Primary: 1, Secondary: 2, Wheel: 524288 } },
      ToolGroupManager: { getToolGroupForViewport: id => id === 'mpr' ? mpr : stack } },
  };
  vm.runInNewContext(readFileSync('config/ohif.js', 'utf8'), { window, document: {},
    requestAnimationFrame(fn) { pending.set(++frame, fn); return frame; },
    cancelAnimationFrame(id) { pending.delete(id); },
  });
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-ux');
  await extension.preRegistration({ servicesManager: { services } });
  const flush = () => { const work = [...pending.values()]; pending.clear(); work.forEach(fn => fn()); };
  const bindings = g => JSON.parse(JSON.stringify(g.toolOptions));
  return { extension, stack, mpr, listeners, window, flush, bindings };
}

test('stack mode enters with left/wheel scroll and right windowing, preserving MPR and middle Pan', async () => {
  const f = await fixture(), beforeMpr = f.bindings(f.mpr);
  f.extension.onModeEnter(); f.flush();
  const options = f.bindings(f.stack);
  assert.deepEqual(options.StackScroll.bindings.map(b => b.mouseButton).sort((a, b) => a - b), [1, 524288]);
  assert.deepEqual(options.WindowLevel.bindings, [{ mouseButton: 2 }]);
  assert.deepEqual(options.Pan.bindings, [{ mouseButton: 4 }]);
  assert.deepEqual(options.Zoom.bindings, []);
  assert.deepEqual(f.bindings(f.mpr), beforeMpr);
  f.extension.onModeExit();
  assert.equal(f.listeners.size, 0);
});

test('a selected tool keeps wheel/right bindings; deselection restores scroll and refresh never steals selection', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  for (const name of ['Length', 'Zoom']) {
    f.stack.setToolPassive('StackScroll');
    f.stack.setToolActive(name, { bindings: [{ mouseButton: 1 }] });
    for (const listener of f.listeners) listener(); f.flush();
    assert.equal(f.stack.getActivePrimaryMouseButtonTool(), name);
    assert.deepEqual(f.bindings(f.stack).StackScroll.bindings, [{ mouseButton: 524288 }]);
    assert.deepEqual(f.bindings(f.stack).WindowLevel.bindings, [{ mouseButton: 2 }]);
    assert.equal(f.window.kinViewerStackMouse.deselect(name), true);
    assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'StackScroll');
  }
  assert.equal(f.window.kinViewerStackMouse.deselect('StackScroll'), false);
  f.extension.onModeExit();
});
