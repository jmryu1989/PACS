'use strict';
// S9-U0a-PRE test-side split generator. It never writes into the product tree: the temporary 18/30/45-part
// pages are written to a scratch directory and served by the browser harness (main_split_harness.py).
// The parts are exactly main_move_contract.chunks() of the page under test, and every generated page is
// checked with main_move_contract.verify() before use, so a split page is the same bytes as the page it
// came from (AGENTS 1-B.14: byte identity is the requirement of this move). No feature string is pinned.
//
// Interface (the first move part reuses it):
//   split(count, outDir, {page, spec}) -> manifest   (count 0 = the page itself, unsplit)
//   deriveSpec(page) -> the move spec's 45 runs for a page that changed since the move baseline
//   node tests/main_split_harness.cjs split <count> <outDir> [page] [spec]   prints the manifest JSON
//   node tests/main_split_harness.cjs derive <page> <outSpec>               writes a derived spec (scratch only)
// manifest = {count, page, scripts, parts, modules, statements}; `statements` maps every top-level
// statement to its module and to its line range in the served layout ({file, start, end}, 1-based).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scripts } = require('./page_source.cjs');
const { baseline, chunks, statements, verify } = require('./main_move_contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));

function lines(text) {
  const breaks = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks.push(i);
  return offset => { // 1-based line of a character offset
    let lo = 0, hi = breaks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < offset) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
}

function outsideProduct(dir) {
  const resolved = path.resolve(dir), rel = path.relative(ROOT, resolved);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside && !rel.split(path.sep)[0].startsWith('tmp'))
    throw new Error('Split pages are scratch files; refusing to write inside the repository: ' + resolved);
  return resolved;
}

function split(count, outDir, options = {}) {
  const page = path.resolve(options.page || path.join(ROOT, 'worklist-v0/hpacs-lite/main.html'));
  const spec = options.spec ? JSON.parse(fs.readFileSync(options.spec, 'utf8')) : require('./main_move_spec.json');
  const dir = outsideProduct(outDir);
  const html = fs.readFileSync(page, 'utf8');
  const inline = scripts(html).filter(t => !t.src);
  if (inline.length !== 1) throw new Error('The page under test must have exactly one inline script');
  const tag = inline[0];
  const parts = chunks(html, spec);
  if (!Number.isInteger(count) || count < 0 || count > parts.length) throw new Error('count must be 0..' + parts.length);
  fs.mkdirSync(dir, { recursive: true });
  const tags = parts.slice(0, count).map(p => `<script src="${p.file}"></script>`);
  const rest = parts.slice(count).map(p => p.body).join('');
  if (count < parts.length) tags.push('<script>' + rest + '</script>');
  const served = count ? html.slice(0, tag.start) + tags.join('\n  ') + html.slice(tag.end) : html;
  for (const p of parts.slice(0, count)) fs.writeFileSync(path.join(dir, p.file), p.body);
  const target = path.join(dir, 'main.html');
  fs.writeFileSync(target, served);
  verify(html, target, spec); // same statements, bytes and outer markup as the page under test

  // Line ranges of every statement in the served layout, from the same AST the contract uses. A range starts at
  // the statement's first token (not its leading comments), so a registration's line names one statement.
  const nodes = statements(tag.body);
  const source = ts.createSourceFile('inline.js', tag.body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.statements.length !== nodes.length) throw new Error('Statement list differs from the move contract');
  source.statements.forEach((node, i) => { nodes[i] = { ...nodes[i], token: node.getStart(source) }; });
  const restAt = count < parts.length ? served.length - (html.length - tag.end) - '</script>'.length - rest.length : -1;
  const restFirst = count < parts.length ? nodes[parts.slice(0, count).reduce((s, q) => s + q.statements, 0)].start : 0;
  const servedLine = lines(served);
  const result = [];
  let index = 0;
  parts.forEach((p, module) => {
    const first = nodes[index].start, external = module < count, at = external ? lines(p.body) : null;
    for (let k = 0; k < p.statements; k++, index++) {
      const n = nodes[index], name = spec.modules[module].statements[k];
      let file, start, end;
      if (external) {
        file = p.file; start = at(n.token - first); end = at(Math.max(n.token - first, n.end - first - 1));
      } else {
        const off = restAt + (n.token - restFirst);
        file = 'main.html'; start = servedLine(off); end = servedLine(off + Math.max(0, n.end - n.token - 1));
      }
      result.push({ index, module, file, name, start, end });
    }
  });
  const externals = scripts(served).filter(t => t.src).map(t => t.src);
  const manifest = { count, page: 'main.html', source: page, scripts: externals,
    parts: parts.slice(0, count).map(p => p.file),
    modules: parts.map((p, i) => ({ index: i, file: p.file, external: i < count, statements: p.statements })),
    statements: result };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

// A page that is no longer byte-identical to the move baseline (the PRE product change) still has to be split
// along the same 45 runs. Its statements are matched to the baseline's by exact text; the longest run of matches in
// the baseline order keeps its module, and every other statement (moved, wrapped or new) joins the run it now sits in.
// Test-side only: the move itself is re-specified from the approved PRE SHA.
function longestIncreasing(values) {
  const tails = [], tailIndex = [], previous = new Array(values.length).fill(-1);
  values.forEach((value, i) => {
    if (value < 0) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid; }
    tails[lo] = value; tailIndex[lo] = i; previous[i] = lo ? tailIndex[lo - 1] : -1;
  });
  const keep = new Set();
  for (let i = tails.length ? tailIndex[tails.length - 1] : -1; i >= 0; i = previous[i]) keep.add(i);
  return keep;
}

