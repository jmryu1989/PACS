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
/** One response serves at most this many frames; a hung pane asks for one and a scroll for one at a time. */
export const MAX_FRAMES_PER_REQUEST = 16;
export const PIXEL_DATA_TAG = Buffer.from([0xe0, 0x7f, 0x10, 0x00]);

/** What the service reads from Orthanc's index about one stored object before deciding on a direct read. */
export interface FrameFacts {
  transferSyntax: string | null;
  pixelDataOffset: number | null;
  rows: number; columns: number; bitsAllocated: number; samplesPerPixel: number; numberOfFrames: number;
  planarConfiguration: number | null; photometric: string; pixelRepresentation: number;
  windowCenter: number | null; windowWidth: number | null;
  /** Stored attachment: same size compressed and uncompressed means Orthanc's own storage compression is off. */
  fileSize: number; storedSize: number;
}

export interface FrameLayout {
  /** Bytes of the pixel data element header in front of the first frame: 12 explicit VR (OB/OW), 8 implicit VR. */
  headerLength: 8 | 12;
  frameBytes: number;
  numberOfFrames: number;
  firstFrameOffset: number;
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
  if (!positiveInteger(frame) || frame > layout.numberOfFrames) return null;
  const start = layout.firstFrameOffset + (frame - 1) * layout.frameBytes;
  return { start, end: start + layout.frameBytes - 1 };
}

/** The WADO-RS frame list "3" or "1,2,3": unique positive integers, at most MAX_FRAMES_PER_REQUEST. */
export function parseFrameList(text: unknown): number[] | null {
  if (typeof text !== 'string' || !/^[1-9]\d{0,6}(?:,[1-9]\d{0,6})*$/.test(text)) return null;
  const frames = text.split(',').map(Number);
  if (frames.length > MAX_FRAMES_PER_REQUEST || new Set(frames).size !== frames.length) return null;
  return frames;
}

/**
 * The Accept header's requested transfer syntax, as the viewer's `transfer-syntax=*` (any) or a UID. A request for a
 * syntax other than the stored one is a transcoding request, which stays with Orthanc.
 */
export function requestedTransferSyntax(accept: unknown): string | null {
  if (typeof accept !== 'string') return null;
  const match = /transfer-syntax\s*=\s*"?([^";,\s]+)"?/i.exec(accept);
  return match ? match[1] : null;
}

export function directReadServes(accept: unknown, storedSyntax: string): boolean {
  const wanted = requestedTransferSyntax(accept);
  return wanted === null || wanted === '*' || wanted === storedSyntax;
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

export function multipartFrames(boundary: string, locationBase: string, transferSyntax: string, frameBytes: number): MultipartFrames {
  if (!/^[0-9a-f-]{20,70}$/.test(boundary)) throw new Error('boundary');
  const partTail = Buffer.from('\r\n', 'latin1'), closing = Buffer.from(`--${boundary}--\r\n`, 'latin1');
  const partHead = (frame: number) => Buffer.from(
    `--${boundary}\r\nContent-Location: ${locationBase}/frames/${frame}\r\n` +
    `Content-Type: application/octet-stream; transfer-syntax=${transferSyntax}\r\nContent-Length: ${frameBytes}\r\nMIME-Version: 1.0\r\n\r\n`, 'latin1');
  return {
    contentType: `multipart/related; type="application/octet-stream; transfer-syntax=${transferSyntax}"; boundary=${boundary}`,
    partHead, partTail, closing,
    contentLength: (frames, bytes) => frames.reduce((sum, frame) => sum + partHead(frame).length + bytes + partTail.length, 0) + closing.length,
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
 * One stored frame to a greyscale PNG no larger than `maxSide` on its longer side (nearest-neighbour subsampling: a
 * series strip thumbnail, not a diagnostic rendering). The window is the stored WindowCenter/WindowWidth when the
 * object has one, else the subsampled frame's own min/max; MONOCHROME1 is inverted so dense tissue stays bright.
 * Only single-sample 8/16-bit frames are previewed here; anything else stays with Orthanc's renderer.
 */
export function previewPng(frame: Buffer, facts: FrameFacts, options: PreviewOptions): Buffer | null {
  if (facts.samplesPerPixel !== 1 || ![8, 16].includes(facts.bitsAllocated)) return null;
  const bytesPerSample = facts.bitsAllocated / 8;
  if (frame.length < facts.rows * facts.columns * bytesPerSample) return null;
  const step = Math.max(1, Math.ceil(Math.max(facts.rows, facts.columns) / Math.max(16, options.maxSide)));
  const width = Math.ceil(facts.columns / step), height = Math.ceil(facts.rows / step);
  const samples = new Float64Array(width * height);
  const signed = facts.pixelRepresentation === 1;
  let min = Infinity, max = -Infinity, index = 0;
  for (let y = 0; y < facts.rows; y += step) {
    for (let x = 0; x < facts.columns; x += step) {
      const at = (y * facts.columns + x) * bytesPerSample;
      const value = bytesPerSample === 2 ? (signed ? frame.readInt16LE(at) : frame.readUInt16LE(at)) : (signed ? frame.readInt8(at) : frame[at]);
      samples[index++] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  let lower = min, upper = max;
  if (facts.windowCenter !== null && facts.windowWidth !== null && facts.windowWidth > 0) {
    lower = facts.windowCenter - facts.windowWidth / 2; upper = facts.windowCenter + facts.windowWidth / 2;
  }
  const span = upper > lower ? upper - lower : 1, invert = facts.photometric === 'MONOCHROME1';
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;   // PNG filter type None for the row
    for (let x = 0; x < width; x++) {
      let grey = Math.round(((samples[y * width + x] - lower) / span) * 255);
      grey = grey < 0 ? 0 : grey > 255 ? 255 : grey;
      raw[y * (width + 1) + 1 + x] = invert ? 255 - grey : grey;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit greyscale, deflate, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}
