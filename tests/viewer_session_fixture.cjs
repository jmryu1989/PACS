'use strict';
// Panel tests isolate the document's lifecycle port. The real controller, scheduling,
// fetch/XHR delivery and failed window closure are covered by viewer_session_dom_test.py.
const fs = require('node:fs');
const vm = require('node:vm');
const gates = require('../worklist-v0/hpacs-lite/work-context.js');
const transports = require('../worklist-v0/hpacs-lite/session-transport.js');
const config = fs.readFileSync(require.resolve('../config/ohif.js'), 'utf8');

function response(status, body, bad = false) {
  return new Response(bad ? '{' : JSON.stringify(body), {
    status, headers: body?.code ? { 'X-KIN-Auth-Code': body.code } : {},
  });
}

function sessionWorld(sandbox, send) {
  const window = sandbox.window || sandbox;
  sandbox.window = window;
  const gate = gates.create(); let announce;
  gate.follow({ onLifecycle(listener) { announce = listener; listener({ state: 'active', session: 'S1' }); } });
  const end = () => announce({ state: 'ending', session: 'S1' });
  window.KinWorkContext = gate;
  window.KinViewerSessionBoundary = { active: () => gate.state() === 'active', ended: () => gate.state() === 'ending' };
  const transport = transports.create({ gate, fetch: send,
    authFailure: failure => { if (failure.session === gate.session()) end(); },
  });
  sandbox.fetch = transport.fetch;
  const context = vm.createContext(sandbox);
  vm.runInContext(config, context, { filename: 'ohif.js' });
  const session = vm.runInContext('kinViewerSession', context);
  return { session, gate, end, context };
}
module.exports = { sessionWorld, response };
