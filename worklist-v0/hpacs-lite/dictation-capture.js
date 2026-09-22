/* U1 capture adapter. No transport, report writes, storage, Blob URLs or implicit insertion.
 * Pure tests are control-flow evidence; actual Chromium capture remains the U4b gate.
 */
(function () {
  'use strict';
  const MAX_BYTES = 1048576;
  function encodeWav(pcm, maxBytes = MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 46 || maxBytes > MAX_BYTES ||
        !(pcm instanceof Uint8Array) || !(pcm.buffer instanceof ArrayBuffer) ||
        !pcm.length || pcm.length % 2 || pcm.length + 44 > maxBytes) throw new Error('DICTATION_AUDIO_INVALID');
    const bytes = new Uint8Array(pcm.length + 44);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
    view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
    return bytes;
  }
  function available(env = globalThis) {
    return env.isSecureContext === true && typeof env.navigator?.mediaDevices?.getUserMedia === 'function' &&
      typeof env.AudioContext === 'function' && typeof env.AudioWorkletNode === 'function';
  }
  function createCapture({ env = globalThis, maxBytes = MAX_BYTES, onComplete = () => {}, onFailure = () => {} } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 46 || maxBytes > MAX_BYTES) throw new Error('DICTATION_AUDIO_INVALID');
    let state = 'idle', context, stream, source, node, result, stopTimer, settle;
    let trackListeners = [];
    const error = code => new Error(code);
    const tracksOff = value => { for (const track of value?.getTracks() ?? []) { try { track.stop(); } catch {} } };
    function release() {
      clearTimeout(stopTimer);
      for (const [track, ended] of trackListeners) track.removeEventListener('ended', ended);
      trackListeners = [];
      tracksOff(stream); stream = undefined;
      if (source) { try { source.disconnect(); } catch {} source = undefined; }
      if (node) { node.port.onmessage = null; node.onprocessorerror = null; try { node.disconnect(); } catch {} try { node.port.close(); } catch {} node = undefined; }
      if (context) { const closed = context; context = undefined; try { void closed.close().catch(() => {}); } catch {} }
    }
    function fail(code) {
      if (['cancelled', 'failed', 'done', 'consumed'].includes(state)) return;
      state = 'failed'; release();
      if (settle) { settle.reject(error(code)); settle = undefined; }
      try { onFailure(code); } catch {}
    }
    async function start() {
      if (state !== 'idle') throw error('DICTATION_CAPTURE_STATE');
      if (!available(env)) { fail('DICTATION_CAPTURE_UNAVAILABLE'); throw error('DICTATION_CAPTURE_UNAVAILABLE'); }
      state = 'starting';
      try {
        context = new env.AudioContext({ sampleRate: 16000 });
        if (context.sampleRate !== 16000 || !context.audioWorklet) throw error('DICTATION_CAPTURE_FORMAT');
        await context.resume();
        if (state !== 'starting') throw error('DICTATION_CAPTURE_CANCELLED');
        await context.audioWorklet.addModule('./dictation-worklet.js');
        if (state !== 'starting') throw error('DICTATION_CAPTURE_CANCELLED');
        const acquired = await env.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        if (state !== 'starting') { tracksOff(acquired); throw error('DICTATION_CAPTURE_CANCELLED'); }
        stream = acquired;
        if (!stream.getAudioTracks().length) throw error('DICTATION_CAPTURE_FORMAT');
        for (const track of stream.getAudioTracks()) {
          if (track.readyState === 'ended') throw error('DICTATION_CAPTURE_FAILED');
          const ended = () => fail('DICTATION_CAPTURE_FAILED');
          track.addEventListener('ended', ended);
          trackListeners.push([track, ended]);
        }
        source = context.createMediaStreamSource(stream);
        node = new env.AudioWorkletNode(context, 'kin-dictation-pcm', { channelCount: 1, channelCountMode: 'explicit',
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          processorOptions: { maxFrames: Math.floor((maxBytes - 44) / 2) } });
        node.onprocessorerror = () => fail('DICTATION_CAPTURE_FAILED');
        node.port.onmessage = ({ data }) => {
          if (!['recording', 'stopping'].includes(state)) return;
          if (data?.type !== 'pcm' || !(data.buffer instanceof ArrayBuffer)) return fail('DICTATION_CAPTURE_FAILED');
          const pcm = new Uint8Array(data.buffer);
          try { result = encodeWav(pcm, maxBytes); }
          catch { return fail('DICTATION_AUDIO_INVALID'); }
          finally { pcm.fill(0); }
          state = 'done'; release();
          if (settle) { const pending = settle; settle = undefined; const value = result; result = undefined; state = 'consumed'; pending.resolve(value); }
          else { try { onComplete(); } catch {} }
        };
        state = 'recording'; source.connect(node); node.connect(context.destination);
      } catch (caught) {
        const code = state === 'cancelled' ? 'DICTATION_CAPTURE_CANCELLED' :
          caught?.message === 'DICTATION_CAPTURE_FORMAT' ? caught.message :
          caught?.name === 'NotAllowedError' ? 'DICTATION_CAPTURE_DENIED' : 'DICTATION_CAPTURE_FAILED';
        fail(code); throw error(code);
      }
    }
    function stop() {
      if (state === 'done') { const value = result; result = undefined; state = 'consumed'; return Promise.resolve(value); }
      if (state !== 'recording') return Promise.reject(error('DICTATION_CAPTURE_STATE'));
      state = 'stopping';
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
        stopTimer = setTimeout(() => fail('DICTATION_CAPTURE_FAILED'), 5000);
        try { node.port.postMessage({ type: 'stop' }); } catch { fail('DICTATION_CAPTURE_FAILED'); }
      });
    }
    function cancel() {
      if (['cancelled', 'consumed', 'failed'].includes(state)) return;
      state = 'cancelled';
      if (result) result.fill(0); result = undefined;
      try { node?.port.postMessage({ type: 'cancel' }); } catch {}
      release();
      if (settle) { settle.reject(error('DICTATION_CAPTURE_CANCELLED')); settle = undefined; }
    }
    return { start, stop, cancel, get state() { return state; } };
  }
  const api = Object.freeze({ MAX_BYTES, encodeWav, available, createCapture });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KinDictationCapture = api;
})();
