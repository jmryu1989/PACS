/*
 * Image Report backgrounds: two simple diagrams drawn here in code (no picture file, nothing taken from another
 * product). The patient's right is on the viewer's left, as on an image read facing the patient.
 *
 *   breast   both breasts seen from the front: an outline each, the nipple, the quadrant lines and the clock positions
 *            (12 at the top, 3 to the viewer's right), R above the right breast and L above the left one.
 *   thyroid  the gland seen from the front: right and left lobes, the isthmus between them and the trachea behind it
 *            (dashed), R and L above the lobes, Upper and Lower beside the right lobe.
 *
 * draw(context, kind, width, height) paints one on a white ground; anything else paints the white ground only.
 */
(function (root) {
  'use strict';

  function breast(c, W, H) {
    const r = Math.min(W * 0.2, H * 0.34);
    for (const [cx, label] of [[W * 0.28, 'R'], [W * 0.72, 'L']]) {
      const cy = H * 0.54;
      c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fill();
      c.save(); c.setLineDash([5, 5]); c.lineWidth = 1;
      c.beginPath(); c.moveTo(cx - r, cy); c.lineTo(cx + r, cy); c.moveTo(cx, cy - r); c.lineTo(cx, cy + r); c.stroke();
      c.restore();
      c.font = '12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (let hour = 1; hour <= 12; hour += 1) {
        const a = hour / 12 * Math.PI * 2 - Math.PI / 2;
        c.fillText(String(hour), cx + Math.cos(a) * (r + 13), cy + Math.sin(a) * (r + 13));
      }
      c.font = 'bold 18px sans-serif'; c.fillText(label, cx, cy - r - 34);
    }
  }

  function thyroid(c, W, H) {
    const cx = W / 2, cy = H * 0.52, lobeW = Math.min(W * 0.1, 64), lobeH = Math.min(H * 0.3, 132), gap = lobeW * 1.45;
    // The trachea behind the gland.
    c.save(); c.setLineDash([4, 5]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx - lobeW * 0.55, cy - lobeH * 1.25); c.lineTo(cx - lobeW * 0.55, cy + lobeH * 1.2);
    c.moveTo(cx + lobeW * 0.55, cy - lobeH * 1.25); c.lineTo(cx + lobeW * 0.55, cy + lobeH * 1.2); c.stroke();
    c.restore();
    c.lineWidth = 2;
    for (const side of [-1, 1]) {
      c.beginPath(); c.ellipse(cx + side * gap, cy, lobeW, lobeH, -side * 0.14, 0, Math.PI * 2); c.stroke();
    }
    // The isthmus joins the lower thirds of the lobes.
    c.beginPath();
    c.moveTo(cx - gap + lobeW * 0.75, cy + lobeH * 0.18); c.quadraticCurveTo(cx, cy + lobeH * 0.08, cx + gap - lobeW * 0.75, cy + lobeH * 0.18);
    c.moveTo(cx - gap + lobeW * 0.8, cy + lobeH * 0.5); c.quadraticCurveTo(cx, cy + lobeH * 0.62, cx + gap - lobeW * 0.8, cy + lobeH * 0.5);
    c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 18px sans-serif';
    c.fillText('R', cx - gap, cy - lobeH - 26); c.fillText('L', cx + gap, cy - lobeH - 26);
    c.font = '12px sans-serif';
    c.fillText('Isthmus', cx, cy + lobeH * 0.85);
    c.textAlign = 'right';
    c.fillText('Upper', cx - gap - lobeW - 12, cy - lobeH * 0.6); c.fillText('Lower', cx - gap - lobeW - 12, cy + lobeH * 0.6);
  }

  function draw(c, kind, W, H) {
    c.save();
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#333333'; c.fillStyle = '#333333';
    if (kind === 'breast') breast(c, W, H);
    else if (kind === 'thyroid') thyroid(c, W, H);
    c.restore();
  }

  const api = Object.freeze({ draw, KINDS: Object.freeze(['breast', 'thyroid']) });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinImageReportDiagrams = api;
})(typeof window === 'object' ? window : null);
