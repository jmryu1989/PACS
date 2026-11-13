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
    magnification: '00700103', annotations: '00700001', layer: '00700002', texts: '00700008', boxUnits: '00700003',
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

  // One presentation state, or null when the JSON is not a GSPS.
  function parse(json) {
    if (!json || typeof json !== 'object') return null;
    const sop = string(json, T.sop), sopClass = string(json, T.sopClass);
    if (!UID.test(sop) || (sopClass && sopClass !== GSPS_CLASS) || (!sopClass && string(json, T.modality) !== 'PR')) return null;
    const images = sequence(json, T.referencedSeries).flatMap(series => references(series) || []);
    if (!images.length) return null;
    const date = string(json, T.createdDate).replace(/\D/g, ''), time = string(json, T.createdTime).replace(/[^\d.]/g, '');
    const voi = sequence(json, T.softcopyVoi).map(item => ({ refs: references(item), center: number(item, T.windowCenter), width: number(item, T.windowWidth) }))
      .filter(item => item.center !== null && item.width !== null && item.width >= 1);
    const area = sequence(json, T.displayedArea).map(item => {
      const tl = numbers(item, T.areaTopLeft), br = numbers(item, T.areaBottomRight);
      return { refs: references(item), tl: tl?.length === 2 ? tl : null, br: br?.length === 2 ? br : null,
        mode: string(item, T.sizeMode).toUpperCase() || 'SCALE TO FIT', magnification: number(item, T.magnification) };
    }).filter(item => item.tl && item.br && item.br[0] >= item.tl[0] && item.br[1] >= item.tl[1]);
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
      voi: voi && { center: voi.center, width: voi.width },
      invert: p.invert,
      rotation: p.rotation, horizontalFlip: p.horizontalFlip,
      // The displayed area's pixels are 1-based and inclusive: from the corner of the top left one to the far corner
      // of the bottom right one.
      area: area && { from: [area.tl[0] - 1, area.tl[1] - 1], to: [area.br[0], area.br[1]], mode: area.mode, magnification: area.magnification },
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

  root.KinGsps = { GSPS_CLASS, parse, latest, forImage, outline };
  if (typeof module === 'object' && module.exports) module.exports = root.KinGsps;
})(typeof globalThis === 'object' ? globalThis : this);
