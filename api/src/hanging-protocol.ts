export type HangingProtocolLibrary = {
  version: 1;
  activeRuleId: string | null;
  rules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    match: Match;
    selectors: Selector[];
    layout: { rows: 1 | 2; cols: 1 | 2; cells: Array<string | null> };
  }>;
};

type Description = { operator: 'equals' | 'contains'; value: string };
type Match = { modality: string | null; retrieveAE: string | null; bodyPart: string | null; description: Description | null };
type Selector = Match & { alias: string; role: 'current' | 'related'; historical: boolean;
  laterality: null | 'L' | 'R' | 'B'; order: 'ascending' | 'descending'; occurrence: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
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
      if (!own(input) || !exact(input, ['id', 'name', 'enabled', 'match', 'selectors', 'layout']) ||
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
          !dense(layout.cells) || layout.cells.length !== (layout.rows as number) * (layout.cols as number) ||
          layout.cells.some(cell => cell !== null && (typeof cell !== 'string' || aliases.get(cell.normalize('NFKC').toLocaleLowerCase('en-US')) !== cell))) return undefined;
      const cells = layout.cells.slice() as Array<string | null>;
      if (!(selectors as Selector[]).some(item => item.role === 'current' && cells.includes(item.alias))) return undefined;
      ids.add(id); names.add(nameKey!);
      rules.push({ id, name, enabled: input.enabled, match: ruleMatch, selectors: selectors as Selector[],
        layout: { rows: layout.rows as 1 | 2, cols: layout.cols as 1 | 2, cells } });
    }
    const activeRuleId = typeof activeInput === 'string' ? activeInput.toLowerCase() : null;
    if (activeRuleId !== null && !rules.some(rule => rule.id === activeRuleId && rule.enabled)) return undefined;
    const clean: HangingProtocolLibrary = { version: 1, activeRuleId, rules };
    return Buffer.byteLength(JSON.stringify(clean), 'utf8') <= 65536 ? clean : undefined;
  } catch { return undefined; }
}
