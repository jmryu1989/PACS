
function kinCreateFrameCoverage() {
  let ready, current, services, epoch=0;
  return {id:'kin.frame-coverage',preRegistration({servicesManager}) {
    services=servicesManager.services;
    ready=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/worklist/hpacs-lite/viewer-frame-coverage.js';
      const timeout=setTimeout(()=>reject(Error('Frame Coverage loading timeout')),20000);
      script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(Error('Frame Coverage loading failed'));};document.head.append(script);
    });ready.catch(()=>{});
  },onModeEnter(){
    const ticket=++epoch;
    window.kinViewerFrameCoverageState=()=>({warn:true,phase:'unverified'});
    window.kinViewerFrameCoverageConfirm=ask=>(ask||window.confirm)('원본 프레임 표시 확인을 연결하지 못했습니다. 이 영상을 떠날까요?');
    ready.then(()=>{if(ticket===epoch)current=window.KinFrameCoverage.mount(services);}).catch(()=>{
      if(ticket===epoch){const status=document.querySelector('#kin-viewer-layout-status');if(status)status.textContent='Frame Coverage를 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.';}
    });
  },onModeExit(){epoch++;current?.stop();current=null;}};
}
