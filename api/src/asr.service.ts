import { Injectable, HttpException } from '@nestjs/common';
import { inspectDictationWav, DICTATION_AUDIO_MAX_BYTES } from './dictation-audio';

// Configured attribution labels, not runtime image/model attestation (U3).
export const ASR_ENGINE_PIN = 'whisper.cpp@927cfce34f31707e17f2bff35c349632fb9e2c3a';
export const ASR_MODEL_PIN = 'ggml-small@sha256:1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b';
export const ASR_TEXT_CAP = 16384;
export const ASR_RESPONSE_CAP = 131072;
export function dictationError(code: string, status = 503) {
  return new HttpException({ code, message: code }, status);
}
function limit(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
export function asrConfiguration(env = process.env) {
  const maxBytes = limit(env.KIN_ASR_MAX_BYTES, DICTATION_AUDIO_MAX_BYTES, 46, DICTATION_AUDIO_MAX_BYTES);
  const timeoutMs = limit(env.KIN_ASR_TIMEOUT_MS, 120000, 1, 240000);
  const languagePin = env.KIN_ASR_LANGUAGE ?? 'auto';
  let url: URL;
  try { url = new URL(env.KIN_ASR_URL); } catch { /* optional, fail closed */ }
  const available = !!(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/inference' &&
    env.KIN_ASR_ENGINE === ASR_ENGINE_PIN && env.KIN_ASR_MODEL === ASR_MODEL_PIN &&
    /^(?:auto|[a-z]{2,3})$/.test(languagePin) && maxBytes !== null && timeoutMs !== null);
  return { available, url: available ? url.href : null, maxBytes: maxBytes ?? DICTATION_AUDIO_MAX_BYTES,
    timeoutMs: timeoutMs ?? 120000, languagePin, enginePin: ASR_ENGINE_PIN, modelPin: ASR_MODEL_PIN };
}

@Injectable()
export class AsrService {
  private busy = false;
  capability() {
    const { url, ...publicConfig } = asrConfiguration();
    return publicConfig;
  }

  async transcribe(bytes: Buffer, disconnected: AbortSignal) {
    const config = asrConfiguration();
    if (!config.available) throw dictationError('DICTATION_NOT_CONFIGURED');
    const audio = inspectDictationWav(bytes, config.maxBytes);
    if (audio.ok === false) throw dictationError(audio.reason === 'too-large' ? 'DICTATION_AUDIO_TOO_LARGE' : 'DICTATION_AUDIO_INVALID', audio.reason === 'too-large' ? 413 : 400);
    if (disconnected.aborted) throw dictationError('DICTATION_ENGINE_FAILED');
    if (this.busy) throw dictationError('DICTATION_BUSY');
    this.busy = true;
    const abort = new AbortController();
    let timedOut = false;
    const onDisconnect = () => abort.abort();
    disconnected.addEventListener('abort', onDisconnect, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, config.timeoutMs);
    // The slot covers the entire upstream response, including bounded body consumption.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'dictation.wav');
      form.append('response_format', 'json');
      form.append('language', config.languagePin);
      const response = await fetch(config.url, { method: 'POST', body: form, signal: abort.signal,
        redirect: 'error', credentials: 'omit' });
      if (!response.ok || !response.body) throw dictationError('DICTATION_ENGINE_FAILED');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > ASR_RESPONSE_CAP))
        throw dictationError('DICTATION_ENGINE_FAILED');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ASR_RESPONSE_CAP) throw dictationError('DICTATION_ENGINE_FAILED');
        chunks.push(value);
      }
      if (abort.signal.aborted) throw dictationError('DICTATION_ENGINE_FAILED');
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > ASR_TEXT_CAP)
        throw dictationError('DICTATION_ENGINE_FAILED');
      return { text: result.text, enginePin: config.enginePin, modelPin: config.modelPin,
        languagePin: config.languagePin, seconds: audio.seconds };
    } catch {
      throw dictationError(timedOut ? 'DICTATION_TIMEOUT' : 'DICTATION_ENGINE_FAILED');
    } finally {
      clearTimeout(timer);
      disconnected.removeEventListener('abort', onDisconnect);
      abort.abort();
      // Best effort and nonblocking: hostile upstream cleanup cannot retain the KIN slot.
      if (reader) void reader.cancel().catch(() => {});
      this.busy = false;
    }
  }
}
