/* Pure comparison of completed, permission-filtered worklist snapshots. */
(function(root){
  'use strict';
  const validUid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  // null is the server's "unknown" (tag absent or non-integer in QIDO). It is neither 0 nor an
  // error: a snapshot that carries it is still comparable on the axes that are known.
  const validCount=value=>value===null||(Number.isSafeInteger(value)&&value>=0);
  // Growth needs two known values. unknown->known is a first observation, not an arrival, and
  // known->unknown is a lost observation; neither may raise a "new images" notice.
  const added=(before,after)=>before!==null&&after!==null&&after>before?after-before:0;
  const invalid=(name,reason,index)=>({error:name+':'+reason+(index===undefined?'':':'+index)});

  function snapshot(rows,name){
    if(!Array.isArray(rows))return invalid(name,'not-array');
    const values=new Map();
    for(let index=0;index<rows.length;index++){
      const row=rows[index];
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid))
        return invalid(name,'invalid-uid',index);
      if(values.has(row.uid))return invalid(name,'duplicate-uid',index);
      if(!validCount(row.count)||!validCount(row.series))
        return invalid(name,'invalid-count',index);
      values.set(row.uid,{count:row.count,series:row.series});
    }
    return {values};
  }

  function diff(previous,next){
    const before=snapshot(previous,'previous');if(before.error)return {ok:false,changes:[],error:before.error};
    const after=snapshot(next,'next');if(after.error)return {ok:false,changes:[],error:after.error};
    const changes=[];
    for(const [uid,current] of after.values){
      const old=before.values.get(uid);if(!old)continue;
      const addedInstances=added(old.count,current.count),addedSeries=added(old.series,current.series);
      if(!addedInstances&&!addedSeries)continue;
      changes.push({uid,previousCount:old.count,count:current.count,previousSeries:old.series,series:current.series,
        addedInstances,addedSeries});
    }
    return {ok:true,changes};
  }

  const api={diff};root.KinStudyArrivals=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
