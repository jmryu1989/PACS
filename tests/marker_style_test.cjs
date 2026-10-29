'use strict';
/* Minhoon item 12 (MH-4) -> RISK marker style changes a record / misses some marks / crosses accounts
 * -> TEST-MARKER-STYLE. A reader's marker colour and thickness redraw every mark on their screens at
 * once, return to the viewer's own style exactly, never follow another account, and roam with the
 * account appearance without letting an older client erase them. Assertions are on the drawn style,
 * the stored choice and the service's public answers. The served viewer check is
 * tests/e2e/test_marker_style.py. */
const test=require('node:test'),assert=require('node:assert/strict');
const markers=require('../worklist-v0/hpacs-lite/marker-style.js');
if(!require('node:fs').existsSync('/app/dist/pacs'))require('./service_test_loader.cjs');
const {PacsService}=require('/app/dist/pacs.service');
const clone=v=>structuredClone(v);

// A browser-like document: one window event target and its localStorage.
function browser(){
  const store=new Map(),win=new EventTarget();
  globalThis.window=win;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>({getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>store.delete(k)})});
  const storageEvent=key=>{const e=new Event('storage');e.key=key;win.dispatchEvent(e);};
  return {store,win,storageEvent};
}
// Cornerstone's default tool style registry and viewports; redraws are counted per viewport.
const BASELINE={global:{color:'rgb(255, 255, 0)',colorHighlighted:'rgb(0, 255, 0)',colorSelected:'rgb(0, 220, 0)',colorLocked:'rgb(209, 193, 90)',
  lineWidth:'1.5',lineDash:'',textBoxColor:'rgb(255, 255, 0)',textBoxColorHighlighted:'rgb(0, 255, 0)',textBoxColorLocked:'rgb(209, 193, 90)',textBoxFontSize:'15px'},
  ArrowAnnotate:{lineDash:'4,4'}};
function viewer(){
  let styles=clone(BASELINE);const redraws=[];
  const viewports=['a','b'].map(id=>({id,element:{id}}));
  const tools={annotation:{config:{style:{getDefaultToolStyles:()=>styles,setDefaultToolStyles:next=>{styles=clone(next);}}}},
    utilities:{triggerAnnotationRender:element=>redraws.push(element.id)}};
  const cornerstone={getRenderingEngines:()=>[{getViewports:()=>viewports}]};
  return {tools,cornerstone,redraws,styles:()=>styles};
}
const OWNER=JSON.stringify(['hospital','reader']),OTHER=JSON.stringify(['hospital','someone-else']);

test('a chosen colour and thickness cover every mark state but selection, and default restores the viewer style exactly',()=>{
  assert.deepEqual(markers.styles(BASELINE,markers.defaults()),BASELINE);
  const red=markers.styles(BASELINE,{version:1,color:'red',width:'thick'});
  for(const name of ['color','colorLocked','textBoxColor','textBoxColorLocked'])assert.equal(red.global[name],'rgb(255, 64, 64)',name);
  for(const name of ['colorHighlighted','colorSelected','textBoxColorHighlighted'])assert.equal(red.global[name],BASELINE.global[name],name+' keeps pointing out the mark under the pointer');
  assert.equal(Number(red.global.lineWidth),3);
  assert.equal(Number(markers.styles(BASELINE,{version:1,color:'default',width:'extra-thick'}).global.lineWidth),4.5);
  // A tool's own default changes only what it already sets; it keeps its dashes and inherits the rest.
  assert.deepEqual(red.ArrowAnnotate,{lineDash:'4,4'});
  // Every offered choice is a distinct drawn style.
  const drawn=new Set();
  for(const [color] of markers.colors)for(const [width] of markers.widths)drawn.add(JSON.stringify(markers.styles(BASELINE,{version:1,color,width}).global));
  assert.equal(drawn.size,markers.colors.length*markers.widths.length);
});

test('stored choices are per account, and a damaged or foreign value draws the default',()=>{
  const b=browser();
  assert.deepEqual(markers.read(OWNER),markers.defaults());
  assert.equal(markers.publish(OWNER,{version:1,color:'cyan',width:'thick'}),true);
  assert.deepEqual(markers.read(OWNER),{version:1,color:'cyan',width:'thick'});
  assert.deepEqual(markers.read(OTHER),markers.defaults());
  for(const bad of ['{',JSON.stringify({version:1,color:'green',width:'thick'}),JSON.stringify({version:1,color:'cyan',width:'thick',extra:1}),JSON.stringify({version:2,color:'cyan',width:'thick'}),' '.repeat(257)]){
    b.store.set(markers.key(OWNER),bad);assert.deepEqual(markers.read(OWNER),markers.defaults(),bad.slice(0,40));
  }
  assert.equal(markers.publish(OWNER,{version:1,color:'purple',width:'thick'}),false);
  assert.equal(markers.publish('',markers.defaults()),false);
});

