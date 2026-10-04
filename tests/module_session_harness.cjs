'use strict';
// Isolated document defaults using the shipped gate and transport factories.
const gates = require('../worklist-v0/hpacs-lite/work-context.js');
const transports = require('../worklist-v0/hpacs-lite/session-transport.js');
function install(fetch, target = globalThis) {
  const gate = gates.create();
  let publish;
  const session = 'SYN-MODULE-SESSION';
  gate.follow({ onLifecycle(listener) { publish = listener; listener({ state: 'active', session }); } });
  const transport = transports.create({ gate, fetch: fetch || (target !== globalThis ? (url, init) => target.fetch(url, init) : undefined), deadlineMs: 0, authFailure(failure) {
    if (failure.session === session && ['AUTH_SESSION_ENDED', 'AUTH_SESSION_MISMATCH'].includes(failure.code))
      publish({ state: 'ending', session });
  } });
  target.KinWorkContext = gate;
  target.KinSessionTransport = { page: () => transport };
  return { gate, transport, end: () => publish({ state: 'ending', session }) };
}
module.exports = { install };
