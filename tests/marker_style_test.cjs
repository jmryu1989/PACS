'use strict';
/* Minhoon item 12 (MH-4) -> RISK marker style changes a record / misses some marks / crosses accounts
 * -> TEST-MARKER-STYLE. A reader's marker colour and thickness redraw every mark on their screens at
 * once, return to the viewer's own style exactly, never follow another account, and roam with the
 * account appearance without letting an older client erase them. Assertions are on the drawn style,
 * the stored choice and the service's public answers. The served viewer check is
 * tests/e2e/test_marker_style.py. */
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
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
  assert.deepEqual(markers.read(OWNER),{...markers.defaults(),color:'cyan',width:'thick'});
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

// The real viewer session (config/ohif/clinician-context.js) and marker extension (config/ohif/marker-style.js)
// in one realm; the window, /me and Cornerstone are synthetic.
function viewerDocument(){
  const b=browser(),v=viewer(),me=[];
  const realm=vm.createContext({window:b.win,Promise,JSON,Error,Set,Map,Object,Array,
    fetch:()=>me.length?Promise.resolve(me.shift()):Promise.reject(Error('network down'))});
  b.win.KinMarkerStyle=markers;b.win.cornerstoneTools=v.tools;b.win.cornerstone=v.cornerstone;
  for(const file of ['clinician-context.js','marker-style.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../config/ohif',file),'utf8'),realm,{filename:file});
  return {...b,...v,me,session:vm.runInContext('kinViewerSession',realm),extension:vm.runInContext('kinCreateMarkerStyle()',realm)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const reader={kind:'member',institution:'hospital',sub:'reader',roles:['radiologist']};

test('a viewer whose first /me failed follows the choice once a later answer names the account',async()=>{
  const d=viewerDocument();
  markers.publish(OWNER,{version:1,color:'red',width:'thick'});
  d.extension.onModeEnter();await settle();
  assert.deepEqual(d.styles(),BASELINE,'no account yet: the viewer style stays');
  // Another extension's later /me (history retries on focus) settles the role for this open viewer.
  d.session.note(reader);await settle();
  assert.equal(d.styles().global.color,'rgb(255, 64, 64)');assert.equal(Number(d.styles().global.lineWidth),3);
  markers.publish(OWNER,{version:1,color:'cyan',width:'standard'});
  assert.equal(d.styles().global.color,'rgb(0, 255, 255)','later changes follow without reopening the viewer');
  d.extension.onModeExit();
  markers.publish(OWNER,{version:1,color:'white',width:'thick'});
  assert.equal(d.styles().global.color,'rgb(0, 255, 255)','after mode exit nothing follows');
});

test('a mode exit before the late answer leaves the viewer style alone',async()=>{
  const d=viewerDocument();
  markers.publish(OWNER,{version:1,color:'magenta',width:'thick'});
  d.extension.onModeEnter();await settle();d.extension.onModeExit();
  d.session.note(reader);await settle();
  assert.deepEqual(d.styles(),BASELINE);
  // The next mode entry starts with the stored choice at once: the owner is known now.
  d.extension.onModeEnter();await settle();
  assert.equal(d.styles().global.color,'rgb(255, 0, 255)');
  d.extension.onModeExit();
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
  assert.equal(second.revision,2);assert.deepEqual(second.sizes.markers,{version:1,color:'default',width:'standard'});
  // An account saved by an older client still upgrades to version 10.
  const g=appearanceFixture(),old=await g.service.saveReadingAppearance({expectedOwner:owner,revision:0,sizes:v9()},caller);
  assert.deepEqual((await g.service.saveReadingAppearance({expectedOwner:owner,revision:old.revision,sizes:v10()},caller)).sizes.markers,{version:1,color:'red',width:'thick'});
});

// ---- A1 FB-111: line style, arrowheads and marker text font (markers version 2, appearance version 11) ----
const v2=(over={})=>({...markers.defaults(),...over});
const SERIF='"Batang", "Noto Serif KR", serif';

test('line style and font reach every mark style; Default keeps the viewer\'s own dashes and font exactly',()=>{
  assert.deepEqual(markers.styles(BASELINE,v2()),BASELINE);
  const dashed=markers.styles(BASELINE,v2({line:'dashed',font:'serif'}));
  assert.equal(dashed.global.lineDash,'6,4');assert.equal(dashed.ArrowAnnotate.lineDash,'6,4','a tool\'s own dashes follow too');
  assert.equal(dashed.global.textBoxFontFamily,SERIF);
  assert.equal(Object.hasOwn(dashed.ArrowAnnotate,'textBoxFontFamily'),false,'a tool default changes only what it already sets');
  assert.equal(markers.styles(BASELINE,v2({line:'dashed',width:'thick'})).global.lineDash,'12,8','dashes grow with the thickness');
  const solid=markers.styles(BASELINE,v2({line:'solid'}));
  assert.equal(solid.global.lineDash,'');assert.equal(solid.ArrowAnnotate.lineDash,'','Solid is a solid line on every mark');
  // The value text's dotted link line keeps its dashes; the font size stays.
  const linked={global:{...BASELINE.global,textBoxLinkLineDash:'2,3'}};
  const out=markers.styles(linked,v2({line:'solid',font:'mono'})).global;
  assert.equal(out.textBoxLinkLineDash,'2,3');assert.equal(out.textBoxFontSize,'15px');assert.equal(out.textBoxFontFamily,'"D2Coding", "Consolas", monospace');
  // Every offered drawn choice is a distinct style (arrowheads are not a style key).
  const drawn=new Set();
  for(const [color] of markers.colors)for(const [width] of markers.widths)for(const [line] of markers.lines)for(const [font] of markers.fonts)
    drawn.add(JSON.stringify(markers.styles(BASELINE,v2({color,width,line,font}))));
  assert.equal(drawn.size,markers.colors.length*markers.widths.length*markers.lines.length*markers.fonts.length);
  assert.deepEqual(markers.look(v2({line:'dashed',font:'serif',width:'thick'})),{color:null,factor:2,dash:'12,8',font:SERIF});
  assert.deepEqual(markers.look(v2({line:'solid'})),{color:null,factor:1,dash:null,font:null});
});

test('version 1 choices are read as version 2; version 2 has its own key, and the old key keeps colour and thickness for older pages',()=>{
  const b=browser();
  b.store.set(markers.oldKey(OWNER),JSON.stringify({version:1,color:'magenta',width:'thick'}));
  assert.deepEqual(markers.read(OWNER),v2({color:'magenta',width:'thick'}),'a stored version 1 choice is kept');
  assert.equal(markers.publish(OWNER,v2({color:'red',line:'dashed',arrowheads:'off',font:'serif'})),true);
  assert.deepEqual(JSON.parse(b.store.get(markers.key(OWNER))),v2({color:'red',line:'dashed',arrowheads:'off',font:'serif'}));
  assert.deepEqual(JSON.parse(b.store.get(markers.oldKey(OWNER))),{version:1,color:'red',width:'standard'});
  // An older page writes only the old key: the version 2 choice and its new fields stay.
  b.store.set(markers.oldKey(OWNER),JSON.stringify({version:1,color:'white',width:'standard'}));
  assert.deepEqual(markers.read(OWNER),v2({color:'red',line:'dashed',arrowheads:'off',font:'serif'}));
  for(const bad of [{...v2(),line:'dotted'},{...v2(),arrowheads:true},{...v2(),font:'comic'},{version:2,color:'red',width:'thick'},{...v2(),extra:1},{...v2(),version:3}])
    assert.equal(markers.normalize(bad),null,JSON.stringify(bad));
});

test('a viewer that only knew version 1 follows an older page\'s change while no version 2 choice exists',()=>{
  const b=browser(),v=viewer();
  const mounted=markers.mount({tools:v.tools,cornerstone:v.cornerstone,owner:OWNER});
  b.store.set(markers.oldKey(OWNER),JSON.stringify({version:1,color:'cyan',width:'thick'}));b.storageEvent(markers.oldKey(OWNER));
  assert.equal(v.styles().global.color,'rgb(0, 255, 255)');
  mounted.dispose();
});

// Cornerstone's SVG node cache and annotation lookup as the pinned build has them: drawArrow draws the shaft as
// '<uid>::line::1' and the heads as '<uid>::line::2' and '::3'.
class Node{constructor(attrs={}){this.attrs=new Map(Object.entries(attrs));this.isConnected=true;}
  setAttribute(k,v){this.attrs.set(k,String(v));}getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}hasAttribute(k){return this.attrs.has(k);}removeAttribute(k){this.attrs.delete(k);}}
