/**
 * KIN-EMR-STATE-V4, layout revision 1 (D1691 approval; Astra order consult-emr-b2-c-v4-order-20261022).
 *
 * The page/index/codec of the authoritative paged, validated checkpoint: canonical control bytes J(x) and the domain
 * hash H(domain, bytes); 64 KiB pages (128-byte header, 32-byte footer) appended to immutable packs; overflow blobs;
 * copy-on-write B+ trees over 32-byte routing digests whose leaves retain and compare the full original keys; the
 * immutable root envelope, the small selector and the v4 transition WAL. Every byte that is consumed is checked
 * against the reference that named it before it can be used; a missing, truncated or corrupt page is never absence.
 *
 * This module knows nothing of the seal's semantics: the engine (external-writer.ts) decides what the trees hold.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { syncDirectory } from './journal-file';

export const V4_FORMAT = 'KIN-EMR-STATE-V4', V4_VERSION = 4, V4_LAYOUT = 1, V4_VALIDATOR_ID = 'b2c-v4.1';
export const PAGE_BYTES = 65536, HEADER_BYTES = 128, BODY_CAPACITY = 65376, FOOTER_OFFSET = 65504, FOOTER_BYTES = 32;
export const REF_BYTES = 56, OVERFLOW_CHUNK = BODY_CAPACITY - REF_BYTES; // 65,320 raw bytes per overflow page
export const CONTROL_MAX_BYTES = 65536, PACK_PAGES = 256; // packs seal at 16 MiB
export const PAGE_MAGIC = Buffer.from('KEMRP004', 'ascii');
export const KIND = { leaf: 1, branch: 2, overflow: 3 } as const;
export const DOMAIN = {
  root: 'KIN-EMR-V4/root', selector: 'KIN-EMR-V4/selector', wal: 'KIN-EMR-V4/wal', page: 'KIN-EMR-V4/page', blob: 'KIN-EMR-V4/blob',
  key: 'KIN-EMR-V4/key', lineage: 'KIN-EMR-V4/lineage', dbEntry: 'KIN-EMR-V4/db-entry', coverage: 'KIN-EMR-V4/coverage',
  witness: 'KIN-EMR-V4/witness', changes: 'KIN-EMR-V4/changes',
} as const;
export const TREE = { meta: 1, intents: 2, slots: 3, proofs: 4, terminal: 5, bundles: 6, pending: 7, dbBindings: 8 } as const;
export const TREE_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type TreeId = typeof TREE_IDS[number];

export class V4Error extends Error {
  constructor(readonly code: 'SealCorrupt' | 'SealUnsupportedFormat' | 'SealMissing' | 'SealUnavailable', readonly detail: string) {
    super(code + ':' + detail); this.name = 'V4Error';
  }
}
const corrupt = (detail: string): never => { throw new V4Error('SealCorrupt', detail); };
const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/, DECIMAL = /^(0|[1-9][0-9]*)$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// ── canonical control bytes J(x) and the domain hash ─────────────────────────────────────────────────────────────────
/** J(x): keys sorted by unsigned UTF-16 code units at every level, arrays in order, JSON.stringify escaping, no
 * whitespace. Only finite numbers that are not negative zero are encodable; control counters are decimal strings. */
export function canonical(value: unknown): string {
  const encode = (v: unknown): string => {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) throw new V4Error('SealCorrupt', 'nonfinite-or-negative-zero');
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
    if (isRecord(v)) {
      const keys = Object.keys(v).sort();
      return '{' + keys.map(k => { if (v[k] === undefined) throw new V4Error('SealCorrupt', 'undefined-field'); return JSON.stringify(k) + ':' + encode(v[k]); }).join(',') + '}';
    }
    throw new V4Error('SealCorrupt', 'unencodable-' + typeof v);
  };
  return encode(value);
}
/** Parse canonical bytes: valid UTF-8 JSON whose re-encoding is byte-identical (duplicate/unknown-order fields,
 * whitespace, noncanonical numbers or escapes are refused). */
export function parseCanonical(bytes: Buffer | string, detail = 'control'): any {
  const text = typeof bytes === 'string' ? bytes : (() => {
    if (!isValidUtf8(bytes)) return corrupt(detail + ':utf8');
    return bytes.toString('utf8');
  })();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return corrupt(detail + ':json'); }
  if (canonical(value) !== text) return corrupt(detail + ':noncanonical');
  return value;
}
function isValidUtf8(bytes: Buffer): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
export function domainHashRaw(domain: string, bytes: Buffer | string): Buffer {
  return createHash('sha256').update(domain, 'ascii').update(Buffer.from([0])).update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest();
}
export function domainHash(domain: string, bytes: Buffer | string): string { return domainHashRaw(domain, bytes).toString('hex'); }
/** A control envelope `{body,sha256}` with sha256 = H(domain, J(body)); its file/line bytes are J(envelope)+LF. */
export function envelope(domain: string, body: unknown): { text: string; sha256: string } {
  const sha256 = domainHash(domain, canonical(body));
  const text = canonical({ body, sha256 }) + '\n';
  if (Buffer.byteLength(text) > CONTROL_MAX_BYTES) corrupt('control-envelope-too-large');
  return { text, sha256 };
}
export function openEnvelope(domain: string, line: Buffer | string, detail = 'envelope'): { body: any; sha256: string } {
  let text = typeof line === 'string' ? line : (isValidUtf8(line) ? line.toString('utf8') : corrupt(detail + ':utf8'));
  if (!text.endsWith('\n')) corrupt(detail + ':unterminated');
  if (Buffer.byteLength(text) > CONTROL_MAX_BYTES) corrupt(detail + ':too-large');
  text = text.slice(0, -1);
  const value = parseCanonical(text, detail);
  if (!isRecord(value) || Object.keys(value).length !== 2 || !('body' in value) || typeof value.sha256 !== 'string' || !HEX64.test(value.sha256)) corrupt(detail + ':shape');
  if (domainHash(domain, canonical(value.body)) !== value.sha256) corrupt(detail + ':sha256');
  return { body: value.body, sha256: value.sha256 };
}
export const decimal = (n: number | bigint): string => { if (typeof n === 'number' && (!Number.isSafeInteger(n) || n < 0)) corrupt('decimal'); return String(n); };
export function parseDecimal(value: unknown, detail: string): number {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return corrupt(detail + ':decimal');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return corrupt(detail + ':decimal-range'); // a u64 above MAX_SAFE_INTEGER is never coerced
  return n;
}

// ── page references ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface PageRef { pack: string; page: string; sha256: string }
export function validRef(value: unknown, detail: string): PageRef {
  if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.pack !== 'string' || !HEX32.test(value.pack) ||
    typeof value.sha256 !== 'string' || !HEX64.test(value.sha256) || typeof value.page !== 'string') return corrupt(detail + ':ref');
  parseDecimal(value.page, detail + ':ref');
  if (/^0+$/.test(value.pack)) corrupt(detail + ':ref-zero-pack');
  return { pack: value.pack, page: value.page, sha256: value.sha256 };
}
export function refToBinary(ref: PageRef | null): Buffer {
  const out = Buffer.alloc(REF_BYTES);
  if (!ref) return out;
  Buffer.from(ref.pack, 'hex').copy(out, 0);
  out.writeBigUInt64LE(BigInt(ref.page), 16);
  Buffer.from(ref.sha256, 'hex').copy(out, 24);
  return out;
}
export function refFromBinary(bytes: Buffer, detail: string): PageRef | null {
  if (bytes.length !== REF_BYTES) corrupt(detail + ':ref-bytes');
  if (bytes.every(b => b === 0)) return null;
  const pack = bytes.subarray(0, 16).toString('hex');
  if (/^0+$/.test(pack)) corrupt(detail + ':ref-zero-pack');
  const page = bytes.readBigUInt64LE(16);
  if (page > BigInt(Number.MAX_SAFE_INTEGER)) corrupt(detail + ':ref-page-range');
  return { pack, page: String(page), sha256: bytes.subarray(24, 56).toString('hex') };
}
export const sameRef = (a: PageRef | null, b: PageRef | null): boolean => (!a && !b) || !!(a && b && a.pack === b.pack && a.page === b.page && a.sha256 === b.sha256);

