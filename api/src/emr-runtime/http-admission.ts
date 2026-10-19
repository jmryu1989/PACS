import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { refuse } from '../emr-contract/validation';

/** Admission belongs to the raw listener, before Express can parse or dispatch a request. */
export function installHttpAdmission(server: Server, stopSignal: AbortSignal) {
  const existing = server.listeners('request');
  if (existing.length !== 1 || ['checkContinue', 'checkExpectation', 'upgrade', 'connect'].some(event => server.listenerCount(event))) {
    refuse('EmrHttpOwnershipRefused');
  }
  const downstream = existing[0] as (request: IncomingMessage, response: ServerResponse) => void;
  const sockets = new Set<Socket>();
  function rejectStopped(response: ServerResponse) {
    response.statusCode = 503;
    response.shouldKeepAlive = false;
    response.setHeader('Connection', 'close');
    response.setHeader('Cache-Control', 'no-store');
    response.end('Service unavailable');
  }
  function dispatch(request: IncomingMessage, response: ServerResponse) {
    if (stopSignal.aborted) { rejectStopped(response); return; }
    downstream.call(server, request, response);
  }
  function checkContinue(request: IncomingMessage, response: ServerResponse) {
    if (stopSignal.aborted) { rejectStopped(response); return; }
    response.writeContinue();
    downstream.call(server, request, response);
  }
  function checkExpectation(_request: IncomingMessage, response: ServerResponse) {
    if (stopSignal.aborted) { rejectStopped(response); return; }
    response.statusCode = 417;
    response.end();
  }
  function unsupported(_request: IncomingMessage, socket: Socket) { socket.destroy(); }
  server.removeListener('request', downstream);
  const handlers = { request: dispatch, checkContinue, checkExpectation, upgrade: unsupported, connect: unsupported };
  for (const [event, handler] of Object.entries(handlers)) server.on(event, handler);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return Object.freeze({
    verifyOwnership() {
      for (const [event, handler] of Object.entries(handlers)) {
        const listeners = server.listeners(event);
        if (listeners.length !== 1 || listeners[0] !== handler) refuse('EmrHttpOwnershipRefused');
      }
    },
    destroyAll() { for (const socket of sockets) socket.destroy(); },
  });
}
