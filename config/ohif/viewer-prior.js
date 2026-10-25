// U3 consumes the U2 document/viewport context. The native data source still
// owns DICOM loading and display-set creation; reports are API reads only.
function kinCreateViewerPrior() {
  let services, extensions, generation = 0, ready, dispose, frame;
  const assets = ['viewer-prior-controller.js', 'viewer-prior-panel.js'];
  function load() {
    return ready ||= assets.reduce((previous, name) => previous.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('이전 검사 모듈을 불러오지 못했습니다.')); };
      document.head.append(script);
    })), Promise.resolve()).catch(error => { ready = null; throw error; });
  }
  function stop() { generation++; cancelAnimationFrame(frame); dispose?.(); dispose = null; }
  function mount(viewer) {
    const host = document.createElement('section'); host.hidden = true; host.dataset.kinUxOwned = '';
    host.className = 'kin-viewer-prior-list';
    const style = document.createElement('style');
    style.textContent = `.kin-viewer-prior-list{position:absolute;right:0;top:0;z-index:35;max-width:100%;max-height:100%;overflow:auto;background:#2D2D2D;color:#E3E3E3;border:1px solid #8AB4C8;padding:8px;font-size:12px}
      .kin-viewer-prior-list[hidden]{display:none}.kin-viewer-prior-list table{border-collapse:collapse;width:100%}.kin-viewer-prior-list th,.kin-viewer-prior-list td{padding:4px;text-align:left;border-bottom:1px solid #555}
      .kin-viewer-prior-list button,.kin-viewer-prior-report button{background:#212121;color:#E3E3E3;border:1px solid #8AB4C8;padding:4px;cursor:pointer}.kin-viewer-prior-list tr:focus-within,.kin-viewer-prior-list tbody tr:hover{background:#3b4c54}
      .kin-viewer-prior-report{z-index:36;overflow:auto}.kin-viewer-prior-report p{overflow-wrap:anywhere}`;
    document.head.append(style);
    let anchor = null, reportOpener = null, reportUid = null, listOpen = false;
    const closeList = () => { controller.close(); if (anchor?.isConnected) anchor.focus(); };
    const report = (uid, opener) => { reportUid = uid; reportOpener = opener; controller.openReport(uid); };
    const controller = window.KinViewerPriorController.create({ viewer,
      async loadStudy(uid) {
        const source = extensions.getActiveDataSource()[0];
        try { await source.retrieve.series.metadata({ StudyInstanceUID: uid, madeInClient: true }); }
        catch (error) {
          // The pinned loader caches failed metadata promises. A user's Retry
          // must reach the data source again rather than replay that failure.
          source.deleteStudyMetadataPromise(uid); throw error;
        }
        return services.displaySetService.getActiveDisplaySets().filter(set => set.StudyInstanceUID === uid && set.images?.length)
          .sort((a, b) => Number(a.SeriesNumber || 0) - Number(b.SeriesNumber || 0) || a.SeriesInstanceUID.localeCompare(b.SeriesInstanceUID));
      },
      onList(value) {
        listOpen = value.state !== 'closed';
        window.KinViewerPriorPanel.list(host, value, { openImages: uid => controller.openImages(uid),
          openReport: report, retry: () => controller.retryList(), close: closeList });
      },
      onReport(value) {
        if (value.state === 'closed') { viewer.reportHost.close({ notify: false }); host.hidden = !listOpen; return; }
        // Collapse the dropdown while its report covers the image. Keep its
        // rows so Close can restore the exact keyboard opener.
        host.hidden = true;
        viewer.reportHost.render(value.origin, (container, controls) => window.KinViewerPriorPanel.report(container, value, controls),
          { opener: reportOpener, onClose: () => controller.closeReport(), onRetry: () => controller.openReport(reportUid) });
      },
    });
    host.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeList(); } };
    const unregister = viewer.registerStudyActions({
      listPriors(value) {
        anchor = value.anchor;
        const pane = anchor.closest('[data-cy="viewport-pane"]');
        if (!pane) return;
        pane.append(host);
        // The list starts immediately below the cell's Study information bar.
        host.style.top = anchor.closest('.kin-viewer-info-bar').offsetHeight + 'px';
        host.style.maxHeight = 'calc(100% - ' + host.style.top + ')';
        controller.open(value);
      },
      openImages: controller.openImages, openReport: report, refresh: controller.refresh,
    });
    const channel = kinViewerOnEnd(stop);
    return () => { channel?.close(); unregister(); controller.dispose(); host.remove(); style.remove(); };
  }
  return {
    id: 'kin.viewer-prior',
    preRegistration({ servicesManager, extensionManager }) { services = servicesManager.services; extensions = extensionManager; },
    onModeEnter() {
      stop(); if (window.top !== window) return;
      const ticket = generation;
      load().then(() => {
        const attach = () => {
          if (ticket !== generation || kinViewerSession.ended()) return;
          if (window.KinViewerUX) dispose = mount(window.KinViewerUX);
          else frame = requestAnimationFrame(attach);
        };
        attach();
      }).catch(error => { if (ticket === generation) services.uiNotificationService?.show({ title: 'Studies', message: error.message, type: 'error' }); });
    },
    onModeExit: stop,
  };
}

