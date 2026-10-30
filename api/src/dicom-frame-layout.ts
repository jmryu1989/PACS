/*
 * MG-LOADING (Minhoon P0, 2026-10-27): WADO-RS frames of uncompressed multi-frame originals as byte ranges.
 *
 * Measured on the synthetic stack with the public EA1141 DBT set: Orthanc 1.12.5 + DICOMweb 1.18 serve every
 * `/frames/N` of a 1 GB tomosynthesis object by reading and MD5-checking the whole file (2.1-3.5 s each, one at a
 * time), so the eight hung panes of a current-vs-prior layout plus the study-browser thumbnails cost 20-30 s on the
 * laptop and 60-80 s on the 2-vCPU demo VM. Orthanc's attachment Range endpoint costs the same whole-file read.
 * In an uncompressed object the pixel data element is one plain array of equal frames at the offset Orthanc records
 * at ingestion (`PixelDataOffset`), so a frame is a byte range of the stored file. This module is the arithmetic and
 * the response shapes; it does no I/O. Anything it cannot prove (encapsulated or big-endian syntaxes, odd bit depths,
 * an element header that disagrees with the indexed tags) is answered `null`, and the service falls back to Orthanc.
 */
import { deflateSync } from 'node:zlib';

/** Transfer syntaxes whose pixel data is a plain little-endian array of frames. Big endian is left to Orthanc. */
export const UNCOMPRESSED_LITTLE_ENDIAN: ReadonlySet<string> = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);
export const IMPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2';
export const PIXEL_DATA_TAG = Buffer.from([0xe0, 0x7f, 0x10, 0x00]);

/** What the service reads from Orthanc's index about one stored object before deciding on a direct read. */
export interface FrameFacts {
  transferSyntax: string | null;
  pixelDataOffset: number | null;
  rows: number; columns: number; bitsAllocated: number; samplesPerPixel: number; numberOfFrames: number;
  planarConfiguration: number | null; photometric: string; pixelRepresentation: number;
  /** Sample layout inside the allocated bits (PS3.5 §8.1.1): null when the object does not say. */
  bitsStored: number | null; highBit: number | null;
  /** Modality LUT as the linear form (PS3.3 C.11.1); a Modality LUT Sequence is `modalityLutSequence`. */
  rescaleSlope: number | null; rescaleIntercept: number | null; modalityLutSequence: boolean;
  /** VOI (PS3.3 C.11.2): the first window, its function (LINEAR when absent), and whether a VOI LUT Sequence exists. */
  windowCenter: number | null; windowWidth: number | null; voiLutFunction: string | null; voiLutSequence: boolean;
  /** The object's functional groups carry a transform shape this reader does not interpret: its preview is Orthanc's. */
  unsupportedTransforms: boolean;
  /** Stored attachment: same size compressed and uncompressed means Orthanc's own storage compression is off. */
  fileSize: number; storedSize: number;
}

export interface FrameSpan { start: number; end: number }
export interface FrameLayout {
  /** Bytes of the pixel data element header in front of the first frame: 12 explicit VR (OB/OW), 8 implicit VR. */
  headerLength: 8 | 12;
  frameBytes: number;
  numberOfFrames: number;
  firstFrameOffset: number;
  /** Compressed frame payloads, excluding the BOT and Item headers. */
  encapsulated?: FrameSpan[][];
}

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The one tag value Orthanc's simplified tags give as a string; a list keeps its first value (VOI windows). */
export function tagNumber(value: unknown): number | null {
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const first = value.split('\\')[0].trim();
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(first)) return null;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The byte layout of the frames, or null when the object is not a plain uncompressed little-endian frame array. */
export function frameLayout(facts: FrameFacts): FrameLayout | null {
  if (!facts.transferSyntax || !UNCOMPRESSED_LITTLE_ENDIAN.has(facts.transferSyntax)) return null;
  if (!positiveInteger(facts.pixelDataOffset) || !positiveInteger(facts.rows) || !positiveInteger(facts.columns)) return null;
  if (![8, 16].includes(facts.bitsAllocated) || ![1, 3].includes(facts.samplesPerPixel)) return null;
  // Colour frames are served only in the pixel-interleaved order the viewer expects of a frame.
  if (facts.samplesPerPixel === 3 && facts.planarConfiguration !== null && facts.planarConfiguration !== 0) return null;
  if (!positiveInteger(facts.numberOfFrames)) return null;
  if (!positiveInteger(facts.fileSize) || facts.fileSize !== facts.storedSize) return null;
  const headerLength = facts.transferSyntax === IMPLICIT_VR_LITTLE_ENDIAN ? 8 : 12;
  const frameBytes = facts.rows * facts.columns * facts.samplesPerPixel * (facts.bitsAllocated / 8);
  const firstFrameOffset = facts.pixelDataOffset + headerLength;
  if (firstFrameOffset + frameBytes * facts.numberOfFrames > facts.fileSize) return null;
  return { headerLength, frameBytes, numberOfFrames: facts.numberOfFrames, firstFrameOffset };
}