function arrowViewer(){
  const b=browser(),doc=new EventTarget();globalThis.document=doc;
  const annotations={arrow:{metadata:{toolName:'ArrowAnnotate'}},sr:{metadata:{toolName:'SRArrowAnnotate'}},point:{metadata:{toolName:'SRSCOORD3DPoint'}},
    srPoint:{metadata:{toolName:'DICOMSRDisplay'},data:{renderableData:{POINT:[[0,0,0]]}}},srLine:{metadata:{toolName:'DICOMSRDisplay'},data:{renderableData:{POLYLINE:[[0,0,0]]}}},
    angle:{metadata:{toolName:'Angle'}}};
  const node=()=>new Node({stroke:'yellow'}),cache={'a:engine':{},'b:engine':{}};
  for(const uid of Object.keys(annotations))for(const part of ['1','2','3'])cache['a:engine'][uid+'::line::'+part]={domRef:node()};
  cache['b:engine']['arrow2::line::2']={domRef:new Node({visibility:'visible'})};annotations.arrow2={metadata:{toolName:'ArrowAnnotate'}};
  const v=viewer();v.tools.state={svgNodeCache:cache};v.tools.annotation.state={getAnnotation:uid=>annotations[uid]};
  v.tools.Enums={Events:{ANNOTATION_RENDERED:'CORNERSTONE_TOOLS_ANNOTATION_RENDERED'}};
  const render=viewportId=>doc.dispatchEvent(new CustomEvent('CORNERSTONE_TOOLS_ANNOTATION_RENDERED',{detail:{viewportId,renderingEngineId:'engine'}}));
  const shown=viewportId=>Object.fromEntries(Object.entries(cache[viewportId+':engine']).map(([k,e])=>[k,e.domRef.getAttribute('visibility')]));
  return {...b,...v,doc,cache,render,shown};
}