function deriveSpec(page, options = {}) {
  const base = options.spec ? JSON.parse(fs.readFileSync(options.spec, 'utf8')) : require('./main_move_spec.json');
  const baseHtml = options.baseHtml ?? baseline();
  const inlineBody = text => {
    const inline = scripts(text).filter(t => !t.src);
    if (inline.length !== 1) throw new Error('Expected exactly one inline script');
    return inline[0].body;
  };
  const texts = body => {
    const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw new Error('Inline script must parse');
    return source.statements.map(node => node.getText(source));
  };
  const oldTexts = texts(inlineBody(baseHtml)), body = inlineBody(fs.readFileSync(page, 'utf8')), newTexts = texts(body);
  const oldModule = base.modules.flatMap((m, i) => m.statements.map(() => i));
  if (oldModule.length !== oldTexts.length) throw new Error('The spec does not describe its baseline page');
  const pool = new Map();
  oldTexts.forEach((text, i) => { if (!pool.has(text)) pool.set(text, []); pool.get(text).push(i); });
  const match = newTexts.map(text => (pool.get(text) || []).shift() ?? -1);
  const anchors = longestIncreasing(match);
  const names = statements(body).map(n => n.name);
  let module = 0;
  const homes = names.map((_, i) => (anchors.has(i) ? (module = oldModule[match[i]]) : module));
  const moved = names.filter((_, i) => !anchors.has(i));
  return { ...base, base: null, derivedFrom: base.base, moved,
    note: 'Test-side split of a changed page: baseline runs kept, moved/new statements join the run they sit in.',
    modules: base.modules.map((m, i) => ({ file: m.file, job: m.job, statements: names.filter((_, k) => homes[k] === i) })) };
}

