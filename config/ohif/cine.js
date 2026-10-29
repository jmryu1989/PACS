
function kinCineWithinBudget(ids, pixels, available, cached = [], cacheable = () => true) {
  if (ids.length < 2 || pixels.length !== ids.length || !Number.isFinite(available) || available < 0) return false;
  let needed = 0, total = 0;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (![p?.rows, p?.columns].every(n => Number.isSafeInteger(n) && n > 0)) return false;
    // Use the decoded frame's size when present; an uncached frame uses its
    // native allocation (8/16-bit monochrome or RGB), not Float32 per sample.
    const bytes = cached[i]?.sizeInBytes ?? p.rows * p.columns * (p.decodedBytesPerPixel ?? Number(p.bitsAllocated || 32) / 8 * Number(p.samplesPerPixel || 1));
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return false;
    total += bytes;
    if (!cached[i]) needed += bytes;
  }
  return Number.isSafeInteger(total) && needed <= available && cacheable(total);
}

function kinCineNext(index, first, last, mode, direction, loop) {
  if (![index, first, last].every(Number.isSafeInteger) || first < 0 || first >= last || index < first || index > last ||
      !['forward', 'reverse', 'yoyo'].includes(mode)) throw Error('invalid cine range state');
  if (mode === 'yoyo') {
    let nextDirection = direction === -1 ? -1 : 1;
    if (index === last && nextDirection === 1) nextDirection = -1;
    else if (index === first && nextDirection === -1) {
      if (!loop) return { stop: true, direction: nextDirection };
      nextDirection = 1;
    }
    return { stop: false, direction: nextDirection, next: index + nextDirection };
  }
  const nextDirection = mode === 'reverse' ? -1 : 1, candidate = index + nextDirection;
  if (candidate >= first && candidate <= last) return { stop: false, direction: nextDirection, next: candidate };
  return loop ? { stop: false, direction: nextDirection, next: nextDirection === 1 ? first : last }
    : { stop: true, direction: nextDirection };
}

