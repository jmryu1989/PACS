// The served configuration's mode lifecycle talks to native tool-group ports.
// Actual drag/wheel/render behavior is covered by test_viewer_tools.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// A cell's element: records the listeners put on it.
function cellElement() {
  return { listeners: [], addEventListener(type, fn, options) { this.listeners.push({ type, fn, options }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter(entry => entry.type !== type || entry.fn !== fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }) };
}
// A synthetic stack viewport of 16 images with a camera.
function stackView(id) {
  return { id, type: 'stack', renderingEngineId: 'engine', element: cellElement(), index: 0, renders: 0,
    camera: { parallelScale: 100, focalPoint: [0, 0, 0], position: [0, 0, 100] },
    getImageIds: () => Array.from({ length: 16 }, (_, n) => 'image-' + n),
    getCurrentImageIdIndex() { return this.index; }, getTargetImageIdIndex() { return this.index; },
    getCamera() { return structuredClone(this.camera); }, setCamera(camera) { Object.assign(this.camera, structuredClone(camera)); },
    canvasToWorld: ([x, y]) => [x - 100, y - 100, 0], render() { this.renders++; } };
}

async function fixture() {
  const pending = new Map(), events = new EventTarget(); let frame = 0;
  const views = new Map([
    ['left', stackView('left')],
    ['right', stackView('right')],
    ['mpr', { id: 'mpr', type: 'orthographic', renderingEngineId: 'engine', element: cellElement() }],
  ]);
  function group(ids) {
    const toolOptions = {
      WindowLevel: { mode: 'Active', bindings: [{ mouseButton: 1 }] },
      Pan: { mode: 'Active', bindings: [{ mouseButton: 4 }] },
      Zoom: { mode: 'Active', bindings: [{ mouseButton: 2 }] },
      StackScroll: { mode: 'Active', bindings: [{ mouseButton: 524288 }] },
      Length: { mode: 'Passive', bindings: [] },
    };
    return { toolOptions, cursors: [],
      setViewportsCursorByToolName(name) { this.cursors.push(name); },
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
  const scrolls = [];
  const window = { top: {},
    cornerstone: { eventTarget: events, Enums: { Events: { ELEMENT_ENABLED: 'enabled' } },
      getRenderingEngine: () => ({ getViewport: id => views.get(id) }) },
    cornerstoneTools: { Enums: { MouseBindings: { Primary: 1, Secondary: 2, Primary_And_Secondary: 3, Auxiliary: 4, Wheel: 524288 } },
      ToolGroupManager: { getToolGroupForViewport: id => id === 'mpr' ? mpr : stack },
      utilities: { scroll(viewport, options) { scrolls.push([viewport.id, options.delta]); viewport.index += options.delta; } } },
  };
  const context = { window, document: {},
    requestAnimationFrame(fn) { pending.set(++frame, fn); return frame; },
    cancelAnimationFrame(id) { pending.delete(id); },
  };
  vm.runInNewContext(readFileSync('config/ohif.js', 'utf8'), context);
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-ux');
  await extension.preRegistration({ servicesManager: { services } });
  const flush = () => { const work = [...pending.values()]; pending.clear(); work.forEach(fn => fn()); };
  const bindings = g => JSON.parse(JSON.stringify(g.toolOptions));
  const buttons = (g, name) => g.toolOptions[name].bindings.map(b => b.mouseButton).sort((a, b) => a - b);
  // A wheel step on a cell as the browser sends it to the capture listener on the cell.
  const wheel = (id, deltaY, keys = {}) => {
    const element = views.get(id).element, event = { deltaY, clientX: 150, clientY: 100, currentTarget: element, prevented: false, stopped: false,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...keys,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const listener of element.listeners.filter(entry => entry.type === 'wheel')) listener.fn(event);
    return event;
  };
  return { extension, stack, mpr, listeners, window, flush, bindings, buttons, services, context, views, scrolls, wheel };
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

test('A3 C-R01-029 #52: Pointer frees the stack primary button, keeps wheel/right, leaves MPR, and any tool takes it back', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  const mouse = f.window.kinViewerStackMouse, beforeMpr = f.bindings(f.mpr);
  assert.equal(typeof mouse.point, 'function', 'the stack mouse offers a pointer');
  assert.equal(mouse.pointing(), false, 'Stack Scroll holds the primary button after entry');
  f.stack.setToolPassive('StackScroll');
  f.stack.setToolActive('Length', { bindings: [{ mouseButton: 1 }] });
  assert.equal(mouse.point(), true);
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), undefined, 'no tool draws or scrolls on a primary drag');
  assert.equal(mouse.pointing(), true);
  // Pinned setToolPassive keeps the Length cursor (Astra r1); no cursor is defined as 'default', so the cells get the plain one.
  assert.deepEqual(f.stack.cursors, ['default']);
  assert.deepEqual(f.mpr.cursors, []);
  const options = f.bindings(f.stack);
  assert.equal(options.Length.mode, 'Passive', 'Length marks stay selectable and movable');
  assert.deepEqual(options.StackScroll.bindings, [{ mouseButton: 524288 }]);
  assert.deepEqual(options.WindowLevel.bindings, [{ mouseButton: 2 }]);
  assert.deepEqual(options.Pan.bindings, [{ mouseButton: 4 }]);
  assert.deepEqual(f.bindings(f.mpr), beforeMpr, 'MPR keeps its own primary tool');
  assert.equal(mouse.point(), true, 'choosing Pointer again keeps it');
  assert.equal(mouse.pointing(), true);
  assert.deepEqual(f.stack.cursors, ['default'], 'nothing to free, nothing reset');
  f.stack.setToolActive('Length', { bindings: [{ mouseButton: 1 }] });
  assert.equal(mouse.pointing(), false, 'another tool takes the primary button back');
  f.services.viewportGridService.getActiveViewportId = () => 'mpr';
  assert.equal(mouse.pointing(), null, 'not offered on an MPR cell');
  assert.equal(mouse.point(), false);
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'Length', 'refused on MPR: nothing changes');
  f.extension.onModeExit();
});

