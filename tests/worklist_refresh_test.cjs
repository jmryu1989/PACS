const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const prefs = require('../worklist-v0/hpacs-lite/worklist-refresh.js');

test('TEST-WORKLIST-REFRESH: bounded explicit intervals, no coercion or extra data', () => {
  for (const seconds of [0,30,60,120,300]) assert.deepEqual(prefs.normalize({version:1,seconds}),{version:1,seconds});
  for (const value of [null,[],{}, {version:1,seconds:'30'},{version:1,seconds:-1},
    {version:1,seconds:1},{version:1,seconds:Infinity},{version:2,seconds:30},
    {version:1,seconds:30,uid:'not a preference'}]) assert.equal(prefs.normalize(value),null);
});

test('TEST-WORKLIST-REFRESH: restore, unavailable storage and ended/changed owner', () => {
  const data = new Map(), events = {}, handlers = {};
  let owner='["institution","actor"]', changed=0, fail=false;
  const window={localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>{if(fail)throw Error('blocked');data.set(k,v);}},
    addEventListener:(name,fn)=>events[name]=fn};
  const sandbox=vm.createContext({window});
  vm.runInContext(readFileSync(require.resolve('../worklist-v0/hpacs-lite/worklist-refresh.js'),'utf8'),sandbox);
  const select={value:'',disabled:true,addEventListener:(name,fn)=>handlers[name]=fn},status={textContent:''};
  const mount=()=>window.KinWorklistRefresh.mount({select,status,owner:()=>owner,changed:()=>changed++});
  const first=mount();assert.equal(first.seconds(),30);assert.equal(select.disabled,false);
  select.value='0';handlers.change();assert.equal(first.seconds(),0);assert.equal(changed,1);
  assert.deepEqual(JSON.parse([...data.values()][0]),{version:1,seconds:0});
  const second=mount();assert.equal(second.seconds(),0);
  fail=true;select.value='60';handlers.change();assert.equal(second.seconds(),60);assert.match(status.textContent,/현재 창/);
  assert.equal(JSON.parse([...data.values()][0]).seconds,0);
  owner='["institution","other"]';select.value='120';handlers.change();assert.equal(select.disabled,true);assert.equal(changed,2);
  assert.equal(second.seconds(),30);
  const third=mount();assert.equal(third.seconds(),30);events.pagehide();select.value='300';handlers.change();assert.equal(changed,2);
});
