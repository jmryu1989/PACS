/* Fixed-format ephemeral capture. Output is silent; captured bytes only leave via the port. */
class KinDictationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const maxFrames = options.processorOptions?.maxFrames;
    this.done = false;
    this.frames = 0;
    if (sampleRate !== 16000 || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 524266) {
      this.done = true;
      this.port.postMessage({ type: 'error' });
      return;
    }
    this.pcm = new Uint8Array(maxFrames * 2);
    this.view = new DataView(this.pcm.buffer);
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'stop') this.finish();
      if (data?.type === 'cancel') { this.done = true; this.pcm.fill(0); }
    };
  }
  finish() {
    if (this.done) return;
    this.done = true;
    const buffer = this.pcm.slice(0, this.frames * 2).buffer;
    this.pcm.fill(0);
    this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
  }
  process(inputs) {
    if (this.done) return false;
    const input = inputs[0];
    if (!input?.length) return true;
    // The node requests explicit mono mixing; fail rather than silently drop a channel.
    if (input.length !== 1) {
      this.done = true; this.pcm.fill(0); this.port.postMessage({ type: 'error' }); return false;
    }
    for (const sample of input[0]) {
      if (!Number.isFinite(sample)) {
        this.done = true; this.pcm.fill(0); this.port.postMessage({ type: 'error' }); return false;
      }
      const value = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.frames++ * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
      if (this.frames * 2 === this.pcm.length) { this.finish(); return false; }
    }
    return true;
  }
}
registerProcessor('kin-dictation-pcm', KinDictationProcessor);