/**
 * The element header read from the file at the indexed offset must name the Pixel Data tag with exactly the length
 * the index implies. An undefined length (0xFFFFFFFF) is encapsulated pixel data regardless of the transfer syntax.
 */
export function pixelDataHeaderMatches(header: Buffer, layout: FrameLayout): boolean {
  if (header.length < layout.headerLength || !header.subarray(0, 4).equals(PIXEL_DATA_TAG)) return false;
  let length: number;
  if (layout.headerLength === 12) {
    const vr = header.toString('latin1', 4, 6);
    if (vr !== 'OB' && vr !== 'OW') return false;
    if (header.readUInt16LE(6) !== 0) return false;
    length = header.readUInt32LE(8);
  } else length = header.readUInt32LE(4);
  const expected = layout.frameBytes * layout.numberOfFrames;
  // DICOM pads an odd-length value to an even length; frame arrays of 8-bit single-sample objects can be odd.
  return length !== 0xffffffff && (length === expected || length === expected + (expected % 2));
}

/** The byte range of one 1-based frame inside the stored file, or null outside the object. */
export function frameRange(layout: FrameLayout, frame: number): { start: number; end: number } | null {
  if (layout.encapsulated) return null;
  if (!positiveInteger(frame) || frame > layout.numberOfFrames) return null;
  const start = layout.firstFrameOffset + (frame - 1) * layout.frameBytes;
  return { start, end: start + layout.frameBytes - 1 };
}

export function frameRanges(layout: FrameLayout, frame: number): FrameSpan[] | null {
  if (!positiveInteger(frame) || frame > layout.numberOfFrames) return null;
  if (layout.encapsulated) return layout.encapsulated[frame - 1];
  const range = frameRange(layout, frame);
  return range ? [range] : null;
}

/**
 * The WADO-RS frame list "3" or "1,2,3" (PS3.18 §10.4.1.1.2): positive integers in the client's order. The list has no
 * invented ceiling: the request line's own length bounds it, every frame is streamed with backpressure, and a frame
 * outside the object is relayed to Orthanc like any other request the reader cannot prove.
 */
export function parseFrameList(text: unknown): number[] | null {
  if (typeof text !== 'string' || !/^[1-9]\d{0,6}(?:,[1-9]\d{0,6})*$/.test(text)) return null;
  return text.split(',').map(Number);
}

interface AcceptEntry { type: string; params: Map<string, string>; q: number }

/** One Accept header as its comma-separated entries; a comma inside a quoted parameter does not split. */
function acceptEntries(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  const split = (text: string, separator: string): string[] => {
    const parts: string[] = []; let quoted = false, start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      else if (text[i] === separator && !quoted) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
  };
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/s, '$1').trim();
  for (const entry of split(header, ',')) {
    const [rawType, ...rawParams] = split(entry, ';');
    const type = rawType.trim().toLowerCase();
    if (!type) continue;
    const params = new Map<string, string>();
    const add = (text: string) => {
      const eq = text.indexOf('=');
      if (eq < 0) return;
      const name = text.slice(0, eq).trim().toLowerCase(), value = unquote(text.slice(eq + 1));
      // Orthanc's own shape puts the part's parameters inside the quoted type: type="application/octet-stream; transfer-syntax=…".
      if (name === 'type' && value.includes(';')) { const [inner, ...rest] = split(value, ';'); params.set('type', inner.trim().toLowerCase()); rest.forEach(add); }
      else if (!params.has(name)) params.set(name, name === 'type' ? value.toLowerCase() : value);
    };
    rawParams.forEach(add);
    const q = params.has('q') ? Number(params.get('q')) : 1;
    entries.push({ type, params, q: Number.isFinite(q) ? q : 0 });
  }
  return entries;
}

/**
 * Whether the client accepts the one representation the direct reader emits - `multipart/related;
 * type="application/octet-stream"; transfer-syntax=<stored>` - by RFC 9110 §12.5.1: of the Accept entries that match
 * it, the most specific decides (a named type over the multipart or the full wildcard range, and within a range a type
 * parameter and a named syntax over their absence), and a quality of 0 excludes it. The representation parameters are
 * matched on every range, wildcards included: `multipart/*; type="image/jpeg"`, or the full wildcard range with
 * `transfer-syntax=1.2.840.10008.1.2.4.80`, asks for parts this path does not emit, so it does not match ours (review
 * MG-05). A representation this path does
 * not emit that the client prefers (a higher quality on image/jpeg, another transfer syntax, a bare application/octet-stream)
 * leaves the request to Orthanc, which can answer it. No Accept header means no preference (PS3.18 §8.7.3.3.1: the
 * stored octet-stream).
 */
