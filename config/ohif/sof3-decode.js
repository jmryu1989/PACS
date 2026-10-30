// REQ-MG-SOF3-DECODE -> RISK-MG-SOF3-PIXEL, RISK-MG-SOF3-FALLBACK. The pinned loader decodes JPEG lossless
// (.70/.57) with a pure-JS decoder, 3.6-4.4x slower per mammography frame than libjpeg-turbo in wasm on the same CPU.
// Unsigned 16-bit greyscale frames are decoded by kin-sof3.wasm in a small worker pool and then handed to the pinned
// worker as Explicit VR Little Endian, so its own post-processing (preScale, target buffer, min/max) builds the frame.
// Every other frame, and every frame once the decoder could not load, keeps the pinned path. A stream libjpeg refused
// is not retried there: that decoder returns black or partial pixels for the same damage.
const KIN_SOF3_WASM = true;
const KIN_SOF3_SYNTAXES = new Set(['1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.57']);
function kinCreateSof3Decode({ workerUrl = '/worklist/hpacs-lite/sof3-decode-worker.js', size = 3, WorkerClass = window.Worker } = {}) {
  let unavailable = KIN_SOF3_WASM && typeof WorkerClass === 'function' ? null : 'disabled', sequence = 0;
  const workers = [], queue = [], counts = { routed: 0, fallbacks: 0, rejected: 0 };
  const routable = task => {
    const frame = task?.imageFrame;
    return KIN_SOF3_SYNTAXES.has(task?.transferSyntax) && frame?.bitsAllocated === 16 && frame.samplesPerPixel === 1 &&
      frame.pixelRepresentation === 0 && frame.rows > 0 && frame.columns > 0 && ArrayBuffer.isView(task.pixelData);
  };
  const settle = (job, next) => { try { job.resolve(next()); } catch (error) { job.reject(error); } };
  const fallBack = job => { counts.fallbacks++; settle(job, () => job.dispatch(job.task)); };
  function release(reason) {
    if (reason && !unavailable) unavailable = reason;
    for (const entry of workers.splice(0)) { entry.worker.terminate(); if (entry.job) fallBack(entry.job); }
    for (const job of queue.splice(0)) fallBack(job);
  }
  function pump() {
    while (queue.length && !unavailable) {
      const entry = workers.find(candidate => !candidate.job) || (workers.length < size ? spawn() : null);
      if (!entry) return;
      const job = entry.job = queue.shift();
      // The pinned loader keeps its own pixelData for the fallback; only this copy is transferred.
      const bytes = job.task.pixelData.slice();
      entry.worker.postMessage({ id: job.id, bytes, rows: job.task.imageFrame.rows, columns: job.task.imageFrame.columns }, [bytes.buffer]);
    }
  }
  function spawn() {
    let worker;
    try { worker = new WorkerClass(workerUrl); } catch (error) { release('worker: ' + (error?.message || error)); return null; }
    const entry = { worker, job: null };
    worker.onmessage = event => {
      const { id, pixels, error, unavailable: reason } = event.data || {};
      const job = entry.job;
      if (!job || job.id !== id) return;
      if (reason) { release(String(reason)); return; }
      entry.job = null;
      if (pixels) {
        counts.routed++;
        settle(job, () => job.dispatch({ ...job.task, transferSyntax: '1.2.840.10008.1.2.1', pixelData: new Uint8Array(pixels) }));
      } else { counts.rejected++; job.reject(new Error(error)); }
      pump();
    };
    // A script that failed to load, or a worker that died, is an unavailable decoder, not a damaged frame.
    worker.onerror = event => { event.preventDefault?.(); release('worker: ' + (event.message || 'failed to load')); };
    workers.push(entry);
    return entry;
  }
  return {
    // null keeps the task on the pinned path. Otherwise dispatch(task) is called once, with the decoded samples as
    // Explicit VR Little Endian, or with the unchanged task if the decoder became unavailable before answering.
    decode(task, dispatch) {
      if (unavailable || !routable(task)) return null;
      return new Promise((resolve, reject) => {
        queue.push({ id: ++sequence, task, dispatch, resolve, reject });
        pump();
      });
    },
    stop() { release(null); },
    state: () => ({ unavailable, workers: workers.length, queued: queue.length, ...counts }),
  };
}
