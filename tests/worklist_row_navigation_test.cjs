const test=require('node:test'),assert=require('node:assert/strict');
const {nextUid}=require('../worklist-v0/hpacs-lite/worklist-row-navigation.js');
test('navigation follows the authorized sorted result across page boundaries without wrapping',()=>{
  const rows=Array.from({length:31},(_,i)=>({uid:'study-'+i}));
  assert.equal(nextUid(rows,'study-24','ArrowDown'),'study-25');
  assert.equal(nextUid(rows,'study-25','ArrowUp'),'study-24');
  assert.equal(nextUid(rows,'study-0','ArrowUp'),'study-0');
  assert.equal(nextUid(rows,'study-30','ArrowDown'),'study-30');
  assert.equal(nextUid(rows,'study-12','Home'),'study-0');
  assert.equal(nextUid(rows,'study-12','End'),'study-30');
});
test('empty or replaced results cannot return a stale study; unrelated keys are untouched',()=>{
  assert.equal(nextUid([],'old','ArrowDown'),null);
  assert.equal(nextUid([{uid:'new'}],'old','ArrowDown'),'new');
  assert.equal(nextUid([{uid:'new'}],'old','ArrowUp'),'new');
  for(const key of ['Enter',' ','Tab','Escape'])assert.equal(nextUid([{uid:'new'}],'new',key),null);
});