export function directReadServes(accept: unknown, storedSyntax: string, mediaType = 'application/octet-stream'): boolean {
  if (typeof accept !== 'string' || !accept.trim()) return true;
  let ours: { rank: number; q: number } | null = null, elsewhere = 0;
  for (const entry of acceptEntries(accept)) {
    const type = entry.params.get('type'), syntax = entry.params.get('transfer-syntax');
    const range = entry.type === '*/*' ? 0 : entry.type === 'multipart/*' ? 1 : entry.type === 'multipart/related' ? 2 : -1;
    let rank = -1;
    if (range >= 0 && !(type !== undefined && type !== '*/*' && type !== mediaType)       // parts of another media type
        && !(syntax !== undefined && syntax !== '*' && syntax !== storedSyntax))                           // another syntax: transcoding
      rank = range * 3 + (type !== undefined && type !== '*/*' ? 1 : 0) + (syntax !== undefined && syntax !== '*' ? 1 : 0);
    if (rank < 0) { elsewhere = Math.max(elsewhere, entry.q); continue; }
    if (!ours || rank > ours.rank || (rank === ours.rank && entry.q > ours.q)) ours = { rank, q: entry.q };
  }
  return ours !== null && ours.q > 0 && ours.q >= elsewhere;
}

/**
 * Whether gzip is acceptable to the client (RFC 9110 §12.5.3): a gzip entry with a positive quality, or a `*` entry
 * with a positive quality when gzip is not named. `gzip;q=0` forbids it; no header or no match means identity.
 */
export function acceptsGzip(acceptEncoding: unknown): boolean {
  if (typeof acceptEncoding !== 'string') return false;
  let gzip: number | null = null, any: number | null = null;
  for (const entry of acceptEncoding.split(',')) {
    const [coding, ...params] = entry.split(';');
    const name = coding.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() === 'q') { q = Number(value?.trim()); if (!Number.isFinite(q)) q = 0; }
    }
    if (name === 'gzip' || name === 'x-gzip') gzip = q;
    else if (name === '*') any = q;
  }
  return gzip !== null ? gzip > 0 : any !== null && any > 0;
}

/** The multipart/related shape Orthanc's DICOMweb plugin answers, so the viewer's parser sees the same parts. */
export interface MultipartFrames {
  contentType: string;
  /** Head of each part in request order; the part body is the frame's bytes and the part ends with CRLF. */
  partHead(frame: number): Buffer;
  partTail: Buffer;
  closing: Buffer;
  /** Body length when the frame bytes are known: heads + frames + tails + closing. */
  contentLength(frames: number[], frameBytes: number): number;
}

export function multipartFrames(boundary: string, locationBase: string, transferSyntax: string,
    frameBytes: number | ((frame: number) => number), mediaType = 'application/octet-stream'): MultipartFrames {
  if (!/^[0-9a-f-]{20,70}$/.test(boundary)) throw new Error('boundary');
  const partTail = Buffer.from('\r\n', 'latin1'), closing = Buffer.from(`--${boundary}--\r\n`, 'latin1');
  const partHead = (frame: number) => Buffer.from(
    `--${boundary}\r\nContent-Location: ${locationBase}/frames/${frame}\r\n` +
    `Content-Type: ${mediaType}; transfer-syntax=${transferSyntax}\r\nContent-Length: ${typeof frameBytes === 'number' ? frameBytes : frameBytes(frame)}\r\nMIME-Version: 1.0\r\n\r\n`, 'latin1');
  return {
    contentType: `multipart/related; type="${mediaType}; transfer-syntax=${transferSyntax}"; boundary=${boundary}`,
    partHead, partTail, closing,
    contentLength: (frames, bytes) => frames.reduce((sum, frame) => sum + partHead(frame).length +
      (typeof frameBytes === 'function' ? frameBytes(frame) : bytes) + partTail.length, 0) + closing.length,
  };
}

// ── Series-strip preview: a small 8-bit greyscale PNG of one frame, windowed like the stored VOI ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

export interface PreviewOptions { maxSide: number }

/**
 * The greyscale pipeline this renderer implements, or null when the object needs a step it does not have (a Modality
 * or VOI LUT table, a palette, a sigmoid VOI, an unusual bit layout): those previews stay with Orthanc's renderer.
 * Stored sample → bits [HighBit-BitsStored+1 .. HighBit] of the allocated word, sign-extended from BitsStored for
 * PixelRepresentation 1 (PS3.5 §8.1.1; the viewer's own decoder does the same) → RescaleSlope/Intercept (C.11.1.1.2)
 * → VOI window with the LINEAR or LINEAR_EXACT function (C.11.2.1.2.1/.3), or the frame's own min/max when the object
 * carries no window → MONOCHROME1 inverted (C.7.6.3.1.2).
 */
