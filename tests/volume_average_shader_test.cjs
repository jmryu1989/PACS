const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('worklist-v0/hpacs-lite/viewer-tech-note.js','utf8');
function setup(){
 const context={};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function kinPrepareVolumeAverage('),source.indexOf('function kinCreateVolumeProjection(')),context);
 const jitter={shaderType:'Fragment',originalValue:'float jitter = 0.01;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false};
 let properties={OpenGL:{ShaderReplacements:[jitter],other:'preserved'},callbacks:'retained'};
 const mapper={getScalarTexture:()=>({getVolumeInfo:()=>({scale:[1],offset:[0]})}),setIpScalarRange(){},getViewSpecificProperties:()=>properties,setViewSpecificProperties:p=>{properties=p}};
 const apply=()=>context.kinPrepareVolumeAverage({getActors:()=>[{actor:{getMapper:()=>mapper}}]},{voxelManager:{getRange:()=>[-1024,-124]}});
 return {apply,read:()=>properties,jitter};
}
test('Average composes with existing shader properties without duplicate patches',()=>{
 const s=setup();s.apply();s.apply();assert.equal(s.read().OpenGL.ShaderReplacements.length,4);assert.equal(s.read().OpenGL.ShaderReplacements[0],s.jitter);assert.equal(s.read().OpenGL.other,'preserved');assert.equal(s.read().callbacks,'retained');
});
test('Pinned vtk global RegExp semantics replace every sum and its denominator',()=>{
 const s=setup();s.apply();let shader='vec4 sum = vec4(0.);\nsum += tValue;\nsum += tValue;\nsum += tValue;\nsum /= vec4(stepsTraveled, stepsTraveled, stepsTraveled, 1.0);';
 for(const r of s.read().OpenGL.ShaderReplacements)shader=shader.replace(r.replaceAll===false?r.originalValue:new RegExp(r.originalValue,'g'),r.replacementValue);
 assert.ok(shader.includes('float kinAverageSamples = 0.0;'));assert.equal((shader.match(/kinAverageSamples \+= 1\.0;/g)||[]).length,3);assert.ok(shader.includes('sum /= vec4(max(kinAverageSamples, 1.0)'));assert.ok(!shader.includes('sum /= vec4(stepsTraveled'));
});
