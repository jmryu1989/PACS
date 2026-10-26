
// OHIF 3.9.1 caches DICOMweb image UIDs without a frameNumber. A cache hit then
// bypasses URL parsing, so _getInstance skips the functional groups. Other frames
// can incidentally populate the shared instance first, making frame 1 order-dependent.
function kinCreateFrameMetadata() {
  let installed = false;
  return { id: 'kin.frame-metadata', preRegistration() {
    if (installed) return;
    // The pinned Orthanc OHIF bundle exposes no MetadataProvider utility module.
    // Its @ohif/core export is shared by the data source and Cornerstone provider.
    // Keep this adapter at that boundary so native geometry, VOI and measurements
    // all consume the same frame, without copying the functional-group parser.
    window.webpackChunk.push([['kin.frame-metadata'], {}, require => {
      const provider = require(29463).Ly.MetadataProvider;
      const original = provider.getUIDsFromImageID;
      provider.getUIDsFromImageID = function (imageId) {
        const uids = original.call(this, imageId);
        if (!uids || uids.frameNumber || !imageId.startsWith('wadors:')) return uids;
        const frame = /\/frames\/([1-9]\d*)(?:$|[?#])/.exec(imageId);
        return frame ? { ...uids, frameNumber: frame[1] } : uids;
      };
      installed = true;
    }]);
  } };
}