export interface GreyscalePipeline {
  bytesPerSample: 1 | 2; shift: number; mask: number; signBit: number; slope: number; intercept: number;
  window: { center: number; width: number; exact: boolean } | null; invert: boolean;
}

export function greyscalePipeline(facts: FrameFacts): GreyscalePipeline | null {
  if (facts.unsupportedTransforms || facts.samplesPerPixel !== 1 || ![8, 16].includes(facts.bitsAllocated)) return null;
  if (facts.photometric !== 'MONOCHROME1' && facts.photometric !== 'MONOCHROME2') return null;
  if (facts.modalityLutSequence) return null;
  const bitsStored = facts.bitsStored ?? facts.bitsAllocated, highBit = facts.highBit ?? bitsStored - 1;
  if (!Number.isInteger(bitsStored) || !Number.isInteger(highBit) || bitsStored < 1 || bitsStored > facts.bitsAllocated ||
      highBit < bitsStored - 1 || highBit >= facts.bitsAllocated) return null;
  if (facts.pixelRepresentation !== 0 && facts.pixelRepresentation !== 1) return null;
  const slope = facts.rescaleSlope ?? 1, intercept = facts.rescaleIntercept ?? 0;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope === 0) return null;
  let window: GreyscalePipeline['window'] = null;
  if (facts.windowCenter !== null && facts.windowWidth !== null) {
    const fn = (facts.voiLutFunction ?? 'LINEAR').toUpperCase();
    if (fn !== 'LINEAR' && fn !== 'LINEAR_EXACT') return null;
    // LINEAR needs a width of at least 1 and LINEAR_EXACT a positive width (C.11.2.1.2); anything else is not a window.
    if (!Number.isFinite(facts.windowCenter) || !Number.isFinite(facts.windowWidth) || facts.windowWidth < (fn === 'LINEAR' ? 1 : Number.MIN_VALUE)) return null;
    window = { center: facts.windowCenter, width: facts.windowWidth, exact: fn === 'LINEAR_EXACT' };
  } else if (facts.voiLutSequence) return null;   // a VOI LUT table without a window is the object's only VOI: Orthanc renders it
  return { bytesPerSample: facts.bitsAllocated === 16 ? 2 : 1, shift: highBit - bitsStored + 1, mask: 2 ** bitsStored - 1,
    signBit: facts.pixelRepresentation === 1 ? 2 ** (bitsStored - 1) : 0, slope, intercept, window, invert: facts.photometric === 'MONOCHROME1' };
}

/**
 * One stored frame to a greyscale PNG no larger than `maxSide` on its longer side (nearest-neighbour subsampling: a
 * series strip thumbnail, not a diagnostic rendering), through `greyscalePipeline`; null when that pipeline does not
 * apply or the frame is shorter than its geometry says.
 */
export function previewPng(frame: Buffer, facts: FrameFacts, options: PreviewOptions): Buffer | null {
  const pipeline = greyscalePipeline(facts);
  if (!pipeline) return null;
  const { bytesPerSample, shift, mask, signBit, slope, intercept, window, invert } = pipeline;
  if (frame.length < facts.rows * facts.columns * bytesPerSample) return null;
  const step = Math.max(1, Math.ceil(Math.max(facts.rows, facts.columns) / Math.max(16, options.maxSide)));
  const width = Math.ceil(facts.columns / step), height = Math.ceil(facts.rows / step);
  const samples = new Float64Array(width * height);
  let min = Infinity, max = -Infinity, index = 0;
  for (let y = 0; y < facts.rows; y += step) {
    for (let x = 0; x < facts.columns; x += step) {
      const at = (y * facts.columns + x) * bytesPerSample;
      let stored = ((bytesPerSample === 2 ? frame.readUInt16LE(at) : frame[at]) >>> shift) & mask;
      if (signBit && stored & signBit) stored -= mask + 1;
      const value = stored * slope + intercept;
      samples[index++] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  // PS3.3 C.11.2.1.2.1 (LINEAR) and C.11.2.1.3 (LINEAR_EXACT) with the output range 0..255; no window: min..max.
  const grey = (value: number): number => {
    let y: number;
    if (window === null) y = max > min ? ((value - min) / (max - min)) * 255 : 0;
    else if (window.exact) y = ((value - window.center) / window.width + 0.5) * 255;
    else if (window.width === 1) y = value <= window.center - 0.5 ? 0 : 255;
    else y = ((value - (window.center - 0.5)) / (window.width - 1) + 0.5) * 255;
    const rounded = Math.round(y);
    return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
  };
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;   // PNG filter type None for the row
    for (let x = 0; x < width; x++) {
      const g = grey(samples[y * width + x]);
      raw[y * (width + 1) + 1 + x] = invert ? 255 - g : g;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit greyscale, deflate, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}