// ── pages ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PageHeader {
  kind: 1 | 2 | 3; page: number; revision: number; payloadLength: number; entryCount: number; tree: number; level: number;
  lineageSha256: string; pack: string;
}
export function buildPage(header: Omit<PageHeader, 'payloadLength'>, payload: Buffer): Buffer {
  if (payload.length > BODY_CAPACITY) corrupt('payload-too-large');
  const page = Buffer.alloc(PAGE_BYTES);
  PAGE_MAGIC.copy(page, 0);
  page.writeUInt16LE(4, 8); page.writeUInt16LE(header.kind, 10); page.writeUInt16LE(HEADER_BYTES, 12); page.writeUInt16LE(0, 14);
  page.writeBigUInt64LE(BigInt(header.page), 16); page.writeBigUInt64LE(BigInt(header.revision), 24);
  page.writeUInt32LE(payload.length, 32); page.writeUInt32LE(header.entryCount, 36);
  page.writeUInt16LE(header.tree, 40); page.writeUInt16LE(header.level, 42); page.writeUInt32LE(0, 44);
  Buffer.from(header.lineageSha256, 'hex').copy(page, 48);
  Buffer.from(header.pack, 'hex').copy(page, 80);
  payload.copy(page, HEADER_BYTES);
  domainHashRaw(DOMAIN.page, page.subarray(0, FOOTER_OFFSET)).copy(page, FOOTER_OFFSET);
  return page;
}
export interface PageExpectation { ref: PageRef; lineageSha256: string; kind?: 1 | 2 | 3; tree?: number; level?: number; maxRevision?: number }
/** Verify the footer, the parent's expected checksum, every header field against the reference and zero padding, then
 * return the payload. Nothing of a page is interpreted before this check. */
export function parsePage(bytes: Buffer, expect: PageExpectation): { header: PageHeader; payload: Buffer } {
  const d = 'page ' + expect.ref.pack + '/' + expect.ref.page;
  if (bytes.length !== PAGE_BYTES) corrupt(d + ':length');
  if (!domainHashRaw(DOMAIN.page, bytes.subarray(0, FOOTER_OFFSET)).equals(bytes.subarray(FOOTER_OFFSET))) corrupt(d + ':footer');
  if (createHash('sha256').update(bytes.subarray(0, FOOTER_OFFSET)).digest('hex') !== pageSha256FromFooter(bytes) || expect.ref.sha256 !== bytes.subarray(FOOTER_OFFSET).toString('hex')) corrupt(d + ':reference-checksum');
  if (!bytes.subarray(0, 8).equals(PAGE_MAGIC) || bytes.readUInt16LE(8) !== 4 || bytes.readUInt16LE(12) !== HEADER_BYTES || bytes.readUInt16LE(14) !== 0 || bytes.readUInt32LE(44) !== 0) corrupt(d + ':header');
  const kindValue = bytes.readUInt16LE(10);
  if (kindValue !== 1 && kindValue !== 2 && kindValue !== 3) corrupt(d + ':kind');
  const kind = kindValue as 1 | 2 | 3;
  const page = bytes.readBigUInt64LE(16), revision = bytes.readBigUInt64LE(24);
  if (page > BigInt(Number.MAX_SAFE_INTEGER) || String(page) !== expect.ref.page) corrupt(d + ':address');
  if (revision < 1n || revision > BigInt(Number.MAX_SAFE_INTEGER) || (expect.maxRevision !== undefined && Number(revision) > expect.maxRevision)) corrupt(d + ':revision');
  const payloadLength = bytes.readUInt32LE(32), entryCount = bytes.readUInt32LE(36), tree = bytes.readUInt16LE(40), level = bytes.readUInt16LE(42);
  if (payloadLength > BODY_CAPACITY) corrupt(d + ':payload-length');
  if (!bytes.subarray(48, 80).equals(Buffer.from(expect.lineageSha256, 'hex'))) corrupt(d + ':lineage');
  if (bytes.subarray(80, 96).toString('hex') !== expect.ref.pack) corrupt(d + ':pack');
  if (!bytes.subarray(96, 128).every(b => b === 0) || !bytes.subarray(HEADER_BYTES + payloadLength, FOOTER_OFFSET).every(b => b === 0)) corrupt(d + ':padding');
  if (expect.kind !== undefined && kind !== expect.kind) corrupt(d + ':kind-expected');
  if (expect.tree !== undefined && tree !== expect.tree) corrupt(d + ':tree');
  if (expect.level !== undefined && level !== expect.level) corrupt(d + ':level');
  if (kind === 3 ? (entryCount !== 0 || level !== 0) : (kind === 1 ? level !== 0 : level < 1)) corrupt(d + ':kind-level');
  if (kind !== 3 && (tree < 1 || tree > 8)) corrupt(d + ':tree-id');
  return { header: { kind, page: Number(page), revision: Number(revision), payloadLength, entryCount, tree, level, lineageSha256: expect.lineageSha256, pack: expect.ref.pack },
    payload: bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength) };
}
const pageSha256FromFooter = (bytes: Buffer) => createHash('sha256').update(bytes.subarray(0, FOOTER_OFFSET)).digest('hex');
/** The page reference checksum is the footer: H(page, bytes[0:65504]). */
export const pageSha256 = (page: Buffer): string => page.subarray(FOOTER_OFFSET).toString('hex');

// ── pack store: immutable packs, bounded verified cache ──────────────────────────────────────────────────────────────
export interface StoreOptions { cacheBytes?: number; maxDescriptors?: number }
/** Packs live under `<v4>/pages/<packId>.pages`; pages are read by reference and verified before use; verified parsed
 * nodes are cached by (pack, page, expected hash) within a byte budget and invalidated explicitly. Open read
 * descriptors are bounded (least recently used closed first): a state of thousands of packs never holds one
 * descriptor per pack. */
export class PackStore {
  readonly pagesDirectory: string;
  private readonly cache = new Map<string, { bytes: number; value: any; header: PageHeader }>();
  private cacheBytes = 0;
  /** Open descriptors in least-recently-used order (insertion order; a use re-inserts). */
  private readonly fds = new Map<string, number>();
  constructor(readonly v4Directory: string, readonly lineageSha256: string, private readonly options: StoreOptions = {}) {
    this.pagesDirectory = path.join(v4Directory, 'pages');
  }
  get cacheBudget(): number { return this.options.cacheBytes ?? 512 * 1024 * 1024; }
  get descriptorBudget(): number { return this.options.maxDescriptors ?? 64; }
  get openDescriptors(): number { return this.fds.size; }
  packFile(pack: string): string { if (!HEX32.test(pack)) corrupt('pack-id'); return path.join(this.pagesDirectory, pack + '.pages'); }
  private fd(pack: string): number {
    let fd = this.fds.get(pack);
    if (fd !== undefined) { this.fds.delete(pack); this.fds.set(pack, fd); return fd; }
    while (this.fds.size >= Math.max(1, this.descriptorBudget)) this.release(this.fds.keys().next().value!);
    fd = fs.openSync(this.packFile(pack), 'r'); this.fds.set(pack, fd);
    return fd;
  }
  /** Exact bytes of one page (full read length checked) from the named pack at page*65536. */
  readRaw(ref: PageRef): Buffer {
    const page = parseDecimal(ref.page, 'ref ' + JSON.stringify(ref.page));
    const file = this.packFile(ref.pack), info = fs.statSync(file, { throwIfNoEntry: false });
    if (!info || !info.isFile()) corrupt('page ' + ref.pack + '/' + ref.page + ':missing-pack');
    const offset = page * PAGE_BYTES;
    if (offset + PAGE_BYTES > info.size) corrupt('page ' + ref.pack + '/' + ref.page + ':beyond-pack');
    const bytes = Buffer.allocUnsafe(PAGE_BYTES);
    let read = 0;
    const fd = this.fd(ref.pack);
    while (read < PAGE_BYTES) { const n = fs.readSync(fd, bytes, read, PAGE_BYTES - read, offset + read); if (!n) corrupt('page ' + ref.pack + '/' + ref.page + ':short-read'); read += n; }
    return bytes;
  }
  /** A verified page: the parsed, validated representation from the cache (immutable, already checked bytes) or a fresh
   * read that is checksummed again before use. */
  page<T>(ref: PageRef, expect: Omit<PageExpectation, 'ref' | 'lineageSha256'>, decode: (header: PageHeader, payload: Buffer) => T, tag = 'node'): T {
    // The cache holds decoded representations: one per (page bytes, decoder); the bytes were verified once.
    const key = tag + ':' + ref.pack + ':' + ref.page + ':' + ref.sha256;
    const cached = this.cache.get(key) as { bytes: number; value: T; header: PageHeader } | undefined;
    if (cached) {
      // The checked bytes are immutable; the expectation of this use is still enforced.
      const h = cached.header, d = 'page ' + ref.pack + '/' + ref.page;
      if (expect.kind !== undefined && h.kind !== expect.kind) corrupt(d + ':kind-expected');
      if (expect.tree !== undefined && h.tree !== expect.tree) corrupt(d + ':tree');
      if (expect.level !== undefined && h.level !== expect.level) corrupt(d + ':level');
      if (expect.maxRevision !== undefined && h.revision > expect.maxRevision) corrupt(d + ':revision');
      this.cache.delete(key); this.cache.set(key, cached); return cached.value;
    }
    const { header, payload } = parsePage(this.readRaw(ref), { ref, lineageSha256: this.lineageSha256, ...expect });
    const value = decode(header, payload);
    // The decoded representation of a page (entries, strings, descriptors) weighs about the page plus its payload again;
    // the budget is charged that way so the owner's heap, not only the page count, stays bounded.
    const bytes = PAGE_BYTES + payload.length;
    while (this.cacheBytes + bytes > this.cacheBudget && this.cache.size) { const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.bytes; this.cache.delete(first); }
    if (bytes <= this.cacheBudget) { this.cache.set(key, { bytes, value, header }); this.cacheBytes += bytes; }
    return value;
  }
  /** Drop one page's cached representations (a page no current root references: an orphan of a transition). The cache
   * then holds about the live pages, not every page the writer ever decoded up to the budget. */
  forget(ref: PageRef): void {
    for (const tag of ['leaf', 'branch', 'header', 'blob', 'blob-next', 'node']) {
      const key = tag + ':' + ref.pack + ':' + ref.page + ':' + ref.sha256, cached = this.cache.get(key);
      if (cached) { this.cacheBytes -= cached.bytes; this.cache.delete(key); }
    }
  }
  /** Close the read descriptor of one pack (before it is unlinked); its cached pages stay valid (immutable bytes). */
  release(pack: string): void {
    const fd = this.fds.get(pack);
    if (fd !== undefined) { this.fds.delete(pack); try { fs.closeSync(fd); } catch { /* closed */ } }
  }
  /** Drop every cached page and descriptor (after uncertain I/O, a replaced target or a new owner incarnation). */
  invalidate(): void {
    this.cache.clear(); this.cacheBytes = 0;
    for (const fd of this.fds.values()) { try { fs.closeSync(fd); } catch { /* closed */ } }
    this.fds.clear();
  }
  close(): void { this.invalidate(); }
  get cachedBytes(): number { return this.cacheBytes; }
  listPacks(): string[] {
    return fs.existsSync(this.pagesDirectory) ? fs.readdirSync(this.pagesDirectory).filter(n => /^[0-9a-f]{32}\.pages$/.test(n)).map(n => n.slice(0, 32)).sort() : [];
  }
}
/** Appends pages to the current pack (sealed at 256 pages), never overwriting a published page; `flush()` fdatasyncs
 * every pack written since the last flush and fsyncs the pages directory for newly created packs. */
