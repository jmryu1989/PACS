export type HangingProtocolLibrary = {
  version: 1;
  activeRuleId: string | null;
  rules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    match: Match;
    selectors: Selector[];
    layout: { rows: 1 | 2; cols: 1 | 2; cells: Cell[] };
    /** Optional, one entry per layout cell: null, or that stack cell's display values. */
    display?: Array<DisplayRule | null>;
    /** Optional: per monitor (n-th display from the left) image grid, worklist, thumbnail strip and toolbar place. */
    monitors?: Monitors;
  }>;
};

type Side = 'top' | 'bottom' | 'left' | 'right' | 'none';
export type Monitors = {
  count: number;
  list: Array<{ images: 'none' | '1x1' | '1x2' | '2x1' | '2x2' | 'auto'; worklist: 'show' | 'none'; thumbs: Side; toolbar: Side }>;
};
const MONITOR: Record<string, unknown[]> = {
  images: ['none', '1x1', '1x2', '2x1', '2x2', 'auto'], worklist: ['show', 'none'],
  thumbs: ['top', 'bottom', 'left', 'right', 'none'], toolbar: ['top', 'bottom', 'left', 'right', 'none'],
};
const MONITOR_KEYS = ['images', 'worklist', 'thumbs', 'toolbar'];

/** The display values of one stack cell (display set presets). */
export type DisplayRule = {
  magnification: 'fit' | '1:1' | '150' | '200';
  windowing: { name: string; w: number; l: number } | null;
  filter: 'none' | 'sharpen' | 'smooth';
  sort: 'stock' | 'instance' | 'position-asc' | 'position-desc' | 'acquisition';
  rotate: 0 | 90 | 180 | 270;
  flip: 'none' | 'horizontal' | 'vertical';
  firstImage: 'first' | 'middle' | 'last';
  gspsAuto: boolean;
  overlay: 'full' | 'none';
};
const DISPLAY: Record<string, unknown[]> = {
  magnification: ['fit', '1:1', '150', '200'], filter: ['none', 'sharpen', 'smooth'],
  sort: ['stock', 'instance', 'position-asc', 'position-desc', 'acquisition'], rotate: [0, 90, 180, 270],
  flip: ['none', 'horizontal', 'vertical'], firstImage: ['first', 'middle', 'last'], overlay: ['full', 'none'],
};
const DISPLAY_KEYS = ['magnification', 'windowing', 'filter', 'sort', 'rotate', 'flip', 'firstImage', 'gspsAuto', 'overlay'];

/** One cell is one viewport: a plane cell names its own orientation, it never expands. */
export type Cell = string | null | { alias: string; view: 'mpr'; orientation: 'axial' | 'sagittal' | 'coronal' };

type Description = { operator: 'equals' | 'contains'; value: string };
type Match = { modality: string | null; retrieveAE: string | null; bodyPart: string | null; description: Description | null };
type Selector = Match & { alias: string; role: 'current' | 'related'; historical: boolean;
  laterality: null | 'L' | 'R' | 'B'; order: 'ascending' | 'descending'; occurrence: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const VIEWS = ['mpr'];
const ORIENTATIONS = ['axial', 'sagittal', 'coronal'];
const own = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string[]) => {
  const actual = Reflect.ownKeys(v), descriptors = Object.getOwnPropertyDescriptors(v);
  return actual.every(key => typeof key === 'string' && descriptors[key].enumerable && 'value' in descriptors[key]) &&
    (actual as string[]).sort().join(',') === keys.slice().sort().join(',');
};
const dense = (v: unknown): v is unknown[] => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(v), descriptors = Object.getOwnPropertyDescriptors(v);
  return keys.length === v.length + 1 && keys[keys.length - 1] === 'length' &&
    keys.slice(0, -1).every((key, index) => typeof key === 'string' && key === String(index) && descriptors[key].enumerable && 'value' in descriptors[key]);
};

const fold = (v: string) => v.normalize('NFKC').toLocaleLowerCase('en-US');

/** Returns a detached cell, undefined for a malformed one. Null stays an explicit vacancy. */
function cell(v: unknown, aliases: Map<string, string>): Cell | undefined {
  if (v === null) return null;
  if (typeof v === 'string') return aliases.get(fold(v)) === v ? v : undefined;
  if (!own(v) || !exact(v, ['alias', 'view', 'orientation'])) return undefined;
  const alias = v.alias, view = v.view, orientation = v.orientation;
  if (typeof alias !== 'string' || aliases.get(fold(alias)) !== alias ||
      !VIEWS.includes(view as string) || !ORIENTATIONS.includes(orientation as string)) return undefined;
  return { alias, view: view as 'mpr', orientation: orientation as 'axial' | 'sagittal' | 'coronal' };
}

