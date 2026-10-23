
function kinCreateViewerTechNote() {
  let ready, current, prepare, epoch=0, active=false, state='stopped';
  // The bridge follows the verified role; document disposal belongs to the page boundary.
  kinViewerSession.onChange(next=>{if(next==='writer'){connect();return;}epoch++;if(active)state=next;if(next==='read-only'){current?.stop();current=null;}});
  function connect() {
    if(!active||state==='loading'||state==='ready'||!kinViewerSession.writer())return;
    const ticket=epoch;state='loading';
    prepare().then(extension=>{
      if(!active||ticket!==epoch)return;
      current=extension;
      if(current.mount()!==true)throw new Error('Tech 메모 연결 대상을 확인하지 못했습니다.');
      state='ready';
    }).catch(e=>{
      if(!active||ticket!==epoch)return;
      state='failed';
      if(window.top===window){const p=document.querySelector('#kin-viewer-layout-status');if(p)p.textContent='Tech 메모 화면을 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.';}
    });
  }
  return {id:'kin.viewer-tech-note',preRegistration({servicesManager}) {
    const load=name=>new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/worklist/hpacs-lite/'+name;
      const fail=()=>{clearTimeout(timer);script.onload=script.onerror=null;script.remove();reject(new Error('Tech 메모 화면을 불러오지 못했습니다. 메모 연결을 다시 시도하세요.'));};
      const timer=setTimeout(fail,20000);
      script.onload=()=>{clearTimeout(timer);resolve();};script.onerror=fail;document.head.append(script);
    });
    const standalone=window.top===window;
    if(standalone){const css=document.createElement('link');css.rel='stylesheet';css.href='/worklist/hpacs-lite/tech-note.css';document.head.append(css);}
    prepare=()=>ready||(ready=(standalone&&typeof window.KinTechNote!=='function'?load('tech-note.js'):Promise.resolve())
      .then(()=>standalone&&typeof window.KinViewerWorkspaceDock!=='function'?load('viewer-workspace-dock.js'):undefined)
      .then(()=>standalone&&!window.KinWorkspaceShortcuts?load('workspace-shortcuts.js'):undefined)
      .then(()=>standalone&&!window.KinViewerWindows?load('viewer-windows.js').catch(()=>undefined):undefined)
      .then(()=>window.KinViewerIdentity?undefined:load('viewer-identity.js'))
      .then(()=>Promise.allSettled([
        window.KinVolumeOrientation?Promise.resolve():load('volume-orientation.js'),
        typeof window.kinCreateVolumeOrientation==='function'?Promise.resolve():load('viewer-volume-orientation.js'),
        window.KinVolumeDisplay?Promise.resolve():load('volume-display.js'),
        typeof window.kinCreateVolumeDisplay==='function'?Promise.resolve():load('viewer-volume-display.js'),
        typeof window.kinCreateVolumeSync==='function'?Promise.resolve():load('viewer-volume-sync.js'),
        typeof window.kinCreateVolumeProgressive==='function'?Promise.resolve():load('viewer-volume-progressive.js'),
        window.KinVolumeMarks?Promise.resolve():load('volume-marks.js'),
        typeof window.kinCreateVolumeMarks==='function'?Promise.resolve():load('viewer-volume-marks.js'),
        window.KinVolumeCurved?Promise.resolve():load('volume-curved.js'),
        typeof window.kinCreateVolumeCurved==='function'?Promise.resolve():load('viewer-volume-curved.js'),
        window.KinVolumePath?Promise.resolve():load('volume-path.js'),
        typeof window.kinCreateVolumePath==='function'?Promise.resolve():load('viewer-volume-path.js'),
        window.KinVolumePreferences?Promise.resolve():load('volume-preferences.js'),
        typeof window.kinCreateVolumePreferences==='function'?Promise.resolve():load('viewer-volume-preferences.js'),
        window.KinVolumeCrosshair?Promise.resolve():load('volume-crosshair.js'),
        typeof window.kinCreateVolumeCrosshair==='function'?Promise.resolve():load('viewer-volume-crosshair.js'),
        window.KinVolumeBatch?Promise.resolve():load('volume-batch.js'),
        window.KinVolumeBatchScout?Promise.resolve():load('volume-batch-scout.js'),
        typeof window.kinRenderVolumeScout==='function'?Promise.resolve():load('viewer-volume-scout.js'),
        typeof window.kinCreateVolumeBatch==='function'?Promise.resolve():load('viewer-volume-batch.js')]))
      .then(()=>typeof window.kinViewerTechNote==='function'?undefined:load('viewer-tech-note.js'))
      .then(()=>window.kinViewerTechNote(servicesManager.services,kinViewerSession.writeModule)).catch(e=>{ready=null;throw e;}));
    window.kinViewerNoteConnectionState=()=>state;
    window.kinViewerNoteReconnect=()=>{if(active&&state==='failed')connect();};
  },onModeEnter(){if(!prepare)return;epoch++;active=true;state='unconfirmed';const ticket=epoch;
    // S5-U2b: Tech notes are a technician record the clinician allowlist neither reads nor writes. The bridge connects only
    // after a /me answered writer; until an answer it stays 'unconfirmed', and 'read-only'/'refused' never connect.
    kinViewerSession.decide().then(session=>{if(!active||ticket!==epoch)return;if(session==='writer')connect();else state=session;});
  },onModeExit(){epoch++;active=false;state='stopped';current?.stop();current=null;}};
}
