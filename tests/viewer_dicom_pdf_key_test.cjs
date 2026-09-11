'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

let config=fs.readFileSync(path.join(__dirname,'..','config','ohif.js'),'utf8');
if(process.env.KIN_PDF_KEY_MUTATION==='drop')config=config.replace(', key });', ' });');
function extract(name){
  const start=config.indexOf(`function ${name}(`);assert.notEqual(start,-1);const brace=config.indexOf('{',start);let depth=0,quote=null,escaped=false;
  for(let i=brace;i<config.length;i++){const char=config[i];if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote=null;continue;}if("'\"`".includes(char))quote=char;else if(char==='{')depth++;else if(char==='}'&&--depth===0)return config.slice(start,i+1);}throw Error(name);
}
function load(extra={}){const sandbox={AbortController,URL,setTimeout,clearTimeout,...extra};vm.createContext(sandbox);vm.runInContext(`${extract('kinDicomPdfViewportGuard')}\n${extract('kinCreateDicomPdf')}`,sandbox);return sandbox;}
function display(over={}){return {displaySetInstanceUID:'ds-pdf',SOPClassHandlerId:'@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf',SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',pdfUrl:Promise.resolve('/pdf'),instance:{SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}},...over};}
function manager(component){const entry={component};return {entry,manager:{getModuleEntry:id=>id==='@ohif/extension-dicom-pdf.viewportModule.dicom-pdf'?entry:null}};}
const React={createElement:(type,props)=>({type,key:props.key==null?null:String(props.key),props})};
const keyed=props=>React.createElement('OHIFCornerstonePdfViewport',props);

test('source identity and pdfUrl identity produce stable fail-closed React keys',()=>{
  const {kinDicomPdfViewportGuard}=load(),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);assert.equal(guard.install(),true);guard.activate();
  const source=display(),first=fixture.entry.component({displaySets:[source]}),repeat=fixture.entry.component({displaySets:[source]});
  assert.equal(first.key,repeat.key);
  const changedPromise=fixture.entry.component({displaySets:[{...source,pdfUrl:Promise.resolve('/pdf')} ]});assert.notEqual(changedPromise.key,first.key);
  const changedUid=fixture.entry.component({displaySets:[{...source,SOPInstanceUID:'1.5',instance:{...source.instance,SOPInstanceUID:'1.5'}}]});assert.notEqual(changedUid.key,first.key);
  const primitive=display({pdfUrl:'/same'});assert.equal(fixture.entry.component({displaySets:[primitive]}).key,fixture.entry.component({displaySets:[{...primitive}]}).key);
  assert.notEqual(fixture.entry.component({displaySets:[primitive]}).key,fixture.entry.component({displaySets:[{...primitive,pdfUrl:'/other'}]}).key);
  for(const props of [{displaySets:[]},{displaySets:[source,source]},{displaySets:[{...source,SOPInstanceUID:'bad'}]},{displaySets:[{...source,pdfUrl:null}]}])assert.equal(fixture.entry.component(props),null);
  const wrong=manager(()=>({key:'discarded'})),wrongGuard=kinDicomPdfViewportGuard(wrong.manager);assert.equal(wrongGuard.install(),true);wrongGuard.activate();assert.equal(wrong.entry.component({displaySets:[source]}),null);
});

test('new promise remount isolates late native async completion',async()=>{
  const {kinDicomPdfViewportGuard}=load(),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);guard.install();guard.activate();
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
  const direct=manager(keyed),guard=sandbox.kinDicomPdfViewportGuard(direct.manager),directOriginal=direct.entry.component;guard.install();guard.activate();guard.dispose();assert.equal(direct.entry.component,directOriginal);
  guard.install();direct.entry.component=external;guard.dispose();assert.equal(direct.entry.component,external);
  const absent=sandbox.kinCreateDicomPdf();assert.throws(()=>absent.preRegistration({servicesManager:{services:{}},extensionManager:{getModuleEntry:()=>null}}),/안전하게 연결/);
});