function text(v: unknown, max: number) {
  if (typeof v !== 'string') return undefined;
  const clean = v.trim();
  return clean === v && clean.length >= 1 && clean.length <= max ? clean : undefined;
}

function token(v: unknown, max: number) {
  if (v === null) return null;
  const clean = text(v, max);
  return clean === undefined || clean !== clean.toUpperCase() ? undefined : clean;
}

function description(v: unknown): Description | null | undefined {
  if (v === null) return null;
  if (!own(v) || !exact(v, ['operator', 'value']) || !['equals', 'contains'].includes(v.operator as string)) return undefined;
  const value = text(v.value, 128);
  return value === undefined ? undefined : { operator: v.operator as Description['operator'], value };
}

function match(v: unknown): Match | undefined {
  if (!own(v) || !exact(v, ['modality', 'retrieveAE', 'bodyPart', 'description'])) return undefined;
  const modality = token(v.modality, 16), retrieveAE = token(v.retrieveAE, 16), bodyPart = token(v.bodyPart, 64);
  const desc = description(v.description);
  if (modality === undefined || retrieveAE === undefined || bodyPart === undefined || desc === undefined) return undefined;
  return { modality, retrieveAE, bodyPart, description: desc };
}

function selector(v: unknown): Selector | undefined {
  if (!own(v) || !exact(v, ['alias', 'role', 'historical', 'modality', 'retrieveAE', 'bodyPart', 'description', 'laterality', 'order', 'occurrence'])) return undefined;
  const alias = text(v.alias, 32), common = match({ modality: v.modality, retrieveAE: v.retrieveAE, bodyPart: v.bodyPart, description: v.description });
  if (!alias || !ALIAS.test(alias) || !common || !['current', 'related'].includes(v.role as string) || typeof v.historical !== 'boolean' ||
      (v.historical && v.role !== 'related') || ![null, 'L', 'R', 'B'].includes(v.laterality as any) ||
      !['ascending', 'descending'].includes(v.order as string) || !Number.isInteger(v.occurrence) || (v.occurrence as number) < 1 || (v.occurrence as number) > 500) return undefined;
  return { alias, role: v.role as Selector['role'], historical: v.historical, ...common,
    laterality: v.laterality as Selector['laterality'], order: v.order as Selector['order'], occurrence: v.occurrence as number };
}

const windowNumber = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) && v > min && Math.abs(v) <= 100000;

/** Null for no rule, undefined for a malformed entry. */
function displayRule(v: unknown): DisplayRule | null | undefined {
  if (v === null) return null;
  if (!own(v) || !exact(v, DISPLAY_KEYS)) return undefined;
  let windowing: DisplayRule['windowing'] = null;
  if (v.windowing !== null) {
    const w = v.windowing;
    if (!own(w) || !exact(w, ['name', 'w', 'l']) || text(w.name, 60) === undefined || !windowNumber(w.w, 0) || !windowNumber(w.l, -100001)) return undefined;
    windowing = { name: w.name as string, w: w.w as number, l: w.l as number };
  }
  if (typeof v.gspsAuto !== 'boolean') return undefined;
  for (const key of Object.keys(DISPLAY)) if (!DISPLAY[key].includes(v[key])) return undefined;
  return { magnification: v.magnification as DisplayRule['magnification'], windowing, filter: v.filter as DisplayRule['filter'],
    sort: v.sort as DisplayRule['sort'], rotate: v.rotate as DisplayRule['rotate'], flip: v.flip as DisplayRule['flip'],
    firstImage: v.firstImage as DisplayRule['firstImage'], gspsAuto: v.gspsAuto, overlay: v.overlay as DisplayRule['overlay'] };
}

/** One entry per cell; a vacancy or a plane cell carries null. */
function displayList(v: unknown, cells: Cell[]): Array<DisplayRule | null> | undefined {
  if (!dense(v) || v.length !== cells.length) return undefined;
  const list: Array<DisplayRule | null> = [];
  for (let index = 0; index < cells.length; index++) {
    const entry = displayRule(v[index]);
    if (entry === undefined || (entry !== null && typeof cells[index] !== 'string')) return undefined;
    list.push(entry);
  }
  return list;
}