function kinCreateCine() {
  let services, extensions, dispose;
  function mount() {
    dispose?.();
    // OHIF's stack handler only copies FrameTime into this millisecond playback
    // hint. Supply the preferred DICOM rate before native cine initializes both
    // its FPS control and playback state; never rewrite the instance metadata.
    const handlerId = '@ohif/extension-default.sopClassHandlerModule.stack';
    const handler = extensions.getModuleEntry(handlerId);
    const nativeDisplaySets = handler.getDisplaySetsFromSeries;
    function sourceRate(displaySet) {
      const instance = displaySet.instances?.[0];
      if (!(Number(instance?.NumberOfFrames) > 1)) return;
      for (const value of [instance.RecommendedDisplayFrameRate, instance.CineRate]) {
        const rate = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
        if (Number.isFinite(rate) && rate > 0) {
          displaySet.FrameRate = 1000 / rate;
          return;
        }
      }
      // Preserve OHIF's existing FrameTime conversion and its no-rate default.
    }
    const createDisplaySets = function (...args) {
      const displaySets = nativeDisplaySets.apply(this, args);
      displaySets.forEach(sourceRate);
      return displaySets;
    };
    handler.getDisplaySetsFromSeries = createDisplaySets;
    services.displaySetService.getActiveDisplaySets().forEach(ds => {
      if (ds.SOPClassHandlerId === handlerId) sourceRate(ds);
    });
    const core = window.cornerstone, cine = services.cineService, grid = services.viewportGridService;
    const nativePlay = cine.playClip, nativeStop = cine.stopClip;
    const records = new Map(), subscriptions = [], listeners = [];
    let ended = false, channel, selected, owner, sequence = 0, halting = false, wasEnabled = false, rangeShown;
    const panel = document.createElement('div'); panel.id = 'kin-cine'; panel.hidden = true;
    panel.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:42;max-width:65vw;display:flex;flex-wrap:wrap;gap:6px;padding:7px;background:#101e32;color:#e1ecfc;border-radius:6px;font:13px sans-serif';
    // Native controls remain the playback/FPS entry point for the selected view.
    const direction = document.createElement('select'); direction.setAttribute('aria-label', 'Playback Direction');
    for (const [value, text] of [['forward', 'Forward'], ['reverse', 'Reverse'], ['yoyo', 'Yoyo']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; direction.append(option);
    }
    const loop = document.createElement('input'); loop.type = 'checkbox'; loop.checked = true;
    const label = document.createElement('label'); label.append(loop, ' Loop');
    const rangeStart = document.createElement('input'); rangeStart.type = 'number'; rangeStart.min = '1'; rangeStart.setAttribute('aria-label', 'Range Start');
    const rangeEnd = document.createElement('input'); rangeEnd.type = 'number'; rangeEnd.min = '2'; rangeEnd.setAttribute('aria-label', 'Range End');
    const applyRange = document.createElement('button'); applyRange.textContent = 'Apply Range';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const first = document.createElement('button'); first.textContent = 'First Frame';
    const last = document.createElement('button'); last.textContent = 'Last Frame';
    const help = document.createElement('span'); help.textContent = '범위는 1부터 시작합니다. Yoyo는 양 끝 프레임을 중복하지 않고 왕복합니다.';
    panel.append('Selected View ', direction, label, ' Range ', rangeStart, ' to ', rangeEnd, applyRange, first, last, status, help); document.body.append(panel);
    for (const control of [direction, rangeStart, rangeEnd, applyRange, first, last]) control.style.cssText = 'background:#263c57;color:white;border:1px solid #6884a6;border-radius:3px;padding:2px 5px';
    rangeStart.style.width = rangeEnd.style.width = '58px';
    const listen = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); listeners.push(() => target.removeEventListener(type, fn, capture)); };
    const viewport = id => services.cornerstoneViewportService.getCornerstoneViewport(id);
    const volumeTarget = (v, verify = false) => { try { return window.kinGetVolumeCineTarget?.(v, verify) || null; } catch (e) { if (verify) throw e; return null; } };
    const eligible = v => v?.type === 'stack' || v?.type === 'orthographic' && !!volumeTarget(v)?.allowed;
    const signature = v => { if (v.type === 'orthographic') { const c=v.getCamera(),round=n=>Number(n.toFixed(6)); return JSON.stringify([volumeTarget(v)?.key,c.viewPlaneNormal.map(round),c.viewUp.map(round),round(c.parallelScale),c.flipHorizontal,c.flipVertical]); } return JSON.stringify([grid.getState().viewports.get(v.id)?.displaySetInstanceUIDs, v.getImageIds?.()]); };
    const contentSignature = v => v.type==='orthographic'?volumeTarget(v)?.contentKey:signature(v);
    const resetDirection = r => { r.playDirection = r.mode === 'reverse' ? -1 : 1; };
    const resetRange = r => { r.range = null; r.rangeRevision = (r.rangeRevision || 0) + 1; resetDirection(r); };
    const resetPlayback = r => { r.mode = 'forward'; r.loop = true; resetRange(r); };
    function positionControls(v) {
      const pane=[...document.querySelectorAll('[data-cy=viewport-grid] > div')].find(p=>p.contains(v?.element)),control=pane?.querySelector('[data-cy="cine-player-play-pause"]'),rect=control?.getBoundingClientRect();
      if(!rect?.width||!panel.offsetHeight)return;
      panel.style.bottom='auto';panel.style.top=Math.max(48,rect.top-panel.offsetHeight-8)+'px';panel.style.left=Math.min(innerWidth-panel.offsetWidth/2-8,Math.max(panel.offsetWidth/2+8,rect.x+rect.width/2))+'px';
    }
    function volumeFrames(v,target) {
      const {sliceRange,spacingInNormalDirection:step,camera}=core.utilities.getVolumeViewportScrollInfo(v,target.volume.volumeId).sliceRangeInfo;
      const {min,max,current}=sliceRange,last=Math.floor((max-min)/step+1e-6),index=Math.round((current-min)/step);
      if(![min,max,current,step].every(Number.isFinite)||step<=0||max<=min||!Number.isSafeInteger(last)||last<1||!Number.isSafeInteger(index))throw Error('MPR 재생 범위를 확인할 수 없습니다.');
      return {min,step,last,index,current,camera};
    }
    function moveVolume(v,target,frames,index) {
      const {camera,min,step,current}=frames,delta=min+index*step-current;
      const next={focalPoint:camera.focalPoint.map((n,i)=>n+camera.viewPlaneNormal[i]*delta),position:camera.position.map((n,i)=>n+camera.viewPlaneNormal[i]*delta)};
      try{v.setCamera(next);v.render();const actual=v.getCamera();if(Object.keys(next).some(key=>next[key].some((n,i)=>Math.abs(n-actual[key][i])>1e-5)))throw Error('MPR 재생 위치를 확인하지 못했습니다.');}
      catch(error){if(volumeTarget(v)?.key===target.key)try{v.setCamera({focalPoint:camera.focalPoint,position:camera.position});v.render();}catch(_){}throw error;}
    }
    function record(v) {
      let r = records.get(v.id);
      if (!r || r.element !== v.element) {
        const previous=r;
        r = { element: v.element, mode: 'forward', loop: true, range: null, rangeRevision: 0, playDirection: 1, ticket: 0, signature: signature(v), content:contentSignature(v) }; records.set(v.id, r);
        // stopClip broadcasts synchronously. Publish the replacement first so
        // its render callback cannot retire the same old viewport recursively.
        if(previous){clearInterval(previous.volumeTimer);nativeStop.call(cine,previous.element,{viewportId:v.id});if(cine.getState().cines?.[v.id]?.isPlaying)cine.setCine({id:v.id,isPlaying:false});}
        const owns=()=>records.get(v.id)===r;
        listen(v.element, core.Enums.Events.VIEWPORT_NEW_IMAGE_SET, () => { if(!owns())return;r.signature = signature(v);r.content=r.signature;resetPlayback(r);halt(v.id);render(); });
        if(v.type==='orthographic') {
          listen(v.element, core.Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, () => { if(!owns())return;r.signature=signature(v);const content=contentSignature(v);if(r.content!==content){r.content=content;resetPlayback(r);}else resetRange(r);halt(v.id);render(); });
          listen(v.element, core.Enums.Events.CAMERA_MODIFIED, () => { if(owns()&&r.signature!==signature(v)) { r.signature=signature(v); resetRange(r); halt(v.id); render(); } });
        }
        listen(v.element, 'CORNERSTONE_CINE_TOOL_STOPPED', () => {if(owns())halt(v.id);});
      }
      return r;
    }
    function halt(id) {
      const r = records.get(id); if (r) { r.ticket = ++sequence; r.loading = false; r.authorized = false; clearInterval(r.volumeTimer); r.volumeTimer=undefined; nativeStop.call(cine, r.element, { viewportId: id }); }
      if (cine.getState().cines?.[id]?.isPlaying) cine.setCine({ id, isPlaying: false });
    }
    function haltAll() { if (halting) return; halting = true; try { records.forEach((_, id) => halt(id)); } finally { halting = false; } }
    function frameCount(v) {
      if (v.type === 'stack') return v.getImageIds?.().length || 0;
      try { const target = volumeTarget(v); return target ? volumeFrames(v, target).last + 1 : 0; } catch (_) { return 0; }
    }
    function playbackRange(r, total) {
      if (!r.range) return { first: 0, last: total - 1 };
      return r.range.first >= 0 && r.range.first < r.range.last && r.range.last < total ? r.range : null;
    }
    function showRange(r, total, bounds) {
      if (rangeShown?.record === r && rangeShown.revision === r.rangeRevision && rangeShown.total === total) return;
      rangeStart.max = rangeEnd.max = String(total); rangeStart.value = total ? String(bounds.first + 1) : ''; rangeEnd.value = total ? String(bounds.last + 1) : '';
      rangeShown = { record: r, revision: r.rangeRevision, total };
    }
    function render() {
      if (ended) return;
      const id = grid.getActiveViewportId(), v = viewport(id), supported = eligible(v);
      first.textContent=v?.type==='orthographic'?'First Plane':'First Frame';last.textContent=v?.type==='orthographic'?'Last Plane':'Last Frame';
      panel.hidden = !cine.getState().isCineEnabled || (!supported&&v?.type!=='orthographic');
      panel.style.display = panel.hidden ? 'none' : 'flex';
      direction.disabled=loop.disabled=rangeStart.disabled=rangeEnd.disabled=applyRange.disabled=!supported;
      if (!supported) { first.disabled=last.disabled=true;rangeShown=undefined;status.textContent='완전히 로드된 단일 정규 CT의 MPR 평면을 선택하고 다른 작업을 마친 뒤 재생하세요.';positionControls(v);return; }
      const r = record(v);
      if (r.signature !== signature(v)) { r.signature = signature(v);const content=contentSignature(v);if(r.content!==content){r.content=content;resetPlayback(r);}else resetRange(r);halt(id); }
      const total=frameCount(v);let bounds=playbackRange(r,total);
      if(!bounds){resetRange(r);r.message='영상 범위가 변경되어 전체 범위로 초기화했습니다.';bounds=playbackRange(r,total);}
      showRange(r,total,bounds);
      direction.value = r.mode; loop.checked = r.loop;
      first.disabled = last.disabled = r.loading || total < 1; applyRange.disabled = r.loading || total < 2;
      status.textContent = r.message || (r.loading ? '프레임 준비 중' : total<1?'재생할 프레임을 확인할 수 없습니다.':`범위 ${bounds.first+1}~${bounds.last+1}` + (v.type==='orthographic'?' · 원본 CT에서 재구성한 평면을 재생합니다.':''));
      positionControls(v);
    }
    async function session() {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('로그인 상태를 확인할 수 없습니다');
        const me = await response.json();
        const key = me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;
        if (!key || (owner && key !== owner)) throw Error('계정이 변경되었습니다');
        owner = key;
      } finally { clearTimeout(timer); }
    }
    cine.stopClip = function (element, options) {
      const v = core.getEnabledElement(element)?.viewport, r = records.get(v?.id || options?.viewportId);
      // A late native unmount may still carry the retired element (or only its
      // viewport id). Neither it nor nativeStop's id fallback owns a new view.
      if (r && r.element !== element) return;
      if (r) { r.ticket = ++sequence; r.loading = false; clearInterval(r.volumeTimer); r.volumeTimer=undefined; }
      return nativeStop.call(this, element, options);
    };
    cine.playClip = async function (element, options = {}) {
      const v = core.getEnabledElement(element)?.viewport;
      if (ended || document.hidden || !v) { if(v)halt(v.id); return; }
      if (v.type !== 'stack' && v.type !== 'orthographic') return nativePlay.call(this, element, options);
      const r = record(v), id = v.id, ticket = r.ticket = ++sequence, before = signature(v);
      clearInterval(r.volumeTimer);r.volumeTimer=undefined;
      const current = () => !ended && !document.hidden && r.authorized && r.ticket === ticket && records.get(id)===r && viewport(id) === v && signature(v) === before && grid.getActiveViewportId() === id && cine.getState().isCineEnabled && (v.type==='stack'||!!volumeTarget(v)?.allowed);
      if (!r.authorized || grid.getActiveViewportId() !== id) { halt(id); return; }
      records.forEach((_, other) => { if (other !== id) halt(other); });
      r.loading = true; r.message = ''; render();
      try {
        if(v.type==='orthographic') {
          const target=volumeTarget(v,true);if(!target)throw Error('완전히 로드된 정규 CT MPR 평면을 선택하세요.');
          const fps=Math.abs(Number(options.framesPerSecond||24));if(!Number.isFinite(fps)||fps<1||fps>90)throw Error('MPR 재생 속도는 1~90 fps입니다.');
          await session();if(!current())return;
          let frames=volumeFrames(v,target);const bounds=playbackRange(r,frames.last+1);if(!bounds)throw Error('MPR 재생 범위가 바뀌었습니다. 다시 적용하세요.');
          if(frames.index<bounds.first||frames.index>bounds.last){moveVolume(v,target,frames,bounds.first);frames=volumeFrames(v,target);}
          nativeStop.call(cine,element,{viewportId:id});clearInterval(r.volumeTimer);r.loading=false;
          // Anchor a physical grid at the first plane. Native cine excludes the
          // final position and its oblique scroll snap accumulates spacing drift.
          const timer=setInterval(()=>{
            if(!current()){clearInterval(timer);if(records.get(id)===r&&r.ticket===ticket){halt(id);render();}return;}
            try{
              const frames=volumeFrames(v,target);if(frames.index<bounds.first||frames.index>bounds.last){moveVolume(v,target,frames,bounds.first);return;}
              const step=kinCineNext(frames.index,bounds.first,bounds.last,r.mode,r.playDirection,r.loop);
              if(step.stop){resetDirection(r);halt(id);render();return;}r.playDirection=step.direction;moveVolume(v,target,frames,step.next);
            }catch(error){clearInterval(timer);if(records.get(id)===r){r.message=error.message||'MPR 재생을 중단했습니다.';if(r.ticket===ticket)halt(id);render();}}
          },1000/fps);r.volumeTimer=timer;render();return;
        }
        const ids = v.getImageIds(), metadata = ids.map(imageId => core.metaData.get('imagePixelModule', imageId));
        const cached = ids.map(id => core.cache.getImage(id));
        // A displayed frame supplies the actual decoder allocation, including
        // Float32 promotion for its rescale and RGB/RGBA conversion.
        const keys = metadata.map((p,i) => JSON.stringify([p?.bitsAllocated,p?.samplesPerPixel,p?.photometricInterpretation,core.metaData.get('modalityLutModule',ids[i])]));
        const allocations = new Map();
        cached.forEach((image,i) => { if (image?.sizeInBytes && metadata[i]?.rows && metadata[i]?.columns)
          allocations.set(keys[i],image.sizeInBytes/(metadata[i].rows*metadata[i].columns)); });
        const pixels = metadata.map((p,i) => ({...p,decodedBytesPerPixel:allocations.get(keys[i])}));
        // Cornerstone includes evictable images in isCacheable(); subtracting the
        // whole image cache would reject cine after viewing an unrelated study.
        let available = core.cache.getMaxCacheSize();
        const heap = performance.memory;
        if (heap && Number.isFinite(heap.jsHeapSizeLimit - heap.usedJSHeapSize))
          available = Math.min(available, heap.jsHeapSizeLimit - heap.usedJSHeapSize);
        if (!kinCineWithinBudget(ids, pixels, available, cached, bytes => core.cache.isCacheable(bytes))) {
          r.message = '현재 영상 캐시·메모리 여유가 부족합니다. 다른 검사를 정리하거나 뷰어를 다시 연 뒤 재생하세요.';
          throw Error(r.message);
        }
        await session(); if (!current()) return;
        // Finish a bounded, four-worker preparation before the native timer starts, so stop/replace cannot be undone by a late frame load.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (current() && next < ids.length) { const imageId = ids[next++]; await core.imageLoader.loadAndCacheImage(imageId); }
        }));
        if (!current()) return;
        const bounds=playbackRange(r,ids.length);if(!bounds)throw Error('재생 범위가 바뀌었습니다. 다시 적용하세요.');const currentIndex=()=>v.getTargetImageIdIndex?.()??v.getCurrentImageIdIndex?.();
        if(currentIndex()<bounds.first||currentIndex()>bounds.last){await core.utilities.jumpToSlice(v.element,{imageIndex:bounds.first});if(!current())return;}
        r.loading = false;
        if(!r.range&&r.mode!=='yoyo'){
          nativePlay.call(this, element, { ...options, framesPerSecond: Math.abs(options.framesPerSecond || 10) * (r.mode==='reverse' ? -1 : 1), loop: r.loop });
        // This pinned native API retains loop from its first play; update its public cine state on every explicit start.
          window.cornerstoneTools.utilities.cine.getToolState(element).loop = r.loop;render();return;
        }
        const fps=Math.abs(Number(options.framesPerSecond||10));if(!Number.isFinite(fps)||fps<1||fps>90)throw Error('재생 속도는 1~90 fps입니다.');
        nativeStop.call(cine,element,{viewportId:id});
        const timer=setInterval(()=>{
          if(!current()){clearInterval(timer);if(records.get(id)===r&&r.ticket===ticket){halt(id);render();}return;}
          try{
            if(core.Enums.ViewportStatus&&v.viewportStatus!==core.Enums.ViewportStatus.RENDERED)return;
            const index=currentIndex();if(index<bounds.first||index>bounds.last){core.utilities.scroll(v,{delta:bounds.first-index,debounceLoading:true});return;}
            const step=kinCineNext(index,bounds.first,bounds.last,r.mode,r.playDirection,r.loop);
            if(step.stop){resetDirection(r);halt(id);render();return;}r.playDirection=step.direction;core.utilities.scroll(v,{delta:step.next-index,debounceLoading:true});
          }catch(error){clearInterval(timer);if(records.get(id)===r){r.message=error.message||'재생을 중단했습니다.';if(r.ticket===ticket)halt(id);render();}}
        },1000/fps);r.volumeTimer=timer;
        render();
      } catch (error) {
        if (current()) { r.message = v.type==='orthographic' ? (error.message || 'MPR 재생을 준비할 수 없습니다.') : (r.message || '재생을 준비할 수 없습니다. 로그인 상태와 영상을 확인하고 다시 시도하세요.'); halt(id); render(); }
      } finally {
        if(v.type==='orthographic'&&records.get(id)===r&&r.ticket===ticket&&!current()){halt(id);render();}
      }
    };
    const change = () => {
      const v = viewport(grid.getActiveViewportId()); if (!eligible(v)) return;
      const r = record(v), modeChanged = r.mode !== direction.value; r.mode = direction.value; r.loop = loop.checked;
      if (modeChanged) resetDirection(r);
      halt(v.id); r.message = '설정을 바꿨습니다. 재생을 눌러 시작하세요.'; render();
    };
    listen(direction, 'change', change); listen(loop, 'change', change);
    listen(applyRange,'click',()=>{
      const v=viewport(grid.getActiveViewportId());if(!eligible(v))return;const r=record(v),total=frameCount(v);
      const parse=value=>/^\d+$/.test(value)?Number(value):NaN,firstValue=parse(rangeStart.value),lastValue=parse(rangeEnd.value);
      if(!Number.isSafeInteger(firstValue)||!Number.isSafeInteger(lastValue)||firstValue<1||firstValue>=lastValue||lastValue>total){
        r.message=`재생 범위는 1~${total} 안에서 시작이 끝보다 작아야 합니다.`;render();return;
      }
      r.range={first:firstValue-1,last:lastValue-1};r.rangeRevision++;resetDirection(r);halt(v.id);r.message='범위를 적용했습니다. 재생을 눌러 시작하세요.';render();
    });
    listen(document, 'click', e => {
      if (!e.target.closest?.('[data-cy="cine-player-play-pause"]')) return;
      const v = viewport(grid.getActiveViewportId());
      if (eligible(v)) record(v).authorized = !cine.getState().cines?.[v.id]?.isPlaying;
    }, true);
    async function jump(end) {
      const v = viewport(grid.getActiveViewportId()); if (!eligible(v)) return;
      halt(v.id); const r = record(v), ticket = r.ticket = ++sequence, before = signature(v);
      if(v.type==='orthographic') {
        try{const target=volumeTarget(v,true);if(!target)throw Error('대상 MPR 평면을 다시 확인하세요.');const frames=volumeFrames(v,target),bounds=playbackRange(r,frames.last+1);if(!bounds)throw Error('MPR 재생 범위가 바뀌었습니다. 다시 적용하세요.');moveVolume(v,target,frames,end?bounds.last:bounds.first);r.message='MPR 범위 끝 위치로 이동했습니다.';}catch(error){r.message=error.message;}render();return;
      }
      const ids=v.getImageIds(),bounds=playbackRange(r,ids.length);if(!bounds){r.message='재생 범위가 바뀌었습니다. 다시 적용하세요.';render();return;}const index=end?bounds.last:bounds.first,imageId=ids[index];
      r.loading = true; r.message = ''; render();
      try {
        await core.imageLoader.loadAndCacheImage(imageId);
        if (ended || r.ticket !== ticket || viewport(v.id) !== v || signature(v) !== before) return;
        await core.utilities.jumpToSlice(v.element, { imageIndex: index });
      } catch (_) { if (!ended && r.ticket === ticket) r.message = '프레임을 불러올 수 없습니다'; }
      finally { if (!ended && r.ticket === ticket) { r.loading = false; render(); } }
    }
    listen(first, 'click', () => jump(false)); listen(last, 'click', () => jump(true));
    for (const event of [grid.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED, grid.EVENTS.GRID_STATE_CHANGED]) subscriptions.push(grid.subscribe(event, () => {
      const id = grid.getActiveViewportId(); if (selected !== id) { haltAll(); selected = id; }
      records.forEach((r, key) => { const v = viewport(key); if (!v || r.signature !== signature(v)) halt(key); }); render();
    }));
    subscriptions.push(cine.subscribe(cine.EVENTS.CINE_STATE_CHANGED, () => {
      const enabled = cine.getState().isCineEnabled, closing = wasEnabled && !enabled; wasEnabled = enabled;
      if (closing) { rangeShown=undefined;haltAll(); } if (!halting) render();
    }));
    const end = () => { haltAll(); ended = true; panel.style.display = 'none'; };
    listen(document, 'visibilitychange', () => { if (document.hidden) haltAll(); });
    listen(window, 'pagehide', end);
    listen(window, 'kin-volume-cine-target-ended', () => { records.forEach((_,id)=>{if(viewport(id)?.type==='orthographic')halt(id);});render(); });

    try { channel = kinViewerOnEnd(end); } catch (_) {}
    const timer = setInterval(render, 250); selected = grid.getActiveViewportId(); render();
    dispose = () => { end(); clearInterval(timer); listeners.forEach(off => off()); subscriptions.forEach(s => s.unsubscribe()); channel?.close(); cine.playClip = nativePlay; cine.stopClip = nativeStop; panel.remove();
      if (handler.getDisplaySetsFromSeries === createDisplaySets) handler.getDisplaySetsFromSeries = nativeDisplaySets;
    };
  }
  return { id: 'kin.cine', preRegistration({ servicesManager, extensionManager }) { services = servicesManager.services; extensions = extensionManager; }, onModeEnter: mount, onModeExit() { dispose?.(); dispose = null; } };
}
