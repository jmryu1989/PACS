const test=require('node:test'),assert=require('node:assert/strict');
const {create,normalize}=require('../worklist-v0/hpacs-lite/worklist-search');
test('manual criteria remain fixed across edits and refresh until explicit apply',()=>{
  const current={quick:'A',cols:{compound:{rules:[{value:'CT'}]}}};
  const s=create(current,{version:1,mode:'manual',clearResults:false});
  current.quick='B';current.cols.compound.rules[0].value='MR';s.change(current);
  assert.equal(s.read(current).criteria.quick,'A');assert.equal(s.read(current).criteria.cols.compound.rules[0].value,'CT');assert.equal(s.read(current).pending,true);
  s.configure({version:1,mode:'manual',clearResults:true},current);assert.equal(s.read(current).criteria.quick,'A');assert.equal(s.read(current).pending,true);
  s.apply(current);assert.equal(s.read(current).criteria.quick,'B');assert.equal(s.read(current).pending,false);
});
test('clear-result barrier survives refresh, while explicit application and automatic edits release it',()=>{
  const s=create({quick:'A'},{version:1,mode:'automatic',clearResults:true});
  s.clear({quick:''});assert.equal(s.read({quick:''}).empty,true);assert.equal(s.read({quick:''}).empty,true);
  s.change({quick:'B'});assert.equal(s.read({quick:'B'}).empty,false);
  s.clear({quick:''});s.apply({quick:''});assert.equal(s.read({quick:''}).empty,false);
  assert.equal(normalize({version:1,mode:'manual',clearResults:false,patient:'A'}),null);
});
