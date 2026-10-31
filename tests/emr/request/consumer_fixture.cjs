'use strict';
// Existing pure business/CAS cases supply their store double through the real
// request context. This does not claim Guard, PostgreSQL or publication evidence.
const {IncomingMessage, ServerResponse} = require('node:http');
const {Socket} = require('node:net');
if (!require('node:fs').existsSync('/app/dist/app.module.js')) require('../../service_test_loader.cjs');
const {createRequestContext} = require('/app/dist/emr-runtime/request-context');
const {createRequestIngress} = require('/app/dist/emr-runtime/request-ingress');

// The draft and commit routes as the controller hands them the shared facts: caller and facts argument positions.
const ROUTES = {
  putReport: {caller: 2, facts: 4, method: 'PUT', route: 'studies/:uid/report'},
  readDraft: {caller: 1, facts: 2, method: 'GET', route: 'studies/:uid/draft'},
  commitReport: {caller: 2, facts: 4, method: 'POST', route: 'studies/:uid/report/commit'},
  discardDraft: {caller: 2, facts: 4, method: 'DELETE', route: 'studies/:uid/draft'},
  forceDiscardDrafts: {caller: 2, facts: 4, method: 'DELETE', route: 'studies/:uid/draft/force'},
};

function withDraftRequestContext(service, ledger) {
  const requests = createRequestContext(createRequestIngress({proxyPeers:[]}), ledger);
  return new Proxy(service, {get(target, name) {
    const at = Object.hasOwn(ROUTES, name) ? ROUTES[name] : null;
    if (!at || typeof target[name] !== 'function') {
      const value = target[name];
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return async (...args) => {
      const caller = args[at.caller];
      const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
      requests.capture.capture(req,res,{issuer:'https://synthetic.invalid',subject:caller.sub,
        roles:caller.roles,institution:caller.institution,rightsVersion:1,binding:{method:'bearer',sessionRef:null}},
        {method:at.method,route:at.route,purpose:'clinical'},async()=>{});
      try {
        return await requests.source.withWork(req,request=>{
          args[at.facts] = {issuer:request.facts.issuer,ip:null,requestId:request.facts.requestId,request};
          return target[name](...args);
        });
      } finally {res.emit('finish');}
    };
  }});
}
module.exports = {withDraftRequestContext};
