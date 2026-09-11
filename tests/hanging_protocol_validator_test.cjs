const {test}=require('node:test');
const assert=require('node:assert/strict');
const cases=require('./hanging_protocol_contract_cases.json');
const {normalizeHangingProtocol}=require('../api/src/hanging-protocol.ts');

test('server validator accepts every shared valid case without changing canonical data',()=>{
  for(const item of cases.valid)assert.deepEqual(normalizeHangingProtocol(item.value),item.value,item.name);
});

test('server validator rejects every shared invalid case',()=>{
  for(const item of cases.invalid)assert.equal(normalizeHangingProtocol(item.value),undefined,item.name);
});

test('server validator rejects non-JSON graphs and the byte limit before traversal',()=>{
  const cyclic={version:1,activeRuleId:null,rules:[]};cyclic.self=cyclic;
  assert.equal(normalizeHangingProtocol(cyclic),undefined);
  assert.equal(normalizeHangingProtocol({version:1,activeRuleId:null,rules:[],pad:'한'.repeat(65537)}),undefined);
  assert.equal(normalizeHangingProtocol(Object.assign(Object.create(null),{version:1,activeRuleId:null,rules:[]})),undefined);
  const sparse={version:1,activeRuleId:null,rules:Array(1)};assert.equal(normalizeHangingProtocol(sparse),undefined);
  const decorated={version:1,activeRuleId:null,rules:[]};decorated.rules.extra=true;assert.equal(normalizeHangingProtocol(decorated),undefined);
  const symbolic={version:1,activeRuleId:null,rules:[]};symbolic[Symbol('extra')]=true;assert.equal(normalizeHangingProtocol(symbolic),undefined);
  let invoked=false;const accessor={version:1,activeRuleId:null,rules:[]};Object.defineProperty(accessor,'extra',{enumerable:false,get(){invoked=true;return 1}});
  assert.equal(normalizeHangingProtocol(accessor),undefined);assert.equal(invoked,false);
});
