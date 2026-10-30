// REQ-MG-SOF3-DECODE: host side of kin-sof3.wasm (unmodified libjpeg-turbo, recipe scripts/build-sof3-wasm.py).
// A plain wasm32-wasi reactor: no emscripten glue, no eval or new Function, so the page CSP needs only
// 'wasm-unsafe-eval'. Runs in the decode worker and in Node tests. libjpeg's allocator state is undefined after
// an error, so an instance that threw is discarded and the caller creates a new one from the same module.
'use strict';
(function (root) {
  const WASI_ERRNO_SUCCESS = 0, WASI_ERRNO_BADF = 8;

  // A frame the viewer must not show: libjpeg refused the stream, padded it (warnings), or it is not the frame
  // the DICOM header describes. The message names the decoder and the codestream for the viewer's explanation.
  function rejected(detail) {
    const error = new Error('JPEG lossless decoder rejected the codestream: ' + detail);
    error.code = 'SOF3_DECODE_REJECTED';
    return error;
  }

  function wasiStubs(module, onExit) {
    // Only the imports this build pulls in get a stub; stdio writes are dropped, exits become exceptions.
    const stubs = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module !== 'wasi_snapshot_preview1') continue;
      stubs[imp.name] = imp.name === 'proc_exit' ? code => onExit(code)
        : imp.name === 'fd_write' ? () => WASI_ERRNO_BADF
        : () => WASI_ERRNO_SUCCESS;
    }
    return stubs;
  }

  async function create(module) {
    let failure = null, exports = null;
    const imports = {
      env: { kin_fail(ptr, len) {
        failure = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
        throw rejected(failure);
      } },
      wasi_snapshot_preview1: wasiStubs(module, code => { throw rejected('libjpeg-turbo exited ' + code + (failure ? ': ' + failure : '')); }),
    };
    exports = (await WebAssembly.instantiate(module, imports)).exports;
    if (typeof exports._initialize === 'function') exports._initialize();
    let broken = false;
    return {
      get broken() { return broken; },
      // Decodes one single-component codestream of exactly rows x columns into 16-bit samples (a fresh ArrayBuffer,
      // transferable). Any refusal, warning or shape mismatch throws; padded pixels never leave this function.
      decode(bytes, { rows, columns }) {
        if (broken) throw new Error('decoder instance discarded after a failure');
        let src = 0, info = 0, dst = 0;
        try {
          src = exports.kin_alloc(bytes.length);
          info = exports.kin_alloc(16);
          if (!src || !info) throw new Error('out of memory');
          new Uint8Array(exports.memory.buffer, src, bytes.length).set(bytes);
          // The header comes first through the same call: a zero-sized destination returns -2 after filling info.
          let result = exports.kin_decode16(src, bytes.length, 0, 0, info);
          const [width, height, components, precision] = new Int32Array(exports.memory.buffer, info, 4);
          if (result === -1 || components !== 1) throw rejected(components + ' components, expected 1');
          if (width !== columns || height !== rows) throw rejected(width + 'x' + height + ' codestream for a ' + columns + 'x' + rows + ' frame');
          if (!(precision >= 2 && precision <= 16)) throw rejected('sample precision ' + precision);
          const samples = width * height;
          dst = exports.kin_alloc(samples * 2);
          if (!dst) throw new Error('out of memory');
          result = exports.kin_decode16(src, bytes.length, dst, samples, info);
          if (result < 0) throw rejected('status ' + result);
          const warnings = exports.kin_warnings();
          // libjpeg pads a truncated or damaged stream and only warns; those samples are not the image.
          if (warnings > 0) throw rejected(warnings + ' warning(s), incomplete or damaged stream');
          const pixels = new Uint16Array(samples);
          pixels.set(new Uint16Array(exports.memory.buffer, dst, samples));
          return { pixels, precision: result };
        } catch (error) {
          broken = true;
          throw error;
        } finally {
          if (!broken) { exports.kin_free(src); exports.kin_free(info); exports.kin_free(dst); }
        }
      },
    };
  }

  const api = { create, rejected };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinSof3 = api;
})(typeof self !== 'undefined' ? self : globalThis);