export class PackWriter {
  private current: { pack: string; fd: number; pages: number } | null = null;
  private readonly dirty = new Map<string, number>();
  private newPacks = false;
  /** Every page this writer appended (in order): the liveness accounting of the roots that reference them. */
  readonly written: PageRef[] = [];
  /** Every overflow chain this writer wrote for a tree bucket, with the bucket that owns it (the route a relocation
   * of the chain's pages must rewrite); the engine drains it with `written`. */
  readonly overflowRoutes: { tree: number; digest: string; descriptor: BlobDescriptor }[] = [];
  /** The pack the writer may still append to (never a reclamation candidate while this writer is open). */
  get currentPack(): string | null { return this.current ? this.current.pack : null; }
  constructor(readonly store: PackStore, public revision: number) {
    fs.mkdirSync(store.pagesDirectory, { recursive: true, mode: 0o700 });
  }
  append(kind: 1 | 2 | 3, tree: number, level: number, entryCount: number, payload: Buffer): PageRef {
    if (!this.current || this.current.pages >= PACK_PAGES) this.open();
    const { pack, fd, pages } = this.current!;
    const page = buildPage({ kind, page: pages, revision: this.revision, entryCount, tree, level, lineageSha256: this.store.lineageSha256, pack }, payload);
    let written = 0;
    const offset = pages * PAGE_BYTES;
    while (written < PAGE_BYTES) { const n = fs.writeSync(fd, page, written, PAGE_BYTES - written, offset + written); if (n <= 0) corrupt('short-write'); written += n; }
    this.current!.pages++;
    this.dirty.set(pack, fd);
    const ref = { pack, page: String(pages), sha256: pageSha256(page) };
    this.written.push(ref);
    return ref;
  }
  private open(): void {
    this.closeCurrent();
    let pack: string, file: string;
    do { pack = randomBytes(16).toString('hex'); file = this.store.packFile(pack); } while (fs.existsSync(file) || /^0+$/.test(pack));
    const fd = fs.openSync(file, 'wx', 0o600);
    this.current = { pack, fd, pages: 0 }; this.newPacks = true;
  }
  private closeCurrent(): void {
    if (this.current && !this.dirty.has(this.current.pack)) { fs.closeSync(this.current.fd); }
    this.current = this.current && this.dirty.has(this.current.pack) ? this.current : null;
  }
  /** Durable: every written pack flushed, new pack names flushed in the directory. */
  flush(): void {
    for (const [pack, fd] of this.dirty) { fs.fdatasyncSync(fd); if (!this.current || this.current.pack !== pack) fs.closeSync(fd); }
    const keep = this.current ? this.dirty.get(this.current.pack) : undefined;
    this.dirty.clear();
    if (keep !== undefined && this.current) { /* the current pack stays open for further appends */ }
    if (this.newPacks) { syncDirectory(this.store.pagesDirectory); this.newPacks = false; }
  }
  close(): void {
    this.flush();
    if (this.current) { try { fs.closeSync(this.current.fd); } catch { /* closed */ } this.current = null; }
  }
}

// ── overflow blobs ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface BlobDescriptor { first: PageRef; bytes: string; pages: string; sha256: string }
export function validBlobDescriptor(value: unknown, detail: string): BlobDescriptor {
  if (!isRecord(value) || Object.keys(value).length !== 4 || typeof value.sha256 !== 'string' || !HEX64.test(value.sha256)) return corrupt(detail + ':blob');
  const first = validRef(value.first, detail + ':blob'), bytes = parseDecimal(value.bytes, detail + ':blob'), pages = parseDecimal(value.pages, detail + ':blob');
  if (bytes < 1 || pages !== Math.ceil(bytes / OVERFLOW_CHUNK)) corrupt(detail + ':blob-size');
  return { first, bytes: value.bytes as string, pages: value.pages as string, sha256: value.sha256 };
}
/** Write raw bytes as a chain of overflow pages (last page first, so each page can name its successor). */
export function writeBlob(writer: PackWriter, tree: number, bytes: Buffer): BlobDescriptor {
  if (!bytes.length) corrupt('empty-blob');
  const pages = Math.ceil(bytes.length / OVERFLOW_CHUNK);
  let next: PageRef | null = null;
  for (let i = pages - 1; i >= 0; i--) {
    const chunk = bytes.subarray(i * OVERFLOW_CHUNK, Math.min(bytes.length, (i + 1) * OVERFLOW_CHUNK));
    next = writer.append(KIND.overflow, tree, 0, 0, Buffer.concat([refToBinary(next), chunk]));
  }
  return { first: next!, bytes: String(bytes.length), pages: String(pages), sha256: domainHash(DOMAIN.blob, bytes) };
}
/** Read and verify a blob: page identities/checksums, chunk lengths, terminal null, no cycles, whole-blob hash. */
export function readBlob(store: PackStore, descriptor: BlobDescriptor, tree: number, detail: string): Buffer {
  const total = parseDecimal(descriptor.bytes, detail), pages = parseDecimal(descriptor.pages, detail);
  const parts: Buffer[] = []; const seen = new Set<string>();
  let ref: PageRef | null = descriptor.first, received = 0;
  for (let i = 0; i < pages; i++) {
    if (!ref) return corrupt(detail + ':blob-short-chain');
    const key = ref.pack + ':' + ref.page;
    if (seen.has(key)) corrupt(detail + ':blob-cycle'); seen.add(key);
    const { next, chunk } = store.page(ref, { kind: KIND.overflow, tree, level: 0 }, (_h, payload) => {
      if (payload.length < REF_BYTES) corrupt(detail + ':blob-page');
      return { next: refFromBinary(payload.subarray(0, REF_BYTES), detail), chunk: Buffer.from(payload.subarray(REF_BYTES)) };
    }, 'blob');
    const expected = i < pages - 1 ? OVERFLOW_CHUNK : total - i * OVERFLOW_CHUNK;
    if (chunk.length !== expected) corrupt(detail + ':blob-chunk');
    parts.push(chunk); received += chunk.length; ref = next;
  }
  if (ref !== null) corrupt(detail + ':blob-terminal');
  const bytes = Buffer.concat(parts, received);
  if (domainHash(DOMAIN.blob, bytes) !== descriptor.sha256) corrupt(detail + ':blob-sha256');
  return bytes;
}

