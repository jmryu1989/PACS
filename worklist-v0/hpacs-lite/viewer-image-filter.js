// Display-stage image filters for a viewer cell: a 3×3 kernel applied to the picture the cell already drew (after its
// window), as an SVG feConvolveMatrix set as the canvas's CSS filter. The image's pixel values, measurements and
// annotations (drawn on their own layer) are not touched.
(function (root) {
  'use strict';
  const KINDS = ['none', 'sharpen', 'smooth'];
  const LABELS = { none: 'None', sharpen: 'Sharpen', smooth: 'Smooth' };
  const KERNELS = {
    sharpen: { matrix: [0, -1, 0, -1, 5, -1, 0, -1, 0], divisor: 1 },
    smooth: { matrix: [1, 2, 1, 2, 4, 2, 1, 2, 1], divisor: 16 },
  };
  const kernel = kind => KERNELS[kind] ? { matrix: [...KERNELS[kind].matrix], divisor: KERNELS[kind].divisor } : null;

  // The same arithmetic feConvolveMatrix does with edgeMode="duplicate" on one channel (0-255, rounded and clamped),
  // for checking a kernel without a browser.
  function convolve(pixels, width, height, kind) {
    const k = kernel(kind);
    if (!k) return Array.from(pixels);
    const at = (x, y) => pixels[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    const out = new Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += k.matrix[(j + 1) * 3 + (i + 1)] * at(x + i, y + j);
      out[y * width + x] = Math.min(255, Math.max(0, Math.round(sum / k.divisor)));
    }
    return out;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const filterId = kind => 'kin-image-filter-' + kind;
  // One hidden <svg> per document holds the filters.
  function definitions(doc) {
    let svg = doc.getElementById('kin-image-filters');
    if (svg) return svg;
    svg = doc.createElementNS(SVG, 'svg'); svg.id = 'kin-image-filters'; svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
    for (const kind of Object.keys(KERNELS)) {
      const filter = doc.createElementNS(SVG, 'filter'); filter.id = filterId(kind);
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const convolution = doc.createElementNS(SVG, 'feConvolveMatrix');
      convolution.setAttribute('order', '3'); convolution.setAttribute('kernelMatrix', KERNELS[kind].matrix.join(' '));
      convolution.setAttribute('divisor', String(KERNELS[kind].divisor)); convolution.setAttribute('edgeMode', 'duplicate');
      convolution.setAttribute('preserveAlpha', 'true');
      filter.append(convolution); svg.append(filter);
    }
    (doc.body || doc.documentElement).append(svg);
    return svg;
  }
  // Sets (or, for 'none', removes) the filter on a cell's canvas. Returns the kind now shown.
  function apply(canvas, kind) {
    if (!canvas?.style) return 'none';
    if (!KERNELS[kind]) { if (canvas.dataset.kinImageFilter) { canvas.style.removeProperty('filter'); delete canvas.dataset.kinImageFilter; } return 'none'; }
    definitions(canvas.ownerDocument);
    canvas.style.filter = 'url(#' + filterId(kind) + ')'; canvas.dataset.kinImageFilter = kind;
    return kind;
  }
  root.KinImageFilter = { KINDS, LABELS, kernel, convolve, apply, filterId };
  if (typeof module === 'object' && module.exports) module.exports = root.KinImageFilter;
})(typeof globalThis === 'object' ? globalThis : this);
