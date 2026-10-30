'use strict';
// After every chat edit: regenerate what the product generates (the main split bundle, the OHIF config) with the
// product's own builders, then syntax-check what the browser will load. A failed check never reaches the mirror.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function run(cmd, args, cwd) {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 120e3 }, (error, stdout, stderr) => {
      resolve({ ok: !error, ms: Date.now() - started, output: (String(stderr) + String(stdout)).slice(-4000) });
    });
  });
}

function syntaxError(code, filename) {
  try { new vm.Script(code, { filename }); return null; } catch (error) {
    const where = (error.stack || '').split('\n')[0];
    return `${filename}: ${error.message}${where && !where.includes(error.message) ? ` (${where})` : ''}`;
  }
}

// Inline classic scripts of an HTML page (JSON/template blocks and external scripts are skipped).
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type)) continue;
    out.push({ code: m[2], line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}

async function buildAndCheck(dir, changed, { python }) {
  const steps = [], errors = [];
  const order = JSON.parse(fs.readFileSync(path.join(dir, 'scripts/main-split-order.json'), 'utf8'));
  const page = path.posix.dirname(order.page);
  const bundled = new Set(order.sources.map(s => `${page}/${s.file}`));
  const artifact = order.artifact;
  const touchedBundle = changed.some(f => bundled.has(f) || f === 'scripts/main-split-order.json');
  const touchedOhif = changed.some(f => f.startsWith('config/ohif/'));

  if (touchedBundle) {
    const r = await run(python, ['scripts/build-main-split-bundle.py'], dir);
    steps.push({ name: 'build-main-split-bundle', ms: r.ms, ok: r.ok });
    if (!r.ok) errors.push(`main split bundle build failed:\n${r.output}`);
  }
  if (touchedOhif) {
    const r = await run(python, ['scripts/build-ohif-config.py'], dir);
    steps.push({ name: 'build-ohif-config', ms: r.ms, ok: r.ok });
    if (!r.ok) errors.push(`OHIF config build failed:\n${r.output}`);
  }

  const started = Date.now();
  const checks = new Set();
  if (touchedBundle || changed.includes(artifact)) checks.add(artifact);
  if (touchedOhif || changed.includes('config/ohif.js')) checks.add('config/ohif.js');
  for (const file of changed) {
    if (file.endsWith('.js') && !bundled.has(file) && file.startsWith('worklist-v0/')) checks.add(file);
    if (file.endsWith('.html') || file.endsWith('.json')) checks.add(file);
  }
  for (const file of checks) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (file.endsWith('.js')) {
      const e = syntaxError(text, file); if (e) errors.push(e);
    } else if (file.endsWith('.html')) {
      for (const block of inlineScripts(text)) {
        const e = syntaxError(block.code, `${file} (inline script at line ${block.line})`); if (e) errors.push(e);
      }
    } else if (file.endsWith('.json')) {
      try { JSON.parse(text); } catch (error) { errors.push(`${file}: invalid JSON: ${error.message}`); }
    }
  }
  steps.push({ name: 'syntax-check', ms: Date.now() - started, ok: !errors.length, files: [...checks] });
  return { ok: !errors.length, steps, errors };
}

module.exports = { buildAndCheck, inlineScripts, syntaxError };