test('arrowheads off hides only the heads of marks drawn as arrows, on every render, and On restores them',()=>{
  const d=arrowViewer();
  markers.publish(OWNER,v2({arrowheads:'off'}));
  const mounted=markers.mount({tools:d.tools,cornerstone:d.cornerstone,owner:OWNER});
  d.render('a');
  const hidden=d.shown('a');
  for(const uid of ['arrow','sr','point','srPoint']){
    assert.equal(hidden[uid+'::line::1'],null,uid+' shaft stays');
    for(const part of ['2','3'])assert.equal(hidden[uid+'::line::'+part],'hidden',uid+' head '+part);
  }
  for(const uid of ['srLine','angle'])for(const part of ['1','2','3'])assert.equal(hidden[uid+'::line::'+part],null,uid+' is not an arrow');
  assert.equal(d.shown('b')['arrow2::line::2'],'visible','another viewport waits for its own render');
  d.render('b');assert.equal(d.shown('b')['arrow2::line::2'],'hidden');
  // A head drawn later (a new arrow) is hidden on the render that draws it.
  d.cache['a:engine']['arrow::line::2']={domRef:new Node()};d.render('a');assert.equal(d.shown('a')['arrow::line::2'],'hidden');
  // On: every head returns to what it was, including a visibility it had of its own.
  d.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:v2()}}));
  assert.ok(Object.values(d.shown('a')).every(x=>x===null));assert.equal(d.shown('b')['arrow2::line::2'],'visible');
  d.render('a');assert.ok(Object.values(d.shown('a')).every(x=>x===null),'On keeps them shown');
  // Off again, then the viewer ends: the heads come back and later renders are left alone.
  d.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:v2({arrowheads:'off'})}}));d.render('a');
  assert.equal(d.shown('a')['sr::line::3'],'hidden');
  mounted.dispose();
  assert.ok(Object.values(d.shown('a')).every(x=>x===null));
  d.render('a');assert.ok(Object.values(d.shown('a')).every(x=>x===null),'a disposed mount hides nothing');
  delete globalThis.document;
});