// A1 04-3 Mouse & Wheel: the account's choices on the stack groups (viewer-features-input.js saves and passes them).
test('A1 04-3: the binding table; the defaults are the stack bindings before the choice existed', async () => {
  const { context: c } = await fixture();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(c.kinMouseSettings(undefined)), { middle: 'Pan', right: 'WindowLevel', both: 'None', defaultTool: 'StackScroll', wheelStep: 1, wrap: false, ctrlZoom: 0 });
  assert.deepEqual(plain(c.kinMouseBindings(undefined, 'StackScroll')),
    { StackScroll: [{ mouseButton: 1 }, { mouseButton: 524288 }], WindowLevel: [{ mouseButton: 2 }], Pan: [{ mouseButton: 4 }] });
  assert.deepEqual(plain(c.kinMouseBindings({ right: 'Zoom', both: 'WindowLevel', middle: 'None' }, 'Pointer')),
    { Zoom: [{ mouseButton: 2 }], WindowLevel: [{ mouseButton: 3 }], StackScroll: [{ mouseButton: 524288 }] });
  // One tool on several buttons gets them together.
  assert.deepEqual(plain(c.kinMouseBindings({ right: 'StackScroll', both: 'StackScroll', middle: 'None' }, 'StackScroll')),
    { StackScroll: [{ mouseButton: 1 }, { mouseButton: 2 }, { mouseButton: 3 }, { mouseButton: 524288 }] });
  // A stored value that is not a choice is its default (the middle button offers no Stack Scroll).
  assert.deepEqual(plain(c.kinMouseSettings({ right: 'Length', middle: 'StackScroll', wheelStep: 4, wrap: 'yes', ctrlZoom: 15, defaultTool: 'Angle' })),
    plain(c.kinMouseSettings(null)));
  assert.deepEqual(plain(c.kinMouseSettings({ right: 'Pan', both: 'Zoom', wheelStep: 3, wrap: true, ctrlZoom: 10, defaultTool: 'Pointer', middle: 'None' })),
    { middle: 'None', right: 'Pan', both: 'Zoom', defaultTool: 'Pointer', wheelStep: 3, wrap: true, ctrlZoom: 10 });
});