/** At most one monitor shows the worklist; at least one shows images with its toolbar. Undefined when malformed. */
function monitorsRule(v: unknown): Monitors | undefined {
  if (!own(v) || !exact(v, ['count', 'list']) || !Number.isInteger(v.count) || (v.count as number) < 1 || (v.count as number) > 4 ||
      !dense(v.list) || v.list.length !== v.count) return undefined;
  const list: Monitors['list'] = [];
  for (const item of v.list) {
    if (!own(item) || !exact(item, MONITOR_KEYS)) return undefined;
    for (const key of MONITOR_KEYS) if (!MONITOR[key].includes(item[key])) return undefined;
    list.push({ images: item.images as Monitors['list'][number]['images'], worklist: item.worklist as 'show' | 'none',
      thumbs: item.thumbs as Side, toolbar: item.toolbar as Side });
  }
  if (list.filter(m => m.worklist === 'show').length > 1 || !list.some(m => m.images !== 'none' && m.toolbar !== 'none')) return undefined;
  return { count: v.count as number, list };
}

/** Returns a detached, canonical value. Undefined means the input is not schema v1 JSON. */
export function normalizeHangingProtocol(value: unknown): HangingProtocolLibrary | undefined {
  try {
    if (!own(value) || !exact(value, ['version', 'activeRuleId', 'rules'])) return undefined;
    const activeInput = value.activeRuleId;
    if (value.version !== 1 || !dense(value.rules) || value.rules.length > 20 ||
        !(activeInput === null || typeof activeInput === 'string' && UUID.test(activeInput))) return undefined;
    const ids = new Set<string>(), names = new Set<string>();
    const rules: HangingProtocolLibrary['rules'] = [];
    for (const input of value.rules) {
      const hasDisplay = own(input) && Object.prototype.hasOwnProperty.call(input, 'display');
      const hasMonitors = own(input) && Object.prototype.hasOwnProperty.call(input, 'monitors');
      if (!own(input) || !exact(input, ['id', 'name', 'enabled', 'match', 'selectors', 'layout', ...(hasDisplay ? ['display'] : []), ...(hasMonitors ? ['monitors'] : [])]) ||
          typeof input.id !== 'string' || !UUID.test(input.id) || typeof input.enabled !== 'boolean' || !dense(input.selectors) || input.selectors.length > 4) return undefined;
      const id = input.id.toLowerCase(), name = text(input.name, 64), ruleMatch = match(input.match);
      const nameKey = name?.normalize('NFKC').toLocaleLowerCase('en-US');
      if (!name || !ruleMatch || ids.has(id) || names.has(nameKey!)) return undefined;
      const selectors = input.selectors.map(selector);
      if (selectors.some(x => x === undefined)) return undefined;
      const aliases = new Map<string, string>();
      for (const item of selectors as Selector[]) {
        const key = item.alias.normalize('NFKC').toLocaleLowerCase('en-US');
        if (aliases.has(key)) return undefined; aliases.set(key, item.alias);
      }
      const layout = input.layout;
      if (!own(layout) || !exact(layout, ['rows', 'cols', 'cells']) ||
          !([[1, 1], [1, 2], [2, 2]] as number[][]).some(([r, c]) => layout.rows === r && layout.cols === c) ||
          !dense(layout.cells) || layout.cells.length !== (layout.rows as number) * (layout.cols as number)) return undefined;
      const cells: Cell[] = [], planes = new Set<string>();
      for (const raw of layout.cells) {
        const item = cell(raw, aliases);
        if (item === undefined) return undefined;
        if (item !== null && typeof item !== 'string') {
          // Two identical planes of one series are a configuration error, not a layout.
          const plane = fold(item.alias) + '|' + item.view + '|' + item.orientation;
          if (planes.has(plane)) return undefined;
          planes.add(plane);
        }
        cells.push(item);
      }
      const named = (value: Cell) => value === null ? null : typeof value === 'string' ? value : value.alias;
      if (!(selectors as Selector[]).some(item => item.role === 'current' && cells.some(value => named(value) === item.alias))) return undefined;
      const display = hasDisplay ? displayList(input.display, cells) : undefined;
      if (hasDisplay && !display) return undefined;
      const monitors = hasMonitors ? monitorsRule(input.monitors) : undefined;
      if (hasMonitors && !monitors) return undefined;
      ids.add(id); names.add(nameKey!);
      rules.push({ id, name, enabled: input.enabled, match: ruleMatch, selectors: selectors as Selector[],
        layout: { rows: layout.rows as 1 | 2, cols: layout.cols as 1 | 2, cells }, ...(display ? { display } : {}), ...(monitors ? { monitors } : {}) });
    }
    const activeRuleId = typeof activeInput === 'string' ? activeInput.toLowerCase() : null;
    if (activeRuleId !== null && !rules.some(rule => rule.id === activeRuleId && rule.enabled)) return undefined;
    const clean: HangingProtocolLibrary = { version: 1, activeRuleId, rules };
    return Buffer.byteLength(JSON.stringify(clean), 'utf8') <= 65536 ? clean : undefined;
  } catch { return undefined; }
}
