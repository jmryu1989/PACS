const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../worklist-v0/hpacs-lite/main.html'),'utf8');
function fixture(){
  const context=vm.createContext({});
  vm.runInContext(`const ohifPlacementWrites=new WeakMap(),ohifPopupSlots=new WeakMap();let ohifPopupHandle=null;const OHIF_RECT_KEY='rect',writes=[];const localStorage={setItem:(key,value)=>writes.push([key,JSON.parse(value)])};
    ${source.slice(source.indexOf('    function popupRect('),source.indexOf('    function watchOhifRect('))}
    this.api={ohifPlacementWrites,ohifPopupSlots,writes,rememberOhifRect,popupRect};`,context);
  const popup={closed:false,document:{visibilityState:'visible'},screenX:0,screenY:10,outerWidth:1000,outerHeight:800};
  return {...context.api,popup};
}
test('pending and aborted positions cannot overwrite saved geometry; actual movement resumes per-slot saving',()=>{
  const f=fixture();f.ohifPopupSlots.set(f.popup,2);
  const state={pending:true,baseline:null};f.ohifPlacementWrites.set(f.popup,state);
  assert.equal(f.rememberOhifRect(f.popup),false);assert.equal(f.writes.length,0);
  state.pending=false;state.baseline=f.popupRect(f.popup);
  assert.equal(f.rememberOhifRect(f.popup),false);assert.equal(f.writes.length,0);
  f.popup.screenX=120;assert.equal(f.rememberOhifRect(f.popup),true);
  assert.equal(f.writes[0][0],'rect:2');assert.equal(f.writes[0][1].left,120);assert.equal(f.ohifPlacementWrites.has(f.popup),false);
});
test('closed, hidden and minimized windows never replace a usable saved position',()=>{
  const f=fixture();f.popup.closed=true;assert.equal(f.rememberOhifRect(f.popup),false);
  f.popup.closed=false;f.popup.document.visibilityState='hidden';assert.equal(f.rememberOhifRect(f.popup),false);
  f.popup.document.visibilityState='visible';f.popup.screenX=-32000;assert.equal(f.rememberOhifRect(f.popup),false);
  assert.equal(f.writes.length,0);
});
test('abandonment with unreadable geometry recovers after restore and a later move',()=>{
  const f=fixture(),state={pending:false,baseline:null};f.ohifPlacementWrites.set(f.popup,state);
  f.popup.screenX=-32000;assert.equal(f.rememberOhifRect(f.popup),false);
  f.popup.screenX=0;assert.equal(f.rememberOhifRect(f.popup),false);
  assert.ok(state.baseline);assert.equal(f.writes.length,0);
  f.popup.screenX=-1800;assert.equal(f.rememberOhifRect(f.popup),true);
  assert.equal(f.writes[0][1].left,-1800);
});