// ── B+ tree over routing digests, copy-on-write ──────────────────────────────────────────────────────────────────────
export function routingDigest(tree: number, key: string): string {
  const id = Buffer.alloc(2); id.writeUInt16LE(tree, 0);
  return domainHash(DOMAIN.key, Buffer.concat([id, Buffer.from(key, 'utf16le').swap16()]));
}
export interface Bucket { digest: string; count: number; pairs: [string, string][] }
/** A bucket as a leaf stores it (its stored value, inline pairs or an overflow descriptor) with its encoded size. */
interface LeafItem { digest: string; count: number; value: any; bytes: number }
interface LeafNode { kind: 1; low: string | null; high: string | null; count: number; entries: { digest: string; count: number; value: any }[] }
interface BranchNode { kind: 2; low: string | null; high: string | null; count: number; children: ChildDescriptor[]; level: number }
export interface ChildDescriptor { low: string | null; high: string | null; count: number; ref: PageRef }
const below = (digest: string, high: string | null) => high === null || digest < high;
const atLeast = (digest: string, low: string | null) => low === null || digest >= low;
function bound(value: unknown, detail: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HEX64.test(value)) return corrupt(detail + ':bound');
  return value;
}
function pairsOf(raw: unknown, detail: string): [string, string][] {
  if (!Array.isArray(raw) || !raw.length) return corrupt(detail + ':pairs');
  const pairs: [string, string][] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') return corrupt(detail + ':pair');
    if (pairs.length && !(item[0] > pairs[pairs.length - 1][0])) corrupt(detail + ':pair-order');
    pairs.push([item[0], item[1]]);
  }
  return pairs;
}
function decodeLeaf(header: PageHeader, payload: Buffer, low: string | null, high: string | null): LeafNode {
  const d = 'leaf ' + header.pack + '/' + header.page;
  const body = parseCanonical(payload, d);
  if (!isRecord(body) || Object.keys(body).length !== 4 || !Array.isArray(body.entries)) corrupt(d + ':shape');
  if (bound(body.low, d) !== low || bound(body.high, d) !== high) corrupt(d + ':range');
  const count = parseDecimal(body.count, d);
  if (header.entryCount !== body.entries.length) corrupt(d + ':entry-count');
  let total = 0, previous: string | null = null;
  const entries = body.entries.map((e: unknown) => {
    if (!isRecord(e) || Object.keys(e).length !== 3 || typeof e.digest !== 'string' || !HEX64.test(e.digest)) return corrupt(d + ':entry');
    if (previous !== null && !(e.digest > previous)) corrupt(d + ':entry-order');
    if (!atLeast(e.digest, low) || !below(e.digest, high)) corrupt(d + ':entry-range');
    previous = e.digest;
    const c = parseDecimal(e.count, d); if (c < 1) corrupt(d + ':bucket-empty');
    total += c;
    const value = e.value as Record<string, unknown>;
    if (!isRecord(value) || Object.keys(value).length !== 1) corrupt(d + ':value');
    if ('inline' in value) { const pairs = pairsOf(value.inline, d); if (pairs.length !== c) corrupt(d + ':bucket-count'); }
    else if ('overflow' in value) validBlobDescriptor(value.overflow, d);
    else corrupt(d + ':value-kind');
    return { digest: e.digest, count: c, value };
  });
  if (total !== count) corrupt(d + ':count');
  return { kind: 1, low, high, count, entries };
}
function decodeBranch(header: PageHeader, payload: Buffer, low: string | null, high: string | null): BranchNode {
  const d = 'branch ' + header.pack + '/' + header.page;
  const body = parseCanonical(payload, d);
  if (!isRecord(body) || Object.keys(body).length !== 4 || !Array.isArray(body.children)) corrupt(d + ':shape');
  if (bound(body.low, d) !== low || bound(body.high, d) !== high) corrupt(d + ':range');
  const count = parseDecimal(body.count, d);
  if (header.entryCount !== body.children.length || body.children.length < 1) corrupt(d + ':children');
  let total = 0;
  const children: ChildDescriptor[] = body.children.map((c: unknown, i: number) => {
    if (!isRecord(c) || Object.keys(c).length !== 4) return corrupt(d + ':child');
    const cl = bound(c.low, d), ch = bound(c.high, d), cc = parseDecimal(c.count, d), ref = validRef(c.ref, d);
    if (cl !== null && ch !== null && !(cl < ch)) corrupt(d + ':child-range');
    total += cc;
    return { low: cl, high: ch, count: cc, ref };
  });
  if (children[0].low !== low || children[children.length - 1].high !== high) corrupt(d + ':partition-ends');
  for (let i = 1; i < children.length; i++) if (children[i].low !== children[i - 1].high || children[i].low === null) corrupt(d + ':partition');
  if (total !== count) corrupt(d + ':count');
  return { kind: 2, low, high, count, children, level: header.level };
}
/** Contiguous groups of items (their encoded sizes, separators included) within `capacity` bytes each: the fewest
 * groups a greedy fill needs, then evened out so that every group holds about the same bytes. A split therefore
 * yields halves - never a full page and a one-item remainder, whose tiny interval almost never receives another
 * member while the full page splits again at the next insert (one more tiny sibling per split, a fan-out that grows
 * with the member count and overflows the parent). Groups keep `minimum` items whenever the item count allows.
 * Returns the end index of each group. */
export function partitionSizes(sizes: number[], capacity: number, minimum: number): number[] {
  const n = sizes.length;
  const greedy: number[] = [];
  { let bytes = 0, count = 0; for (let i = 0; i < n; i++) { if (count >= minimum && bytes + sizes[i] > capacity) { greedy.push(i); bytes = 0; count = 0; } bytes += sizes[i]; count++; } greedy.push(n); }
  // The greedy fill with a too-small last group folded into its predecessor: the fallback only (a pathological item
  // mix no even partition can respect); the fold is what overflowed a 218-child branch split (217 + 1 -> 218).
  const folded = () => { if (greedy.length > 1 && n - greedy[greedy.length - 2] < minimum) greedy.splice(greedy.length - 2, 1); return greedy; };
  const k = greedy.length;
  if (k === 1) return greedy;
  const ends: number[] = [];
  let bytes = 0, count = 0, unplaced = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const groupsLeft = k - ends.length - 1, target = Math.ceil((bytes + unplaced) / (groupsLeft + 1));
    if (groupsLeft > 0 && count >= minimum && n - i >= groupsLeft * minimum && (bytes + sizes[i] > capacity || bytes >= target)) { ends.push(i); bytes = 0; count = 0; }
    bytes += sizes[i]; count++; unplaced -= sizes[i];
  }
  ends.push(n);
  // The evened-out groups must respect the capacity exactly as the greedy ones do; otherwise the greedy ones stand.
  let start = 0;
  for (const end of ends) { let b = 0; for (let i = start; i < end; i++) b += sizes[i]; if (b > capacity) return folded(); start = end; }
  return ends;
}
/** One logical tree of the checkpoint: lookups verify the whole route; `apply` builds the copy-on-write replacement
 * pages for a batch of changes and returns the new root descriptor. Leaves are never merged (an emptied leaf keeps its
 * interval); splits keep the partition exact and even (`partitionSizes`); a one-child root is collapsed. */
