// Persist column identifiers only, never cell values, filters or report content.
export const COLUMN_KEYS = {
  Radiology: ['pf','assignedReader','techNote','no','viewing','count','series','em','ss','rs','confirm','acc','ts','id','name','reqDate','reqDept','reqDoc','ptClass','age','birth','sex','modality','desc','date','preDoc','preReviewer','institutionName','time'],
  Technician: ['assignedReader','techNote','no','count','series','em','ss','matched','rs','acc','id','name','age','sex','modality','desc','date','ward','reqHosp','time'],
};

/**
 * Columns that join a stored layout at a fixed place instead of at the end: each one, when the stored order lacks it,
 * goes right after its anchor (the request columns after Name, Confirm after RS). Applied in this sequence, so the
 * request columns keep their own order. Every other missing key is still added at the end, and the stored order and
 * hidden list are kept as they are. The page's normalizer (worklist-columns.js) uses the same list.
 */
export const PLACED_COLUMNS: Record<string, [string, string][]> = {
  Radiology: [['reqDate','name'],['reqDept','reqDate'],['reqDoc','reqDept'],['ptClass','reqDoc'],['confirm','rs']],
  Technician: [],
};

export function placeMissingColumns(stored: string[], keys: string[], placed: [string, string][]) {
  const late = new Set(placed.map(([k]) => k));
  const order = [...stored, ...keys.filter(k => !stored.includes(k) && !late.has(k))];
  for (const [k, anchor] of placed) {
    if (stored.includes(k) || !keys.includes(k)) continue;
    const at = order.indexOf(anchor);
    order.splice(at < 0 ? order.length : at + 1, 0, k);
  }
  return order;
}

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
    clean.modes[mode] = { order: placeMissingColumns(part.order, keys, PLACED_COLUMNS[mode] ?? []), hidden: [...part.hidden] };
    if (Object.prototype.hasOwnProperty.call(part, 'appearance')) {
      const a = part.appearance;
      // 민훈 2026-11-01: 기본 11px, 사용자 설정으로 키움. Compact 기본값도 계정에 저장한다.
      if (!object(a) || Object.keys(a).sort().join() !== 'color,font,size,widths' ||
          !['default','cool','warm'].includes(a.color) || !['default','sans','mono'].includes(a.font) ||
          !Number.isInteger(a.size) || a.size < 10 || a.size > 20 || !object(a.widths) ||
          Object.entries(a.widths).some(([k,w]) => !keys.includes(k) || !Number.isInteger(w) || Number(w) < 64 || Number(w) > 600)) return null;
      clean.modes[mode].appearance = { widths: { ...a.widths }, font: a.font, size: a.size, color: a.color };
    }
  }
  return clean;
}