test('an open viewer redraws all its marks at once on a change and ignores another account',()=>{
  const b=browser(),v=viewer();
  markers.publish(OWNER,{version:1,color:'magenta',width:'standard'});
  const mounted=markers.mount({tools:v.tools,cornerstone:v.cornerstone,owner:OWNER});
  assert.equal(v.styles().global.color,'rgb(255, 0, 255)','a new viewer document starts with the stored choice');
  assert.deepEqual(v.redraws,['a','b']);
  v.redraws.length=0;
  // The work page's dialog in the same window (or the embedding page) announces the value.
  b.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OTHER,value:{version:1,color:'white',width:'extra-thick'}}}));
  assert.equal(v.styles().global.color,'rgb(255, 0, 255)');assert.deepEqual(v.redraws,[]);
  b.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:{version:1,color:'white',width:'extra-thick'}}}));
  assert.equal(v.styles().global.color,'rgb(255, 255, 255)');assert.equal(Number(v.styles().global.lineWidth),4.5);
  assert.deepEqual(v.redraws,['a','b'],'every viewport redraws its marks without a reload');
  // Another window stored a newer choice: the storage notice re-reads it.
  b.store.set(markers.key(OWNER),JSON.stringify({version:1,color:'cyan',width:'thick'}));b.storageEvent(markers.key(OWNER));
  assert.equal(v.styles().global.color,'rgb(0, 255, 255)');assert.equal(Number(v.styles().global.lineWidth),3);
  b.store.set(markers.key(OTHER),JSON.stringify({version:1,color:'red',width:'thick'}));b.storageEvent(markers.key(OTHER));
  assert.equal(v.styles().global.color,'rgb(0, 255, 255)');
  mounted.dispose();
  // A later mount in the same document (next study) still knows the viewer's own style.
  const again=markers.mount({tools:v.tools,cornerstone:v.cornerstone,owner:OWNER});
  b.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:markers.defaults()}}));
  assert.deepEqual(v.styles(),BASELINE);
  again.dispose();
  b.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:{version:1,color:'red',width:'thick'}}}));
  assert.deepEqual(v.styles(),BASELINE,'a disposed mount follows nothing');
});

test('a viewer without the style registry draws as before',()=>{
  browser();
  assert.equal(markers.mount({tools:{},cornerstone:{getRenderingEngines:()=>[]},owner:OWNER}),null);
  assert.equal(markers.mount({tools:viewer().tools,cornerstone:viewer().cornerstone,owner:null}),null);
});

// The account appearance carries the choice (version 10); the service checks and keeps it.
function appearanceFixture(){
  let rows=new Map();
  const key=o=>JSON.stringify([o.institution,o.subject]);
  const table=store=>({
    async findUnique({where}){return clone(store.get(key(where.institution_subject))??null);},
    async create({data}){if(store.has(key(data)))throw Object.assign(Error('unique'),{code:'P2002'});store.set(key(data),clone(data));return clone(data);},
    async updateMany({where,data}){
      const row=store.get(key(where));
      const stored=where.OR.some(c=>c.sizes.path.join()==='version'&&row?.sizes?.version===c.sizes.equals);
      if(!row||row.revision!==where.revision||!stored)return {count:0};
      store.set(key(where),{...row,sizes:clone(data.sizes),revision:row.revision+data.revision.increment});return {count:1};
    },
  });
  const prisma={readingAppearance:{findUnique:a=>table(rows).findUnique(a)},async $transaction(run){const pending=clone(rows);const result=await run({readingAppearance:table(pending)});rows=pending;return result;}};
  return {service:new PacsService(prisma,{},{},{},{}),snapshot:()=>clone(rows)};
}
const caller={kind:'member',institution:'synthetic-a',sub:'reader-a',actor:'reader@synthetic.test',roles:['radiologist']};
const owner=[caller.institution,caller.sub];
const profile=color=>({size:12,font:'default',color,name:true,date:true,description:false,position:'top-right',fieldPositions:{name:'top-right',date:'top-right',description:'top-right'},overrides:{}});
const v9=()=>({version:9,list:12,current:12,prior:12,fonts:{version:1,list:'default',current:'default',prior:'default'},colors:{version:1,list:'default',current:'default',prior:'default'},
  dock:{version:2,placement:'bottom',panel:-1,autoHide:false},viewer:{version:3,current:profile('default'),prior:profile('warm')},
  toolbar:{version:1,order:['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools'],hidden:[]},
  mpr:{version:1,progressive:false,display:{autoHideCrosshair:false,cube:true,demographics:true,orientation:true,sample:true,scale:true,thickness:true,windowing:true,zoom:true},mouse:{left:'WindowLevel',middle:'Pan',right:'Zoom'},sync:{windowing:true,zoom:false}}});
const v10=(choice={version:1,color:'red',width:'thick'})=>({...v9(),version:10,markers:choice});
const status=code=>e=>e.getStatus?.()===code;

test('the account appearance keeps the marker choice and an older client cannot erase it',async()=>{
  const f=appearanceFixture(),save=(sizes,revision)=>f.service.saveReadingAppearance({expectedOwner:owner,revision,sizes},caller);
  const first=await save(v10(),0);
  assert.deepEqual(first.sizes.markers,{version:1,color:'red',width:'thick'});
  assert.deepEqual((await f.service.readingAppearance(caller)).sizes,v10());
  const before=f.snapshot();
  for(const choice of [{version:1,color:'green',width:'thick'},{version:1,color:'red',width:'hairline'},{version:2,color:'red',width:'thick'},{version:1,color:'red',width:'thick',points:[[0,0]]},null])
    await assert.rejects(save(v10(choice),first.revision),status(400),JSON.stringify(choice));
  const missing=v10();delete missing.markers;await assert.rejects(save(missing,first.revision),status(400));
  // A version 9 client knows the revision but would drop the markers: refused, row kept.
  await assert.rejects(save(v9(),first.revision),status(409));
  assert.deepEqual(f.snapshot(),before);
  const second=await save(v10({version:1,color:'default',width:'standard'}),first.revision);
  assert.equal(second.revision,2);assert.deepEqual(second.sizes.markers,markers.defaults());
  // An account saved by an older client still upgrades to version 10.
  const g=appearanceFixture(),old=await g.service.saveReadingAppearance({expectedOwner:owner,revision:0,sizes:v9()},caller);
  assert.deepEqual((await g.service.saveReadingAppearance({expectedOwner:owner,revision:old.revision,sizes:v10()},caller)).sizes.markers,{version:1,color:'red',width:'thick'});
});
