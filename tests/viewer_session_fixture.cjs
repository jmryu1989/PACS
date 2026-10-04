'use strict';
// Panel tests isolate the document's lifecycle port. The real controller, scheduling,
// fetch/XHR delivery and failed window closure are covered by viewer_session_dom_test.py.
const fs = require('node:fs');
const vm = require('node:vm');
const gates = require('../worklist-v0/hpacs-lite/work-context.js');
const transports = require('../worklist-v0/hpacs-lite/session-transport.js');
const resources = require('../worklist-v0/hpacs-lite/viewer-resources.js');
const config = fs.readFileSync(require.resolve('../config/ohif.js'), 'utf8');

function response(status, body, bad = false) {
  return new Response(bad ? '{' : JSON.stringify(body), {
    status, headers: body?.code ? { 'X-KIN-Auth-Code': body.code } : {},
  });
}

function pageDefaults(sandbox, send = sandbox.fetch, source = config) {
  const window = sandbox.window || sandbox;
  sandbox.window = window;
  const gate = gates.create(); let announce;
  gate.follow({ onLifecycle(listener) { announce = listener; listener({ state: 'active', session: 'S1' }); } });
  const end = () => announce({ state: 'ending', session: 'S1' });
  window.KinWorkContext = gate;
  window.KinViewerSessionBoundary = { active: () => gate.state() === 'active', ended: () => gate.state() === 'ending',
    wait: value => Promise.resolve(value), onEnd: run => gate.onInvalidate(() => { if (gate.state() === 'ending') run(); }) };
  const transport = transports.create({ gate, fetch: send,
    authFailure: failure => { if (failure.session === gate.session()) end(); },
  });
  sandbox.fetch = transport.fetch;
  window.fetch = transport.fetch;
  window.URL = class extends URL {};
  window.DOMException = DOMException;
  window.KinViewerResource = resources.create(window, window.KinViewerSessionBoundary, value => {
    const url = new URL(value, sandbox.location?.href || 'https://viewer.test');
    return url.origin === (sandbox.location?.origin || 'https://viewer.test') && /^\/(api|dicom-web|instances)(\/|$)/.test(url.pathname);
  });
  window.KinSessionTransport = { page: () => transport };
  sandbox.document ||= {};
  sandbox.location ||= {};
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'ohif.js' });
  const session = vm.runInContext('kinViewerSession', context);
  return { session, gate, end, transport, context };
}
const sessionWorld = pageDefaults;
function loadPanel(page, name) {
  vm.runInContext(fs.readFileSync(require.resolve('../worklist-v0/hpacs-lite/' + name), 'utf8'), page.context, {filename:name});
}
module.exports = { pageDefaults, sessionWorld, response, loadPanel };