export class Tree {
  constructor(readonly store: PackStore, readonly id: number, readonly root: PageRef, readonly count: number, readonly level: number) {}
  private node(ref: PageRef, level: number, low: string | null, high: string | null): LeafNode | BranchNode {
    return this.store.page(ref, { tree: this.id, level, kind: level === 0 ? KIND.leaf : KIND.branch }, (h, p) =>
      level === 0 ? decodeLeaf(h, p, low, high) : decodeBranch(h, p, low, high), level === 0 ? 'leaf' : 'branch');
  }
  private bucketPairs(entry: { digest: string; value: any }): [string, string][] {
    if ('inline' in entry.value) return entry.value.inline as [string, string][];
    const raw = readBlob(this.store, entry.value.overflow, this.id, 'bucket ' + entry.digest);
    const pairs = pairsOf(parseCanonical(raw, 'bucket ' + entry.digest), 'bucket ' + entry.digest);
    return pairs;
  }
  /** The member's raw value JSON, or undefined only after a verified route and bucket absence. */
  get(key: string): string | undefined {
    const digest = routingDigest(this.id, key);
    let ref = this.root, level = this.level, low: string | null = null, high: string | null = null;
    for (;;) {
      const node = this.node(ref, level, low, high);
      if (node.kind === 1) {
        const entry = node.entries.find(e => e.digest === digest);
        if (!entry) return undefined;
        const pair = this.bucketPairs(entry).find(p => p[0] === key);
        return pair ? pair[1] : undefined;
      }
      const child = node.children.find(c => atLeast(digest, c.low) && below(digest, c.high));
      if (!child) corrupt('branch:no-child');
      ref = child.ref; level = node.level - 1; low = child.low; high = child.high;
    }
  }
  /** Every (key, raw) pair in routing order (full keys inside a bucket in code-unit order). */
  *entries(): Generator<[string, string]> {
    const walk = function* (this: Tree, ref: PageRef, level: number, low: string | null, high: string | null): Generator<[string, string]> {
      const node = this.node(ref, level, low, high);
      if (node.kind === 1) { for (const entry of node.entries) for (const pair of this.bucketPairs(entry)) yield pair; return; }
      for (const child of node.children) yield* walk.call(this, child.ref, node.level - 1, child.low, child.high);
    }.bind(this);
    yield* walk(this.root, this.level, null, null);
  }
  /** Every page reference reachable from this tree (nodes and overflow chains), for liveness accounting and copies. */
  *pages(): Generator<PageRef> {
    for (const [ref] of this.pagesWithOwners()) yield ref;
  }
  /** Every reachable page with, for an overflow page, the bucket (tree, digest) whose chain it belongs to (the route
   * that must be rewritten to move it); a node page carries null. */
  *pagesWithOwners(): Generator<[PageRef, PageOwner | null]> {
    const walk = function* (this: Tree, ref: PageRef, level: number, low: string | null, high: string | null): Generator<[PageRef, PageOwner | null]> {
      yield [ref, null];
      const node = this.node(ref, level, low, high);
      if (node.kind === 1) {
        for (const entry of node.entries) if ('overflow' in entry.value) for (const p of blobPages(this.store, entry.value.overflow, this.id)) yield [p, { tree: this.id, digest: entry.digest }];
        return;
      }
      for (const child of node.children) yield* walk.call(this, child.ref, node.level - 1, child.low, child.high);
    }.bind(this);
    yield* walk(this.root, this.level, null, null);
  }
  /** Open a tree from its root descriptor: the root page's verified header supplies the level. */
  static open(store: PackStore, id: number, ref: PageRef, count: number): Tree {
    const level = store.page(ref, { tree: id }, h => h.level, 'header');
    return new Tree(store, id, ref, count, level);
  }
  static empty(writer: PackWriter, id: number): Tree {
    const ref = writer.append(KIND.leaf, id, 0, 0, Buffer.from(canonical({ low: null, high: null, count: '0', entries: [] })));
    return new Tree(writer.store, id, ref, 0, 0);
  }
  /** Copy-on-write batch update: `changes` maps full keys to raw value JSON (set) or null (delete). The pages the new
   * root no longer references (the replaced nodes, the replaced buckets' overflow chains and the collapsed one-child
   * branches written here) are appended to `orphans`: the liveness accounting of pack reclamation. */
  apply(writer: PackWriter, changes: Map<string, string | null>, orphans?: PageRef[]): Tree {
    if (!changes.size) return this;
    const byDigest = new Map<string, Map<string, string | null>>();
    for (const [key, value] of changes) { const d = routingDigest(this.id, key); let m = byDigest.get(d); if (!m) byDigest.set(d, m = new Map()); m.set(key, value); }
    return this.rewrite(writer, [...byDigest.keys()].sort(), byDigest, orphans);
  }
  /** Copy-on-write rewrite of the routes to `digests` with no logical change: the same members, the same partition,
   * the pages on those routes relocated into the writer's current pack; the replaced pages are the orphans. An
   * unchanged overflow chain is reused, never rewritten - unless it occupies a pack in `evacuate`: then the bucket is
   * re-encoded (a bounded copy of its pairs into a new chain) and the old chain is orphaned. */
  touch(writer: PackWriter, digests: string[], orphans?: PageRef[], evacuate?: Set<string>): Tree {
    const sorted = [...new Set(digests)].sort();
    if (!sorted.length) return this;
    return this.rewrite(writer, sorted, new Map(sorted.map(d => [d, new Map<string, string | null>()])), orphans, evacuate);
  }
  /** The node at `level` whose interval contains `digest` (the route from the root), with its interval. */
  locate(level: number, digest: string): { ref: PageRef; low: string | null; high: string | null } {
    if (level > this.level || level < 0) corrupt('locate:level');
    let ref = this.root, at = this.level, low: string | null = null, high: string | null = null;
    while (at > level) {
      const node = this.node(ref, at, low, high) as BranchNode;
      const child = node.children.find(c => atLeast(digest, c.low) && below(digest, c.high));
      if (!child) corrupt('branch:no-child');
      ref = child.ref; at = node.level - 1; low = child.low; high = child.high;
    }
    return { ref, low, high };
  }
  private rewrite(writer: PackWriter, digests: string[], byDigest: Map<string, Map<string, string | null>>, orphans?: PageRef[], evacuate?: Set<string>): Tree {
    const descriptors = this.update(writer, this.root, this.level, null, null, digests, byDigest, orphans, evacuate);
    let level = this.level, children = descriptors;
    while (children.length > 1) { children = this.writeBranches(writer, children, level + 1, null, null); level++; }
    let root = children[0];
    // Collapse a one-child chain to the first node that is a leaf or has several children.
    while (level > 0) {
      const node = this.node(root.ref, level, null, null) as BranchNode;
      if (node.children.length !== 1) break;
      orphans?.push(root.ref);
      root = node.children[0]; level--;
    }
    return new Tree(this.store, this.id, root.ref, root.count, level);
  }
  private update(writer: PackWriter, ref: PageRef, level: number, low: string | null, high: string | null, digests: string[], byDigest: Map<string, Map<string, string | null>>, orphans?: PageRef[], evacuate?: Set<string>): ChildDescriptor[] {
    const node = this.node(ref, level, low, high);
    orphans?.push(ref);
    if (node.kind === 1) {
      // Unchanged buckets keep their stored value (an overflow chain is reused, not read or rewritten); a changed
      // bucket is re-encoded from its pairs, and its former overflow chain is orphaned.
      const buckets = new Map<string, LeafItem>();
      for (const entry of node.entries) buckets.set(entry.digest, { digest: entry.digest, count: entry.count, value: entry.value, bytes: Buffer.byteLength(canonical({ digest: entry.digest, count: String(entry.count), value: entry.value })) });
      for (const digest of digests) {
        const existing = buckets.get(digest), edits = byDigest.get(digest)!;
        if (!edits.size && existing && 'overflow' in existing.value) {
          // A relocation touch of an overflow bucket: its chain stays where it is unless a page of it occupies a pack
          // being evacuated - then the bucket is re-encoded into a new chain and the old one orphaned.
          const chain = [...blobPages(this.store, existing.value.overflow, this.id)];
          if (!evacuate || !chain.some(p => evacuate.has(p.pack))) continue;
          orphans?.push(...chain);
        } else if (existing && orphans && 'overflow' in existing.value && edits.size) for (const p of blobPages(this.store, existing.value.overflow, this.id)) orphans.push(p);
        const pairs = new Map(existing ? this.bucketPairs({ digest, value: existing.value }) : []);
        for (const [key, value] of edits) { if (value === null) pairs.delete(key); else pairs.set(key, value); }
        if (!pairs.size) { buckets.delete(digest); continue; }
        buckets.set(digest, this.encodeBucket(writer, digest, [...pairs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));
      }
      return this.writeLeafItems(writer, [...buckets.values()].sort((a, b) => (a.digest < b.digest ? -1 : 1)), low, high);
    }
    const next: ChildDescriptor[] = [];
    let at = 0;
    for (const child of node.children) {
      const mine: string[] = [];
      while (at < digests.length && below(digests[at], child.high)) { if (atLeast(digests[at], child.low)) mine.push(digests[at]); at++; }
      if (!mine.length) { next.push(child); continue; }
      next.push(...this.update(writer, child.ref, node.level - 1, child.low, child.high, mine, byDigest, orphans, evacuate));
    }
    return this.writeBranches(writer, next, node.level, low, high);
  }
  /** One bucket's stored encoding: inline while the whole page could hold it, otherwise a new overflow chain. */
  private encodeBucket(writer: PackWriter, digest: string, pairs: [string, string][]): LeafItem {
    const inline = canonical({ digest, count: String(pairs.length), value: { inline: pairs } });
    if (Buffer.byteLength(inline) <= BODY_CAPACITY - 160) return { digest, count: pairs.length, value: { inline: pairs }, bytes: Buffer.byteLength(inline) };
    const descriptor = writeBlob(writer, this.id, Buffer.from(canonical(pairs)));
    writer.overflowRoutes.push({ tree: this.id, digest, descriptor });
    const text = canonical({ digest, count: String(pairs.length), value: { overflow: descriptor } });
    return { digest, count: pairs.length, value: { overflow: descriptor }, bytes: Buffer.byteLength(text) };
  }
  /** Leaves for sorted buckets within [low, high): inline values while the page fits, overflow for oversized buckets,
   * splits at bucket boundaries. */
  private writeLeaves(writer: PackWriter, buckets: [string, [string, string][]][], low: string | null, high: string | null): ChildDescriptor[] {
    return this.writeLeafItems(writer, buckets.map(([digest, pairs]) => this.encodeBucket(writer, digest, pairs)), low, high);
  }
  private writeLeafItems(writer: PackWriter, items: LeafItem[], low: string | null, high: string | null): ChildDescriptor[] {
    const chunks: typeof items[] = [];
    let start = 0;
    for (const end of partitionSizes(items.map(item => item.bytes + 1), BODY_CAPACITY - 200, 1)) { chunks.push(items.slice(start, end)); start = end; }
    const out: ChildDescriptor[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const cl = i === 0 ? low : chunk[0].digest, ch = i === chunks.length - 1 ? high : chunks[i + 1][0].digest;
      const count = chunk.reduce((n, e) => n + e.count, 0);
      const payload = Buffer.from(canonical({ low: cl, high: ch, count: String(count), entries: chunk.map(e => ({ digest: e.digest, count: String(e.count), value: e.value })) }));
      if (payload.length > BODY_CAPACITY) corrupt('leaf-overflow-internal');
      out.push({ low: cl, high: ch, count, ref: writer.append(KIND.leaf, this.id, 0, chunk.length, payload) });
    }
    return out;
  }
  private writeBranches(writer: PackWriter, children: ChildDescriptor[], level: number, low: string | null, high: string | null): ChildDescriptor[] {
    const encode = (c: ChildDescriptor) => ({ low: c.low, high: c.high, count: String(c.count), ref: c.ref });
    const sizes = children.map(c => Buffer.byteLength(canonical(encode(c))) + 1);
    const groups: ChildDescriptor[][] = [];
    let start = 0;
    for (const end of partitionSizes(sizes, BODY_CAPACITY - 200, 2)) { groups.push(children.slice(start, end)); start = end; }
    return groups.map(group => {
      const gl = group[0].low, gh = group[group.length - 1].high, count = group.reduce((n, c) => n + c.count, 0);
      const payload = Buffer.from(canonical({ low: gl, high: gh, count: String(count), children: group.map(encode) }));
      if (payload.length > BODY_CAPACITY) corrupt('branch-overflow-internal');
      return { low: gl, high: gh, count, ref: writer.append(KIND.branch, this.id, level, group.length, payload) };
    });
  }
  /** Bulk load from members sorted by routing digest (then full key): one streaming pass writes the leaves in order and
   * the branches bottom-up; a conversion's way to build a tree of any size without a change map in memory. */
  static bulk(writer: PackWriter, id: number, members: Iterable<[string, string, string]>): Tree {
    const builder = new Tree(writer.store, id, { pack: 'f'.repeat(32), page: '0', sha256: 'f'.repeat(64) }, 0, 0);
    let chunk: [string, [string, string][]][] = [], chunkBytes = 0, low: string | null = null;
    let bucket: [string, [string, string][]] | null = null;
    const leaves: ChildDescriptor[] = [];
    const flush = (high: string | null) => {
      if (!chunk.length && leaves.length) return;
      leaves.push(...builder.writeLeaves(writer, chunk, low, high));
      low = high; chunk = []; chunkBytes = 0;
    };
    const take = (b: [string, [string, string][]]) => {
      const bytes = Buffer.byteLength(canonical({ digest: b[0], count: String(b[1].length), value: { inline: b[1] } }));
      if (chunk.length && chunkBytes + bytes + 1 > BODY_CAPACITY - 200) flush(b[0]);
      chunk.push(b); chunkBytes += Math.min(bytes, 512) + 1;
    };
    let previousKey: string | null = null, previousDigest: string | null = null;
    for (const [digest, key, raw] of members) {
      if (previousDigest !== null && (digest < previousDigest || (digest === previousDigest && !(key > previousKey!)))) corrupt('bulk:order');
      previousDigest = digest; previousKey = key;
      if (bucket && bucket[0] === digest) { bucket[1].push([key, raw]); continue; }
      if (bucket) take(bucket);
      bucket = [digest, [[key, raw]]];
    }
    if (bucket) take(bucket);
    flush(null);
    if (!leaves.length) return Tree.empty(writer, id);
    let level = 0, children = leaves;
    while (children.length > 1) { children = builder.writeBranches(writer, children, level + 1, null, null); level++; }
    return new Tree(writer.store, id, children[0].ref, children[0].count, level);
  }
  /** Full structural check of the tree: every page, global partition, counts, uniqueness, buckets and blobs. Returns
   * the verified key count and page count. */
  check(): { keys: number; pages: number } {
    let keys = 0, pages = 0; let previousDigest: string | null = null;
    const seenPages = new Set<string>();
    const walk = (ref: PageRef, level: number, low: string | null, high: string | null, expectedCount: number): void => {
      const id = ref.pack + ':' + ref.page; if (seenPages.has(id)) corrupt('tree:shared-page'); seenPages.add(id); pages++;
      const node = this.node(ref, level, low, high);
      if (node.count !== expectedCount) corrupt('tree:count');
      if (node.kind === 1) {
        for (const entry of node.entries) {
          if (previousDigest !== null && !(entry.digest > previousDigest)) corrupt('tree:global-order'); previousDigest = entry.digest;
          const pairs = this.bucketPairs(entry);
          if (pairs.length !== entry.count) corrupt('tree:bucket-count');
          for (const [key] of pairs) if (routingDigest(this.id, key) !== entry.digest) corrupt('tree:bucket-digest');
          if ('overflow' in entry.value) for (const p of blobPages(this.store, entry.value.overflow, this.id)) { const pid = p.pack + ':' + p.page; if (seenPages.has(pid)) corrupt('tree:shared-page'); seenPages.add(pid); pages++; }
          keys += pairs.length;
        }
        return;
      }
      if (node.children.length < 2 && !(level === this.level && node.children.length === 1 && false)) { if (node.children.length < 2) corrupt('tree:branch-children'); }
      for (const child of node.children) walk(child.ref, node.level - 1, child.low, child.high, child.count);
    };
    walk(this.root, this.level, null, null, this.count);
    if (keys !== this.count) corrupt('tree:total');
    return { keys, pages };
  }
  /** A bounded, resumable walk of the leaves in digest order from the leaf boundary `from` (null: the first leaf): at
   * most `maxLeaves` leaf pages per call, every visited page verified on use (header, bounds, partition, counts), every
   * bucket's count and routing checked, every overflow chain followed, and `member` applied to every key/value. Returns
   * the boundary (the completed leaf's `high`) to continue from; `done` when the walk reached the end of the tree. The
   * caller sums `keys` against the root count. `visit` sees every reachable page exactly once over a complete walk
   * (leaves and overflow pages when their leaf is processed, a branch in the step that starts at its lower bound), so
   * a sweep can rebuild the per-pack liveness accounting; an overflow page comes with the bucket that owns its chain. */
  checkFrom(from: string | null, maxLeaves: number, member?: (key: string, raw: string) => void, visit?: (ref: PageRef, owner: PageOwner | null) => void): { next: string | null; keys: number; pages: number; done: boolean } {
    let keys = 0, pages = 0, leaves = 0, last: string | null = null, next: string | null = from, done = true;
    const walk = (ref: PageRef, level: number, low: string | null, high: string | null, expectedCount: number): boolean => {
      if (high !== null && from !== null && high <= from) return true;   // entirely before the cursor: already checked
      const node = this.node(ref, level, low, high); pages++;
      if (node.count !== expectedCount) corrupt('tree:count');
      if (node.kind === 1) {
        if (leaves >= maxLeaves) { done = false; return false; }
        leaves++; visit?.(ref, null);
        for (const entry of node.entries) {
          if (last !== null && !(entry.digest > last)) corrupt('tree:global-order');
          const pairs = this.bucketPairs(entry);
          if (pairs.length !== entry.count) corrupt('tree:bucket-count');
          for (const [key, raw] of pairs) { if (routingDigest(this.id, key) !== entry.digest) corrupt('tree:bucket-digest'); member?.(key, raw); }
          if ('overflow' in entry.value) for (const p of blobPages(this.store, entry.value.overflow, this.id)) { pages++; visit?.(p, { tree: this.id, digest: entry.digest }); }
          keys += pairs.length; last = entry.digest;
        }
        next = high;
        return true;
      }
      if (node.children.length < 2) corrupt('tree:branch-children');
      // A branch is first entered in the step whose cursor is its lower bound (an earlier step that ran out of budget at
      // its first leaf left the cursor there); that is its one counted visit.
      if (low === null ? from === null : low === from) visit?.(ref, null);
      for (const child of node.children) if (!walk(child.ref, node.level - 1, child.low, child.high, child.count)) return false;
      return true;
    };
    walk(this.root, this.level, null, null, this.count);
    return { next: done ? null : next, keys, pages, done };
  }
}
/** The bucket a reachable overflow page belongs to (a node page has no owner but itself). */
export interface PageOwner { tree: number; digest: string }
/** The pages of one overflow chain in order (each page verified on the read that names its successor). */
export function* blobPages(store: PackStore, descriptor: BlobDescriptor, tree: number): Generator<PageRef> {
  const pages = parseDecimal(descriptor.pages, 'blob');
  let ref: PageRef | null = descriptor.first;
  for (let i = 0; i < pages && ref; i++) {
    yield ref;
    const current = ref;
    ref = store.page(current, { kind: KIND.overflow, tree, level: 0 }, (_h, payload) => refFromBinary(payload.subarray(0, REF_BYTES), 'blob'), 'blob-next');
  }
}

// ── root, selector and WAL envelopes ─────────────────────────────────────────────────────────────────────────────────
export interface TreeDescriptor { id: TreeId; count: string; ref: PageRef }
export interface Transition { previousRoot: string | null; kind: 'initialize' | 'import-v3' | 'patch' | 'compact' | 'scrub'; changes: null | { inline: Change[] } | { overflow: BlobDescriptor } }
export interface Change { tree: TreeId; key: string; beforeSha256: string | null; afterSha256: string | null; dependencies: { tree: TreeId; key: string }[] }
export interface FullCheck { checkedRoot: string | null; coverageSha256: string; checkedRevision: string; validatorSha256: string; completedAt: string; dbWitnessSha256: string }
export interface RootBody {
  format: typeof V4_FORMAT; version: 4; layout: 1; validatorId: typeof V4_VALIDATOR_ID; validatorSha256: string; revision: string; generation: string;
  lineageSha256: string; trees: TreeDescriptor[]; stateTailSha256: string | null; transition: Transition; fullCheck: FullCheck;
}
export interface SelectorBody { format: typeof V4_FORMAT; version: 4; layout: 1; rootSha256: string; revision: string; wal: { segment: string; offset: string; lsn: string; previousSha256: string } }
const exactKeys = (v: unknown, keys: string[], detail: string): Record<string, any> => {
  if (!isRecord(v) || Object.keys(v).length !== keys.length || keys.some(k => !(k in v))) return corrupt(detail + ':keys');
  return v as Record<string, any>;
};
export function validRootBody(value: unknown): RootBody {
  const d = 'root';
  const r = exactKeys(value, ['format', 'version', 'layout', 'validatorId', 'validatorSha256', 'revision', 'generation', 'lineageSha256', 'trees', 'stateTailSha256', 'transition', 'fullCheck'], d);
  if (r.format !== V4_FORMAT || r.version !== V4_VERSION || r.layout !== V4_LAYOUT || r.validatorId !== V4_VALIDATOR_ID) {
    if (r.format !== V4_FORMAT || r.version !== V4_VERSION) throw new V4Error('SealUnsupportedFormat', 'root-format');
    corrupt(d + ':layout-or-validator');
  }
  if (typeof r.validatorSha256 !== 'string' || !HEX64.test(r.validatorSha256) || typeof r.lineageSha256 !== 'string' || !HEX64.test(r.lineageSha256)) corrupt(d + ':hashes');
  parseDecimal(r.revision, d); parseDecimal(r.generation, d);
  if (!(r.stateTailSha256 === null || (typeof r.stateTailSha256 === 'string' && HEX64.test(r.stateTailSha256)))) corrupt(d + ':tail');
  if (!Array.isArray(r.trees) || r.trees.length !== 8) corrupt(d + ':trees');
  r.trees.forEach((t: unknown, i: number) => { const td = exactKeys(t, ['id', 'count', 'ref'], d + ':tree'); if (td.id !== i + 1) corrupt(d + ':tree-order'); parseDecimal(td.count, d); validRef(td.ref, d + ':tree'); });
  const tr = exactKeys(r.transition, ['previousRoot', 'kind', 'changes'], d + ':transition');
  if (!(tr.previousRoot === null || (typeof tr.previousRoot === 'string' && HEX64.test(tr.previousRoot)))) corrupt(d + ':previousRoot');
  if (!['initialize', 'import-v3', 'patch', 'compact', 'scrub'].includes(tr.kind)) corrupt(d + ':transition-kind');
  if (tr.kind === 'initialize' || tr.kind === 'import-v3') { if (tr.changes !== null || tr.previousRoot !== null) corrupt(d + ':initial-transition'); }
  else {
    if (tr.previousRoot === null) corrupt(d + ':previousRoot-required');
    if (!isRecord(tr.changes) || Object.keys(tr.changes).length !== 1) corrupt(d + ':changes');
    if ('inline' in tr.changes) validChanges(tr.changes.inline, d);
    else if ('overflow' in tr.changes) validBlobDescriptor(tr.changes.overflow, d);
    else corrupt(d + ':changes-kind');
  }
  validFullCheck(r.fullCheck, d);
  return r as RootBody;
}
export function validChanges(value: unknown, detail: string): Change[] {
  if (!Array.isArray(value)) return corrupt(detail + ':change-array');
  let previous: { tree: number; key: string } | null = null;
  return value.map((c: unknown) => {
    const ch = exactKeys(c, ['tree', 'key', 'beforeSha256', 'afterSha256', 'dependencies'], detail + ':change');
    if (!TREE_IDS.includes(ch.tree) || typeof ch.key !== 'string') corrupt(detail + ':change-identity');
    for (const f of ['beforeSha256', 'afterSha256']) if (!(ch[f] === null || (typeof ch[f] === 'string' && HEX64.test(ch[f])))) corrupt(detail + ':change-hash');
    if (previous && !(ch.tree > previous.tree || (ch.tree === previous.tree && ch.key > previous.key))) corrupt(detail + ':change-order');
    previous = { tree: ch.tree, key: ch.key };
    if (!Array.isArray(ch.dependencies)) corrupt(detail + ':dependencies');
    let last: { tree: number; key: string } | null = null;
    for (const dep of ch.dependencies) {
      const dd = exactKeys(dep, ['tree', 'key'], detail + ':dependency');
      if (!TREE_IDS.includes(dd.tree) || typeof dd.key !== 'string') corrupt(detail + ':dependency-identity');
      if (last && !(dd.tree > last.tree || (dd.tree === last.tree && dd.key > last.key))) corrupt(detail + ':dependency-order');
      last = { tree: dd.tree, key: dd.key };
    }
    return ch as Change;
  });
}
export function validFullCheck(value: unknown, detail: string): FullCheck {
  const f = exactKeys(value, ['checkedRoot', 'coverageSha256', 'checkedRevision', 'validatorSha256', 'completedAt', 'dbWitnessSha256'], detail + ':fullCheck');
  if (!(f.checkedRoot === null || (typeof f.checkedRoot === 'string' && HEX64.test(f.checkedRoot)))) corrupt(detail + ':fullCheck-root');
  for (const k of ['coverageSha256', 'validatorSha256', 'dbWitnessSha256']) if (typeof f[k] !== 'string' || !HEX64.test(f[k])) corrupt(detail + ':fullCheck-hash');
  parseDecimal(f.checkedRevision, detail + ':fullCheck');
  if (typeof f.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(f.completedAt) || !Number.isFinite(Date.parse(f.completedAt))) corrupt(detail + ':fullCheck-time');
  return f as FullCheck;
}
export function validSelectorBody(value: unknown): SelectorBody {
  const d = 'selector';
  const s = exactKeys(value, ['format', 'version', 'layout', 'rootSha256', 'revision', 'wal'], d);
  if (s.format !== V4_FORMAT || s.version !== V4_VERSION) throw new V4Error('SealUnsupportedFormat', 'selector-format');
  if (s.layout !== V4_LAYOUT || typeof s.rootSha256 !== 'string' || !HEX64.test(s.rootSha256)) corrupt(d + ':layout-or-root');
  parseDecimal(s.revision, d);
  const w = exactKeys(s.wal, ['segment', 'offset', 'lsn', 'previousSha256'], d + ':wal');
  if (typeof w.segment !== 'string' || !HEX32.test(w.segment) || typeof w.previousSha256 !== 'string' || !HEX64.test(w.previousSha256)) corrupt(d + ':wal-identity');
  parseDecimal(w.offset, d + ':wal'); parseDecimal(w.lsn, d + ':wal');
  return s as SelectorBody;
}
export function rootsDirectory(v4: string): string { return path.join(v4, 'roots'); }
export function walDirectory(v4: string): string { return path.join(v4, 'wal'); }
/** Publish an immutable root envelope: `roots/<rootSha256>.json`, temporary write, fsync, rename, directory fsync. */
export function writeRoot(v4: string, body: RootBody): string {
  validRootBody(body);
  const { text, sha256 } = envelope(DOMAIN.root, body);
  const dir = rootsDirectory(v4); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, sha256 + '.json');
  if (fs.existsSync(file)) { if (fs.readFileSync(file, 'utf8') !== text) corrupt('root-exists-differently'); return sha256; }
  writeAtomic(file, text);
  return sha256;
}
export function readRoot(v4: string, sha256: string): RootBody {
  if (!HEX64.test(sha256)) corrupt('root-name');
  const file = path.join(rootsDirectory(v4), sha256 + '.json');
  const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw new V4Error('SealCorrupt', 'root-missing:' + sha256);
  if (info.size > CONTROL_MAX_BYTES) corrupt('root-too-large');
  const opened = openEnvelope(DOMAIN.root, fs.readFileSync(file), 'root');
  if (opened.sha256 !== sha256) corrupt('root-name-mismatch');
  return validRootBody(opened.body);
}
export function writeAtomic(file: string, text: string): void {
  const temporary = path.join(path.dirname(file), '.tmp-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}
export function writeSelector(file: string, body: SelectorBody): string {
  validSelectorBody(body);
  const { text, sha256 } = envelope(DOMAIN.selector, body);
  writeAtomic(file, text);
  return sha256;
}
/** The selector, or null when the file does not exist; a v3 checkpoint at that path is SealUnsupportedFormat. */
export function readSelector(file: string): { body: SelectorBody; sha256: string } | null {
  const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) corrupt('selector-not-file');
  if (info.size > CONTROL_MAX_BYTES) {
    // A v3 checkpoint is far larger than any selector; name it as the other supported format.
    throw new V4Error('SealUnsupportedFormat', 'selector-size');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 9).toString('latin1') === '{"state":') throw new V4Error('SealUnsupportedFormat', 'v3-checkpoint');
  const opened = openEnvelope(DOMAIN.selector, bytes, 'selector');
  return { body: validSelectorBody(opened.body), sha256: opened.sha256 };
}

