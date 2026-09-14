// Local pure proof for the pixel-oracle mutations M1P/M5P; never run on the hosted runner (the pinned served bundle is not in
// the repository). It rebuilds the linked fragment source the way the pinned vtk OpenGL VolumeMapper does for the product's
// replacements: the pinned vtkVolumeFS template, pre replacements, the pinned clip-plane substitution, post replacements, with
// the pinned substitute function evaluated from the bundle itself. On that source it runs the candidate's own GPU checks and the
// mutant's linked-source check, including negative controls. It does not compile GLSL or render pixels.
// Usage: node tests/voi_mutations/shader_proof.cjs <ohif-bundle.js> <M1P viewer-volume-mip.js> <M5P viewer-volume-mip.js>
const fs=require('fs'),crypto=require('crypto'),path=require('path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
const pin=manifest.pinned_shader,sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const count=(source,text)=>source.split(text).length-1;
const [bundlePath,...viewerPaths]=process.argv.slice(2);
assert.equal(viewerPaths.length,2,'usage: shader_proof.cjs <bundle> <M1P viewer> <M5P viewer>');
const bundle=fs.readFileSync(bundlePath);assert.equal(sha(bundle),pin.bundle_sha256,'served bundle differs from the pin');
const lines=bundle.toString('utf8').split(/\r?\n/),line=number=>lines[number-1];
const template=JSON.parse(line(pin.template_line).match(/^\s*var vtkVolumeFS = ("(?:[^"\\]|\\.)*");\s*$/)[1]);
assert.equal(sha(template),pin.template_sha256,'vtkVolumeFS template differs from the pin');
const substituteEnd=lines.findIndex((text,index)=>index>=pin.substitute_line&&text==='}');
const substitute=new Function(lines.slice(pin.substitute_line-1,substituteEnd+1).join('\n')+'\nreturn substitute;')();
const clip=number=>{const m=line(number).match(/substitute\(FSSource, ('\/\/VTK::ClipPlane::(?:Dec|Impl)'), (\[.*\]), false\)\.result;$/);assert.ok(m,'clip-plane substitution moved: '+number);return [new Function('return '+m[1])(),new Function('clipPlaneSize','return '+m[2])];};
const clipDec=clip(pin.clip_dec_line),clipImpl=clip(pin.clip_impl_line);
const order=lines.slice(pin.build_shaders_lines[0]-1,pin.build_shaders_lines[1]).join('\n');
assert.ok(/applyShaderReplacements\(shaders, openGLSpec, true\);\s*publicAPI\.replaceShaderValues\(shaders, ren, actor\);[\s\S]*applyShaderReplacements\(shaders, openGLSpec\);/.test(order),'pinned pre/values/post order moved');
assert.ok(line(pin.apply_replacements_line).includes('pre && currReplacement.replaceFirst || !pre && !currReplacement.replaceFirst'),'pinned replaceFirst rule moved');
// No other volume-mapper substitution touches the anchors the mutations rely on.
const mapperSource=lines.slice(pin.template_line,pin.mapper_end_line).join('\n');
for(const anchor of ['applyBlend','getTextureValue(posIS)','sum += tValue','rayDirRatio = dot(rayDir, vClipPlaneNormals[i])'])
  assert.equal(count(mapperSource,anchor),anchor.startsWith('rayDirRatio')?1:0,'volume mapper also substitutes '+anchor);

function linked(replacements,planes){
  let source=template;
  for(const r of replacements)if(r.replaceFirst)source=substitute(source,r.originalValue,r.replacementValue,r.replaceAll).result;
  source=substitute(source,clipDec[0],clipDec[1](planes),false).result;source=substitute(source,clipImpl[0],clipImpl[1](planes),false).result;
  for(const r of replacements)if(!r.replaceFirst)source=substitute(source,r.originalValue,r.replacementValue,r.replaceAll).result;
  return source;
}
const model=require(path.join(ROOT,'worklist-v0/hpacs-lite/volume-mip.js'));
const note=fs.readFileSync(path.join(ROOT,'worklist-v0/hpacs-lite/viewer-tech-note.js'),'utf8').split(/\r?\n/);
const averageStart=note.findIndex(text=>text==='function kinPrepareVolumeAverage(viewport,volume){');
const prepareAverage=new Function(note.slice(averageStart,note.findIndex((text,index)=>index>averageStart&&text==='}')+1).join('\n')+'\nreturn kinPrepareVolumeAverage;')();
function block(name,file){
  const source=fs.readFileSync(file,'utf8'),text=source.split('\n');
  assert.equal(sha(Buffer.from(source)),manifest.variants[name].after_sha256,name+' viewer is not the manifest after-image');
  const begin=text.indexOf('  // MUTATION-BEGIN '+name),end=text.indexOf('  // MUTATION-END '+name);assert.ok(begin>0&&end>begin,name+' block markers');
  return new Function('model',text.slice(begin,end+1).join('\n')+'\nreturn {mutantShader,mutantProblem};')(model);
}
function braces(source,start,stop){const body=source.slice(source.indexOf(start),source.indexOf(stop,source.indexOf(start)));let depth=0;for(const c of body){if(c==='{')depth++;if(c==='}')depth--;assert.ok(depth>=0);}return depth;}

const report={bundle_sha256:pin.bundle_sha256,template_sha256:pin.template_sha256,template_counts:{sample:count(template,'tValue = getTextureValue(posIS);'),applyBlend:count(template,'void applyBlend('),sum:count(template,'sum += tValue;'),clipImpl:count(template,'//VTK::ClipPlane::Impl')},variants:{}};
assert.deepEqual(report.template_counts,{sample:11,applyBlend:1,sum:3,clipImpl:1});
// The original M1/M5 declared kinMutantVoiInside with an escaped RegExp but replaceAll false: the pinned substitute takes that
// string literally, so the declaration never lands while the replaced samples still call it.
report.original_m1_m5_declaration_matches=substitute(template,'void applyBlend\\(','x',false).result!==template;
assert.equal(report.original_m1_m5_declaration_matches,false);

for(const [name,file] of [['M1P',viewerPaths[0]],['M5P',viewerPaths[1]]]){
  const {mutantShader,mutantProblem}=block(name,file),rows=[];
  for(const info of [{offset:[0],scale:[1]},{offset:[-1500],scale:[3300]}]){
    let props={};const mapper={getViewSpecificProperties:()=>props,setViewSpecificProperties:p=>{props=p;},getScalarTexture:()=>({getVolumeInfo:()=>info}),setIpScalarRange:()=>{}};
    const op={mapper},viewport={getActors:()=>[{actor:{getMapper:()=>mapper}}]},volume={voxelManager:{getRange:()=>[-1500,1500]}};
    const displays=[['MIP',true],['Raysum',true],['MinIP',true],['Raysum',false],['MIP',true],['Raysum',true]];
    for(const [mode,voi] of displays){
      const blend=model.blendMode(mode),want={blend,voiSlab:voi?{thickness:41}:null},request={mode,voiSlab:want.voiSlab,original:false};
      if(blend===3)prepareAverage(viewport,volume);
      mutantShader(op,name==='M1P'?!!want.voiSlab:!!want.voiSlab&&want.blend===3);
      const planes=voi?4:2,source=linked(props.OpenGL.ShaderReplacements,planes);
      const active=name==='M1P'?voi:voi&&blend===3;
      const row={mode,voi,offset:info.offset[0],clipShader:model.clipShader(source,planes),averageShader:blend===3?model.averageShader(source):null,mutantProblem:mutantProblem(op,request,source),
        unclipped:count(source,'/*kinMutantVoiUnclipped*/'),zeroFill:count(source,'/*kinMutantVoiZeroFill*/'),denominator:count(source,'/*kinMutantVoiDenominator*/'),zero:op.mutantZero};
      assert.equal(row.clipShader,true,name+' '+mode+' clipShader');if(blend===3)assert.equal(row.averageShader,true,name+' averageShader');
      assert.equal(row.mutantProblem,'',name+' '+mode+' mutantProblem');
      if(active){
        assert.equal(row.unclipped,1);assert.equal(row.zeroFill,name==='M1P'?11:0);assert.equal(row.denominator,name==='M5P'?3:0);
        assert.ok(source.indexOf('#define vtkClippingPlanesOn')<source.indexOf('#if (vtkLightComplexity > 0) || (defined vtkClippingPlanesOn)'));
        assert.ok(source.indexOf('vec3 IStoVC(vec3 posIS)')<source.indexOf('bool kinMutantVoiInside(vec3 p)')&&source.indexOf('bool kinMutantVoiInside(vec3 p)')<source.indexOf('void applyBlend('));
        const rays=source.indexOf('vec2 computeRayDistances'),skip=source.indexOf('if (i >= 2) { continue; }');
        assert.ok(rays<skip&&skip<source.indexOf('return dists;',rays),'skip is inside computeRayDistances');
        assert.equal(braces(source,'vec2 computeRayDistances','return dists;'),1);assert.equal(braces(source,'bool kinMutantVoiInside(vec3 p)','void applyBlend('),0);
        assert.equal(row.zero,'const vec4 kinMutantVoiZero = vec4('+((0-info.offset[0])/info.scale[0]).toFixed(9)+');');
      }else assert.ok(!source.includes('kinMutantVoi'),name+' '+mode+' leaked');
      rows.push(row);
    }
    // Negative controls: the mutant's own check refuses every way the replacement can fail to link.
    const replacements=props.OpenGL.ShaderReplacements,request={mode:'Raysum',voiSlab:{thickness:41},original:false};
    const refuse=(list,label)=>assert.notEqual(mutantProblem(op,request,linked(list,4)),'',name+' accepts '+label);
    refuse(replacements.filter(r=>r.replaceFirst!==false||!String(r.replacementValue).includes('kinMutantVoiUnclipped')),'a missing loop skip');
    refuse(replacements.map(r=>r.originalValue==='void applyBlend('?{...r,originalValue:'void applyBlend\\('}:r),'an escaped plain-string declaration');
    refuse(replacements.filter(r=>!String(r.replacementValue).includes(name==='M1P'?'kinMutantVoiZeroFill':'kinMutantVoiDenominator')),'a missing sample replacement');
    if(name==='M5P')refuse([...replacements.filter(r=>String(r.replacementValue).includes('kinMutantVoi')),...replacements.filter(r=>!String(r.replacementValue).includes('kinMutantVoi'))],'the mutant before the average patch');
    const stale=linked(replacements,4);assert.notEqual(mutantProblem(op,{mode:'MIP',voiSlab:name==='M5P'?{thickness:41}:null,original:false},stale),'',name+' accepts a stale mutated shader');
  }
  report.variants[name]={displays:rows.length,rows:rows.map(r=>[r.mode,r.voi,r.offset,r.unclipped,r.zeroFill,r.denominator].join(':')),negative_controls:name==='M5P'?5:4};
}
console.log(JSON.stringify(report,null,1));
