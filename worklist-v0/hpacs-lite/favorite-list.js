/* A folder narrows the loaded list; it never grants study access. */
window.KinFavoriteList = function (app) {
  let scope=null, sequence=0, controller=null;
  const prefix=app.label??'즐겨찾기',noun=app.noun??'폴더';
  const identity=()=>JSON.stringify(app.identity());
  const owns=()=>scope&&JSON.stringify(scope.owner)===identity();
  function cancel(){++sequence;controller?.abort();controller=null;}
  function changed(){app.changed();}
  function clear(){cancel();scope=null;changed();}
  function accept(value){
    if(!scope)return;
    if(!owns()||JSON.stringify(value?.owner)!==identity()){
      cancel();scope={owner:null,id:null,name:'',uids:new Set(),status:'계정이 바뀌었습니다. 새로고침하세요.'};changed();return;
    }
    if(!Number.isInteger(value.revision)||!Array.isArray(value.folders))throw new Error(prefix+' 목록 형식 오류');
    const folder=value.folders.find(f=>f.id===scope.id);
    if(folder&&(typeof folder.name!=='string'||!Array.isArray(folder.uids)||folder.uids.some(uid=>typeof uid!=='string')))throw new Error(prefix+' '+noun+' 형식 오류');
    if(value.revision<scope.revision)return;
    scope={...scope,revision:value.revision,name:folder?.name??scope.name,uids:new Set(folder?.uids??[]),
      status:folder?'':noun+'가 삭제되었습니다. 범위를 해제하거나 다른 '+noun+'를 선택하세요.'};changed();
  }
  return {
    apply(value,id){
      if(!app.identity()||JSON.stringify(value?.owner)!==identity())throw new Error(prefix+' 계정이 바뀌었습니다');
      if(!value.folders?.some(f=>f.id===id))throw new Error(noun+'를 찾을 수 없습니다');
      cancel();scope={owner:value.owner,id,name:'',revision:-1,uids:new Set(),status:''};
      try{accept(value);}catch(e){scope.status=e.message;changed();throw e;}
    },
    adopt(value){if(!scope)return;cancel();try{accept(value);}catch(e){scope.uids=new Set();scope.status=e.message;changed();}},
    clear,
    end(){cancel();if(scope){scope={owner:null,id:null,name:'',uids:new Set(),status:''};changed();}},
    filter(list){return scope?(owns()?list.filter(s=>scope.uids.has(s.uid)):[]):list;},
    key(){return scope?.id??(scope?'invalid':null);},
    label(){return scope?(owns()?prefix+': '+scope.name+(scope.status?' · '+scope.status:' · 기존 검색과 함께 적용'):prefix+': 계정 확인 필요'):'';},
    async refresh(){
      if(!scope)return;
      if(!owns()){accept(null);return;}
      cancel();const ticket=sequence;controller=new AbortController();const local=controller;
      const timer=setTimeout(()=>local.abort(),12000);
      try{const value=await (app.read?app.read(local.signal):app.api('GET','/favorite-folders',undefined,local.signal));if(ticket===sequence)accept(value);}
      catch(e){if(ticket===sequence&&scope){scope.uids=new Set();scope.status='확인 실패 · Refresh로 다시 시도하세요.';changed();}}
      finally{clearTimeout(timer);if(controller===local)controller=null;}
    },
  };
};
