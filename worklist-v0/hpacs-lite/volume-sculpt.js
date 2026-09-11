(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KinVolumeSculpt=api;
})(typeof globalThis==='object'?globalThis:this,()=>{
  'use strict';
  const MODES=new Set(['Freehand Area','Freehand Line','Curved Area','Curved Line','Ellipse','Rectangle']);
  const EPS=1e-9,MAX_POINTS=64,MAX_OPERATIONS=8;

  function finite(n){return typeof n==='number'&&Number.isFinite(n);}
  function point(value){
    if(!Array.isArray(value)||value.length!==2||!value.every(finite)||value.some(n=>n<0||n>1))throw Error('Sculpt points must be finite normalized coordinates.');
    return [value[0],value[1]];
  }
  function queryPoint(value){
    if(!Array.isArray(value)||value.length!==2||!value.every(finite))throw Error('Sculpt query must contain finite coordinates.');
    return [value[0],value[1]];
  }
  function same(a,b){return Math.abs(a[0]-b[0])<=EPS&&Math.abs(a[1]-b[1])<=EPS;}
  function distanceToSegment(p,a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
    if(den<=EPS)return Math.hypot(p[0]-a[0],p[1]-a[1]);
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den));
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  }
  function rdp(points,tolerance){
    if(points.length<=2)return points.slice();
    let furthest=-1,index=-1;
    for(let i=1;i<points.length-1;i++){
      const distance=distanceToSegment(points[i],points[0],points[points.length-1]);
      if(distance>furthest){furthest=distance;index=i;}
    }
    if(furthest<=tolerance)return [points[0],points[points.length-1]];
    const left=rdp(points.slice(0,index+1),tolerance),right=rdp(points.slice(index),tolerance);
    return left.slice(0,-1).concat(right);
  }
  function simplify(points,tolerance,closed){
    let input=points.slice();
    if(closed&&!same(input[0],input[input.length-1]))input.push(input[0]);
    let output=rdp(input,tolerance);
    if(closed&&output.length>1&&same(output[0],output[output.length-1]))output.pop();
    if(output.length>MAX_POINTS)throw Error('Sculpt boundary cannot be simplified to 64 points within tolerance.');
    return output;
  }
  function catmull(points){
    const output=[points[0]],steps=12;
    for(let i=0;i<points.length-1;i++){
      const p0=points[Math.max(0,i-1)],p1=points[i],p2=points[i+1],p3=points[Math.min(points.length-1,i+2)];
      for(let step=1;step<=steps;step++){
        const t=step/steps,t2=t*t,t3=t2*t;
        output.push([0,1].map(axis=>Math.max(0,Math.min(1,.5*((2*p1[axis])+(-p0[axis]+p2[axis])*t+(2*p0[axis]-5*p1[axis]+4*p2[axis]-p3[axis])*t2+(-p0[axis]+3*p1[axis]-3*p2[axis]+p3[axis])*t3)))));
      }
    }
    return output;
  }
  function boundaryProjection(p){
    const distances=[p[1],1-p[0],1-p[1],p[0]];
    let edge=0;
    for(let i=1;i<4;i++)if(distances[i]<distances[edge])edge=i;
    if(edge===0)return {point:[p[0],0],position:p[0]};
    if(edge===1)return {point:[1,p[1]],position:1+p[1]};
    if(edge===2)return {point:[p[0],1],position:3-p[0]};
    return {point:[0,p[1]],position:4-p[1]};
  }
  function perimeter(from,to){
    let end=to.position;
    if(end<from.position-EPS)end+=4;
    const corners=[[1,[1,0]],[2,[1,1]],[3,[0,1]],[4,[0,0]],[5,[1,0]],[6,[1,1]],[7,[0,1]],[8,[0,0]]];
    const result=[];
    for(const [position,value] of corners)if(position>from.position+EPS&&position<end-EPS)result.push(value);
    result.push(to.point);
    return result;
  }
  function polygonArea(points){
    let area=0;
    for(let i=0,j=points.length-1;i<points.length;j=i++)area+=points[j][0]*points[i][1]-points[i][0]*points[j][1];
    return area/2;
  }
  function polygonRegion(points,tolerance){
    const simplified=simplify(points,tolerance,true);
    if(simplified.length<3||Math.abs(polygonArea(simplified))<=EPS)throw Error('Sculpt boundary is degenerate.');
    const xs=simplified.map(p=>p[0]),ys=simplified.map(p=>p[1]);
    return {kind:'Polygon',points:simplified,bounds:[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)]};
  }
  function makeRegion(mode,values,tolerance=.002){
    if(!MODES.has(mode)||!Array.isArray(values)||!finite(tolerance)||tolerance<=0||tolerance>.25)throw Error('Invalid sculpt region.');
    if((mode==='Rectangle'||mode==='Ellipse')&&values.length!==2)throw Error('Rectangle and ellipse require two corner points.');
    if(mode.startsWith('Freehand')&&values.length>2048)throw Error('Freehand sculpt input exceeds 2048 points.');
    if(mode.startsWith('Curved')&&values.length>128)throw Error('Curved sculpt input exceeds 128 control points.');
    const points=values.map(point);
    if(points.length<2)throw Error('Sculpt boundary is degenerate.');
    if(mode==='Rectangle'||mode==='Ellipse'){
      const bounds=[Math.min(points[0][0],points[1][0]),Math.max(points[0][0],points[1][0]),Math.min(points[0][1],points[1][1]),Math.max(points[0][1],points[1][1])];
      if(bounds[1]-bounds[0]<=EPS||bounds[3]-bounds[2]<=EPS)throw Error('Sculpt boundary is degenerate.');
      return Object.freeze({kind:mode,bounds:Object.freeze(bounds)});
    }
    let path=mode.startsWith('Curved')?catmull(points):points;
    if(mode.endsWith('Line')){
      const first=boundaryProjection(path[0]),last=boundaryProjection(path[path.length-1]);
      path=path.concat([last.point],perimeter(last,first));
    }
    const region=polygonRegion(path,tolerance);
    region.points=Object.freeze(region.points.map(p=>Object.freeze(p.slice())));
    region.bounds=Object.freeze(region.bounds);
    return Object.freeze(region);
  }
  function validRegion(region){
    if(!region||typeof region!=='object')return false;
    if(region.kind==='Rectangle'||region.kind==='Ellipse')return Array.isArray(region.bounds)&&region.bounds.length===4&&region.bounds.every(finite)&&region.bounds[0]>=0&&region.bounds[1]<=1&&region.bounds[2]>=0&&region.bounds[3]<=1&&region.bounds[1]-region.bounds[0]>EPS&&region.bounds[3]-region.bounds[2]>EPS;
    if(region.kind!=='Polygon'||!Array.isArray(region.points)||region.points.length<3||region.points.length>MAX_POINTS||!Array.isArray(region.bounds)||region.bounds.length!==4||!region.bounds.every(finite))return false;
    try{
      if(!region.points.every(p=>{point(p);return true;})||Math.abs(polygonArea(region.points))<=EPS)return false;
      const xs=region.points.map(p=>p[0]),ys=region.points.map(p=>p[1]);
      const actual=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)];
      return actual.every((value,index)=>Math.abs(value-region.bounds[index])<=EPS);
    }catch(_){return false;}
  }
  function onSegment(p,a,b){return distanceToSegment(p,a,b)<=EPS;}
  function contains(region,value){
    if(!validRegion(region))throw Error('Invalid sculpt region.');
    const p=queryPoint(value),b=region.bounds;
    if(p[0]<b[0]-EPS||p[0]>b[1]+EPS||p[1]<b[2]-EPS||p[1]>b[3]+EPS)return false;
    if(region.kind==='Rectangle')return true;
    if(region.kind==='Ellipse'){
      const cx=(b[0]+b[1])/2,cy=(b[2]+b[3])/2,rx=(b[1]-b[0])/2,ry=(b[3]-b[2])/2;
      return ((p[0]-cx)/rx)**2+((p[1]-cy)/ry)**2<=1+EPS;
    }
    let inside=false;
    for(let i=0,j=region.points.length-1;i<region.points.length;j=i++){
      const a=region.points[j],c=region.points[i];
      if(onSegment(p,a,c))return true;
      if((a[1]>p[1])!==(c[1]>p[1])&&p[0]<(c[0]-a[0])*(p[1]-a[1])/(c[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  function vector(value,length){return Array.isArray(value)&&value.length===length&&value.every(finite);}
  function projection(imageData,worldToCanvas,width,height){
    if(!imageData||typeof imageData.getSpatialExtent!=='function'||typeof imageData.indexToWorld!=='function'||typeof worldToCanvas!=='function'||!finite(width)||!finite(height)||width<=0||height<=0)throw Error('Invalid sculpt projection.');
    const extent=Array.from(imageData.getSpatialExtent());
    if(!vector(extent,6)||extent[1]-extent[0]<=0||extent[3]-extent[2]<=0||extent[5]-extent[4]<=0)throw Error('Invalid sculpt spatial extent.');
    const indices=[[extent[0],extent[2],extent[4]],[extent[1],extent[2],extent[4]],[extent[0],extent[3],extent[4]],[extent[0],extent[2],extent[5]]];
    const canvas=indices.map(index=>Array.from(worldToCanvas(Array.from(imageData.indexToWorld(index)))));
    if(!canvas.every(value=>vector(value,2)))throw Error('Invalid sculpt projection.');
    const normalize=value=>[value[0]/width,value[1]/height],base=normalize(canvas[0]);
    const axes=canvas.slice(1).map(value=>{const normalized=normalize(value);return [normalized[0]-base[0],normalized[1]-base[1]];});
    if(!safeVector(base,2)||!axes.every(value=>safeVector(value,2))||!rankTwo(axes))throw Error('Invalid sculpt projection.');
    return Object.freeze({base:Object.freeze(base),axes:Object.freeze(axes.map(value=>Object.freeze(value)))});
  }
  function safeVector(value,length){return vector(value,length)&&value.every(n=>Math.abs(n)<=1e6);}
  function rankTwo(axes){
    for(let i=0;i<axes.length;i++)for(let j=i+1;j<axes.length;j++)if(axes[i][0]*axes[j][1]-axes[i][1]*axes[j][0]!==0)return true;
    return false;
  }
  function validProjection(value){return value&&safeVector(value.base,2)&&Array.isArray(value.axes)&&value.axes.length===3&&value.axes.every(axis=>safeVector(axis,2))&&rankTwo(value.axes);}
  function cloneRegion(region){return region.kind==='Polygon'?{kind:'Polygon',points:region.points.map(p=>p.slice()),bounds:region.bounds.slice()}:{kind:region.kind,bounds:region.bounds.slice()};}
  function makeOperation(region,value,side){
    if(!validRegion(region)||!validProjection(value)||(side!=='Inside'&&side!=='Outside'))throw Error('Invalid sculpt operation.');
    const cloned=cloneRegion(region);
    if(cloned.points)cloned.points=Object.freeze(cloned.points.map(p=>Object.freeze(p)));
    cloned.bounds=Object.freeze(cloned.bounds);
    return Object.freeze({region:Object.freeze(cloned),projection:Object.freeze({base:Object.freeze(value.base.slice()),axes:Object.freeze(value.axes.map(axis=>Object.freeze(axis.slice())))}),side});
  }
  function number(value){
    if(!finite(value)||Math.abs(value)>1e6)throw Error('Invalid sculpt numeric value.');
    const result=Object.is(value,-0)?'0.0':String(value);
    return /[.eE]/.test(result)?result:result+'.0';
  }
  function vec2(value){return `vec2(${number(value[0])}, ${number(value[1])})`;}
  function regionExpression(region,q,index){
    const b=region.bounds;
    if(region.kind==='Rectangle')return `(${q}.x >= ${number(b[0])} && ${q}.x <= ${number(b[1])} && ${q}.y >= ${number(b[2])} && ${q}.y <= ${number(b[3])})`;
    if(region.kind==='Ellipse'){
      const center=[(b[0]+b[1])/2,(b[2]+b[3])/2],radius=[(b[1]-b[0])/2,(b[3]-b[2])/2];
      return `(dot((${q} - ${vec2(center)}) / ${vec2(radius)}, (${q} - ${vec2(center)}) / ${vec2(radius)}) <= 1.0)`;
    }
    const lines=[`bool kinIn${index} = false;`,`bool kinBoundary${index} = false;`,`if (${q}.x >= ${number(b[0])} && ${q}.x <= ${number(b[1])} && ${q}.y >= ${number(b[2])} && ${q}.y <= ${number(b[3])}) {`];
    for(let i=0,j=region.points.length-1;i<region.points.length;j=i++){
      const a=region.points[j],c=region.points[i],edge=[c[0]-a[0],c[1]-a[1]];
      lines.push(`  { vec2 a = ${vec2(a)}; vec2 e = ${vec2(edge)}; vec2 d = ${q} - a; float ee = dot(e,e); float u = clamp(dot(d,e) / max(ee, 1e-20), 0.0, 1.0); kinBoundary${index} = kinBoundary${index} || distance(d, u*e) <= 1e-7; }`);
      const dy=c[1]-a[1];
      if(Math.abs(dy)>EPS)lines.push(`  if (((${q}.y < ${number(a[1])}) != (${q}.y < ${number(c[1])})) && (${q}.x < ${number(a[0])} + (${q}.y - ${number(a[1])}) * ${number(c[0]-a[0])} / ${number(dy)})) kinIn${index} = !kinIn${index};`);
    }
    lines.push(`  kinIn${index} = kinIn${index} || kinBoundary${index};`,`}`);
    return {lines,result:`kinIn${index}`};
  }
  function shaderReplacement(operations){
    if(!Array.isArray(operations)||operations.length>MAX_OPERATIONS)throw Error('At most 8 sculpt operations are supported.');
    const lines=[],hidden=[];
    operations.forEach((operation,index)=>{
      if(!operation||!validRegion(operation.region)||!validProjection(operation.projection)||(operation.side!=='Inside'&&operation.side!=='Outside'))throw Error('Invalid sculpt operation.');
      const p=operation.projection,q=`kinSculptPoint${index}`;
      lines.push(`  vec2 ${q} = ${vec2(p.base)} + ${vec2(p.axes[0])} * posIS.x + ${vec2(p.axes[1])} * posIS.y + ${vec2(p.axes[2])} * posIS.z;`);
      const expression=regionExpression(operation.region,q,index);
      if(typeof expression==='string')hidden.push(operation.side==='Inside'?expression:`!${expression}`);
      else{lines.push(...expression.lines.map(line=>'  '+line));hidden.push(operation.side==='Inside'?expression.result:`!${expression.result}`);}
    });
    if(hidden.length)lines.push(`  if (${hidden.map(value=>`(${value})`).join(' || ')}) return vec4(0.0);`);
    const signature='vec4 getColorForValue(vec4 tValue, vec3 posIS, vec3 tstep)\n{';
    return {shaderType:'Fragment',replaceFirst:true,originalValue:signature,replacementValue:signature+(lines.length?'\n  {\n'+lines.map(line=>'  '+line).join('\n')+'\n  }':''),replaceAll:false};
  }
  return Object.freeze({makeRegion,contains,projection,makeOperation,shaderReplacement});
});
