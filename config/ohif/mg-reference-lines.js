
// REQ-MG-03 -> RISK-MG-FALSE-ANATOMY: breast views and priors do not share a
// patient coordinate system merely because they occupy the same tool group.
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
        if (source?.Modality === 'MG' || target?.Modality === 'MG') {
          if (source?.Modality !== 'MG' || target?.Modality !== 'MG' ||
              !source.FrameOfReferenceUID || source.FrameOfReferenceUID !== target.FrameOfReferenceUID ||
              !source.StudyInstanceUID || source.StudyInstanceUID !== target.StudyInstanceUID ||
              !side(source) || side(source) !== side(target)) return false;
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