test('A1 04-3: the wheel step stops on an end and, with wraparound, goes round from the end both ways', async () => {
  const { context: c } = await fixture();
  const cases = [[0, 1, 3, false, 3], [12, 1, 3, false, 15], [14, 1, 3, false, 15], [15, 1, 3, false, 15], [15, 1, 3, true, 0],
    [14, 1, 3, true, 15], [1, -1, 3, true, 0], [0, -1, 3, true, 15], [0, -1, 1, false, 0], [15, 1, 1, true, 0], [7, -1, 5, false, 2]];
  for (const [index, direction, step, wrap, expected] of cases)
    assert.equal(c.kinWheelTarget(index, 16, direction, step, wrap), expected, JSON.stringify({ index, direction, step, wrap }));
  assert.equal(c.kinWheelTarget(4, 0, 1, 3, true), 4);
});

test('A1 04-3: Apply puts the choices on the groups already open, keeps the left tool, and MPR keeps its own', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  const mouse = f.window.kinViewerStackMouse, beforeMpr = f.bindings(f.mpr);
  mouse.configure({ right: 'Zoom', both: 'Pan', middle: 'None' });
  assert.deepEqual(f.buttons(f.stack, 'StackScroll'), [1, 524288]);
  assert.deepEqual(f.buttons(f.stack, 'Zoom'), [2]);
  assert.deepEqual(f.buttons(f.stack, 'Pan'), [3]);
  assert.deepEqual(f.buttons(f.stack, 'WindowLevel'), []);
  assert.deepEqual(f.bindings(f.mpr), beforeMpr);
  // Apply's Left button puts that tool on the left now.
  mouse.configure({ right: 'Zoom', both: 'Pan', middle: 'None' }, { left: 'WindowLevel' });
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'WindowLevel');
  assert.deepEqual(f.buttons(f.stack, 'StackScroll'), [524288]);
  f.extension.onModeExit();
});

test('A1 04-3: a toolbar choice changes only the left button; right, both and wheel stay through later saves', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  const mouse = f.window.kinViewerStackMouse;
  mouse.configure({ right: 'Zoom', both: 'WindowLevel' });
  // As the stock toolbar selects a tool: the old primary tool goes passive, the new one takes the primary button.
  f.stack.setToolPassive('StackScroll'); f.stack.setToolActive('Length', { bindings: [{ mouseButton: 1 }] });
  for (const listener of f.listeners) listener(); f.flush();
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'Length');
  assert.deepEqual([f.buttons(f.stack, 'Zoom'), f.buttons(f.stack, 'WindowLevel'), f.buttons(f.stack, 'StackScroll')], [[2], [3], [524288]]);
  // Another window saves the same value, then a new right button: the reader's Length stays on the left.
  mouse.configure({ right: 'Zoom', both: 'WindowLevel' });
  mouse.configure({ right: 'Pan', both: 'WindowLevel' });
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'Length');
  assert.deepEqual([f.buttons(f.stack, 'Pan'), f.buttons(f.stack, 'Zoom'), f.buttons(f.stack, 'Length')], [[2, 4], [], [1]]);
  f.extension.onModeExit();
});

