'use strict';
// Existing pure business/CAS cases supply their store double through the real
// request context. This does not claim Guard, PostgreSQL or publication evidence.
const {IncomingMessage, ServerResponse} = require('node:http');
const {Socket} = require('node:net');
if (!require('node:fs').existsSync('/app/dist/app.module.js')) require('../../service_test_loader.cjs');
const {createRequestContext} = require('/app/dist/emr-runtime/request-context');
const {createRequestIngress} = require('/app/dist/emr-runtime/request-ingress');

function withDraftRequestContext(service, ledger) {
  const requests = createRequestContext(createRequestIngress({proxyPeers:[]}), ledger);
  return new Proxy(service, {get(target, name) {
    if (name !== 'putReport' && name !== 'readDraft') {
      const value = target[name];
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return async (...args) => {
      const caller = args[name === 'putReport' ? 2 : 1];
      const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
      requests.capture.capture(req,res,{issuer:'https://synthetic.invalid',subject:caller.sub,
        roles:caller.roles,institution:caller.institution,rightsVersion:1,binding:{method:'bearer',sessionRef:null}},
        {method:name === 'putReport' ? 'PUT' : 'GET',route:name === 'putReport' ? 'studies/:uid/report' : 'studies/:uid/draft',purpose:'clinical'},async()=>{});
      try {
        return await requests.source.withWork(req,request=>{
          args[name === 'putReport' ? 4 : 2] = {issuer:request.facts.issuer,ip:null,requestId:request.facts.requestId,request};
          return target[name](...args);
        });
      } finally {res.emit('finish');}
    };
  }});
}
module.exports = {withDraftRequestContext};
