const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const apply=vm.runInNewContext(source.slice(source.indexOf('function kinApplyCTPreset'),source.indexOf('function kinCreateCTPresets'))+';kinApplyCTPreset');
function setup(){
 const called=[],messages=[],v={type:'stack'},ds={Modality:'CT',SOPClassUID:'1.2.840.10008.5.1.4.1.1.2'},presets=[{window:'400',level:'40'},{window:'1500',level:'-600'},{window:'150',level:'90'},{window:'2500',level:'480'},{window:'80',level:'40'}];
 const grid={displaySetInstanceUIDs:['one']};
 const services={viewportGridService:{getActiveViewportId:()=> 'chosen',getState:()=>({viewports:new Map([['chosen',grid]])})},cornerstoneViewportService:{getCornerstoneViewport:()=>v},displaySetService:{getDisplaySetByUID:()=>ds},customizationService:{get:()=>({presets:{CT:presets}})},uiNotificationService:{show:x=>messages.push(x)}};
 return {called,messages,v,ds,presets,grid,services,commands:{runCommand:(...args)=>called.push(args)}};
}
test('five CT presets use the native command and only the selected viewport',()=>{
 const x=setup();const before=JSON.stringify(x.presets);
 for(let i=0;i<5;i++){assert.equal(apply(x.services,x.commands,i),true);const [name,options,context]=x.called[i];assert.equal(name,'setViewportWindowLevel');assert.equal(context,'CORNERSTONE');assert.equal(options.viewportId,'chosen');assert.equal(options.window,Number(x.presets[i].window));assert.equal(options.level,Number(x.presets[i].level));}
 assert.equal(JSON.stringify(x.presets),before);
});
test('empty mixed non-CT and specialized viewports never receive CT presets',()=>{
 for(const change of [x=>x.grid.displaySetInstanceUIDs=[],x=>x.grid.displaySetInstanceUIDs=['one','two'],x=>x.ds.Modality='US',x=>x.ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.2.1',x=>x.v.type='volume']){
  const x=setup();change(x);assert.equal(apply(x.services,x.commands,0),false);assert.equal(x.called.length,0);assert.equal(x.messages.length,1);
 }
});
test('bad index missing preset and invalid numeric values fail without a native write',()=>{
 for(const i of [-1,5,NaN,Infinity,'1',1.5]){const x=setup();assert.equal(apply(x.services,x.commands,i),false);assert.equal(x.called.length,0);}
 for(const p of [undefined,{window:'bad',level:40},{window:0,level:40},{window:400,level:NaN},{window:400,level:''}]){const x=setup();x.presets[0]=p;assert.equal(apply(x.services,x.commands,0),false);assert.equal(x.called.length,0);}
});
test('mode command guard preserves other operations and restores native registration on exit',()=>{
 const context={window:{},document:{},localStorage:{}};vm.runInNewContext(source,context);
 assert.equal(context.window.config.hotkeys,undefined);
 const extension=context.window.config.extensions.find(e=>e.id==='kin.ct-presets');assert.ok(extension);
 const x=setup(),other=[];const native={commandFn:props=>other.push(props)};let definition=native;
 x.commands.getCommand=()=>definition;x.commands.registerCommand=(context,name,value)=>{assert.equal(context,'CORNERSTONE');assert.equal(name,'setWindowLevel');definition=value;};
 extension.onModeEnter({servicesManager:{services:x.services},commandsManager:x.commands});assert.notEqual(definition,native);
 definition.commandFn({description:'Lung',window:1500,level:-600});assert.equal(x.called.length,1);
 definition.commandFn({window:100,level:30});assert.equal(other.length,1);extension.onModeExit();assert.equal(definition,native);
});