test('the tool groups\' own dashes (SR previews) follow Solid and Dashed and return with Default',()=>{
  const d=arrowViewer();
  let groups={SRToolGroup:{SRLength:{lineDash:'4,4'},DICOMSRDisplay:{lineDash:'4,4'},global:{}}};
  Object.assign(d.tools.annotation.config.style,{config:{get toolGroups(){return groups;}},getToolGroupToolStyles:id=>groups[id],setToolGroupToolStyles:(id,s)=>{groups={...groups,[id]:clone(s)};}});
  const own=clone(groups);
  const mounted=markers.mount({tools:d.tools,cornerstone:d.cornerstone,owner:OWNER});
  assert.deepEqual(groups,own);
  for(const [line,dash] of [['solid',''],['dashed','6,4']]){
    d.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:v2({line,color:'red'})}}));
    assert.equal(groups.SRToolGroup.SRLength.lineDash,dash);assert.equal(groups.SRToolGroup.DICOMSRDisplay.lineDash,dash);
    assert.deepEqual(groups.SRToolGroup.global,{},'the group adds nothing it did not set');
  }
  d.win.dispatchEvent(new CustomEvent('kin-marker-style-change',{detail:{owner:OWNER,value:v2()}}));
  assert.deepEqual(groups,own);
  mounted.dispose();delete globalThis.document;
});

test('appearance version 11 keeps the version 2 marker choice and a version 10 client cannot erase it',async()=>{
  const f=appearanceFixture(),save=(sizes,revision)=>f.service.saveReadingAppearance({expectedOwner:owner,revision,sizes},caller);
  const v11=(choice=v2({color:'red',width:'thick',line:'dashed',arrowheads:'off',font:'serif'}))=>({...v9(),version:11,markers:choice});
  const first=await save(v11(),0);
  assert.deepEqual(first.sizes.markers,v2({color:'red',width:'thick',line:'dashed',arrowheads:'off',font:'serif'}));
  assert.deepEqual((await f.service.readingAppearance(caller)).sizes,v11());
  const before=f.snapshot();
  for(const choice of [{...v2(),line:'dotted'},{...v2(),arrowheads:'none'},{...v2(),font:'comic'},{version:1,color:'red',width:'thick'},(({font,...rest})=>rest)(v2()),{...v2(),points:[[0,0]]}])
    await assert.rejects(save(v11(choice),first.revision),status(400),JSON.stringify(choice));
  await assert.rejects(save(v10(v2()),first.revision),status(400),'version 10 carries the version 1 marker choice');
  await assert.rejects(save(v10(),first.revision),status(409),'a version 10 client would drop line, arrowheads and font');
  assert.deepEqual(f.snapshot(),before);
  // An account saved at version 10 upgrades to 11.
  const g=appearanceFixture(),old=await g.service.saveReadingAppearance({expectedOwner:owner,revision:0,sizes:v10()},caller);
  assert.deepEqual((await g.service.saveReadingAppearance({expectedOwner:owner,revision:old.revision,sizes:v11()},caller)).sizes.markers.line,'dashed');
});