// Fixture projection for tests that compile part of main.html's script into a page of their own. Such a test names a
// run of statements of the f1d5406 page (the last page they were cut from by text markers) by the declarations that
// start and end it; the projection returns those statements from the page under test - wherever its statements now
// are, in the f1d5406 order - so a declaration moved ahead of its consumers stays in the fixture and one moved in
// from elsewhere does not. Declarations are matched by their declared names (a test's mutant may change a body);
// other statements by their text; a statement with no counterpart (new, or a mutated anonymous one) belongs to the
// run it sits in, as a cut by markers would have it. Function names select fixture source only - nothing here
// asserts on them.
const FIXTURE_BASE = 'f1d540626aac03f46de23a9620d69f4c9da66037';
// The two runs the report harness tests compile (also main_split_harness.py REPORT_FIXTURE): what they cut between
// "let selectionSeq = 0;" .. "function reportSource()" and "function reportSource() {" .. "function heldByOther(s)".
const REPORT_FIXTURE = { BASE_BLOCK: ['selectionSeq', 'reportSource'], REPORT_BLOCK: ['reportSource', 'heldByOther'] };
function fixtureBlocks(page, ranges) {
  const { readPageSource } = require('./page_source.cjs');
  const inlineBody = text => {
    const inline = scripts(text).filter(t => !t.src);
    if (inline.length !== 1) throw new Error('Expected exactly one inline script');
    return inline[0].body;
  };
  const parse = body => {
    const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw new Error('Inline script must parse');
    return source.statements.map(node => ({
      names: ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(source))
        : node.name ? [node.name.getText(source)] : [],
      text: node.getText(source).replace(/\r\n?/g, '\n'), full: body.slice(node.getFullStart(), node.end) }));
  };
  const base = parse(inlineBody(execFileSync('git', ['cat-file', '--filters', `${FIXTURE_BASE}:worklist-v0/hpacs-lite/main.html`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 })));
  const current = parse(inlineBody(readPageSource(page)));
  const byName = new Map(), byText = new Map();
  base.forEach((s, i) => {
    for (const name of s.names) byName.set(name, i);
    if (!s.names.length) { if (!byText.has(s.text)) byText.set(s.text, []); byText.get(s.text).push(i); }
  });
  const home = current.map(s => {
    if (s.names.length) {
      const found = new Set(s.names.map(name => byName.get(name)));
      return found.size === 1 && !found.has(undefined) ? [...found][0] : -1;
    }
    return (byText.get(s.text) || []).shift() ?? -1;
  });
  const result = {};
  for (const [key, [first, end]] of Object.entries(ranges)) {
    const lo = byName.get(first), hi = byName.get(end);
    if (lo === undefined || hi === undefined || lo >= hi) throw new Error(`Fixture ${key}: no run from ${first} to ${end}`);
    const picked = [];
    let previous = -1;
    current.forEach((s, i) => {
      if (home[i] >= 0) { previous = home[i]; if (home[i] >= lo && home[i] < hi) picked.push([home[i], 0, i]); return; }
      const next = home.slice(i + 1).find(h => h >= 0) ?? Infinity;
      if (previous >= lo && previous < hi && next >= lo && next <= hi) picked.push([previous, 1, i]);
    });
    const declared = new Set(base.slice(lo, hi).flatMap(s => s.names));
    for (const [, , i] of picked) for (const name of current[i].names) declared.delete(name);
    if (declared.size) throw new Error(`Fixture ${key}: declarations not found in the page: ${[...declared].join(', ')}`);
    picked.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    result[key] = picked.map(([, , i]) => current[i].full).join('');
  }
  return result;
}

module.exports = { split, deriveSpec, fixtureBlocks, FIXTURE_BASE, REPORT_FIXTURE };
if (require.main === module) {
  const [op, ...args] = process.argv.slice(2);
  if (op === 'fixture' && args[1]) {
    process.stdout.write(JSON.stringify(fixtureBlocks(args[0], JSON.parse(args[1]))));
  } else if (op === 'split' && args[1]) {
    const [count, outDir, page, spec] = args;
    process.stdout.write(JSON.stringify(split(Number(count), outDir, { page, spec })));
  } else if (op === 'derive' && args[1]) {
    const [page, out] = args;
    const derived = deriveSpec(page);
    fs.writeFileSync(outsideProduct(path.dirname(out)) && out, JSON.stringify(derived, null, 1));
    process.stdout.write(JSON.stringify({ moved: derived.moved, statements: derived.modules.reduce((n, m) => n + m.statements.length, 0) }));
  } else throw new Error('Usage: node main_split_harness.cjs split <count> <outDir> [page] [spec] | derive <page> <outSpec>'
    + ' | fixture <page> <{"KEY":["firstDeclaration","endDeclaration"]}>');
}
