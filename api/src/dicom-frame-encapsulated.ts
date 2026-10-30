import type { FrameFacts, FrameLayout, FrameSpan } from './dicom-frame-layout';

/** Codecs supported by the pinned Cornerstone loader. No server-side pixel conversion. */
export const ENCAPSULATED_MEDIA = new Map([
  ['1.2.840.10008.1.2.4.70', 'image/jpeg'],
  ['1.2.840.10008.1.2.4.80', 'image/jls'],
  ['1.2.840.10008.1.2.4.90', 'image/jp2'],
  ['1.2.840.10008.1.2.4.91', 'image/jp2'],
  ['1.2.840.10008.1.2.5', 'image/dicom-rle'],
]);

/**
 * PS3.5 A.4: offsets point to Item tags, not their values. Read only element/Item headers and the BOT;
 * skip compressed payloads by seeking. Cache this immutable description, never the whole DBT object.
 * Empty BOT is unambiguous for a single frame or one Item per frame (including EOT objects).
 * An empty BOT with multiple fragments per frame needs codec parsing: leave it to Orthanc.
 */
export async function encapsulatedLayout(facts: FrameFacts,
    read: (start: number, length: number) => Promise<Buffer>, signal?: AbortSignal): Promise<FrameLayout | null> {
  const { pixelDataOffset: offset, fileSize: size, numberOfFrames: count } = facts;
  if (!ENCAPSULATED_MEDIA.has(facts.transferSyntax!) || !Number.isSafeInteger(offset) || offset! <= 0 ||
      !Number.isSafeInteger(size) || size !== facts.storedSize || !Number.isSafeInteger(count) || count < 1 ||
      offset! + 20 > size) return null;
  const exact = async (start: number, length: number) => {
    signal?.throwIfAborted();
    const bytes = await read(start, length);
    if (bytes.length !== length) throw new Error('Incomplete encapsulated pixel data');
    return bytes;
  };
  const header = await exact(offset!, 12);
  if (header.readUInt32LE(0) !== 0x00107fe0 || header.toString('ascii', 4, 6) !== 'OB' ||
      header.readUInt16LE(6) !== 0 || header.readUInt32LE(8) !== 0xffffffff) return null;
  const bot = await exact(offset! + 12, 8), botBytes = bot.readUInt32LE(4);
  if (bot.readUInt32LE(0) !== 0xe000fffe || (botBytes !== 0 && botBytes !== count * 4) ||
      offset! + 20 + botBytes + 8 > size) return null;
  const base = offset! + 20 + botBytes;
  // Even a corrupt frame count cannot allocate more memory than the checked table in the stored file.
  const offsets: number[] = [];
  for (let at = 0; at < botBytes; at += 4) {
    const value = (await exact(offset! + 20 + at, 4)).readUInt32LE(0);
    if ((!at && value !== 0) || (at && value <= offsets[offsets.length - 1]) || base + value + 8 >= size) return null;
    offsets.push(value);
  }
  const fragments: FrameSpan[] = [], starts: number[] = [];
  let position = base, ended = false;
  while (position + 8 <= size) {
    const item = await exact(position, 8), tag = item.readUInt32LE(0), length = item.readUInt32LE(4);
    if (tag === 0xe0ddfffe) { ended = length === 0; break; }
    if (tag !== 0xe000fffe || length < 2 || length % 2 || length === 0xffffffff || position + 8 + length > size) return null;
    starts.push(position - base);
    fragments.push({ start: position + 8, end: position + 7 + length });
    position += 8 + length;
  }
  if (!ended || !fragments.length) return null;
  let frames: FrameSpan[][];
  if (offsets.length) {
    const index = new Map(starts.map((start, i) => [start, i]));
    const boundaries = offsets.map(value => index.get(value));
    if (boundaries.some(value => value === undefined)) return null;
    frames = boundaries.map((begin, i) => fragments.slice(begin!, boundaries[i + 1] ?? fragments.length));
  } else if (count === 1) frames = [fragments];
  else if (fragments.length === count) frames = fragments.map(fragment => [fragment]);
  else return null;
  // RLE's single frame is always exactly one fragment (PS3.5 A.4.2).
  if (facts.transferSyntax === '1.2.840.10008.1.2.5' && frames.some(frame => frame.length !== 1)) return null;
  return { headerLength: 12, frameBytes: 0, numberOfFrames: count, firstFrameOffset: base, encapsulated: frames };
}
