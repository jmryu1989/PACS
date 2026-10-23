
/*
 * Stack flip/reset geometry adapted from Cornerstone3D Viewport.
 * MIT License — Copyright (c) 2019 Open Health Imaging Foundation.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * Source: https://github.com/cornerstonejs/cornerstone3D/blob/main/LICENSE
 * Pinned source: app.bundle.6656ed549d35896854f2.js, SHA256
 * 4fc18be2b7ae02369093d0505ae3241c9d78cb7396aebef4a0e01b8534f5ff58.
 */
const kinStackPrecision = (() => {
  const names = ['flip', '_getFocalPointForResetCamera'];
  const hashes = [
    '94ab10a51ca3095a7eef8ace693f7477e7961de741f1e9d8208b867520d8e8e4',
    '6734d58b792202f939f6fb3e9a7c19e67c191f83bcab66094ee82e4cd273f210',
  ];
  let pending;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => new Float64Array([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
  const add = (a, b, k) => new Float64Array([a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]);
  const negate = a => new Float64Array([-a[0], -a[1], -a[2]]);
  const cross = (a, b) => new Float64Array([
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ]);

  // Float32 temporaries round large patient-space origins before editing begins.
  // Both this helper and flip must keep double precision; changing flip alone worsens drift.
  function resetFocal(centered, previous, { resetPan = true, resetToCenter = true }) {
    if (resetToCenter && resetPan) return centered;
    if (!resetToCenter && resetPan) {
      const distance = dot(sub(centered, previous.focalPoint), previous.viewPlaneNormal);
      return Array.from(add(centered, previous.viewPlaneNormal, -distance));
    }
    const invalid = Array.isArray(previous.focalPoint)
      ? previous.focalPoint.some(Number.isNaN) : Number.isNaN(previous.focalPoint);
    return invalid ? centered : previous.focalPoint;
  }

  function flip({ flipHorizontal, flipVertical }) {
    const imageData = this.getDefaultImageData();
    if (!imageData) return;
    const camera = this.getCamera();
    const { viewPlaneNormal, viewUp, focalPoint, position } = camera;
    const right = cross(viewPlaneNormal, viewUp);
    let up = new Float64Array(viewUp);
    const normal = negate(viewPlaneNormal);
    const delta = sub(position, focalPoint);
    const distance = Math.sqrt(dot(delta, delta));
    const center = imageData.indexToWorld(imageData.getDimensions().map(d => Math.floor(d / 2)), new Float64Array(3));
    const reset = this._getFocalPointForResetCamera(center, camera, { resetPan: true, resetToCenter: false });
    const pan = sub(focalPoint, reset);
    const panLength = Math.sqrt(dot(pan, pan));
    const mirror = axis => {
      const projected = add(new Float64Array(3), axis, 2 * dot(pan, axis));
      const result = sub(projected, pan);
      const length = dot(result, result);
      const inverse = length > 0 ? 1 / Math.sqrt(length) : length;
      return new Float64Array([result[0] * inverse, result[1] * inverse, result[2] * inverse]);
    };
    if (flipHorizontal) {
      const focal = add(reset, mirror(up), panLength);
      this.setCamera({ viewPlaneNormal: normal, position: add(focal, normal, distance), focalPoint: focal });
      this.flipHorizontal = !this.flipHorizontal;
    }
    if (flipVertical) {
      up = negate(viewUp);
      const focal = add(reset, mirror(right), panLength);
      this.setCamera({ focalPoint: focal, viewPlaneNormal: normal, viewUp: up, position: add(focal, normal, distance) });
      this.flipVertical = !this.flipVertical;
    }
    this.render();
  }

  function status(state) {
    // This reports installation only. Future persistence still validates original DICOM geometry on the server.
    window.kinViewerPrecision = Object.freeze({ version: 1, state, scope: 'gpu-stack-flip' });
    if (state === 'unsupported') console.warn('KIN stack precision adapter: unsupported viewer source; original methods retained.');
    return state;
  }

  /*
   * A flip stays while the person scrolls the same stack (S7-U5 fix round H2, the commander's decision: the OHIF default
   * and the expectation of main's Images Only test). The pinned viewer re-centres the camera on every frame it shows
   * (_updateActorToDisplayImageId -> resetCameraNoEvent, which clears both flips) and then gives back rotation, zoom and
   * pan (its view presentation) but not the flips, so a flipped image silently un-flipped on the next slice. The flips are
   * given back only for a frame of the same stack: setStack clears the flips and invalidates the stack before its first
   * frame, so a new stack starts unflipped, and every explicit reset (Space/Reset, Reset Display, a Job restore, a cell
   * merge) clears them outside this method. Pinned like the methods above; on another source the stock method stays.
   * The rotation is given back again after the flips: the frame update re-applies the angle the flipped camera reported
   * to the unflipped camera, where the same number is another orientation (a 90 degree turn then a flip came back turned
   * 180 degrees); with the flips back first the angle means what it meant before the frame.
   */
  const KEEP = '_updateActorToDisplayImageId';
  const KEEP_HASH = '1d0c256a7758f34b11ff56cd2a14df83780f318d1c86264c014a0320045b0f91';
  function keepFlips(original) {
    return function (image) {
      const same = !this.stackInvalidated, horizontal = !!this.flipHorizontal, vertical = !!this.flipVertical;
      const rotation = same && (horizontal || vertical) ? this.getRotation() : null;
      const result = original.call(this, image);
      if (same && !this.stackInvalidated) {
        const flipHorizontal = horizontal && !this.flipHorizontal, flipVertical = vertical && !this.flipVertical;
        if (flipHorizontal || flipVertical) {
          this.flip({ flipHorizontal, flipVertical });
          if (Number.isFinite(rotation)) this.setRotation(rotation);
        }
      }
      return result;
    };
  }
  async function installKeepFlips(target) {
    const original = Object.hasOwn(target, KEEP) ? target[KEEP] : null;
    if (typeof original !== 'function' || !Object.isExtensible(target)) return 'unsupported';
    const bytes = new TextEncoder().encode(Function.prototype.toString.call(original).replace(/\r\n/g, '\n').trim());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== KEEP_HASH || target[KEEP] !== original) {
      console.warn('KIN stack flip keeper: unsupported viewer source; the stock frame update is retained.');
      return 'unsupported';
    }
    Object.defineProperty(target, KEEP, { configurable: true, writable: true, value: keepFlips(original) });
    return 'ready';
  }

  async function install() {
    const core = window.cornerstone;
    const base = core?.Viewport?.prototype;
    const target = core?.StackViewport?.prototype;
    if (!base || !target || !globalThis.crypto?.subtle || Object.getPrototypeOf(target) !== base) return status('unsupported');
    const originals = names.map(name => base[name]);
    const eligible = () => Object.isExtensible(target) && names.every((name, i) =>
      typeof originals[i] === 'function' && base[name] === originals[i] &&
      !Object.hasOwn(target, name) && target[name] === originals[i]);
    if (!eligible()) return status('unsupported');
    const actual = await Promise.all(originals.map(async fn => {
      const bytes = new TextEncoder().encode(Function.prototype.toString.call(fn).replace(/\r\n/g, '\n').trim());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }));
    // Recheck after the asynchronous hash; another extension may have installed its own methods.
    if (!eligible() || actual.some((hash, i) => hash !== hashes[i])) return status('unsupported');
    const replacements = [flip, resetFocal];
    const descriptors = Object.fromEntries(names.map((name, i) => [name, {
      configurable: true, writable: true,
      value: function (...args) {
        return (this.useCPURendering ? originals[i] : replacements[i]).apply(this, args);
      },
    }]));
    Object.defineProperties(target, descriptors);
    // The flip keeper relies on the flip installed just above (double precision on GPU stacks).
    window.kinViewerFlipKeeper = Object.freeze({ version: 1, state: await installKeepFlips(target).catch(() => 'unsupported') });
    return status('ready');
  }
  return { id: 'kin.stack-precision', preRegistration() {
    // Extension registration can be repeated across modes; never stack wrappers.
    pending ||= install().catch(() => status('unsupported'));
    return pending;
  } };
})();
