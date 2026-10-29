/** S3-ASR-U2a: strict byte validation for the dictation wire format, no I/O.
 * Accept only RIFF/WAVE containing one PCM fmt chunk and one nonempty data chunk.
 * No metadata/ancillary chunks are forwarded to an eventual engine. This is a
 * bounded capture wire format, not a general-purpose WAV upload/import parser.
 */
/** The largest file RIFF's 32-bit size field can describe: a limit of the format, not a policy. */
export const DICTATION_WAV_MAX_BYTES = 0xffff_ffff + 8;
/** The size limit when KIN_ASR_MAX_BYTES is unset: 180 s of the capture format (16 kHz mono PCM16 =
 * 32,000 bytes/s) plus its 44-byte header. A 180 s capture was recorded, sent and transcribed end to
 * end on the synthetic stack (docs/ops/dictation-first-site.md); a site sets its own value. */
export const DICTATION_AUDIO_DEFAULT_BYTES = 180 * 32_000 + 44;
const DICTATION_SAMPLE_RATE = 16_000;

type DictationAudioInspection =
  | { ok: false; reason: 'invalid-limit' | 'not-bytes' | 'too-large' | 'invalid-wave' | 'unsupported-format' }
  | { ok: true; byteLength: number; dataOffset: number; dataBytes: number;
      frames: number; seconds: number; sampleRate: 16000; channels: 1; bitsPerSample: 16 };

export function inspectDictationWav(
  input: unknown,
  byteLimit: number = DICTATION_AUDIO_DEFAULT_BYTES,
): DictationAudioInspection {
  // The deployment's total request limit (KIN_ASR_MAX_BYTES), bounded only by the format itself.
  // 46 bytes is the smallest accepted header plus one complete PCM16 sample.
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 46 || byteLimit > DICTATION_WAV_MAX_BYTES) {
    return { ok: false, reason: 'invalid-limit' };
  }
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
    return { ok: false, reason: 'not-bytes' };
  }
  if (input.byteLength > byteLimit) return { ok: false, reason: 'too-large' };
  if (input.byteLength < 46) return { ok: false, reason: 'invalid-wave' };
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tag = (offset: number, value: string) =>
    value.split('').every((c, i) => view.getUint8(offset + i) === c.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || view.getUint32(4, true) !== input.byteLength - 8 ||
      !tag(12, 'fmt ')) return { ok: false, reason: 'invalid-wave' };

  const formatBytes = view.getUint32(16, true);
  // PCM's legacy 16-byte header and WAVEFORMATEX's zero extension are equivalent.
  if (formatBytes !== 16 && formatBytes !== 18) return { ok: false, reason: 'unsupported-format' };
  const dataHeader = 20 + formatBytes;
  const dataOffset = dataHeader + 8;
  if (input.byteLength < dataOffset + 2) return { ok: false, reason: 'invalid-wave' };
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== DICTATION_SAMPLE_RATE || view.getUint32(28, true) !== 32000 ||
      view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      (formatBytes === 18 && view.getUint16(36, true) !== 0)) {
    return { ok: false, reason: 'unsupported-format' };
  }
  if (!tag(dataHeader, 'data')) return { ok: false, reason: 'invalid-wave' };
  const dataBytes = view.getUint32(dataHeader + 4, true);
  if (dataBytes === 0 || dataBytes % 2 !== 0 || dataBytes !== input.byteLength - dataOffset) {
    return { ok: false, reason: 'invalid-wave' };
  }
  const frames = dataBytes / 2;
  // Duration comes from the validated data chunk, never a request field or RIFF size.
  return { ok: true, byteLength: input.byteLength, dataOffset, dataBytes, frames,
    seconds: frames / DICTATION_SAMPLE_RATE, sampleRate: DICTATION_SAMPLE_RATE,
    channels: 1, bitsPerSample: 16 };
}
