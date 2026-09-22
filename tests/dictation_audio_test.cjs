// Pure byte fixtures, no audio files, microphone, engine, network or database.
// CI tests the compiled image module. Local Node24 may strip types from the same source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const modulePath = process.env.KIN_DICTATION_AUDIO_MODULE || '/app/dist/dictation-audio';
const { inspectDictationWav, DICTATION_AUDIO_MAX_BYTES } = require(modulePath);

function wav(dataBytes = 4, extended = false) {
  const offset = extended ? 46 : 44;
  const b = Buffer.alloc(offset + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(extended ? 18 : 16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', offset - 8); b.writeUInt32LE(dataBytes, offset - 4);
  for (let i = offset; i < b.length; i++) b[i] = (i * 19) % 256;
  return b;
}
function refused(b, reason) {
  const result = inspectDictationWav(b);
  assert.equal(result.ok, false);
  if (reason) assert.equal(result.reason, reason);
}

test('accepts one second of PCM and derives duration exclusively from data frames', () => {
  const b = wav(32000);
  assert.deepEqual(inspectDictationWav(b), { ok: true, byteLength: 32044, dataOffset: 44,
    dataBytes: 32000, frames: 16000, seconds: 1, sampleRate: 16000, channels: 1, bitsPerSample: 16 });
});
test('accepts PCM WAVEFORMATEX with zero extension and accounts for the longer header', () => {
  const r = inspectDictationWav(wav(2, true));
  assert.equal(r.ok, true); assert.equal(r.dataOffset, 46); assert.equal(r.byteLength, 48);
  assert.equal(r.seconds, 1 / 16000);
});
test('the full WAV byte cap includes the header and cannot be raised by configuration', () => {
  assert.equal(DICTATION_AUDIO_MAX_BYTES, 1048576);
  const exact = wav(1048576 - 44), r = inspectDictationWav(exact);
  assert.equal(r.ok, true); assert.equal(r.seconds, (1048576 - 44) / 32000);
  refused(wav(1048576 - 42), 'too-large');
  assert.equal(inspectDictationWav(wav(), 1048577).reason, 'invalid-limit');
  assert.equal(inspectDictationWav(wav(), 46).reason, 'too-large');
  assert.equal(inspectDictationWav(wav(2), 46).ok, true);
});
test('invalid limit values fail as configuration errors rather than creating an unbounded request', () => {
  for (const n of [0, -1, 45, NaN, Infinity, '100', 60.5, null]) {
    assert.equal(inspectDictationWav(wav(), n).reason, 'invalid-limit');
  }
});
test('all truncated minimum headers fail without throwing or reading past the view', () => {
  for (let n = 0; n < 46; n++) refused(wav(2).subarray(0, n), 'invalid-wave');
  for (let n = 46; n < 48; n++) {
    const b = wav(2, true).subarray(0, n); b.writeUInt32LE(n - 8, 4); refused(b, 'invalid-wave');
  }
});
test('non-byte values and shared mutable buffers are not accepted', () => {
  for (const v of [null, undefined, 'RIFF', {}, [], new Uint16Array(50), new ArrayBuffer(60)]) refused(v, 'not-bytes');
  refused(new Uint8Array(new SharedArrayBuffer(60)), 'not-bytes');
});
test('parsing uses the exact subarray offset and never modifies input bytes', () => {
  const original = wav(100), padded = Buffer.concat([Buffer.alloc(13, 7), original, Buffer.alloc(9, 9)]);
  const slice = padded.subarray(13, 13 + original.length);
  const before = createHash('sha256').update(padded).digest('hex');
  assert.equal(inspectDictationWav(slice).dataBytes, 100);
  assert.equal(createHash('sha256').update(padded).digest('hex'), before);
});
test('RIFF, WAVE, fmt and data identifiers must match exactly', () => {
  for (const offset of [0, 8, 12, 36]) {
    const b = wav(); b[offset] ^= 32; refused(b, 'invalid-wave');
  }
});
test('claimed RIFF length must match actual bytes, with no trailing payload', () => {
  for (const n of [0, 39, 41, 0xffffffff]) {
    const b = wav(); b.writeUInt32LE(n, 4); refused(b, 'invalid-wave');
  }
  refused(Buffer.concat([wav(), Buffer.from([0, 0])]), 'invalid-wave');
});
test('declared data length must be nonempty, aligned and exhaust the enclosing RIFF', () => {
  for (const n of [0, 1, 2, 3, 6, 0xffffffff]) {
    const b = wav(); b.writeUInt32LE(n, 40); refused(b, 'invalid-wave');
  }
  refused(wav(0), 'invalid-wave'); refused(wav(3), 'invalid-wave');
});
for (const [name, offset, size, value] of [
  ['float format', 20, 2, 3], ['stereo', 22, 2, 2], ['48kHz', 24, 4, 48000],
  ['false byte rate', 28, 4, 16000], ['false block alignment', 32, 2, 1], ['8-bit depth', 34, 2, 8],
]) {
  test(`rejects ${name} even when lengths otherwise agree`, () => {
    const b = wav(); if (size === 2) b.writeUInt16LE(value, offset); else b.writeUInt32LE(value, offset);
    refused(b, 'unsupported-format');
  });
}
test('only PCM16 fmt sizes and a zero extension are accepted', () => {
  for (const n of [0, 15, 17, 40, 0xffffffff]) {
    const b = wav(); b.writeUInt32LE(n, 16); refused(b, 'unsupported-format');
  }
  const b = wav(2, true); b.writeUInt16LE(1, 36); refused(b, 'unsupported-format');
});
test('metadata, repeated chunks, data before format and disguised trailing chunks are refused', () => {
  const extra = Buffer.from('LIST\u0004\u0000\u0000\u0000NAME', 'binary');
  const b = Buffer.concat([wav(), extra]); b.writeUInt32LE(b.length - 8, 4); refused(b, 'invalid-wave');
  const fmtFirst = wav(); fmtFirst.write('data', 12); refused(fmtFirst, 'invalid-wave');
  const repeated = wav(); repeated.write('fmt ', 36); refused(repeated, 'invalid-wave');
  const front = Buffer.concat([wav().subarray(0, 12), extra, wav().subarray(12)]);
  front.writeUInt32LE(front.length - 8, 4); refused(front, 'invalid-wave');
});
