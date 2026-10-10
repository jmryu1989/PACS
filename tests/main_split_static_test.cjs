'use strict';
// REQ-S9-U0a-BYTES/PRE-ORDER -> RISK-MOVE-ORDER/EARLY-TDZ -> C2/C6.
// Byte/order identity is this refactor's requirement (§1-B.14). TypeScript owns syntax and symbols;
// statement names map locations only. Browser PRE cases are the oracle for callbacks during task gaps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scripts, readPage } = require('./page_source.cjs');
const { baseline, statements } = require('./main_move_contract.cjs');
const spec = require('./main_move_spec.json');
const ROOT = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));
const page = path.join(ROOT, spec.page);
const lf = text => text.replace(/\r\n/g, '\n');
const blob = file => execFileSync('git', ['show', `${spec.base}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const baseHtml = lf(baseline()), actual = readPage(page);
const baseBody = scripts(baseHtml).find(s => !s.src).body;
const homes = spec.modules.flatMap((m, module) => m.statements.map(name => ({ name, module, file: m.file })));
const report = { base: spec.base, actual_count: actual.files.length, typescript: ts.version };
function save() {
  if (!process.env.KIN_SPLIT_STATIC_OUT) return;
  fs.mkdirSync(path.dirname(process.env.KIN_SPLIT_STATIC_OUT), { recursive: true });
  fs.writeFileSync(process.env.KIN_SPLIT_STATIC_OUT, JSON.stringify(report, null, 2) + '\n');
}
process.on('exit', save);

function program(html, current) {
  const entries = new Map(), mappings = new Map();
  let index = 0;
  for (const tag of scripts(html)) {
    const moved = tag.src === actual.bundle || spec.modules.some(m => m.file === tag.src);
    const name = tag.src || 'remaining-inline.js';
    const body = lf(tag.src ? (current ? fs.readFileSync(path.join(path.dirname(page), tag.src), 'utf8')
      : blob(path.posix.join(path.posix.dirname(spec.page), tag.src))) : tag.body);
    const file = path.join(ROOT, 'tmp', 'split-static-virtual', name).replace(/\\/g, '/');
    entries.set(file, body);
    if (moved || !tag.src) {
      const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      mappings.set(file, source.statements.map(node => ({ index: index++, start: node.getFullStart(), end: node.end })));
    }
  }
  const options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None, skipLibCheck: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists, getSource = host.getSourceFile;
  host.readFile = file => entries.has(file) ? entries.get(file) : read(file);
  host.fileExists = file => entries.has(file) || exists(file);
  host.getSourceFile = (file, language, ...rest) => entries.has(file.replace(/\\/g, '/'))
    ? ts.createSourceFile(file, entries.get(file.replace(/\\/g, '/')), language, true, ts.ScriptKind.JS)
    : getSource(file, language, ...rest);
  const compiled = ts.createProgram([...entries.keys()], options, host);
  for (const file of entries.keys()) assert.ok(compiled.getSourceFile(file), `C6 Program actually loaded ${file}`);
  return { compiled, entries, mappings };
}

test('C6: one classic-script Program has no parse errors or new global name/duplicate/TDZ diagnostics', () => {
  const before = program(baseHtml, false), after = program(lf(actual.html), true);
  const relevant = new Set([2304, 2451, 2300, 2448, 2450, 2454, 2393, 2303]);
  function diagnostics(input) {
    const parse = input.compiled.getSyntacticDiagnostics();
    assert.deepEqual(parse.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], 'C6 parse diagnostics');
    return input.compiled.getSemanticDiagnostics().filter(d => relevant.has(d.code)).map(d => {
      const ranges = input.mappings.get(d.file.fileName);
      const at = ranges && ranges.find(s => s.start <= d.start && d.start <= s.end);
      return JSON.stringify({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        location: at ? [homes[at.index].name, d.start - at.start] : [path.basename(d.file.fileName), d.start] });
    }).sort();
  }
  const a = diagnostics(before), b = diagnostics(after), remaining = a.slice(), added = [];
  for (const diagnostic of b) {
    const at = remaining.indexOf(diagnostic);
    if (at < 0) added.push(JSON.parse(diagnostic)); else remaining.splice(at, 1);
  }
  report.C6 = { source_files: after.entries.size, baseline_diagnostics: a.map(JSON.parse),
    candidate_diagnostics: b.map(JSON.parse), added };
  assert.deepEqual(added, [], 'C6 new global diagnostics');
});

function analyze(body, movedCount, ownership = homes) {
  const source = ts.createSourceFile('inline.js', lf(body), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0);
  const host = ts.createCompilerHost({ allowJs: true });
  host.getSourceFile = file => file === 'inline.js' ? source : undefined;
  const checker = ts.createProgram(['inline.js'], { allowJs: true, noLib: true }, host).getTypeChecker();
  const named = statements(body), declarations = new Map(), refs = [], certain = [];
  const fileOf = index => ownership[index].module < movedCount ? ownership[index].module : movedCount;
  source.statements.forEach((node, index) => {
    const items = ts.isVariableStatement(node) ? node.declarationList.declarations : node.name ? [node] : [];
    for (const item of items) {
      const symbol = checker.getSymbolAtLocation(item.name);
      if (symbol) declarations.set(symbol, { index, node: item, function: ts.isFunctionDeclaration(item) });
    }
  });
  const symbolOf = node => checker.getSymbolAtLocation(node);
  function writeKind(node) {
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) && parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'write' : 'read-write';
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) return 'read-write';
    return 'read';
  }
  function reference(node) {
    const p = node.parent;
    return !(p.name === node && (ts.isDeclaration(p) || ts.isPropertyAccessExpression(p))) &&
      !(ts.isPropertyAssignment(p) && p.name === node) && !(ts.isLabeledStatement(p) && p.label === node);
  }
  function scan(node, origin, mode, chain = []) {
    if (ts.isIdentifier(node) && reference(node)) {
      const home = declarations.get(symbolOf(node));
      if (home && home.index > origin) {
        const unavailable = fileOf(home.index) > fileOf(origin) || (!home.function && home.index > origin);
        const item = { statement: named[origin].name, binding: node.text, declared_by: named[home.index].name,
          from_module: ownership[origin].file, to_module: ownership[home.index].file, access: writeKind(node),
          classification: mode, crosses_file: fileOf(home.index) > fileOf(origin), calls: chain };
        refs.push(item);
        if (mode === 'eager' && unavailable) certain.push(item);
      }
    }
    if (ts.isFunctionLike(node)) {
      // Function creation does not execute its body. Direct calls are expanded separately below.
      for (const parameter of node.parameters || []) if (parameter.initializer) scan(parameter.initializer, origin, 'deferred', chain);
      const parentCall = node.parent && ts.isCallExpression(node.parent) ? node.parent : null;
      const callbackMode = parentCall ? 'gap' : 'deferred';
      if (node.body) ts.forEachChild(node.body, child => scan(child, origin, callbackMode, chain));
      return;
    }
    if (ts.isCallExpression(node) && mode === 'eager') {
      const target = ts.isIdentifier(node.expression) ? declarations.get(symbolOf(node.expression)) : null;
      if (target && target.function && !chain.includes(node.expression.text)) {
        const callee = target.node;
        for (const statement of callee.body.statements) {
          // An async function yields at its first top-level await; following callbacks belong to the task-gap oracle.
          let awaits = false;
          const find = n => { if (ts.isAwaitExpression(n)) awaits = true; if (!ts.isFunctionLike(n)) ts.forEachChild(n, find); };
          scan(statement, origin, 'eager', [...chain, node.expression.text]);
          find(statement);
          if (awaits) break;
        }
      } else if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) {
        const body = node.expression.body;
        ts.forEachChild(body, child => scan(child, origin, 'eager', [...chain, '<IIFE>']));
      }
      // These standard array operations synchronously invoke callbacks. Other factory/registration callbacks
      // remain explicit gap possibilities, discharged by the browser's held-boundary/lifecycle cases.
      if (ts.isPropertyAccessExpression(node.expression) && ['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find']
        .includes(node.expression.name.text)) {
        for (const argument of node.arguments) if ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && argument.body)
          scan(argument.body, origin, 'eager', [...chain, node.expression.name.text + ' callback']);
      }
    }
    ts.forEachChild(node, child => scan(child, origin, mode, chain));
  }
  source.statements.forEach((node, index) => scan(node, index, 'eager'));
  // Deferred forward references cross browser task gaps. Keep the entire inventory (not the historical count),
  // with the PRE cases that exercise input/session-end and library lifecycle while each boundary is held.
  for (const ref of refs) if (ref.classification !== 'eager') ref.coverage = [
    'EarlyInputSplit: held 6/9/current-study/33/38 and 0/150ms', 'WindowAndSessionEvents',
    'ActualLayout.test_actual_held_input_and_leaving_boundaries', 'Registration', 'AfterAuthScenarios'];
  return { references: refs, certain };
}

test('C2: statement/effect order and declaration homes are preserved; eager reads and writes have no new hazard', () => {
  const body = lf(actual.script), nodes = statements(body);
  assert.deepEqual(nodes.map(n => n.name), homes.map(h => h.name), 'C2 every statement and effect keeps relative order');
  assert.deepEqual(actual.region.filter(t => t.src).map(t => t.src),
    actual.bundle ? [actual.bundle] : spec.modules.slice(0, actual.files.length).map(m => m.file), 'C2 file order');
  if (actual.bundle) assert.deepEqual(require('../scripts/main-split-order.json').sources.map(s => s.file),
    spec.modules.map(m => m.file), 'C2 editable source order');
  assert.equal(new Set(actual.files).size, actual.files.length, 'C2 no file collision');
  const current = analyze(body, actual.bundle ? 0 : actual.files.length), baselineAnalysis = analyze(baseBody, 0);
  report.C2 = { statements: nodes.length, ...current, baseline_certain: baselineAnalysis.certain };
  assert.deepEqual(baselineAnalysis.certain, [], 'C2 baseline certain load-order violations');
  assert.deepEqual(current.certain, [], 'C2 certain load-order violations');
});

test('C2: immediate writes and a forward function call are detected independently of byte comparison', () => {
  // A narrow compiler probe verifies the reads/writes analysis without making product code satisfy a test shape.
  const body = 'let first = second; second = 1; later(); let second = 0; function later() {}';
  const ownership = statements(body).map((s, i) => ({ ...s, module: i < 3 ? 0 : 1, file: i < 3 ? 'early.js' : 'late.js' }));
  const observed = analyze(body, 2, ownership);
  assert.deepEqual(observed.certain.map(r => [r.binding, r.access]),
    [['second', 'read'], ['second', 'write'], ['later', 'read']]);
});