test('A1 04-3: the default tool is the left tool of a new group and what turning a tool off returns to; Pointer stays Pointer', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  let mouse = f.window.kinViewerStackMouse;
  // Read after the groups were set up with the old default: an untouched left follows the new default.
  mouse.configure({ defaultTool: 'Zoom' });
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'Zoom');
  f.stack.setToolPassive('Zoom'); f.stack.setToolActive('Length', { bindings: [{ mouseButton: 1 }] });
  assert.equal(mouse.deselect('Length'), true);
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'Zoom');
  assert.equal(mouse.deselect('Zoom'), false, 'the default tool itself is not turned off');
  // Pointer (Astra: point() is not the default tool's way back): it frees the left button and nothing takes it back.
  assert.equal(mouse.point(), true);
  assert.equal(mouse.pointing(), true);
  for (const listener of f.listeners) listener(); f.flush();
  assert.equal(mouse.pointing(), true);
  // A default of Pointer: turning a tool off leaves the left button free.
  mouse.configure({ defaultTool: 'Pointer' });
  f.stack.setToolActive('Length', { bindings: [{ mouseButton: 1 }] });
  assert.equal(mouse.deselect('Length'), true);
  assert.equal(mouse.pointing(), true);
  // A new mode entry (a new group for this document) starts from the last choices.
  mouse.configure({ defaultTool: 'WindowLevel', right: 'Zoom' });
  f.extension.onModeExit();
  f.extension.onModeEnter(); f.flush(); mouse = f.window.kinViewerStackMouse;
  assert.equal(f.stack.getActivePrimaryMouseButtonTool(), 'WindowLevel');
  assert.deepEqual(f.buttons(f.stack, 'Zoom'), [2]);
  f.extension.onModeExit();
});

test('A1 04-3: wheel steps, wraparound and Ctrl+wheel zoom act once on a stack cell; the defaults leave the native wheel', async () => {
  const f = await fixture(); f.extension.onModeEnter(); f.flush();
  const mouse = f.window.kinViewerStackMouse, left = f.views.get('left');
  assert.deepEqual(f.views.get('mpr').element.listeners, [], 'no wheel handling on an MPR cell');
  assert.equal(left.element.listeners.filter(entry => entry.type === 'wheel' && entry.options.capture && !entry.options.passive).length, 1);
  // Defaults: the native scroll and the native nothing on Ctrl+wheel.
  let event = f.wheel('left', 100);
  assert.equal(event.prevented || event.stopped, false); assert.deepEqual(f.scrolls, []);
  event = f.wheel('left', -100, { ctrlKey: true });
  assert.equal(event.stopped, false); assert.equal(left.camera.parallelScale, 100);
  mouse.configure({ wheelStep: 3, wrap: true, ctrlZoom: 10 });
  event = f.wheel('left', 100);
  assert.equal(event.prevented && event.stopped, true, 'taken before the native scroll, so one step runs once');
  assert.equal(left.index, 3);
  for (let n = 0; n < 4; n++) f.wheel('left', 100);
  assert.equal(left.index, 15, 'a step past the end stops on the last image');
  f.wheel('left', 100); assert.equal(left.index, 0, 'from the last image it goes round to the first');
  f.wheel('left', -100); assert.equal(left.index, 15, 'and backwards from the first to the last');
  f.wheel('left', 0.5); assert.equal(left.index, 15, 'a wheel event without a step does nothing');
  // Ctrl+wheel up: 10 % larger around the pointer (150,100 -> world 50,0); down undoes it.
  f.wheel('left', -100, { ctrlKey: true });
  assert.ok(Math.abs(left.camera.parallelScale - 100 / 1.1) < 1e-9);
  assert.ok(Math.abs(left.camera.focalPoint[0] - 50 * (1 - 1 / 1.1)) < 1e-9);
  assert.equal(left.camera.position[0], left.camera.focalPoint[0]);
  f.wheel('left', 100, { ctrlKey: true });
  assert.ok(Math.abs(left.camera.parallelScale - 100) < 1e-9);
  assert.equal(f.wheel('left', 100, { shiftKey: true }).stopped, false, 'other modifiers stay native');
  f.extension.onModeExit();
  assert.deepEqual(left.element.listeners, [], 'the cell listener goes with the mode');
});
