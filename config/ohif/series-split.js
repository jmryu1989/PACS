
// One single-frame MR series that the viewer itself marks as several time points (b values, temporal positions,
// trigger/echo times or echo numbers at the same positions) opens as one display set per time point, so each can
// sit in its own cell and Image Slice Sync can match positions. The grouping is the viewer's own 4D detection;
// anything it does not recognise, and every other series, keeps the display sets the stack handler made.
function kinSeriesSplitModel(sets, rebuild) {
  const LABELS = { DiffusionBValue: 'b', TemporalPositionIdentifier: 'Phase ', EchoTime: 'TE ', EchoNumber: 'Echo ', TriggerTime: 'TT ' };
  if (!Array.isArray(sets) || sets.length !== 1) return sets;
  const set = sets[0], images = set?.images, info = set?.dynamicVolumeInfo, groups = info?.timePoints;
  if (set.Modality !== 'MR' || set.isDynamicVolume !== true || set.isMultiFrame === true || !Array.isArray(images) ||
      !Array.isArray(groups) || groups.length < 2) return sets;
  // Every group must name images of this set, each image exactly once, and the groups must be equally long.
  const byId = new Map(images.map(image => [image?.imageId, image])), seen = new Set();
  if (byId.size !== images.length || byId.has(undefined)) return sets;
  const size = Array.isArray(groups[0]) ? groups[0].length : 0;
  const members = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== size || size < 1) return sets;
    const list = [];
    for (const id of group) {
      if (!byId.has(id) || seen.has(id)) return sets;
      seen.add(id); list.push(byId.get(id));
    }
    members.push(list);
  }
  if (seen.size !== images.length) return sets;
  const value = instance => {
    const tag = info.splittingTag, prefix = LABELS[tag];
    if (prefix === undefined || !instance) return '';
    let raw = instance[tag];
    if (raw === undefined && tag === 'EchoNumber') raw = instance.EchoNumbers;
    if (Array.isArray(raw)) raw = raw[0];
    const number = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(number) ? ' ' + prefix + number : '';
  };
  const description = String(set.SeriesDescription ?? '').trim();
  const split = [];
  try {
    for (let k = 0; k < members.length; k++) {
      const made = rebuild(members[k].slice());
      if (!Array.isArray(made) || made.length !== 1 || made[0]?.images?.length !== members[k].length) return sets;
      const part = made[0], label = `${k + 1}/${members.length}` + value(part.images[0]);
      const text = description ? `${description} · ${label}` : label;
      if (typeof part.setAttribute === 'function') part.setAttribute('SeriesDescription', text);
      else part.SeriesDescription = text;
      split.push(part);
    }
  } catch (_) {
    return sets;
  }
  return split;
}

function kinCreateSeriesSplit() {
  let extensions, dispose;
  function mount() {
    dispose?.();
    dispose = null;
    const handler = extensions.getModuleEntry('@ohif/extension-default.sopClassHandlerModule.stack');
    const previous = typeof handler?.getDisplaySetsFromSeries === 'function' ? handler.getDisplaySetsFromSeries : null;
    if (!previous) return;
    let ended = false;
    const createDisplaySets = function (instances, ...rest) {
      const sets = previous.call(this, instances, ...rest);
      // A hook left inside the chain after its mode ended passes the sets on unchanged.
      if (ended) return sets;
      return kinSeriesSplitModel(sets, members => previous.call(this, members, ...rest));
    };
    handler.getDisplaySetsFromSeries = createDisplaySets;
    dispose = () => {
      ended = true;
      if (handler.getDisplaySetsFromSeries === createDisplaySets) handler.getDisplaySetsFromSeries = previous;
    };
  }
  return { id: 'kin.series-split', preRegistration({ extensionManager }) { extensions = extensionManager; },
    onModeEnter: mount, onModeExit() { dispose?.(); dispose = null; } };
}
