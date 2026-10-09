'use strict';
// AST locations and provenance only. Never reconstruct a virtual monolithic service.
// Every file and text hash here is taken over the LF form (`lf`): Git stores LF and a Windows autocrlf checkout
// shows CRLF, so a raw-byte hash would pin the checkout, not the source (CI on Linux disagreed with Windows).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => value.replace(/\\/g, '/');
const lf = value => value.replace(/\r\n/g, '\n');
const targets = ['values', 'access', 'institutions', 'worklist', 'dicom-gateway', 'preferences',
  'filters', 'study-state', 'tech-note', 'report-draft', 'report-evidence', 'report-commit',
  'hold', 'clinician', 'audit', 'metrics'].map(name => `api/src/pacs/${name}.ts`);
const facade = 'api/src/pacs.service.ts';

function createSource(options = {}) {
  const apiSrc = path.resolve(options.apiSrc || process.env.KIN_TEST_API_SRC || path.join(root, 'api/src'));
  const spec = options.spec || JSON.parse(fs.readFileSync(path.join(__dirname, 'pacs_split_spec.json'), 'utf8'));
  const overrides = new Map(Object.entries(options.overrides || {}).map(([file, text]) => [path.resolve(file), text]));
  function filename(file) {
    if (typeof file !== 'string' || !/^api\/src\/[a-zA-Z0-9_./-]+\.ts$/.test(file) || file.includes('..'))
      throw new Error(`Invalid API-relative path: ${file}`);
    return path.join(apiSrc, file.slice('api/src/'.length));
  }
  const configFile = path.join(root, 'api/tsconfig.json');
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
  if (parsed.errors.length) throw new Error('Unresolved TypeScript config');
  const files = ts.sys.readDirectory(apiSrc, ['.ts'], undefined, ['**/*.ts']);
  for (const file of overrides.keys()) if (!files.includes(file)) files.push(file);
  const compilerOptions = { ...parsed.options, noEmit: true, incremental: false,
    typeRoots: [path.join(root, 'api/node_modules/@types')] };
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalRead = host.readFile, originalExists = host.fileExists;
  const originalDirectoryExists = host.directoryExists;
  host.directoryExists = directory => [...overrides.keys()].some(file =>
    file.startsWith(path.resolve(directory) + path.sep)) || originalDirectoryExists(directory);
  host.readFile = file => overrides.has(path.resolve(file)) ? overrides.get(path.resolve(file)) : originalRead(file);
  host.fileExists = file => overrides.has(path.resolve(file)) || originalExists(file);
  host.resolveModuleNames = (names, containingFile) => names.map(name => ts.resolveModuleName(name,
    name.startsWith('.') ? containingFile : path.join(root, 'api/src/__dependency_resolution__.ts'),
    compilerOptions, host).resolvedModule);
  // One Program includes the entire source corpus and follows imports, including an alternate API root.
  const program = ts.createProgram(files, compilerOptions, host);
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile &&
    !path.relative(apiSrc, file.fileName).startsWith('..'));
  const diagnostics = program.getSyntacticDiagnostics();
  if (diagnostics.length) throw new Error('Invalid TypeScript syntax: ' + diagnostics.map(d =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '));
  for (const file of sources) for (const statement of file.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
      const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!module || !module.declarations?.length) throw new Error(`Unresolved module: ${statement.moduleSpecifier.text} in ${file.fileName}`);
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        const exports = checker.getExportsOfModule(module);
        for (const binding of bindings.elements) {
          const imported = binding.propertyName || binding.name;
          const exported = exports.find(symbol => symbol.name === imported.text);
          const target = exported?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
          if (!target?.declarations?.length)
            throw new Error(`Unresolved named export: ${imported.text} from ${statement.moduleSpecifier.text} in ${file.fileName}`);
          const local = resolveSymbol(binding.name);
          if (local !== target)
            throw new Error(`Mismatched named binding: ${binding.name.text} in ${file.fileName}`);
        }
      }
    }
  }
  function resolveSymbol(node) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || !symbol.declarations?.length) throw new Error(`Unresolved symbol: ${node.getText()}`);
    return symbol;
  }
  function candidates(location) {
    const file = program.getSourceFile(filename(location.file));
    if (!file) throw new Error(`Unresolved spec file: ${location.file}`);
    let nodes;
    if (location.owner !== null) {
      const owners = file.statements.filter(node => ts.isClassDeclaration(node) && node.name?.text === location.owner);
      if (owners.length !== 1) throw new Error(`Missing or ambiguous owner: ${location.owner} in ${location.file}`);
      nodes = [...owners[0].members];
    } else {
      nodes = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [node]);
    }
    return nodes.filter(node => (ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(file)) === location.name &&
      (!location.kind || ts.SyntaxKind[node.kind] === location.kind));
  }
  function locate(location) {
    const found = candidates(location);
    if (!found.length) throw new Error(`Missing declaration: ${JSON.stringify(location)}`);
    if (found.length !== 1) throw new Error(`Ambiguous or duplicate declaration: ${JSON.stringify(location)}`);
    const node = found[0];
    if (node.name) {
      const symbol = resolveSymbol(node.name);
      if (!symbol.declarations.includes(node)) throw new Error(`Unresolved declaration binding: ${location.name}`);
    }
    return node;
  }
  function entry(id) {
    const entries = spec.entries.filter(item => item.id === id);
    if (entries.length !== 1) throw new Error(`Missing or duplicate spec entry: ${id}`);
    return entries[0];
  }
  function member(name, kind) {
    const entries = spec.entries.filter(item => item.category === 'member' && item.name === name && (!kind || item.kind === kind));
    if (entries.length !== 1) throw new Error(`Missing or ambiguous member name: ${name}`);
    return locate(entries[0].live);
  }
  function validate() {
    if (spec.schema !== 1 || !['relist', 'split'].includes(spec.phase)) throw new Error('Unsupported split spec');
    if (spec.typescript && spec.typescript !== ts.version) throw new Error('TypeScript version differs from the pinned compiler');
    if (JSON.stringify(spec.targets) !== JSON.stringify(targets)) throw new Error('Misnamed target file in module map');
    if (spec.allocation_sha256 !== sha256(JSON.stringify(spec.entries.map(e => [e.id, e.target]))))
      throw new Error('Target allocation differs from the approved map');
    const ids = new Set(), locations = new Set();
    for (const item of spec.entries) {
      if (ids.has(item.id)) throw new Error(`Duplicate spec entry: ${item.id}`);
      ids.add(item.id);
      if (![facade, ...targets].includes(item.target)) throw new Error(`Misnamed target: ${item.target}`);
      if (spec.phase === 'relist' && item.live.file !== facade || spec.phase === 'split' && item.live.file !== item.target)
        throw new Error(`Unresolved spec location/target: ${item.id}`);
      const node = locate(item.live), key = `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText();
      const kind = ts.SyntaxKind[node.kind];
      const category = ts.isClassDeclaration(node.parent) ? 'member' : 'declaration';
      if (item.name !== name || item.kind !== kind || item.category !== category ||
          item.live.name !== name || item.live.kind !== kind || item.id !== `${category}:${name}:${kind}`)
        throw new Error(`Inconsistent spec identity: ${item.id}`);
      if (locations.has(key)) throw new Error(`Duplicate implementation: ${item.id}`);
      locations.add(key);
    }
    if (spec.phase === 'relist') {
      const file = program.getSourceFile(filename(facade));
      const cls = file.statements.filter(n => ts.isClassDeclaration(n) && n.name?.text === 'PacsService');
      if (cls.length !== 1) throw new Error('Missing or duplicate PacsService');
      const top = file.statements.filter(n => !ts.isImportDeclaration(n) && n !== cls[0])
        .flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [n]);
      for (const node of [...cls[0].members, ...top]) {
        const key = `${file.fileName}:${node.pos}:${node.end}`;
        if (!locations.has(key)) throw new Error(`Unlisted declaration: ${node.name?.getText() || ts.SyntaxKind[node.kind]}`);
      }
    } else {
      // An unremoved old implementation is a duplicate even if the spec points
      // only to the new owner. Forwarders have a different body and are not copies.
      const baselines = new Map(spec.entries.map(e => [e.baseline?.text_sha256, e.id]));
      for (const file of sources.filter(sf => [facade, ...targets].includes(
        'api/src/' + slash(path.relative(apiSrc, sf.fileName))))) {
        const declarations = file.statements.flatMap(n => ts.isClassDeclaration(n) ? [...n.members] :
          ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [n]);
        for (const node of declarations) {
          const key = `${file.fileName}:${node.pos}:${node.end}`;
          const id = baselines.get(sha256(lf(node.getText())));
          if (id && !locations.has(key)) throw new Error(`Duplicate unmapped implementation: ${id}`);
        }
      }
    }
    return { members: spec.entries.filter(e => e.category === 'member').length,
      declarations: spec.entries.filter(e => e.category === 'declaration').length };
  }
  function sourceFiles() {
    return sources.map(file => ({ file: 'api/src/' + slash(path.relative(apiSrc, file.fileName)),
      sha256: sha256(lf(host.readFile(file.fileName))) })).sort((a, b) => a.file.localeCompare(b.file));
  }
  function callsTo(file, name) {
    const source = program.getSourceFile(filename(file));
    if (!source) throw new Error(`Unresolved call owner: ${file}`);
    const declarations = source.statements.filter(n => n.name?.text === name);
    if (declarations.length !== 1) throw new Error(`Ambiguous call binding: ${name}`);
    const wanted = resolveSymbol(declarations[0].name), calls = [];
    for (const sf of sources) {
      function walk(node) {
        if (ts.isCallExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          let symbol = checker.getSymbolAtLocation(callee);
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          if (symbol === wanted) calls.push({ file: 'api/src/' + slash(path.relative(apiSrc, sf.fileName)),
            start: node.getStart(sf), text: lf(node.getText(sf)) });
        }
        ts.forEachChild(node, walk);
      }
      walk(sf);
    }
    return calls;
  }
  return { program, checker, spec, apiSrc, locate, entry, member, validate, sourceFiles, callsTo, resolveSymbol };
}
module.exports = { createSource, ts, sha256, lf, targets, facade };
// The existing image suites use /tests for shared vectors. Keep those same vectors
// when executing against local TypeScript; do not copy or rewrite their test code.
if (process.env.KIN_PACS_TEST_PRELOAD === '1') {
  require('./service_test_loader.cjs');
  const Module = require('node:module'), resolve = Module._resolveFilename;
  Module._resolveFilename = function (name, parent, ...rest) {
    if (name.startsWith('/tests/')) name = path.join(__dirname, name.slice(7));
    return resolve.call(this, name, parent, ...rest);
  };
}
if (require.main === module) {
  const source = createSource();
  source.validate();
  const [operation, id] = process.argv.slice(2);
  if (operation === 'inventory') console.log(JSON.stringify({ ...source.validate(), files: source.sourceFiles() }));
  else if (operation === 'entry') {
    const node = source.locate(source.entry(id).live);
    console.log(JSON.stringify({ file: source.entry(id).live.file,
      text: lf(node.getText()), sha256: sha256(lf(node.getText())) }));
  } else if (operation === 'clinician-sites') {
    const calls = source.callsTo('api/src/clinician-policy.ts', 'clinicianOnly');
    console.log(JSON.stringify(calls));
  } else throw new Error('Expected inventory, entry <id>, or clinician-sites');
}
