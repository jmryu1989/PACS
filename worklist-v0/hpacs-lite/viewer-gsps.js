// Grayscale Softcopy Presentation State (GSPS) reading: what a stored presentation state says for one image, read from
// its DICOM JSON (as DICOMweb returns it). Pure: no viewer, no network. The viewer side (viewer-features-view.js)
// fetches the presentation states of a study, picks the latest one for the shown image and applies the result.
(function (root) {
  'use strict';
  const GSPS_CLASS = '1.2.840.10008.5.1.4.1.1.11.1';
  const UID = /^\d+(?:\.\d+)+$/;
  const T = {
    sopClass: '00080016', sop: '00080018', modality: '00080060', instanceNumber: '00200013', label: '00700080',
    createdDate: '00700082', createdTime: '00700083', referencedSeries: '00081115', referencedImages: '00081140',
    referencedSop: '00081155', referencedFrames: '00081160', softcopyVoi: '00283110', windowCenter: '00281050',
    windowWidth: '00281051', lutShape: '20500020', rotation: '00700042', horizontalFlip: '00700041',
    displayedArea: '0070005A', areaTopLeft: '00700052', areaBottomRight: '00700053', sizeMode: '00700100',
    magnification: '00700103', presentationSpacing: '00700101', presentationAspect: '00700102',
    voiLut: '00283010', lutDescriptor: '00283002', lutData: '00283006', annotations: '00700001', layer: '00700002', texts: '00700008', boxUnits: '00700003',
    anchorUnits: '00700004', text: '00700006', boxTopLeft: '00700010', boxBottomRight: '00700011', anchor: '00700014',
    graphics: '00700009', graphicUnits: '00700005', graphicData: '00700022', graphicType: '00700023', filled: '00700024',
  };
  const values = (item, tag) => { const value = item?.[tag]?.Value; return Array.isArray(value) ? value : []; };
  const first = (item, tag) => values(item, tag)[0];
  const string = (item, tag) => { const value = first(item, tag); return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''; };
  const number = (item, tag, index = 0) => { const value = Number(values(item, tag)[index]); return values(item, tag).length > index && Number.isFinite(value) ? value : null; };
  const numbers = (item, tag) => { const list = values(item, tag).map(Number); return list.length && list.every(Number.isFinite) ? list : null; };
  const sequence = (item, tag) => values(item, tag).filter(entry => entry && typeof entry === 'object');

  // The images an item names (Referenced Image Sequence): null when the item names none (it then applies to every
  // image the presentation state names).
  function references(item) {
    const list = sequence(item, T.referencedImages);
    if (!list.length) return null;
    return list.map(entry => ({ sop: string(entry, T.referencedSop), frames: numbers(entry, T.referencedFrames) })).filter(entry => UID.test(entry.sop));
  }
  const names = (refs, sop, frame) => refs === null || refs.some(entry => entry.sop === sop && (!entry.frames || entry.frames.includes(frame)));

  // A VOI LUT (0028,3010) item: { first, bits, data } with every entry read, or { unreadable: true }. The data comes as
  // numbers or as InlineBinary (16-bit little endian when Bits > 8, else 8-bit); a table only named by a bulk data
  // URI is not read here.
  function lut(item) {
    const descriptor = values(item, T.lutDescriptor).map(Number);
    if (descriptor.length !== 3 || !descriptor.every(Number.isFinite)) return { unreadable: true };
    const count = descriptor[0] === 0 ? 65536 : descriptor[0], first = descriptor[1], bits = descriptor[2];
    if (!(bits >= 8 && bits <= 16)) return { unreadable: true };
    let data = values(item, T.lutData).map(Number);
    const inline = item?.[T.lutData]?.InlineBinary;
    if (!data.length && typeof inline === 'string') {
      try {
        const bytes = Uint8Array.from(atob(inline), c => c.charCodeAt(0));
        data = bits > 8 || bytes.length === count * 2 ? Array.from({ length: bytes.length >> 1 }, (_, i) => bytes[2 * i] | bytes[2 * i + 1] << 8) : Array.from(bytes);
      } catch (_) { return { unreadable: true }; }
    }
    if (data.length !== count || !data.every(Number.isFinite)) return { unreadable: true };
    return { first, bits, data };
  }

  // The frame number (1-based) an image id names, as the DICOMweb frame URL (or a frame parameter) says; 1 for a
  // single-frame object; null when a multi-frame object's id names no frame.
  function frameOf(imageId, numberOfFrames) {
    const text = String(imageId || ''), match = /\/frames\/(\d+)(?:$|[/?#])/.exec(text) || /[?&]frame=(\d+)/.exec(text);
    if (match) return Number(match[1]) || null;
    return Number(numberOfFrames) > 1 ? null : 1;
  }

  // One presentation state, or null when the JSON is not a GSPS.
  function parse(json) {
    if (!json || typeof json !== 'object') return null;
    const sop = string(json, T.sop), sopClass = string(json, T.sopClass);
    if (!UID.test(sop) || (sopClass && sopClass !== GSPS_CLASS) || (!sopClass && string(json, T.modality) !== 'PR')) return null;
    const images = sequence(json, T.referencedSeries).flatMap(series => references(series) || []);
    if (!images.length) return null;
    const date = string(json, T.createdDate).replace(/\D/g, ''), time = string(json, T.createdTime).replace(/[^\d.]/g, '');
    // A window (Window Center/Width) or a stored table (VOI LUT Sequence); an item with neither stays, unreadable, so
    // the viewer does not take another item's window for it.
    const voi = sequence(json, T.softcopyVoi).map(item => {
      const center = number(item, T.windowCenter), width = number(item, T.windowWidth), table = sequence(item, T.voiLut)[0];
      if (center !== null && width !== null && width >= 1) return { refs: references(item), center, width };
      return { refs: references(item), lut: table ? lut(table) : { unreadable: true } };
    });
    // The corners are the displayed image's top left and bottom right after its rotation and flip, written in the
    // stored image's pixels: either may be the larger number.
    const area = sequence(json, T.displayedArea).map(item => {
      const tl = numbers(item, T.areaTopLeft), br = numbers(item, T.areaBottomRight);
      const spacing = numbers(item, T.presentationSpacing), aspect = numbers(item, T.presentationAspect);
      return { refs: references(item), tl: tl?.length === 2 ? tl : null, br: br?.length === 2 ? br : null,
        mode: string(item, T.sizeMode).toUpperCase() || 'SCALE TO FIT', magnification: number(item, T.magnification),
        // Row spacing over column spacing of the presented pixels, when the presentation state gives one.
        aspect: spacing?.length === 2 && spacing[0] > 0 && spacing[1] > 0 ? spacing[0] / spacing[1] : aspect?.length === 2 && aspect[0] > 0 && aspect[1] > 0 ? aspect[0] / aspect[1] : null };
    }).filter(item => item.tl && item.br);
    const annotations = sequence(json, T.annotations).map(item => ({
      refs: references(item), layer: string(item, T.layer),
      graphics: sequence(item, T.graphics).map(graphic => {
        const data = numbers(graphic, T.graphicData), points = [];
        if (data) for (let i = 0; i + 1 < data.length; i += 2) points.push([data[i], data[i + 1]]);
        return { units: string(graphic, T.graphicUnits).toUpperCase(), type: string(graphic, T.graphicType).toUpperCase(), points, filled: string(graphic, T.filled).toUpperCase() === 'Y' };
      }).filter(graphic => ['PIXEL', 'DISPLAY'].includes(graphic.units) && ['POINT', 'POLYLINE', 'INTERPOLATED', 'CIRCLE', 'ELLIPSE'].includes(graphic.type) && graphic.points.length),
      texts: sequence(item, T.texts).map(text => {
        const tl = numbers(text, T.boxTopLeft), br = numbers(text, T.boxBottomRight), anchor = numbers(text, T.anchor);
        return { text: values(text, T.text).join('\\').slice(0, 1024), box: tl?.length === 2 && br?.length === 2 ? { tl, br } : null,
          boxUnits: string(text, T.boxUnits).toUpperCase(), anchor: anchor?.length === 2 ? anchor : null, anchorUnits: string(text, T.anchorUnits).toUpperCase() };
      }).filter(text => text.text && (text.box || text.anchor)),
    }));
    const rotation = number(json, T.rotation), shape = string(json, T.lutShape).toUpperCase();
    return {
      sop, label: string(json, T.label), created: (date.padEnd(8, '0') + time.split('.')[0].padEnd(6, '0')).slice(0, 14) + (time.includes('.') ? '.' + time.split('.')[1] : ''),
      instanceNumber: number(json, T.instanceNumber), images,
      voi, invert: shape === 'INVERSE' ? true : shape === 'IDENTITY' ? false : null,
      rotation: [0, 90, 180, 270].includes(rotation) ? rotation : null,
      horizontalFlip: json[T.horizontalFlip] ? string(json, T.horizontalFlip).toUpperCase() === 'Y' : null,
      area, annotations,
    };
  }

  // The latest presentation state that names this image (and frame, 1-based), or null.
  function latest(presentations, sop, frame = 1) {
    const list = (presentations || []).filter(p => p && p.images.some(entry => entry.sop === sop && (!entry.frames || entry.frames.includes(frame))));
    list.sort((a, b) => b.created.localeCompare(a.created) || (b.instanceNumber ?? 0) - (a.instanceNumber ?? 0) || b.sop.localeCompare(a.sop));
    return list[0] || null;
  }

  // What a presentation state says for one image. Coordinates are DICOM image coordinates: 0\0 is the top left corner
  // of the top left pixel, Columns\Rows the bottom right corner of the last one. The spatial transformation is the
  // standard's order: the rotation, then a horizontal flip of the rotated image.
  function forImage(p, sop, frame = 1) {
    // An item without its own image list applies to the images the presentation state names, and to no other.
    if (!p || !names(p.images, sop, frame)) return null;
    const voi = p.voi.find(item => names(item.refs, sop, frame)) || null;
    const area = p.area.find(item => names(item.refs, sop, frame)) || null;
    const annotations = p.annotations.filter(item => names(item.refs, sop, frame));
    return {
      sop: p.sop, label: p.label,
      voi: !voi ? null : voi.lut ? (voi.lut.unreadable ? { unreadable: true } : { lut: voi.lut }) : { center: voi.center, width: voi.width },
      invert: p.invert,
      rotation: p.rotation, horizontalFlip: p.horizontalFlip,
      // The displayed area's pixels are 1-based and inclusive: from the outer corner of the smaller-numbered pixel to the
      // far corner of the larger one, on each axis.
      area: area && { from: [Math.min(area.tl[0], area.br[0]) - 1, Math.min(area.tl[1], area.br[1]) - 1], to: [Math.max(area.tl[0], area.br[0]), Math.max(area.tl[1], area.br[1])],
        mode: area.mode, magnification: area.magnification, aspect: area.aspect },
      graphics: annotations.flatMap(item => item.graphics.map(graphic => ({ ...graphic, layer: item.layer }))),
      texts: annotations.flatMap(item => item.texts.map(text => ({ ...text, layer: item.layer }))),
    };
  }

  // The points of a graphic as a closed or open outline to draw (CIRCLE: centre + a point on it; ELLIPSE: the ends
  // of the major then the minor axis), each as [x, y] in the graphic's own units.
  function outline(graphic, steps = 48) {
    const p = graphic.points;
    if (graphic.type === 'CIRCLE' && p.length >= 2) {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      return { closed: true, points: Array.from({ length: steps }, (_, i) => [p[0][0] + r * Math.cos(2 * Math.PI * i / steps), p[0][1] + r * Math.sin(2 * Math.PI * i / steps)]) };
    }
    if (graphic.type === 'ELLIPSE' && p.length >= 4) {
      const centre = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
      const major = [(p[1][0] - p[0][0]) / 2, (p[1][1] - p[0][1]) / 2], minorLength = Math.hypot(p[3][0] - p[2][0], p[3][1] - p[2][1]) / 2;
      const majorLength = Math.hypot(...major) || 1, unit = [major[0] / majorLength, major[1] / majorLength], normal = [-unit[1], unit[0]];
      return { closed: true, points: Array.from({ length: steps }, (_, i) => { const a = 2 * Math.PI * i / steps, c = Math.cos(a) * majorLength, s = Math.sin(a) * minorLength;
        return [centre[0] + c * unit[0] + s * normal[0], centre[1] + c * unit[1] + s * normal[1]]; }) };
    }
    if (graphic.type === 'POINT') return { closed: false, point: true, points: [p[0]] };
    const closed = p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1];
    return { closed, points: p };
  }

  root.KinGsps = { GSPS_CLASS, parse, latest, forImage, outline, frameOf };
  if (typeof module === 'object' && module.exports) module.exports = root.KinGsps;
})(typeof globalThis === 'object' ? globalThis : this);
