const test=require('node:test'),assert=require('node:assert/strict');
const {screens,identity,fit}=require('../worklist-v0/hpacs-lite/viewer-display-layout.js');
test('available-screen order and identity exclude duplicates and unusable geometry',()=>{
 const a={availLeft:0,availTop:0,availWidth:1920,availHeight:1040,isPrimary:true},b={...a,availLeft:-1920,isPrimary:false};
 const list=screens({screens:[a,b,a,{...a,availWidth:NaN}]});
 assert.equal(list.length,2);assert.equal(list[0].left,-1920);assert.equal(list[1].primary,true);
 assert.notEqual(identity(list[0]),identity({...list[0],width:1280}));
});
test('an existing window fits the chosen screen including negative and smaller available bounds',()=>{
 assert.deepEqual(fit({width:1000,height:800},{left:-1920,top:0,width:1920,height:1040}),{left:-1460,top:120,width:1000,height:800});
 assert.deepEqual(fit({width:1600,height:1000},{left:1920,top:100,width:1280,height:720}),{left:1920,top:100,width:1280,height:720});
 assert.equal(fit({width:NaN,height:800},{left:0,top:0,width:1920,height:1040}),null);
});
