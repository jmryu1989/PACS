/* Selected-stack browser fullscreen. The native viewport and its clinical state stay mounted. */
(function (root) {
  'use strict';
  const uid = value => typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
  const patient = value => typeof value === 'string' && value.trim() && value.length <= 64;
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const ownership = new WeakMap();

  function create(services, options = {}) {
    const doc = options.doc || root.document, win = options.root || doc?.defaultView || root;
    const ownerOf = options.owner || (() => win.kinViewerWindowOwner?.());
    const metadata = options.metadata || (imageId => win.cornerstone?.metaData?.get('instance', imageId));
    const rendered = options.rendered || (() => win.cornerstone?.Enums?.ViewportStatus?.RENDERED || 'rendered');
    const intervalMs = options.intervalMs === 0 ? 0 : Math.max(100, Math.min(1000, options.intervalMs || 250));
    const requestTimeoutMs = Math.max(10, Math.min(10000, options.requestTimeoutMs || 10000));
    let ended = false, panel = null, open = null, status = null, active = null, timer = null, channel = null;
    const subscriptions = [], listeners = [];
    const listen = (target, event, handler, settings) => { target?.addEventListener?.(event, handler, settings); listeners.push([target, event, handler, settings]); };
    const safe = fn => { try { fn(); } catch (_) { if (active) leave('영상 화면 연결이 바뀌어 Images Only를 종료했습니다.'); else refresh(); } };
    const live = () => !ended && options.live?.() !== false;
    const owner = () => { try { const value = ownerOf(); return typeof value === 'string' && value.trim() && value.length <= 1024 ? value : null; } catch (_) { return null; } };
    const dialogs = () => !!doc.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    const busy = () => {
      try {
        return typeof win.kinViewerHistoryWorkspaceState !== 'function' || typeof win.kinViewerJobWorkspaceState !== 'function' ||
          !!win.kinViewerHistoryWorkspaceState()?.busy || !!win.kinViewerJobWorkspaceState()?.busy;
      } catch (_) { return true; }
    };
    function gridSignature(state) {
      return JSON.stringify([state.layout || null, [...state.viewports.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([id, value]) =>
        [id, value.x, value.y, value.width, value.height, value.displaySetInstanceUIDs])]);
    }
    function inspect() {
      if (!live()) throw Error('현재 영상 세션을 확인할 수 없습니다.');
      if (doc.fullscreenElement) throw Error('열려 있는 전체 화면을 종료한 뒤 다시 시도하세요.');
      const boundOwner = owner(); if (!boundOwner) throw Error('현재 영상 계정을 확인할 수 없습니다.');
      if (dialogs()) throw Error('열린 대화상자를 닫은 뒤 다시 시도하세요.');
      if (busy()) throw Error('저장 또는 영상 작업이 끝난 뒤 다시 시도하세요.');
      const grid = services?.viewportGridService, state = grid?.getState?.(), viewportId = state?.activeViewportId;
      const cell = typeof viewportId === 'string' && state?.viewports?.get?.(viewportId);
      const setIds = cell?.displaySetInstanceUIDs;
      if (!cell || !Array.isArray(setIds) || setIds.length !== 1 || !setIds[0]) throw Error('한 영상 묶음이 선택된 칸을 확인하세요.');
      const viewport = services?.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
      const displaySet = services?.displaySetService?.getDisplaySetByUID?.(setIds[0]);
      if (!viewport || viewport.type !== 'stack' || viewport.viewportStatus !== rendered() || !viewport.element?.isConnected || typeof viewport.element.requestFullscreen !== 'function') throw Error('불러온 일반 영상 칸에서만 Images Only를 사용할 수 있습니다.');
      if (ownership.has(viewport.element)) throw Error('이 영상의 전체 화면 요청이 아직 완료되지 않았습니다. 브라우저에서 요청을 취소하거나 페이지를 다시 여세요.');
      const imageIds = viewport.getImageIds?.(), current = viewport.getCurrentImageId?.();
      if (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > 2000 || new Set(imageIds).size !== imageIds.length || !imageIds.includes(current)) throw Error('선택 영상의 원본 목록을 확인할 수 없습니다.');
      if (!displaySet || displaySet.displaySetInstanceUID !== setIds[0] || !uid(displaySet.StudyInstanceUID) || !uid(displaySet.SeriesInstanceUID)) throw Error('선택 영상의 원본 식별을 확인할 수 없습니다.');
      const source = Array.isArray(displaySet.images) ? displaySet.images : Array.isArray(displaySet.instances) ? displaySet.instances : null;
      if (!source || !source.length || source.length > 2000) throw Error('선택 영상의 원본 목록이 일치하지 않습니다.');
      const values = imageIds.map(imageId => metadata(imageId));
      if (values.some(value => !value || value.StudyInstanceUID !== displaySet.StudyInstanceUID || value.SeriesInstanceUID !== displaySet.SeriesInstanceUID ||
          !uid(value.SOPInstanceUID) || !patient(value.PatientID))) throw Error('선택 영상의 환자 또는 원본 식별이 일치하지 않습니다.');
      const patientId = values[0].PatientID;
      if (values.some(value => value.PatientID !== patientId)) throw Error('선택 영상의 환자 또는 원본 식별이 일치하지 않습니다.');
      const sourceSops = source.map(value => value?.SOPInstanceUID);
      if (source.some(value => value?.StudyInstanceUID !== displaySet.StudyInstanceUID || value?.SeriesInstanceUID !== displaySet.SeriesInstanceUID || value?.PatientID !== patientId || !uid(value?.SOPInstanceUID)) ||
          new Set(sourceSops).size !== sourceSops.length || !same([...sourceSops].sort(), [...new Set(values.map(value => value.SOPInstanceUID))].sort())) throw Error('선택 영상의 원본 목록이 일치하지 않습니다.');
      const identity = [...viewport.element.querySelectorAll('.kin-viewer-identity')].find(element => element.dataset.study === displaySet.StudyInstanceUID && element.isConnected);
      if (!identity) throw Error('환자와 원본 식별 표시를 확인한 뒤 다시 시도하세요.');
      return { owner: boundOwner, viewportId, cell, viewport, element: viewport.element, displaySet, displaySetId: setIds[0],
        imageIds: [...imageIds], grid: gridSignature(state), study: displaySet.StudyInstanceUID,
        sourceIdentity: JSON.stringify([displaySet.StudyInstanceUID, displaySet.SeriesInstanceUID, patientId,
          values.map(value => [value.StudyInstanceUID, value.SeriesInstanceUID, value.PatientID, value.SOPInstanceUID]),
          source.map(value => [value.StudyInstanceUID, value.SeriesInstanceUID, value.PatientID, value.SOPInstanceUID])]) };
    }
    function matches(record) {
      try {
        if (!record || !live() || owner() !== record.owner || dialogs() || busy()) return false;
        const state = services.viewportGridService.getState(), cell = state.viewports.get(record.viewportId);
        if (cell !== record.cell || gridSignature(state) !== record.grid || services.cornerstoneViewportService.getCornerstoneViewport(record.viewportId) !== record.viewport ||
            services.displaySetService.getDisplaySetByUID(record.displaySetId) !== record.displaySet || record.viewport.element !== record.element) return false;
        const imageIds = record.viewport.getImageIds?.(), current = record.viewport.getCurrentImageId?.();
        if (!Array.isArray(imageIds) || !same(imageIds, record.imageIds) || !imageIds.includes(current)) return false;
        const source = Array.isArray(record.displaySet.images) ? record.displaySet.images : Array.isArray(record.displaySet.instances) ? record.displaySet.instances : null;
        const values = imageIds.map(imageId => metadata(imageId));
        if (!source || values.some(value => !value)) return false;
        return JSON.stringify([record.displaySet.StudyInstanceUID, record.displaySet.SeriesInstanceUID, values[0].PatientID,
          values.map(value => [value.StudyInstanceUID, value.SeriesInstanceUID, value.PatientID, value.SOPInstanceUID]),
          source.map(value => [value?.StudyInstanceUID, value?.SeriesInstanceUID, value?.PatientID, value?.SOPInstanceUID])]) === record.sourceIdentity;
      } catch (_) { return false; }
    }
    function placeExit(record) {
      const candidates = [
        ['right:12px;top:50%;transform:translateY(-50%)', 'right-middle'],
        ['left:12px;top:50%;transform:translateY(-50%)', 'left-middle'],
        ['left:50%;bottom:12px;transform:translateX(-50%)', 'bottom-middle'],
        ['left:50%;top:12px;transform:translateX(-50%)', 'top-middle'],
      ];
      const identities = [...record.element.querySelectorAll('.kin-viewer-identity,.kin-viewer-identity-content,.kin-viewer-identity-group')]
        .filter(value => value.isConnected && value.getClientRects?.().length);
      const target = record.element.getBoundingClientRect?.();
      record.exit.hidden = false;
      if (!record.exit.isConnected || target && (!target.width || !target.height)) { record.exit.hidden = true; return false; }
      for (const [position, name] of candidates) {
        record.exit.style.cssText = 'position:absolute;z-index:1000;padding:8px 12px;border:1px solid #9cc3ff;border-radius:4px;background:#0b182b;color:#fff;' + position;
        const box = record.exit.getBoundingClientRect?.();
        if (box && (!box.width || !box.height)) continue;
        const outside = box && target && target.width && target.height && (box.left < target.left || box.right > target.right || box.top < target.top || box.bottom > target.bottom);
        if (!outside && (!box || !identities.some(value => { const other = value.getBoundingClientRect(); return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top; }))) {
          record.exit.dataset.position = name; return true;
        }
      }
      record.exit.hidden = true; return false;
    }
    function removeExit(record) {
      if (!record) return;
      if (record.exit?.dataset.kinImagesOnly === record.token) record.exit.remove();
    }
    function release(record) {
      if (!record) return;
      if (record.requestTimer) win.clearTimeout(record.requestTimer);
      if (record.placementTimer) win.clearTimeout(record.placementTimer);
      record.requestTimer = record.placementTimer = null; record.pending = false;
      if (ownership.get(record.element) === record) ownership.delete(record.element);
    }
    function exitFailed(record) {
      if (ownership.get(record.element) !== record) return;
      record.exitMessage = '';
      if (doc.fullscreenElement !== record.element) { finish(record); return; }
      if (record.exit?.dataset.kinImagesOnly === record.token) {
        record.exit.textContent = 'Exit Images Only · Retry · 종료 요청이 거절되었습니다.';
        record.exit.style.background = '#431414';
        if (!placeExit(record)) {
          record.placementBlocked = true;
          record.exit.textContent = 'Exit Images Only · Retry · 종료 거절';
          if (!placeExit(record) && status && live()) status.textContent = '안전한 Exit 위치가 없습니다. Esc로 전체 화면을 종료한 뒤 영상 배치를 확인하세요.';
        }
      }
    }
    function finish(record, message) {
      release(record); removeExit(record); if (active === record) active = null;
      if (status && live()) status.textContent = message || 'Images Only를 종료했습니다.';
      refresh();
    }
    function exitOwned(record, message) {
      if (!record || ownership.get(record.element) !== record) return;
      record.exitMessage = message || '';
      if (doc.fullscreenElement === record.element) {
        try { Promise.resolve(doc.exitFullscreen()).then(() => {
          if (ownership.get(record.element) !== record) return;
          if (doc.fullscreenElement !== record.element) finish(record, message); else exitFailed(record);
        }, () => { if (ownership.get(record.element) === record) exitFailed(record); }); }
        catch (_) { exitFailed(record); }
      } else if (record.pending) {
        record.cancelled = true; removeExit(record); if (active === record) active = null;
        if (status && live()) status.textContent = message || '전체 화면 요청이 끝날 때까지 기다려 주세요.';
        refresh();
      } else finish(record, message);
    }
    function leave(message) { const record = active; if (record) exitOwned(record, message); }
    function shieldExit(record) {
      const block = event => {
        const current = ownership.get(record.element);
        if (current && current !== record) return;
        if (event.target === record.exit || record.exit?.contains?.(event.target)) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
      };
      const events = ['pointerdown', 'mousedown', 'click', 'dblclick'];
      events.forEach(event => record.element.addEventListener(event, block, true));
      win.setTimeout(() => events.forEach(event => record.element.removeEventListener(event, block, true)), 400);
    }
    function ensurePlacement(record, force) {
      if (ownership.get(record.element) !== record || doc.fullscreenElement !== record.element) return;
      const now = Date.now(), wait = 250 - (now - (record.lastPlacement || 0));
      if (!force && wait > 0) {
        if (!record.placementTimer) record.placementTimer = win.setTimeout(() => {
          record.placementTimer = null;
          if (active === record) ensurePlacement(record, true);
        }, wait);
        return;
      }
      record.lastPlacement = now;
      if (record.placementBlocked) {
        if (placeExit(record)) {
          record.placementBlocked = false;
          if (status && live()) status.textContent = 'Images Only · Esc 또는 Exit Images Only로 돌아갑니다.';
        }
      } else if (!placeExit(record)) {
        record.placementBlocked = true;
        exitOwned(record, '환자와 원본 식별 표시를 가리지 않는 위치가 없어 Images Only를 종료했습니다.');
      }
    }
    function observe() {
      if (!active) { refresh(); return; }
      if (!matches(active)) exitOwned(active, '영상 화면 연결이 바뀌어 Images Only를 종료했습니다.');
      else ensurePlacement(active, false);
    }
    function refresh() {
      if (!open) return;
      let reason = '';
      try { if (!active) inspect(); } catch (error) { reason = error.message; }
      open.disabled = ended || !!active || !!reason;
      open.title = reason || '선택한 영상 칸만 브라우저 전체 화면으로 표시합니다.';
      if (!active && reason && status) status.textContent = reason;
    }
    function enter() {
      if (active) return;
      let record;
      try { record = inspect(); } catch (error) { status.textContent = error.message; refresh(); return; }
      const exit = doc.createElement('button'); exit.type = 'button'; exit.id = 'kin-images-only-exit'; exit.textContent = 'Exit Images Only';
      exit.dataset.kinImagesOnly = record.token = String(Date.now()) + ':' + Math.random();
      for (const event of ['pointerdown', 'mousedown', 'touchstart']) exit.addEventListener(event, value => { value.preventDefault(); value.stopPropagation(); }, true);
      exit.addEventListener('click', value => {
        value.preventDefault(); value.stopPropagation();
        if (ownership.get(record.element) !== record) return;
        record.placementBlocked = false; shieldExit(record); exitOwned(record);
      }, true);
      record.exit = exit; record.element.append(exit);
      if (!placeExit(record)) { removeExit(record); status.textContent = '환자와 원본 식별 표시를 가리지 않는 위치를 확보한 뒤 다시 시도하세요.'; refresh(); return; }
      record.pending = true; active = record; ownership.set(record.element, record); refresh();
      record.requestTimer = win.setTimeout(() => {
        if (ownership.get(record.element) !== record || !record.pending) return;
        record.timedOut = true;
        if (doc.fullscreenElement === record.element && active === record && matches(record)) {
          record.pending = false; status.textContent = 'Images Only · Esc 또는 Exit Images Only로 돌아갑니다.';
        } else if (status && live()) status.textContent = '전체 화면 요청이 아직 완료되지 않았습니다. 브라우저에서 요청을 취소하거나 페이지를 다시 여세요.';
      }, requestTimeoutMs);
      let request;
      try { request = record.element.requestFullscreen(); }
      catch (error) { if (doc.fullscreenElement === record.element) exitFailed(record); else finish(record, '브라우저가 Images Only 요청을 허용하지 않았습니다.'); return; }
      Promise.resolve(request).then(() => {
        if (record.requestTimer) win.clearTimeout(record.requestTimer); record.requestTimer = null;
        if (ownership.get(record.element) !== record) return;
        record.pending = false;
        if (record.cancelled || ended || active !== record || !matches(record) || doc.fullscreenElement !== record.element) exitOwned(record, '영상 화면 연결이 바뀌어 Images Only를 종료했습니다.');
        else { status.textContent = 'Images Only · Esc 또는 Exit Images Only로 돌아갑니다.'; refresh(); }
      }, () => {
        if (record.requestTimer) win.clearTimeout(record.requestTimer); record.requestTimer = null;
        if (ownership.get(record.element) !== record) return;
        record.pending = false;
        if (active === record) {
          if (doc.fullscreenElement === record.element) exitFailed(record);
          else finish(record, '브라우저가 Images Only 요청을 허용하지 않았습니다.');
        } else if (doc.fullscreenElement === record.element) exitOwned(record);
        else finish(record);
      });
    }
    function fullscreenChanged() {
      if (!active) return;
      if (doc.fullscreenElement === active.element) {
        if (!matches(active)) exitOwned(active, '영상 화면 연결이 바뀌어 Images Only를 종료했습니다.');
        else ensurePlacement(active, true);
      }
      else finish(active, active.exitMessage || 'Images Only를 종료했습니다.');
    }
    function end() {
      if (ended) return; ended = true;
      const record = active; active = null;
      if (record && (doc.fullscreenElement === record.element || record.pending)) exitOwned(record);
      else { release(record); removeExit(record); }
      if (timer) win.clearInterval(timer); timer = null;
      subscriptions.splice(0).forEach(item => { try { item?.unsubscribe?.(); } catch (_) {} });
      listeners.splice(0).forEach(([target, event, handler, settings]) => target?.removeEventListener?.(event, handler, settings));
      channel?.close?.(); channel = null; panel?.remove(); panel = open = status = null;
    }
    function mount(host = doc.getElementById('kin-viewer-layout')) {
      if (ended || panel || !host?.isConnected) return false;
      panel = doc.createElement('section'); panel.id = 'kin-images-only';
      open = doc.createElement('button'); open.type = 'button'; open.id = 'kin-images-only-enter'; open.textContent = 'Images Only'; open.addEventListener('click', enter); panel.append(open);
      status = doc.createElement('p'); status.id = 'kin-images-only-status'; status.setAttribute('role', 'status'); panel.append(status); host.append(panel);
      listen(doc, 'fullscreenchange', () => safe(fullscreenChanged));
      listen(win, 'storage', event => { if (event.key === 'kin-session-ended') end(); });
      listen(win, 'pagehide', end);
      try { channel = new win.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') end(); }; } catch (_) {}
      for (const service of [services?.viewportGridService, services?.displaySetService]) for (const event of new Set(Object.values(service?.EVENTS || {}))) {
        try { subscriptions.push(service.subscribe(event, () => safe(observe))); } catch (_) {}
      }
      for (const event of ['PRE_STACK_NEW_IMAGE', 'STACK_NEW_IMAGE', 'IMAGE_RENDERED'].map(name => win.cornerstone?.Enums?.Events?.[name]).filter(Boolean)) listen(doc, event, () => safe(observe), true);
      if (intervalMs) timer = win.setInterval(() => safe(observe), intervalMs);
      refresh(); return true;
    }
    return { mount, stop: end };
  }
  const api = { create };
  root.KinViewerImagesOnly = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
