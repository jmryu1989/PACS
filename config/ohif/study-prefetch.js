
function kinCreateStudyPrefetch() {
  let stop;
  function mount() {
    stop?.();
    const core = window.cornerstone, prefetch = window.cornerstoneTools.utilities.stackContextPrefetch;
    const enable = prefetch.enable, elements = new Set();
    const type = core.Enums.RequestType.Prefetch;
    function clearQueued(imageIds) {
      const keep = request => request.requestType !== type ||
        (imageIds && !imageIds.has(request.additionalDetails?.imageId));
      core.imageLoadPoolManager.filterRequests(keep);
      core.imageRetrievalPoolManager.filterRequests(keep);
    }
    const wrapped = function (element) {
      const viewport = core.getEnabledElement(element)?.viewport;
      const imageIds = viewport?.getImageIds?.() || [];
      const instance = imageIds.length ? core.metaData.get('instance', imageIds[0]) : null;
      // The pinned context prefetch fills a quarter of the cache after its initial neighbours.
      // Large DBT requests remain queued in Orthanc even after navigation. Load DBT on demand.
      if (instance?.Modality === 'MG' && Number(instance.NumberOfFrames) > 1) {
        prefetch.disable(element); clearQueued(new Set(imageIds)); return;
      }
      elements.add(element);
      return enable.call(this, element);
    };
    prefetch.enable = wrapped;
    const leave = () => {
      for (const element of elements) prefetch.disable(element);
      elements.clear(); clearQueued();
    };
    window.addEventListener('pagehide', leave);
    stop = () => {
      leave(); window.removeEventListener('pagehide', leave);
      if (prefetch.enable === wrapped) prefetch.enable = enable;
    };
  }
  return { id: 'kin.study-prefetch', onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
