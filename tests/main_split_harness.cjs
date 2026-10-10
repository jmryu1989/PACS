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
const { scripts, readPage, readPageSource } = require('./page_source.cjs');
const { createHash } = require('node:crypto');
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
  const html = readPageSource(page);
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

  const manifest = actual(target, { spec: options.spec, kind: 'generated', source: page });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

// Read delivered files again, independently of the generator. Actual layouts are never regenerated: a changed
// or missing asset must remain visible to the browser and its hash oracle.
function actual(page, options = {}) {
  const spec = options.spec ? JSON.parse(fs.readFileSync(options.spec, 'utf8')) : require('./main_move_spec.json');
  const input = readPage(page), served = input.html, html = input.source;
  const tag = scripts(html).find(t => !t.src), parts = chunks(html, spec);
  const count = input.files.length, rest = input.region.find(t => !t.src);
  // Line ranges of every statement in the served layout, from the same AST the contract uses. A range starts at
  // the statement's first token (not its leading comments), so a registration's line names one statement.
  const nodes = statements(tag.body);
  const source = ts.createSourceFile('inline.js', tag.body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.statements.length !== nodes.length) throw new Error('Statement list differs from the move contract');
  source.statements.forEach((node, i) => { nodes[i] = { ...nodes[i], token: node.getStart(source) }; });
  const restAt = rest ? rest.start + rest.tag.indexOf('>') + 1 : -1;
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
  const files = [page, ...input.files];
  const inputs = Object.fromEntries(files.map(file => {
    const bytes = fs.readFileSync(file);
    return [path.basename(file), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      lf_sha256: createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex') }];
  }));
  const manifest = { kind: options.kind || 'actual', count, page: path.basename(page), source: options.source || page,
    scripts: externals, inputs,
    parts: parts.slice(0, count).map(p => p.file),
    modules: parts.map((p, i) => ({ index: i, file: p.file, external: i < count, statements: p.statements })),
    statements: result };
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
  const html = readPageSource(page);
  const oldTexts = texts(inlineBody(baseHtml)), body = inlineBody(html), newTexts = texts(body);
  const oldModule = base.modules.flatMap((m, i) => m.statements.map(() => i));
  if (oldModule.length !== oldTexts.length) throw new Error('The spec does not describe its baseline page');
  const pool = new Map();
  oldTexts.forEach((text, i) => { if (!pool.has(text)) pool.set(text, []); pool.get(text).push(i); });
  const match = newTexts.map(text => (pool.get(text) || []).shift() ?? -1);
  const anchors = longestIncreasing(match);
  const names = statements(body).map(n => n.name);
  // A statement outside the kept order that sits between two runs joins the later one when the f1d5406 page had it in
  // that file - a mutant that puts a declaration back at its f1d5406 place gets the f1d5406 file, so the gap the
  // original split had in front of it is there again - and otherwise the run it follows.
  const fixture = readFixture(), file = new Map(base.modules.map((m, i) => [m.file, i]));
  const f1d5406Module = fixture.modules.flatMap(([name, count]) => Array(count).fill(file.get(name)));
  const f1d5406Home = frozenIndexes(fixtureStatements(html), fixture.statements);
  const nextAnchored = [];
  for (let i = names.length - 1, next = base.modules.length - 1; i >= 0; i--) {
    nextAnchored[i] = next;
    if (anchors.has(i)) next = oldModule[match[i]];
  }
  let module = 0;
  const homes = names.map((_, i) => {
    if (anchors.has(i)) return (module = oldModule[match[i]]);
    const wanted = f1d5406Home[i] >= 0 ? f1d5406Module[f1d5406Home[i]] : undefined;
    if (wanted !== undefined && wanted >= module && wanted <= nextAnchored[i]) module = wanted;
    return module;
  });
  const moved = names.filter((_, i) => !anchors.has(i));
  return { ...base, base: null, derivedFrom: base.base, moved,
    note: 'Test-side split of a changed page: baseline runs kept; a moved/new statement between two runs joins the '
      + 'later one when the f1d5406 split had it there, otherwise the run it sits in.',
    modules: base.modules.map((m, i) => ({ file: m.file, job: m.job, statements: names.filter((_, k) => homes[k] === i) })) };
}

// Fixture projection for tests that compile part of main.html's script into a page of their own. Such a test names a
// run of statements of the f1d5406 page (the last page they were cut from by text markers) by the declarations that
// start and end it; the projection returns those statements from the page under test - wherever its statements now
// are, in the f1d5406 order - so a declaration moved ahead of its consumers stays in the fixture and one moved in
// from elsewhere does not. Declarations are matched by their declared names (a test's mutant may change a body);
// other statements by their text; a statement with no counterpart (new, or a mutated anonymous one) belongs to the
// run it sits in, as a cut by markers would have it. Function names select fixture source only - nothing here
// asserts on them. The f1d5406 statement list is read from main_split_harness_fixture.json (each statement's declared
// names, or a hash of its text), written by `freeze` from the git blob, so the tests need no git history or network;
// `fixture-check` compares that file with the blob where the history is there.
const FIXTURE_BASE = 'f1d540626aac03f46de23a9620d69f4c9da66037';
const FIXTURE_FILE = path.join(__dirname, 'main_split_harness_fixture.json');
// The two runs the report harness tests compile (also main_split_harness.py REPORT_FIXTURE): what they cut between
// "let selectionSeq = 0;" .. "function reportSource()" and "function reportSource() {" .. "function heldByOther(s)".
const REPORT_FIXTURE = { BASE_BLOCK: ['selectionSeq', 'reportSource'], REPORT_BLOCK: ['reportSource', 'heldByOther'] };
const fingerprintOf = text => '#' + require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
function fixtureStatements(text) {
  const inline = scripts(text).filter(t => !t.src);
  if (inline.length !== 1) throw new Error('Expected exactly one inline script');
  const body = inline[0].body;
  const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error('Inline script must parse');
  return source.statements.map(node => ({
    names: ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(source))
      : node.name ? [node.name.getText(source)] : [],
    print: fingerprintOf(node.getText(source).replace(/\r\n?/g, '\n')), full: body.slice(node.getFullStart(), node.end) }));
}
// The f1d5406 split's files and statement counts come with the statement list (deriveSpec gives a statement between
// two runs the file the f1d5406 split had it in).
function freezeFixture() {
  const blob = path => execFileSync('git', ['cat-file', '--filters', `${FIXTURE_BASE}:${path}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
  const spec = JSON.parse(blob('tests/main_move_spec.json'));
  return { base: FIXTURE_BASE, page: 'worklist-v0/hpacs-lite/main.html',
    modules: spec.modules.map(m => [m.file, m.statements.length]),
    statements: fixtureStatements(blob('worklist-v0/hpacs-lite/main.html')).map(s => (s.names.length ? s.names : s.print)) };
}
function readFixture() {
  const kept = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
  return { modules: kept.modules,
    statements: kept.statements.map(s => (Array.isArray(s) ? { names: s } : { names: [], print: s })) };
}
// Each current statement's f1d5406 statement: a declaration by its declared names (a split declarator finds the
// multi-declaration it came from), anything else by its text, in order; -1 when there is none.
function frozenIndexes(current, base) {
  const byName = new Map(), byPrint = new Map();
  base.forEach((s, i) => {
    for (const name of s.names) byName.set(name, i);
    if (!s.names.length) { if (!byPrint.has(s.print)) byPrint.set(s.print, []); byPrint.get(s.print).push(i); }
  });
  return current.map(s => {
    if (s.names.length) {
      const found = new Set(s.names.map(name => byName.get(name)));
      return found.size === 1 && !found.has(undefined) ? [...found][0] : -1;
    }
    return (byPrint.get(s.print) || []).shift() ?? -1;
  });
}
function fixtureBlocks(page, ranges) {
  const { readPageSource } = require('./page_source.cjs');
  const base = readFixture().statements;
  const current = fixtureStatements(readPageSource(page));
  const byName = new Map();
  base.forEach((s, i) => { for (const name of s.names) byName.set(name, i); });
  const home = frozenIndexes(current, base);
  const result = {};
  for (const [key, [first, end]] of Object.entries(ranges)) {
    const lo = byName.get(first), hi = byName.get(end);
    if (lo === undefined || hi === undefined || lo >= hi) throw new Error(`Fixture ${key}: no run from ${first} to ${end}`);
    const picked = [];
    let previous = -1;
    current.forEach((s, i) => {
      if (home[i] >= 0) { previous = home[i]; if (home[i] >= lo && home[i] < hi) picked.push([home[i], 0, i]); return; }
      // An unmatched statement right after one of the run belongs to it, as a cut to the end marker would have it - even
      // where the end marker's declaration has moved away (S9-U0a-PRE moved reportWriteBlock and heldByOther).
      const next = home.slice(i + 1).find(h => h >= 0) ?? Infinity;
      if (previous >= lo && previous < hi && next >= lo) picked.push([previous, 1, i]);
    });
    const declared = new Set(base.slice(lo, hi).flatMap(s => s.names));
    for (const [, , i] of picked) for (const name of current[i].names) declared.delete(name);
    if (declared.size) throw new Error(`Fixture ${key}: declarations not found in the page: ${[...declared].join(', ')}`);
    picked.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    result[key] = picked.map(([, , i]) => current[i].full).join('');
  }
  return result;
}

// S9-U0a-PRE mutants on the page under test (tests/main_early_input_mutants.py): M01..M35 put one declaration PRE
// moved back at its f1d5406 place - after the nearest earlier f1d5406 statement PRE did not move, a split declarator
// back into its multi-declaration - and leave every other one where it is; M36 registers a second Quick Match closure
// from the boot Retry click; M37 registers the dictation edit notice after the citation input listener of the same
// textareas. Units are f1d5406 statement indexes (main_split_harness_fixture.json), so the mutant follows the
// statements wherever the page keeps them. Test-side only: it writes a copy, never the product.
const PRE_UNITS = [['M01', 254], ['M02', 107], ['M03', 115, 'selectedUid'], ['M04', 185], ['M05', 248], ['M06', 462],
  ['M07', 386], ['M08', 213], ['M09', 214], ['M10', 218], ['M11', 148], ['M12', 149], ['M13', 150, 'consultationFilter'],
  ['M14', 151], ['M15', 152], ['M16', 153], ['M17', 154], ['M18', 155], ['M19', 186], ['M20', 187], ['M21', 209],
  ['M22', 274], ['M23', 398], ['M24', 399], ['M25', 580], ['M26', 581], ['M27', 582], ['M28', 585], ['M29', 587],
  ['M30', 596], ['M31', 550], ['M32', 551, 'workspaceState'], ['M33', 553], ['M34', 554], ['M35', 558]];
const QUICK_MATCH = 572, CITATION_INPUT = 352;   // the f1d5406 Quick Match and citation input registrations
function preMutant(page, id) {
  const html = readPageSource(page);
  const inline = scripts(html).filter(t => !t.src);
  if (inline.length !== 1) throw new Error('Expected one inline script (an unsplit page)');
  const tag = inline[0], at = tag.start + tag.tag.indexOf('>') + 1, body = tag.body;
  const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const current = source.statements.map(node => ({ node,
    names: ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(source))
      : node.name ? [node.name.getText(source)] : [],
    print: fingerprintOf(node.getText(source).replace(/\r\n?/g, '\n')) }));
  const frozen = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')).statements;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const one = (what, test) => {
    const found = current.filter(test);
    if (found.length !== 1) throw new Error(`${id}: ${what} found ${found.length} times`);
    return found[0];
  };
  const exactly = index => one(`f1d5406 statement ${index}`, s => Array.isArray(frozen[index]) ? same(s.names, frozen[index]) : s.print === frozen[index]);
  const edits = [];
  const unit = PRE_UNITS.find(u => u[0] === id);
  if (unit) {
    const [, index, declarator] = unit;
    const moved = new Set(PRE_UNITS.filter(u => !u[2]).map(u => u[1]));
    let anchorIndex = index - 1;
    while (moved.has(anchorIndex)) anchorIndex--;
    const anchorNames = frozen[anchorIndex];
    // A multi-declaration host stays where it was; its moved declarator (a statement of its own now) is not the anchor.
    const split = new Set(PRE_UNITS.filter(u => u[2]).map(u => u[2]));
    const anchor = Array.isArray(anchorNames)
      ? one(`anchor ${anchorIndex}`, s => s.names.length && s.names.every(n => anchorNames.includes(n))
        && !(s.names.length === 1 && split.has(s.names[0])))
      : exactly(anchorIndex);
    if (declarator) {
      const alone = one(declarator, s => same(s.names, [declarator]));
      const host = one(`host of ${declarator}`, s => s !== alone && s.names.length && s.names.every(n => frozen[index].includes(n)));
      const k = frozen[index].indexOf(declarator), decls = host.node.declarationList.declarations;
      const text = alone.node.declarationList.declarations[0].getText(source);
      edits.push([alone.node.getFullStart(), alone.node.end, '']);
      edits.push(k === 0 ? [decls[0].getStart(source), decls[0].getStart(source), text + ', '] : [decls[k - 1].end, decls[k - 1].end, ', ' + text]);
    } else {
      const stmt = exactly(index);
      edits.push([stmt.node.getFullStart(), stmt.node.end, '']);
      edits.push([anchor.node.end, anchor.node.end, body.slice(stmt.node.getFullStart(), stmt.node.end)]);
    }
  } else if (id === 'M36') {
    const closure = exactly(QUICK_MATCH).node.getText(source).replace(/\r?\n\s*/g, ' ');
    const retry = 'retry.addEventListener("click", () => { retry.disabled = true; boot(); });';
    const i = body.indexOf(retry);
    if (i < 0 || body.indexOf(retry, i + 1) >= 0) throw new Error('M36: the Retry registration');
    edits.push([i, i + retry.length, `retry.addEventListener("click", () => { retry.disabled = true; ${closure} boot(); });`]);
  } else if (id === 'M37') {
    const notice = /\r?\n[^\r\n]*\/\/[^\r\n]*\r?\n\s*el\.addEventListener\("input", \(\) => \{ work\.edited\(\); dictation\.redraw\(\); \}\);/.exec(body);
    if (!notice) throw new Error('M37: the dictation edit notice');
    edits.push([notice.index, notice.index + notice[0].length, '']);
    const cite = exactly(CITATION_INPUT).node;
    edits.push([cite.end, cite.end, '\n    for (const k of RFIELDS) $("#" + k).addEventListener("input", () => { work.edited(); dictation.redraw(); });']);
  } else throw new Error('Unknown PRE mutant ' + id);
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let next = body;
  for (const [from, to, text] of edits) next = next.slice(0, from) + text + next.slice(to);
  const parsed = ts.createSourceFile('inline.js', next, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error(`${id}: the mutant does not parse`);
  return html.slice(0, at) + next + html.slice(tag.end - '</script>'.length);
}

// The statement a declaration mutant (M01..M35) put back, in the mutant page: its index among the page's top-level
// statements (the restored multi-declaration for a split declarator) and the bindings it gives the page (the declarator
// alone; none for the anonymous storage read M27).
function restoredStatement(html, id) {
  const unit = PRE_UNITS.find(u => u[0] === id);
  if (!unit) return null;
  const [, index, declarator] = unit;
  const frozen = readFixture().statements;
  const home = frozenIndexes(fixtureStatements(html), frozen);
  const hits = home.flatMap((h, i) => (h === index ? [i] : []));
  if (hits.length !== 1) throw new Error(`${id}: the restored statement found ${hits.length} times`);
  return { index: hits[0], f1d5406: index, bindings: declarator ? [declarator] : frozen[index].names };
}
// Where the page under test has f1d5406 statements (by index): {f1d5406Index: currentIndex or -1}.
function locateStatements(page, indexes) {
  const home = frozenIndexes(fixtureStatements(readPageSource(page)), readFixture().statements);
  return Object.fromEntries(indexes.map(index => [index, home.indexOf(Number(index))]));
}
// A mutant as the early-input suite serves it: the page, its derived spec and its 45-part layout, with the part that
// holds the restored statement (the manifest the browser is given, not an assumption about it).
function mutantLayout(page, id, outDir) {
  const dir = outsideProduct(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, id + '.html'), html = preMutant(page, id);
  fs.writeFileSync(out, html);
  const spec = path.join(dir, id + '-spec.json');
  fs.writeFileSync(spec, JSON.stringify(deriveSpec(out), null, 1));
  const restored = restoredStatement(html, id);
  const manifest = split(45, path.join(dir, id + '-45'), { page: out, spec });
  return { id, page: out, spec, restored,
    part: restored && { count: 45, ...manifest.statements[restored.index], parts: manifest.parts } };
}

function splitMutant(page, id, outDir) {
  const dir = outsideProduct(outDir);
  if (id === 'S2-M06') {
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'input.html'), spec = path.join(dir, 'derived-spec.json');
    fs.writeFileSync(source, preMutant(page, 'M37'));
    fs.writeFileSync(spec, JSON.stringify(deriveSpec(source)));
    const destination = path.join(dir, 'actual30');
    const manifest = split(30, destination, { page: source, spec });
    return { id, page: path.join(destination, 'main.html'), spec, manifest };
  }
  const count = id.startsWith('S2-') ? 30 : Math.max(18, readPage(page).files.length);
  const manifest = split(count, dir, { page });
  const target = path.join(dir, 'main.html');
  let html = fs.readFileSync(target, 'utf8');
  if (id === 'S1-M01') {
    const file = path.join(dir, 'page-core.js'), body = fs.readFileSync(file, 'utf8');
    const node = statements(body).find(n => n.name === 'apiFail');
    if (!node) throw new Error('S1-M01: apiFail span missing');
    const at = body.indexOf(' ', node.start);
    fs.writeFileSync(file, body.slice(0, at) + '\t' + body.slice(at + 1));
  } else if (id === 'S1-M02') {
    fs.unlinkSync(path.join(dir, 'study-corrections.js'));
  } else if (id === 'S1-M03') {
    const body = fs.readFileSync(path.join(dir, 'study-corrections.js'), 'utf8');
    const node = statements(body).find(n => n.name === 'doDelete');
    const inline = scripts(html).find(t => !t.src), at = inline.start + '<script>'.length;
    html = html.slice(0, at) + body.slice(node.start) + html.slice(at);
  } else if (id === 'S1-M04') {
    html = html.replace('<script src="page-core.js"></script>\n  <script src="study-state.js"></script>',
      '<script src="study-state.js"></script>\n  <script src="page-core.js"></script>');
  } else if (id === 'S1-M05') {
    html = html.replace('<script src="report-dictation.js">', '<script defer src="report-dictation.js">');
  } else if (id === 'S2-M01') {
    const file = path.join(dir, 'related-report.js'), body = fs.readFileSync(file, 'utf8');
    const nodes = statements(body);
    if (nodes[0].name !== 'relatedReportSeq') throw new Error('S2-M01: first declaration missing');
    fs.writeFileSync(file, body.slice(nodes[1].start));
  } else if (id === 'S2-M02') {
    const first = '<script src="report-editor.js"></script>', next = '<script src="report-draft-sync.js"></script>';
    if (!html.includes(first + '\n  ' + next)) throw new Error('S2-M02: adjacent tags missing');
    html = html.replace(first + '\n  ' + next, next + '\n  ' + first);
  } else if (id === 'S2-M03') {
    const file = path.join(dir, 'report-commit.js'), body = fs.readFileSync(file, 'utf8');
    const nodes = statements(body), last = nodes.at(-1);
    // getFullStart owns leading trivia: the boundary LF may be the last LF inside this run.
    const at = body.lastIndexOf('\n');
    if (at < last.start) throw new Error('S2-M03: final statement LF missing');
    fs.writeFileSync(file, body.slice(0, at > 0 && body[at - 1] === '\r' ? at - 1 : at) + body.slice(at + 1));
  } else if (id === 'S2-M04') {
    const body = fs.readFileSync(path.join(dir, 'report-toolbar.js'), 'utf8');
    const nodes = statements(body), node = nodes.at(-1);
    if (node.name !== 'ExpressionStatement after move #2') throw new Error('S2-M04: final move registration missing');
    const inline = scripts(html).find(t => !t.src), at = inline.start + '<script>'.length;
    html = html.slice(0, at) + body.slice(node.start) + html.slice(at);
  } else if (id !== 'BASELINE') throw new Error('Unknown byte mutant ' + id);
  fs.writeFileSync(target, html);
  return { id, page: target, manifest };
}

module.exports = { split, actual, splitMutant, deriveSpec, fixtureBlocks, freezeFixture, preMutant, restoredStatement, locateStatements,
  mutantLayout, PRE_UNITS, FIXTURE_BASE, FIXTURE_FILE, REPORT_FIXTURE };
if (require.main === module) {
  const [op, ...args] = process.argv.slice(2);
  if (op === 'fixture' && args[1]) {
    process.stdout.write(JSON.stringify(fixtureBlocks(args[0], JSON.parse(args[1]))));
  } else if (op === 'pre-mutant' && args[2]) {
    const [page, id, out] = args;
    fs.writeFileSync(outsideProduct(path.dirname(path.resolve(out))) && out, preMutant(page, id));
    process.stdout.write(JSON.stringify({ id, out }));
  } else if (op === 'freeze') {
    const frozen = freezeFixture();
    fs.writeFileSync(FIXTURE_FILE, '{"base": ' + JSON.stringify(frozen.base) + ', "page": ' + JSON.stringify(frozen.page)
      + ', "modules": [\n' + frozen.modules.map(m => JSON.stringify(m)).join(',\n')
      + '\n], "statements": [\n' + frozen.statements.map(s => JSON.stringify(s)).join(',\n') + '\n]}\n');
    process.stdout.write(JSON.stringify({ modules: frozen.modules.length, statements: frozen.statements.length }));
  } else if (op === 'mutant-layout' && args[2]) {
    const [page, id, outDir] = args;
    process.stdout.write(JSON.stringify(mutantLayout(page, id, outDir)));
  } else if (op === 'frozen-index' && args[0]) {
    process.stdout.write(JSON.stringify(frozenIndexes(fixtureStatements(readPageSource(args[0])),
      readFixture().statements)));
  } else if (op === 'locate' && args[1]) {
    const [page, ...indexes] = args;
    process.stdout.write(JSON.stringify(locateStatements(page, indexes)));
  } else if (op === 'fixture-check') {
    const frozen = freezeFixture(), kept = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    const same = JSON.stringify(frozen) === JSON.stringify(kept);
    process.stdout.write(JSON.stringify({ same, statements: kept.statements.length }));
    process.exitCode = same ? 0 : 1;
  } else if (op === 'split-mutant' && args[2]) {
    process.stdout.write(JSON.stringify(splitMutant(args[0], args[1], args[2])));
  } else if (op === 'actual' && args[0]) {
    process.stdout.write(JSON.stringify(actual(args[0], { spec: args[1] })));
  } else if (op === 'split' && args[1]) {
    const [count, outDir, page, spec] = args;
    process.stdout.write(JSON.stringify(split(Number(count), outDir, { page, spec })));
  } else if (op === 'derive' && args[1]) {
    const [page, out] = args;
    const derived = deriveSpec(page);
    fs.writeFileSync(outsideProduct(path.dirname(out)) && out, JSON.stringify(derived, null, 1));
    process.stdout.write(JSON.stringify({ moved: derived.moved, statements: derived.modules.reduce((n, m) => n + m.statements.length, 0) }));
  } else throw new Error('Usage: node main_split_harness.cjs split <count> <outDir> [page] [spec] | derive <page> <outSpec>'
    + ' | fixture <page> <{"KEY":["firstDeclaration","endDeclaration"]}> | freeze | fixture-check | pre-mutant <page> <M01..M37> <out>'
    + ' | mutant-layout <page> <M01..M37> <outDir> | locate <page> <f1d5406 statement index>...');
}
