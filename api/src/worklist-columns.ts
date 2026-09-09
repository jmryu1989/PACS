// Persist column identifiers only, never cell values, filters or report content.
export const COLUMN_KEYS = {
  Radiology: ['pf','techNote','no','viewing','count','series','em','ss','rs','acc','ts','id','name','age','birth','sex','modality','desc','date','preDoc','preReviewer'],
  Technician: ['techNote','no','count','series','em','ss','matched','rs','acc','id','name','age','sex','modality','desc','date','ward','reqHosp'],
};

export function normalizeWorklistColumns(value: any) {
  const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || value.version !== 1 || Object.keys(value).sort().join() !== 'modes,version' ||
      !object(value.modes) || Object.keys(value.modes).sort().join() !== 'Radiology,Technician' ||
      JSON.stringify(value).length > 8192) return null;
  const clean = { version: 1, modes: {} };
  for (const [mode, keys] of Object.entries(COLUMN_KEYS)) {
    const part = value.modes[mode];
    if (!object(part) || !['hidden,order','appearance,hidden,order'].includes(Object.keys(part).sort().join())) return null;
    for (const name of ['order', 'hidden']) {
      const list = part[name];
      if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length ||
          list.some(k => typeof k !== 'string' || !keys.includes(k))) return null;
    }
    if (part.hidden.some(k => k === 'id' || k === 'name')) return null;
    clean.modes[mode] = { order: [...part.order, ...keys.filter(k => !part.order.includes(k))], hidden: [...part.hidden] };
    if (Object.prototype.hasOwnProperty.call(part, 'appearance')) {
      const a = part.appearance;
      if (!object(a) || Object.keys(a).sort().join() !== 'color,font,size,widths' ||
          !['default','cool','warm'].includes(a.color) || !['default','sans','mono'].includes(a.font) ||
          !Number.isInteger(a.size) || a.size < 12 || a.size > 20 || !object(a.widths) ||
          Object.entries(a.widths).some(([k,w]) => !keys.includes(k) || !Number.isInteger(w) || Number(w) < 64 || Number(w) > 600)) return null;
      clean.modes[mode].appearance = { widths: { ...a.widths }, font: a.font, size: a.size, color: a.color };
    }
  }
  return clean;
}
