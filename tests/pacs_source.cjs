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
      if (spec.facade) validateFacade(locations);
      if (spec.concerns) validateConcerns(locations);
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
  // ── split phase: the facade and the concern files hold exactly what the spec names (order S9-U0b sections 4, 5, 7) ──
  const keyOf = node => `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
  const pathOf = node => 'api/src/' + slash(path.relative(apiSrc, node.getSourceFile().fileName));
  const decoratorsOf = node => (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []);
  const modifiersOf = node => (node.modifiers ?? []).filter(m => !ts.isDecorator(m)).map(m => ts.SyntaxKind[m.kind]).sort().join(',');
  const declaredIn = (symbol, file, test) => symbol.declarations.some(d => test(d) && pathOf(d) === file);
  /** The class decorator is Nest's own Injectable(), resolved through the installed @nestjs/common, without options. */
  function nestInjectable(decorator) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || call.arguments.length) return false;
    return resolveSymbol(call.expression).declarations.some(d =>
      /[\\/]node_modules[\\/]@nestjs[\\/]common[\\/]/.test(d.getSourceFile().fileName) && d.name?.getText() === 'Injectable');
  }
  function validateFacade(locations) {
    const wanted = spec.facade, file = program.getSourceFile(filename(wanted.file));
    if (!file) throw new Error(`Unresolved facade file: ${wanted.file}`);
    const classes = file.statements.filter(ts.isClassDeclaration);
    if (classes.length !== 1 || classes[0].name?.text !== wanted.class) throw new Error('Missing or duplicate facade class');
    const cls = classes[0], decorators = decoratorsOf(cls);
    if (decorators.length !== 1 || !nestInjectable(decorators[0])) throw new Error('Facade class decorator differs');
    const reexported = [];
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) || statement === cls) continue;
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        reexported.push(...statement.exportClause.elements.map(element => element.name.text));
        continue;
      }
      throw new Error(`Unlisted facade statement: ${ts.SyntaxKind[statement.kind]}`);
    }
    if (JSON.stringify([...reexported].sort()) !== JSON.stringify([...wanted.reexports].sort())) throw new Error('Facade re-exports differ');
    const slots = new Map(wanted.slots.map(slot => [slot.name, slot])), forwards = new Map(wanted.forwards.map(w => [w.name, w]));
    const seenSlots = new Set(), seenForwards = new Set();
    let ctor = null;
    for (const m of cls.members) {
      if (decoratorsOf(m).length || (ts.isConstructorDeclaration(m) && m.parameters.some(p => decoratorsOf(p).length)))
        throw new Error('Facade member decorator');
      if (ts.isConstructorDeclaration(m)) {
        if (!locations.has(keyOf(m))) throw new Error('Facade constructor is not the mapped one');
        ctor = m;
        continue;
      }
      const name = m.name?.getText();
      if (ts.isPropertyDeclaration(m)) {
        const slot = slots.get(name);
        if (!slot || seenSlots.has(name)) throw new Error(`Unlisted facade field: ${name}`);
        if (modifiersOf(m) !== 'PrivateKeyword,ReadonlyKeyword' || m.initializer || !m.type || !ts.isTypeReferenceNode(m.type) ||
            m.type.typeName.getText() !== slot.class || !declaredIn(resolveSymbol(m.type.typeName), slot.file, ts.isClassDeclaration))
          throw new Error(`Facade slot differs: ${name}`);
        seenSlots.add(name);
        continue;
      }
      if (ts.isMethodDeclaration(m) && m.body) {
        const w = forwards.get(name);
        if (!w || seenForwards.has(name)) throw new Error(`Unlisted facade method: ${name}`);
        const signature = lf(file.text.slice(m.getStart(file), m.body.getStart(file))).trimEnd();
        if (sha256(signature) !== w.signature_sha256) throw new Error(`Facade signature differs: ${name}`);
        const [only, ...rest] = m.body.statements;
        const call = !rest.length && only && ts.isReturnStatement(only) && only.expression && ts.isCallExpression(only.expression) ? only.expression : null;
        const callee = call && ts.isPropertyAccessExpression(call.expression) ? call.expression : null;
        const holder = callee && ts.isPropertyAccessExpression(callee.expression) &&
          callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword ? callee.expression : null;
        const args = call ? call.arguments.map(a => (ts.isIdentifier(a) ? a.text : null)) : [];
        const params = m.parameters.map(p => (ts.isIdentifier(p.name) && !p.dotDotDotToken ? p.name.text : '?'));
        if (!holder || holder.name.text !== w.slot || callee.name.text !== name || JSON.stringify(args) !== JSON.stringify(params))
          throw new Error(`Facade forwarding differs: ${name}`);
        // the call reaches the moved implementation of the same name on that concern, nothing else
        if (!resolveSymbol(callee.name).declarations.includes(member(name, 'MethodDeclaration')))
          throw new Error(`Facade forwarding target differs: ${name}`);
        seenForwards.add(name);
        continue;
      }
      throw new Error(`Unlisted facade member: ${name ?? ts.SyntaxKind[m.kind]}`);
    }
    if (seenSlots.size !== slots.size) throw new Error('Missing facade slot');
    if (seenForwards.size !== forwards.size) throw new Error('Missing facade forwarding');
    if (!ctor) throw new Error('Missing facade constructor');
    const parameters = ctor.parameters.map(p => `${p.name.getText()}:${p.type?.getText()}`);
    if (JSON.stringify(parameters) !== JSON.stringify(wanted.parameters)) throw new Error('Facade constructor parameters differ');
    // the body creates every slot once, in the recorded order, from the recorded references (no locals, no locator)
    const statements = ctor.body?.statements ?? [];
    if (statements.length !== wanted.slots.length) throw new Error('Facade composition differs');
    statements.forEach((statement, index) => {
      const slot = wanted.slots[index];
      const assign = ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken ? statement.expression : null;
      const left = assign && ts.isPropertyAccessExpression(assign.left) &&
        assign.left.expression.kind === ts.SyntaxKind.ThisKeyword ? assign.left.name.text : null;
      const created = assign && ts.isNewExpression(assign.right) ? assign.right : null;
      const args = (created?.arguments ?? []).map(a => (ts.isPropertyAccessExpression(a) &&
        a.expression.kind === ts.SyntaxKind.ThisKeyword ? a.name.text : null));
      if (left !== slot.name || !created || created.expression.getText() !== slot.class || JSON.stringify(args) !== JSON.stringify(slot.args) ||
          !declaredIn(resolveSymbol(created.expression), slot.file, ts.isClassDeclaration))
        throw new Error(`Facade composition differs: ${slot.name}`);
    });
  }
  function validateConcerns(locations) {
    for (const [file, concern] of Object.entries(spec.concerns)) {
      const source = program.getSourceFile(filename(file));
      if (!source) throw new Error(`Unresolved concern file: ${file}`);
      const classes = source.statements.filter(ts.isClassDeclaration);
      if (JSON.stringify(classes.map(c => c.name?.text)) !== JSON.stringify(concern.class ? [concern.class] : []))
        throw new Error(`Concern class differs: ${file}`);
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) || ts.isClassDeclaration(statement)) continue;
        for (const node of ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement])
          if (!locations.has(keyOf(node))) throw new Error(`Unlisted declaration in ${file}: ${node.name?.getText() ?? ts.SyntaxKind[node.kind]}`);
      }
      for (const cls of classes) {
        if (decoratorsOf(cls).length) throw new Error(`Concern decorator: ${file}`);
        for (const m of cls.members) {
          if (decoratorsOf(m).length) throw new Error(`Concern member decorator: ${file}`);
          if (ts.isConstructorDeclaration(m)) {
            const parameters = m.parameters.map(p => `${p.name.getText()}:${p.type?.getText()}`);
            if (JSON.stringify(parameters) !== JSON.stringify(concern.parameters) || m.body?.statements.length ||
                m.parameters.some(p => decoratorsOf(p).length || modifiersOf(p) !== 'PrivateKeyword,ReadonlyKeyword'))
              throw new Error(`Concern constructor differs: ${file}`);
            continue;
          }
          if (!locations.has(keyOf(m))) throw new Error(`Unlisted member in ${file}: ${m.name?.getText() ?? ts.SyntaxKind[m.kind]}`);
        }
      }
    }
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