// ── v4 transition WAL ─────────────────────────────────────────────────────────────────────────────────────────────────
export type WalRecord =
  | { format: 'KIN-EMR-WAL'; version: 4; segment: string; lsn: string; previousSha256: string; type: 'start'; baseRoot: string; previousSegment: null | { segment: string; finalSha256: string } }
  | { format: 'KIN-EMR-WAL'; version: 4; segment: string; lsn: string; previousSha256: string; type: 'prepare'; previousRoot: string | null; nextRoot: string; transitionSha256: string; tailBefore: string | null; tailAfter: string | null }
  | { format: 'KIN-EMR-WAL'; version: 4; segment: string; lsn: string; previousSha256: string; type: 'complete'; prepareLsn: string; nextRoot: string };
export const ZERO64 = '0'.repeat(64);
export function validWalRecord(value: unknown): WalRecord {
  const d = 'wal';
  if (!isRecord(value) || value.format !== 'KIN-EMR-WAL' || value.version !== 4) throw new V4Error('SealUnsupportedFormat', 'wal-format');
  const common = ['format', 'version', 'segment', 'lsn', 'previousSha256', 'type'];
  const extra: Record<string, string[]> = { start: ['baseRoot', 'previousSegment'], prepare: ['previousRoot', 'nextRoot', 'transitionSha256', 'tailBefore', 'tailAfter'], complete: ['prepareLsn', 'nextRoot'] };
  const type = value.type;
  if (typeof type !== 'string' || !(type in extra)) return corrupt(d + ':type');
  const r = exactKeys(value, [...common, ...extra[type]], d);
  if (typeof r.segment !== 'string' || !HEX32.test(r.segment) || typeof r.previousSha256 !== 'string' || !HEX64.test(r.previousSha256)) corrupt(d + ':identity');
  parseDecimal(r.lsn, d);
  const hex = (v: unknown) => typeof v === 'string' && HEX64.test(v);
  if (r.type === 'start') {
    if (!hex(r.baseRoot)) corrupt(d + ':baseRoot');
    if (r.previousSegment !== null) { const p = exactKeys(r.previousSegment, ['segment', 'finalSha256'], d + ':previousSegment'); if (typeof p.segment !== 'string' || !HEX32.test(p.segment) || !hex(p.finalSha256)) corrupt(d + ':previousSegment'); }
  } else if (r.type === 'prepare') {
    if (!(r.previousRoot === null || hex(r.previousRoot)) || !hex(r.nextRoot) || !hex(r.transitionSha256) || !(r.tailBefore === null || hex(r.tailBefore)) || !(r.tailAfter === null || hex(r.tailAfter))) corrupt(d + ':prepare');
  } else { parseDecimal(r.prepareLsn, d); if (!hex(r.nextRoot)) corrupt(d + ':complete'); }
  return r as WalRecord;
}
export class WalSegment {
  readonly file: string;
  private fd: number | null = null;
  constructor(readonly v4: string, readonly segment: string) { this.file = path.join(walDirectory(v4), segment + '.jsonl'); }
  static create(v4: string): WalSegment {
    const dir = walDirectory(v4); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let id: string;
    do { id = randomBytes(16).toString('hex'); } while (fs.existsSync(path.join(dir, id + '.jsonl')) || /^0+$/.test(id));
    const segment = new WalSegment(v4, id);
    segment.fd = fs.openSync(segment.file, 'wx', 0o600);
    return segment;
  }
  open(): void { if (this.fd === null) this.fd = fs.openSync(this.file, 'a', 0o600); }
  /** Append one record, fdatasync, and return its envelope hash and byte extent. */
  append(record: WalRecord): { sha256: string; offset: number; end: number } {
    validWalRecord(record);
    this.open();
    const { text, sha256 } = envelope(DOMAIN.wal, record);
    const offset = fs.fstatSync(this.fd!).size;
    const bytes = Buffer.from(text);
    let written = 0;
    while (written < bytes.length) { const n = fs.writeSync(this.fd!, bytes, written, bytes.length - written, offset + written); if (n <= 0) corrupt('wal-short-write'); written += n; }
    fs.fdatasyncSync(this.fd!);
    return { sha256, offset, end: offset + bytes.length };
  }
  close(): void { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
  /** Complete records from `offset` with their byte extents; the torn suffix (if any) is returned separately. */
  static read(file: string, offset: number): { records: { record: WalRecord; sha256: string; offset: number; end: number }[]; torn: Buffer | null; size: number } {
    const size = fs.statSync(file).size;
    if (offset > size) corrupt('wal-offset-beyond-file');
    const raw = fs.readFileSync(file).subarray(offset);
    const records: { record: WalRecord; sha256: string; offset: number; end: number }[] = [];
    let at = 0;
    while (at < raw.length) {
      const lf = raw.indexOf(10, at);
      if (lf < 0) break;
      if (lf - at + 1 > CONTROL_MAX_BYTES) corrupt('wal-line-too-large');
      const line = raw.subarray(at, lf + 1);
      const opened = openEnvelope(DOMAIN.wal, line, 'wal');
      records.push({ record: validWalRecord(opened.body), sha256: opened.sha256, offset: offset + at, end: offset + lf + 1 });
      at = lf + 1;
    }
    return { records, torn: at < raw.length ? Buffer.from(raw.subarray(at)) : null, size };
  }
}

// ── validator manifest ────────────────────────────────────────────────────────────────────────────────────────────────
/** validatorSha256 = SHA-256 of J(path-sorted [{path,sha256}]) over every .ts file under api/src/emr-runtime and
 * api/src/emr-contract, api/src/emr-retention/contract.ts and every migration.sql under api/prisma/migrations. In the
 * reviewed image the manifest is carried as metadata (dist/emr-runtime/validator-manifest.json); from a source tree it
 * is computed from the files themselves. */
export function validatorManifest(sourceRoot: string): { files: { path: string; sha256: string }[]; validatorSha256: string } {
  const files: { path: string; sha256: string }[] = [];
  const add = (rel: string) => { const full = path.join(sourceRoot, rel); if (fs.existsSync(full) && fs.statSync(full).isFile()) files.push({ path: rel.replace(/\\/g, '/'), sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') }); };
  const walk = (rel: string, test: (name: string) => boolean) => {
    const full = path.join(sourceRoot, rel);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) walk(path.join(rel, entry.name), test); else if (entry.isFile() && test(entry.name)) add(path.join(rel, entry.name));
    }
  };
  walk('api/src/emr-runtime', n => n.endsWith('.ts')); walk('api/src/emr-contract', n => n.endsWith('.ts'));
  add('api/src/emr-retention/contract.ts');
  walk('api/prisma/migrations', n => n === 'migration.sql');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, validatorSha256: createHash('sha256').update(canonical(files)).digest('hex') };
}
export function loadValidatorManifest(sourceRoot: string): { files: { path: string; sha256: string }[]; validatorSha256: string } {
  const carried = path.join(sourceRoot, 'dist', 'emr-runtime', 'validator-manifest.json');
  if (fs.existsSync(carried)) {
    const m = JSON.parse(fs.readFileSync(carried, 'utf8'));
    if (!Array.isArray(m.files) || typeof m.validatorSha256 !== 'string' || createHash('sha256').update(canonical(m.files)).digest('hex') !== m.validatorSha256) corrupt('validator-manifest');
    return m;
  }
  return validatorManifest(sourceRoot);
}
export function lineageSha256(lineage: unknown): string { return domainHash(DOMAIN.lineage, canonical(lineage)); }
export const blobSha256 = (raw: string | Buffer): string => domainHash(DOMAIN.blob, raw);
