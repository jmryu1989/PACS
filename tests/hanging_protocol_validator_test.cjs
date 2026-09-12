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

test('server validator detaches plane cells and keeps stack cells as plain strings',()=>{
  const value=cases.valid.find(item=>item.name==='three explicit planes of one current volume').value;
  const clean=normalizeHangingProtocol(value),cells=clean.rules[0].layout.cells;
  assert.equal(cells.length,4,'a plane layout keeps one cell per viewport');
  assert.notEqual(cells[0],value.rules[0].layout.cells[0]);
  assert.deepEqual(cells[0],{alias:'Current',view:'mpr',orientation:'axial'});
  assert.equal(Object.getPrototypeOf(cells[0]),Object.prototype);
  const mixed=cases.valid.find(item=>item.name==='one plane beside a stack cell of the same series').value;
  assert.equal(typeof normalizeHangingProtocol(mixed).rules[0].layout.cells[0],'string');
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
