// REQ-MG-SOF3-DECODE: classic decode worker for JPEG lossless (.70/.57) greyscale frames. The viewer posts
// {id, bytes, rows, columns} and receives {id, pixels} (16-bit samples, transferred), {id, error} when the stream is
// refused, or {id, unavailable} when the decoder itself could not load. One long-lived instance per worker; an instance
// that threw is replaced from the compiled module.
'use strict';
importScripts('kin-sof3.js');

// A fresh instance's first full-size frame took ~280 ms against ~42 ms for the next one; decoding these 16x8 streams
// (16- and 12-bit sample paths) first brought it to ~44 ms. A wrong answer here means the decoder is not usable.
const WARM_UP = [
  { sum: 4023264, codestream: '/9j/4AAQSkZJRgABAQAAAQABAAD/wwALEAAIABABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAADQkQ/9oACAEBAAEAAMgBoAaAGgBoAaAGgBoAaAGgBoAaAGgBoAaAHQFAiQIkCJAiQIkCJAiQIkCJAiQIkCJAiQIkCKgKCCggoIKCCggoIKCCggoIKCCggoIKCCggoINAUGBBgQYEGBBgQYEGBBgQYEGBBgQYEGBBgQYKAoP6D+g/oP6D+g/oP6D+g/oP6D+g/oP6D+g/0BQnkJ5CeQnkJ5CeQnkJ5CeQnkJ5CeQnkJ5CeoCheoXqF6heoXqF6heoXqF6heoXqF6heoXqF7QFDcQ3ENxDcQ3ENxDcQ3ENxDcQ3ENxDcQ3ENz/2Q==' },
  { sum: 193504, codestream: '/9j/4AAQSkZJRgABAQAAAQABAAD/wwALDAAIABABAREA/8QAGQABAQEBAQEAAAAAAAAAAAAABwgCBgkM/9oACAEBAAEAAPn/APe973ve973ve9+gPRdF0XRdF0XRdF0XRdF0XRdF0XoCgoKCgoKCgoKCgoKCgoKD6AsDAwMDAwMDAwMDAwMDAwegL+/v7+/v7+/v7+/v7+/v/oDT1PU9T1PU9T1PU9T1PU9T1PU96A17Xte17Xte17Xte17Xte178F5XvoDbluW5bluW5bluW5bnwbduW5bluf/Z' },
];

const compiled = fetch(new URL('kin-sof3.wasm', self.location.href)).then(response => {
  if (!response.ok) throw new Error('kin-sof3.wasm HTTP ' + response.status);
  return response.arrayBuffer();
}).then(bytes => WebAssembly.compile(bytes));
let decoder = null;

async function instance() {
  if (decoder && !decoder.broken) return decoder;
  decoder = (async () => {
    const created = await self.KinSof3.create(await compiled);
    for (const { sum, codestream } of WARM_UP) {
      const bytes = Uint8Array.from(atob(codestream), c => c.charCodeAt(0));
      if (created.decode(bytes, { rows: 8, columns: 16 }).pixels.reduce((a, b) => a + b, 0) !== sum)
        throw new Error('decoder self-test returned different samples');
    }
    return created;
  })();
  try { return decoder = await decoder; } catch (error) { decoder = null; throw error; }
}
// Start (and warm) the decoder before the first frame arrives, and say at once if it cannot load.
instance().catch(error => self.postMessage({ unavailable: String(error?.message || error) }));

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
