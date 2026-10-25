
// REQ-MG-03 / REQ-VIEWER-REFERENCE-PLANE -> RISK-MG-FALSE-ANATOMY:
// panes do not share patient coordinates merely because they occupy one tool group.
function kinCreateMGReferenceLines() {
  let services, stop;
  function mount() {
    stop?.();
    const core = window.cornerstone, manager = window.cornerstoneTools.ToolGroupManager;
    const groups = new Set(), tools = new Set(), restores = [];
    function instance(viewport) {
      const imageId = viewport?.getCurrentImageId?.();
      return imageId ? core.metaData.get('instance', imageId) : null;
    }
    function storedPlane(image) {
      // imagePlaneModule already contains OHIF's fallback plane. The instance for
      // the displayed frame is also the native provider's input, before defaults.
      // DICOM DS values may remain numeric strings in the served instance.
      const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') &&
        Number.isFinite(Number(value));
      return [[image?.ImageOrientationPatient, 6], [image?.ImagePositionPatient, 3]]
        .every(([values, length]) => Array.isArray(values) && values.length === length && values.every(numeric));
    }
    function side(image) {
      const values = [image?.ImageLaterality, image?.Laterality, image?.FrameLaterality];
      const anatomy = group => {
        const sequence = group?.FrameAnatomySequence;
        values.push((Array.isArray(sequence) ? sequence[0] : sequence)?.FrameLaterality);
      };
      anatomy(image);
      const shared = image?.SharedFunctionalGroupsSequence;
      anatomy(Array.isArray(shared) ? shared[0] : shared);
      const frames = image?.PerFrameFunctionalGroupsSequence;
      if (Array.isArray(frames)) frames.forEach(anatomy);
      const known = values.filter(Boolean);
      return known.length && ['R', 'L'].includes(known[0]) && known.every(value => value === known[0]) ? known[0] : null;
    }
    function wrap(tool) {
      if (!tool || tools.has(tool)) return;
      tools.add(tool);
      const render = tool.renderAnnotation;
      const wrapped = function (enabledElement, svgDrawingHelper) {
        // editData names the plane actually used by the native renderer. Reading current
        // images here also covers pane replacement, scrolling and active-pane changes.
        const sourceViewport = core.getEnabledElementByViewportId(this.editData?.sourceViewportId)?.viewport;
        const source = instance(sourceViewport), target = instance(enabledElement.viewport);
        if (!storedPlane(source) || !storedPlane(target) ||
            !source.FrameOfReferenceUID || source.FrameOfReferenceUID !== target.FrameOfReferenceUID ||
            !source.StudyInstanceUID || source.StudyInstanceUID !== target.StudyInstanceUID) return false;
        if (source?.Modality === 'MG' || target?.Modality === 'MG') {
          const sourceSide = side(source);
          if (source?.Modality !== 'MG' || target?.Modality !== 'MG' ||
              !sourceSide || sourceSide !== side(target)) return false;
        }
        return render.call(this, enabledElement, svgDrawingHelper);
      };
      tool.renderAnnotation = wrapped;
      restores.push(() => { if (tool.renderAnnotation === wrapped) tool.renderAnnotation = render; });
    }
    function attach(group) {
      if (!group || groups.has(group)) return;
      groups.add(group);
      const add = group.addTool;
      const wrapped = function (name, ...args) {
        const result = add.call(this, name, ...args);
        if (name === 'ReferenceLines') wrap(this.getToolInstance(name));
        return result;
      };
      group.addTool = wrapped;
      restores.push(() => { if (group.addTool === wrapped) group.addTool = add; });
      if (group.hasTool('ReferenceLines')) wrap(group.getToolInstance('ReferenceLines'));
    }
    const service = services.toolGroupService;
    const subscription = service.subscribe(service.EVENTS.TOOLGROUP_CREATED,
      event => attach(manager.getToolGroup(event.toolGroupId)));
    manager.getAllToolGroups().forEach(attach);
    stop = () => { subscription.unsubscribe(); restores.reverse().forEach(restore => restore()); };
  }
  return { id: 'kin.mg-reference-lines', preRegistration({ servicesManager }) {
    services = servicesManager.services;
  }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
