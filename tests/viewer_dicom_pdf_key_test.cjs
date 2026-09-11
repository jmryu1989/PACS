'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

let config=fs.readFileSync(path.join(__dirname,'..','config','ohif.js'),'utf8');
if(process.env.KIN_PDF_KEY_MUTATION==='drop')config=config.replace('original.call(this, { ...props, key })','original.call(this, { ...props })');
function extract(name){
  const start=config.indexOf(`function ${name}(`);assert.notEqual(start,-1);const brace=config.indexOf('{',start);let depth=0,quote=null,escaped=false;
  for(let i=brace;i<config.length;i++){const char=config[i];if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote=null;continue;}if("'\"`".includes(char))quote=char;else if(char==='{')depth++;else if(char==='}'&&--depth===0)return config.slice(start,i+1);}throw Error(name);
}
function load(extra={}){const sandbox={...extra};vm.createContext(sandbox);vm.runInContext(`${extract('kinDicomPdfViewportGuard')}\n${extract('kinCreateDicomPdf')}`,sandbox);return sandbox;}
function display(over={}){return {displaySetInstanceUID:'ds-pdf',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',pdfUrl:Promise.resolve('/pdf'),...over};}
function manager(component){const entry={component};return {entry,manager:{getModuleEntry:id=>id==='@ohif/extension-dicom-pdf.viewportModule.dicom-pdf'?entry:null}};}
const React={createElement:(type,props)=>({type,key:props.key==null?null:String(props.key),props})};
const keyed=props=>React.createElement('OHIFCornerstonePdfViewport',props);

test('source identity and pdfUrl identity produce stable fail-closed React keys',()=>{
  const {kinDicomPdfViewportGuard}=load(),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);assert.equal(guard.install(),true);
  const source=display(),first=fixture.entry.component({displaySets:[source]}),repeat=fixture.entry.component({displaySets:[source]});
  assert.equal(first.key,repeat.key);
  const changedPromise=fixture.entry.component({displaySets:[{...source,pdfUrl:Promise.resolve('/pdf')} ]});assert.notEqual(changedPromise.key,first.key);
  const changedUid=fixture.entry.component({displaySets:[{...source,SOPInstanceUID:'1.5'}]});assert.notEqual(changedUid.key,first.key);
  const primitive=display({pdfUrl:'/same'});assert.equal(fixture.entry.component({displaySets:[primitive]}).key,fixture.entry.component({displaySets:[{...primitive}]}).key);
  assert.notEqual(fixture.entry.component({displaySets:[primitive]}).key,fixture.entry.component({displaySets:[{...primitive,pdfUrl:'/other'}]}).key);
  for(const props of [{displaySets:[]},{displaySets:[source,source]},{displaySets:[{...source,SOPInstanceUID:'bad'}]},{displaySets:[{...source,pdfUrl:null}]}])assert.equal(fixture.entry.component(props),null);
  const wrong=manager(()=>({key:'discarded'})),wrongGuard=kinDicomPdfViewportGuard(wrong.manager);assert.equal(wrongGuard.install(),true);assert.equal(wrong.entry.component({displaySets:[source]}),null);
});

test('new promise remount isolates late native async completion',async()=>{
  const {kinDicomPdfViewportGuard}=load(),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);guard.install();
  let resolveOld,resolveNew;const oldUrl=new Promise(resolve=>{resolveOld=resolve}),newUrl=new Promise(resolve=>{resolveNew=resolve});
  const oldElement=fixture.entry.component({displaySets:[display({pdfUrl:oldUrl})]}),newElement=fixture.entry.component({displaySets:[display({pdfUrl:newUrl})]});assert.notEqual(oldElement.key,newElement.key);
  const instances=new Map([[oldElement.key,{url:null}],[newElement.key,{url:null}]]),current=newElement.key;
  oldUrl.then(url=>{instances.get(oldElement.key).url=url});newUrl.then(url=>{instances.get(newElement.key).url=url});resolveOld('old.pdf');await Promise.resolve();
  assert.equal(instances.get(current).url,null);resolveNew('new.pdf');await Promise.resolve();assert.equal(instances.get(current).url,'new.pdf');
});

test('preRegistration wraps synchronously, mode lifecycle retains ownership, and missing entry fails closed',async()=>{
  let creates=0,mounts=0,stops=0;const window={KinDicomPdf:{create(){creates++;return {mount(){mounts++},stop(){stops++}}}}},document={querySelector:()=>null,createElement:()=>{throw Error('loader must not run')}};
  const sandbox=load({window,document,setTimeout,clearTimeout}),fixture=manager(keyed),extension=sandbox.kinCreateDicomPdf(),original=fixture.entry.component;
  extension.preRegistration({servicesManager:{services:{token:17}},extensionManager:fixture.manager});assert.notEqual(fixture.entry.component,original);
  const owned=fixture.entry.component;extension.onModeEnter();await Promise.resolve();await Promise.resolve();assert.deepEqual([creates,mounts,stops],[1,1,0]);
  extension.onModeExit();assert.equal(fixture.entry.component,owned);assert.equal(stops,1);
  extension.onModeEnter();await Promise.resolve();await Promise.resolve();assert.equal(fixture.entry.component,owned);assert.deepEqual([creates,mounts,stops],[2,2,1]);
  const external=keyed;fixture.entry.component=external;extension.onModeEnter();await Promise.resolve();await Promise.resolve();assert.notEqual(fixture.entry.component,external);assert.equal(stops,2);
  const direct=manager(keyed),guard=sandbox.kinDicomPdfViewportGuard(direct.manager),directOriginal=direct.entry.component;guard.install();guard.dispose();assert.equal(direct.entry.component,directOriginal);
  guard.install();direct.entry.component=external;guard.dispose();assert.equal(direct.entry.component,external);
  const absent=sandbox.kinCreateDicomPdf();assert.throws(()=>absent.preRegistration({servicesManager:{services:{}},extensionManager:{getModuleEntry:()=>null}}),/안전하게 연결/);
});

test('config registers the pinned PDF extension before the guard',()=>{
  const list=config.match(/extensions:\s*\[([^\]]+)\]/s)?.[1]||'';
  assert.ok(list.indexOf("'@ohif/extension-dicom-pdf'")>=0);assert.ok(list.indexOf("'@ohif/extension-dicom-pdf'")<list.indexOf('kinCreateDicomPdf()'));
});
