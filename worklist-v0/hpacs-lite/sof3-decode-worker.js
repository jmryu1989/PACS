// REQ-MG-SOF3-DECODE: classic decode worker for JPEG lossless (.70/.57) greyscale frames. The viewer posts
// {id, bytes, rows, columns} and receives {id, pixels} (16-bit samples, transferred), {id, error} when the stream is
// refused, or {id, unavailable} when the decoder itself could not load. One long-lived instance per worker: a fresh
// instance's first decode is measurably slower, and an instance that threw is replaced from the compiled module.
'use strict';
importScripts('kin-sof3.js');

const compiled = fetch(new URL('kin-sof3.wasm', self.location.href)).then(response => {
  if (!response.ok) throw new Error('kin-sof3.wasm HTTP ' + response.status);
  return response.arrayBuffer();
}).then(bytes => WebAssembly.compile(bytes));
compiled.catch(() => {}); // A load failure is answered to every request as unavailable, not as a stray rejection.
let decoder = null;

async function instance() {
  if (!decoder || decoder.broken) decoder = await self.KinSof3.create(await compiled);
  return decoder;
}

self.onmessage = async event => {
  const { id, bytes, rows, columns } = event.data || {};
  let current;
  try { current = await instance(); }
  catch (error) { self.postMessage({ id, unavailable: String(error?.message || error) }); return; }
  try {
    const { pixels } = current.decode(bytes, { rows, columns });
    self.postMessage({ id, pixels: pixels.buffer }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
