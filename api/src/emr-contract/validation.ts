/** Closed, JSON-compatible contracts prevent silent loss of evidence fields. */
export class ContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ContractError'; }
}
export function refuse(code: string): never { throw new ContractError(code); }

export function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key =>
    !Object.prototype.hasOwnProperty.call(descriptors, key) || !('value' in descriptors[key]) || !descriptors[key].enumerable))
    throw new Error(`Expected exactly: ${keys.join(', ')}`);
  return value as Record<string, any>;
}

export function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error('Expected a string');
  // Reject UTF-16 that Buffer would silently replace with U+FFFD.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired surrogate');
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Unpaired surrogate');
  }
  return value;
}

export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(`Expected one of: ${choices.join(', ')}`);
  return value as T;
}

export function utc(value: unknown): string {
  const s = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) ||
      !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) throw new Error('Expected UTC milliseconds');
  return s;
}

export function sha256(value: unknown): string {
  const s = string(value);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error('Expected lowercase SHA-256');
  return s;
}

export function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error('Expected a safe integer');
  return value as number;
}

export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
