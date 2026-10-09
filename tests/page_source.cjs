'use strict';
// Legacy source consumers need the same inline page text across a byte-only move.
// This is the single reconstruction implementation; page_source.py is its Python adapter.
const fs = require('node:fs');
const path = require('node:path');
const spec = require('./main_move_spec.json');
const movedNames = new Set(spec.modules.map(m => m.file));

function scripts(html) {
  const result = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(re)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
    result.push({ start: match.index, end: match.index + match[0].length,
      attrs: match[1], src: src ? src[1] : null, body: match[2], tag: match[0] });
  }
  return result;
}

function readPage(file) {
  file = path.resolve(file);
  const html = fs.readFileSync(file, 'utf8');
  const tags = scripts(html);
  // A moved file named any other way ("./x.js", "x.js?v=1", an absolute path) would not count as moved and the
  // page would read as unsplit with its script cut short; refuse it instead of returning partial source.
  const misnamed = tags.filter(t => t.src && !movedNames.has(t.src) && movedNames.has(path.posix.basename(t.src.replace(/[?#].*$/, ''))));
  if (misnamed.length) throw new Error('Moved script src must be the plain spec file name: ' + misnamed.map(t => t.src).join(', '));
  const moved = tags.filter(t => movedNames.has(t.src));
  const inline = tags.filter(t => !t.src);
  if (inline.length > 1) throw new Error('Expected at most one remaining inline script');
  const region = tags.filter(t => !t.src || movedNames.has(t.src));
  if (!region.length) throw new Error('Page has neither the inline script nor moved scripts');
  const expected = spec.modules.slice(0, moved.length).map(m => m.file);
  if (JSON.stringify(moved.map(t => t.src)) !== JSON.stringify(expected))
    throw new Error('Moved script load order differs from the spec');
  if (moved.length && region[region.length - 1].src === null && inline[0] !== region.at(-1))
    throw new Error('Remaining inline script must follow moved files');
  if (inline.length && region.at(-1) !== inline[0]) throw new Error('Inline script precedes moved files');
  const files = [];
  let body = '';
  for (let i = 0; i < region.length; i++) {
    const t = region[i];
    if (i && html.slice(region[i - 1].end, t.start).trim())
      throw new Error('Non-script markup inside the moved script region');
    if (t.src) {
      if (!/^\s+src=["'][^"']+["']\s*$/.test(t.attrs) || t.body)
        throw new Error('Moved files must use ordinary blocking classic script tags');
      const source = path.join(path.dirname(file), t.src);
      files.push(source);
      body += fs.readFileSync(source, 'utf8'); // A missing split asset is an error, never an inline fallback.
    } else {
      if (t.attrs.trim()) throw new Error('Expected an ordinary inline classic script');
      body += t.body;
    }
  }
  return { html, script: body, files, region,
    source: moved.length ? html.slice(0, region[0].start) + '<script>' + body + '</script>' + html.slice(region.at(-1).end) : html };
}
function readPageSource(file) { return readPage(file).source; }
function movedFiles(file) { return readPage(file).files; }
function readSource(file) { return path.extname(file).toLowerCase() === '.html' ? readPageSource(file) : fs.readFileSync(file, 'utf8'); }
module.exports = { scripts, readPage, readPageSource, readSource, movedFiles };
if (require.main === module) {
  const [op, file] = process.argv.slice(2);
  if (op === 'source') process.stdout.write(readSource(file));
  else if (op === 'files') process.stdout.write(JSON.stringify(movedFiles(file)));
  else throw new Error('Usage: node page_source.cjs source|files <page>');
}