test('config registers the pinned PDF extension before the guard',()=>{
  const list=config.match(/extensions:\s*\[([^\]]+)\]/s)?.[1]||'';
  assert.ok(list.indexOf("'@ohif/extension-dicom-pdf'")>=0);assert.ok(list.indexOf("'@ohif/extension-dicom-pdf'")<list.indexOf('kinCreateDicomPdf()'));
});

test('native source resolver returns the authenticated Orthanc PDF route once per exact source',async()=>{
  const requests=[];
  const fetch=async(url,init={})=>{requests.push([url,init.method||'GET',init.body||null]);if(url==='/api/me')return {ok:true,json:async()=>({kind:'member',institution:'hospital',sub:'reader'})};if(url==='/api/dicom/lookup')return {ok:true,json:async()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'})};throw Error(url)};
  const {kinDicomPdfViewportGuard}=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);guard.install();guard.activate();
  const source=display({SOPClassHandlerId:'@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf',SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered'),instance:{SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}});
  const first=fixture.entry.component({displaySets:[source]}),repeat=fixture.entry.component({displaySets:[source]});assert.equal(first.key,repeat.key);assert.equal(first.props.displaySets[0].pdfUrl,repeat.props.displaySets[0].pdfUrl);
  assert.equal(await first.props.displaySets[0].pdfUrl,'https://pdf.test/instances/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee/pdf');
  assert.deepEqual(requests.map(x=>x[0]),['/api/me','/api/dicom/lookup','/api/me']);assert.deepEqual(JSON.parse(requests[1][2]),{studyUid:'1.2',sopUid:'1.4'});
});

test('native resolvers are independent and reject stale owner, source, mode, and external URLs',async()=>{
  let held=[];const fetch=(url,init={})=>new Promise((resolve,reject)=>{held.push({url,init,resolve,reject});init.signal?.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true})});
  const {kinDicomPdfViewportGuard}=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);guard.install();guard.activate();
  const exact=over=>display({SOPClassHandlerId:'@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf',SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered'),instance:{SOPClassUID:'1.2.840.10008.5.1.4.1.1.104.1',StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}},...over});
  const a=fixture.entry.component({displaySets:[exact()]}),b=fixture.entry.component({displaySets:[exact({displaySetInstanceUID:'other'})]});await new Promise(resolve=>setImmediate(resolve));assert.equal(held.length,2,'separate cells resolve independently');
  guard.deactivate();await assert.rejects(a.props.displaySets[0].pdfUrl);await assert.rejects(b.props.displaySets[0].pdfUrl);
  guard.activate();const outside=fixture.entry.component({displaySets:[exact({pdfUrl:Promise.resolve('https://outside.test/file.pdf')})]});await assert.rejects(outside.props.displaySets[0].pdfUrl);assert.equal(held.length,2,'external URL fails before authenticated lookup');
});

test('native resolver rejects source mutation and an owner change after lookup',async()=>{
  const reply=value=>({ok:true,json:async()=>value});let release;
  const heldFetch=(url,init={})=>new Promise((resolve,reject)=>{release=()=>resolve(reply({kind:'member',institution:'hospital',sub:'reader'}));init.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true})});
  let sandbox=load({fetch:heldFetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=sandbox.kinDicomPdfViewportGuard(fixture.manager);guard.install();guard.activate();
  const source=display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')}),element=fixture.entry.component({displaySets:[source]});await new Promise(resolve=>setImmediate(resolve));source.instance.SOPInstanceUID='1.9';release();await assert.rejects(element.props.displaySets[0].pdfUrl,/변경/);
  let calls=0;const changedOwner=async url=>{calls++;if(url==='/api/dicom/lookup')return reply({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});return reply({kind:'member',institution:'hospital',sub:calls===1?'reader':'other'})};
  sandbox=load({fetch:changedOwner,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}});fixture=manager(keyed);guard=sandbox.kinDicomPdfViewportGuard(fixture.manager);guard.install();guard.activate();
  await assert.rejects(fixture.entry.component({displaySets:[display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')})]}).props.displaySets[0].pdfUrl,/계정이 변경/);
});

test('a viewport rendered before onModeEnter waits for activation instead of becoming blank',async()=>{
  const fetch=async url=>url==='/api/dicom/lookup'?{ok:true,json:async()=>({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'})}:{ok:true,json:async()=>({kind:'member',institution:'hospital',sub:'reader'})};
  const {kinDicomPdfViewportGuard}=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager);guard.install();
  const source=display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')}),element=fixture.entry.component({displaySets:[source]});assert.ok(element,'ModeRoute renders its captured layout before its effect calls onModeEnter');
  guard.activate();assert.equal(await element.props.displaySets[0].pdfUrl,'https://pdf.test/instances/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee/pdf');
  guard.deactivate();const reentry=fixture.entry.component({displaySets:[source]});assert.ok(reentry);assert.notEqual(reentry.key,element.key);guard.activate();assert.equal(await reentry.props.displaySets[0].pdfUrl,'https://pdf.test/instances/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee/pdf');
});

test('a timed out native resolver keeps one promise and succeeds only after explicit retry',async()=>{
  let blocked=true,failures=0;const reply=value=>({ok:true,json:async()=>value});
  const fetch=async url=>{if(blocked)return new Promise(()=>{});if(url==='/api/dicom/lookup')return reply({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});return reply({kind:'member',institution:'hospital',sub:'reader'})};
  const {kinDicomPdfViewportGuard}=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager,{timeoutMs:20,onFailure:()=>failures++});guard.install();guard.activate();
  const element=fixture.entry.component({displaySets:[display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')})]}),samePromise=element.props.displaySets[0].pdfUrl;
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(failures,1);blocked=false;guard.retry();assert.equal(element.props.displaySets[0].pdfUrl,samePromise);
  assert.equal(await samePromise,'https://pdf.test/instances/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee/pdf');
});

test('a transient native HTTP failure keeps the consumed promise for explicit retry',async()=>{
  let unavailable=true,failures=0;const reply=value=>({ok:true,status:200,json:async()=>value});
  const fetch=async url=>{if(unavailable)return {ok:false,status:503,json:async()=>({})};if(url==='/api/dicom/lookup')return reply({id:'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'});return reply({kind:'member',institution:'hospital',sub:'reader'})};
  const {kinDicomPdfViewportGuard}=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'}}),fixture=manager(keyed),guard=kinDicomPdfViewportGuard(fixture.manager,{onFailure:()=>failures++});guard.install();guard.activate();
  const element=fixture.entry.component({displaySets:[display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')})]}),samePromise=element.props.displaySets[0].pdfUrl;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(failures,1);unavailable=false;guard.retry();assert.equal(element.props.displaySets[0].pdfUrl,samePromise);
  assert.equal(await samePromise,'https://pdf.test/instances/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee/pdf');
});

test('session-ended retires pending native work',async()=>{
  const listeners=new Map();let ended=0;class Channel{constructor(){this.onmessage=null}close(){this.closed=true}}
  const addEventListener=(name,fn)=>listeners.set(name,fn),removeEventListener=(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)};
  const fetch=()=>new Promise(()=>{}),sandbox=load({fetch,location:{href:'https://pdf.test/ohif/viewer',origin:'https://pdf.test'},addEventListener,removeEventListener,BroadcastChannel:Channel}),fixture=manager(keyed),guard=sandbox.kinDicomPdfViewportGuard(fixture.manager,{onSessionEnd:()=>ended++});guard.install();guard.activate();
  const promise=fixture.entry.component({displaySets:[display({pdfUrl:Promise.resolve('https://pdf.test/dicom-web/studies/1.2/series/1.3/instances/1.4/rendered')})]}).props.displaySets[0].pdfUrl;listeners.get('storage')({key:'kin-session-ended'});await assert.rejects(promise,/중단/);assert.equal(ended,1);
});
