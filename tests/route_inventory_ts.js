'use strict';
/* S7-U1a-B-R-001-F02: what the TypeScript compiler binds each name spelled like a route decorator to.
 *
 * tests/clinician_policy_test.py refuses a route decorator, Controller, RequestMapping, Public or SetMetadata name that
 * occurs in api/src anywhere but its import and a decorator its inventory reads. Which occurrences are that decorator
 * is a question of TypeScript's binding (a type named Head is not Nest's Head, a type-only re-export of it is not
 * either), so it is answered here by the compiler and type checker api/package-lock.json installs
 * (api/node_modules/typescript, 'npm ci --prefix api --ignore-scripts'), with api/tsconfig.json's options, not by a
 * reader of this repository. This file only asks the checker and reports; the test decides what an answer means.
 *
 * One process answers many requests (the test judges some three hundred source sets): one JSON object per line on stdin
 * and one per line on stdout. A request is
 *   {"files": {"<path under api/src>": text | null, ...}, "names": {"Head": "@nestjs/common", "Public": "./auth.guard"}}
 * where files is the whole set to judge, null standing for the text the previous request sent for that path. A file
 * under api/src that is not in the set does not exist for the program; lib and node_modules are read from disk. The
 * answer is {"typescript", "node", "decorators": {name: declaration or null}, "files": {path: [[offset, name, binding]]}}
 * for every identifier spelled as one of names (offset in code points of the text sent), where binding is
 *   decorator  - the checker resolves it, through every import and export alias, to one of the names' decorators: the
 *                export of that name from its module;
 *   project    - to declarations that are all in files of the set, none of them a decorator;
 *   package    - to a declaration outside the set (lib, node_modules) that is not a decorator;
 *   unresolved - to nothing the checker knows (an unknown export, a property of any), or its file does not parse, or
 *                the decorator of that spelling is not found.
 * A shorthand property ('{ Head }') and a destructured name ('const { Head } = x') also read a value or a property;
 * each symbol the identifier stands for is resolved and the strongest answer (decorator, unresolved, package, project)
 * is given. A module under node_modules that does not resolve (typescript or @nestjs/common not installed) is an answer
 * {"error": ...}, and the test fails on it.
 * EMR-A-LAND OL-01: contracts also reports relative loader resolutions and fixed-list prototype comparisons by
 * code-point offset, using this same program and its AST. The closed source contract decides which forms to accept.
 * EMR-R1-LAND: {"classPropertySource": maskedSource} returns {"class_properties": [codePointOffset, ...]} without
 * changing the binding program's source set. Only AST-confirmed property names are excluded by the heading reader.
 * D1660 (EMR-B2 c, D73 §15): contracts also reports, per file, constructors_returning_another_object (the constructor
 * keyword offsets whose own scope returns an expression other than `this`) and process_uses ([offset, kind, member]
 * for every use of the global process: 'member' by '.' or one plain literal key, 'optional', 'computed', 'value' or
 * 'shadow' for a project declaration of that name); null for a file that does not parse. The closed source contract
 * decides which members and forms are accepted.
 */
const path = require('path');
const readline = require('readline');

const API = path.resolve(__dirname, '..', 'api').split(path.sep).join('/');
const SRC = API + '/src';
const RANK = ['project', 'package', 'unresolved', 'decorator'];

let ts, options, host, previous, loadError = null;
const texts = new Map();      // absolute path of a file of the current set -> text
const parsed = new Map();     // absolute path -> SourceFile, reused while its text is the same
const disk = new Map();       // absolute path outside api/src -> SourceFile, parsed once
const offsets = new WeakMap();

const absolute = file => path.resolve(file).split(path.sep).join('/');
const underSrc = file => file === SRC || file.startsWith(SRC + '/');

function load() {
  ts = require(require.resolve('typescript', { paths: [API] }));
  const config = ts.readConfigFile(API + '/tsconfig.json', ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, API);
  options = { ...parsedConfig.options, noEmit: true, incremental: false, sourceMap: false };
  delete options.outDir;
  delete options.tsBuildInfoFile;
  const base = ts.createCompilerHost(options, true);
  host = {
    ...base,
    fileExists: file => (underSrc(absolute(file)) ? texts.has(absolute(file)) : base.fileExists(file)),
    readFile: file => (underSrc(absolute(file)) ? texts.get(absolute(file)) : base.readFile(file)),
    directoryExists: dir => {
      const at = absolute(dir);
      if (!underSrc(at)) return base.directoryExists ? base.directoryExists(dir) : true;
      return at === SRC || [...texts.keys()].some(file => file.startsWith(at + '/'));
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreate) {
      const at = absolute(fileName);
      if (underSrc(at)) {
        const text = texts.get(at);
        if (text === undefined) return undefined;
        const known = parsed.get(at);
        if (known && known.text === text) return known;
        const file = ts.createSourceFile(fileName, text, languageVersion, true);
        parsed.set(at, file);
        return file;
      }
      if (!disk.has(at)) disk.set(at, base.getSourceFile(fileName, languageVersion, onError, shouldCreate));
      return disk.get(at);
    },
  };
}

function codePoint(file, offset) {
  let table = offsets.get(file);
  if (table === undefined) {
    const text = file.text;
    table = null;
    if (/[\uD800-\uDFFF]/.test(text)) {
      table = new Int32Array(text.length + 1);
      let points = 0, i = 0;
      while (i < text.length) {
        const width = text.codePointAt(i) > 0xffff ? 2 : 1;
        for (let k = 0; k < width; k++) table[i + k] = points;
        i += width;
        points++;
      }
      table[text.length] = points;
    }
    offsets.set(file, table);
  }
  return table === null ? offset : table[offset];
}

function target(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function decorators(program, checker, names) {
  const found = new Map();
  const containing = SRC + '/__route_inventory__.ts';
  for (const [name, specifier] of Object.entries(names)) {
    const resolved = ts.resolveModuleName(specifier, containing, options, host).resolvedModule;
    if (!resolved) {
      if (!specifier.startsWith('.')) throw new Error(`${specifier} does not resolve from api/src: run npm ci --prefix api`);
      found.set(name, null);
      continue;
    }
    const file = program.getSourceFile(resolved.resolvedFileName);
    const module = file && checker.getSymbolAtLocation(file);
    const exported = module && checker.getExportsOfModule(module).find(symbol => symbol.name === name);
    found.set(name, exported ? target(checker, exported) : null);
  }
  if (![...found.values()].some(Boolean)) throw new Error('no decorator resolves: ' + JSON.stringify(names));
  return found;
}

function standsFor(checker, node) {
  const symbols = [checker.getSymbolAtLocation(node)];
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    symbols.push(checker.getShorthandAssignmentValueSymbol(parent));
  }
  if (ts.isBindingElement(parent) && parent.name === node && !parent.propertyName && ts.isObjectBindingPattern(parent.parent)) {
    symbols.push(checker.getPropertyOfType(checker.getTypeAtLocation(parent.parent), node.text));
  }
  return symbols;
}

function binding(checker, node, decorator, known, files) {
  if (!decorator.get(node.text)) return 'unresolved';
  let answer = 'project';
  for (const symbol of standsFor(checker, node)) {
    const resolved = target(checker, symbol);
    let kind;
    if (resolved && known.has(resolved)) kind = 'decorator';
    else if (!resolved || !resolved.declarations || !resolved.declarations.length) kind = 'unresolved';
    else if (resolved.declarations.every(d => files.has(absolute(d.getSourceFile().fileName)))) kind = 'project';
    else kind = 'package';
    if (RANK.indexOf(kind) > RANK.indexOf(answer)) answer = kind;
  }
  return answer;
}

// Relative loaders are followed with the same compiler host as the inventory, including virtual fixtures.
// Merely starting with './' is insufficient: missing/out-of-scope files and decorator exports stay closed.
function relativeLoad(node, file, program, checker, known, files) {
  let argument, callee;
  if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
       ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
    argument = node.arguments[0];
    callee = node.expression;
  } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    argument = node.argument.literal;
    callee = node.getChildren(file).find(child => child.kind === ts.SyntaxKind.ImportKeyword);
    if (!callee) return null;
  } else return null;
  if (!ts.isStringLiteral(argument) || !/^\.\.?\//.test(argument.text)) return null;
  const offset = codePoint(file, callee.getStart(file));
  const resolved = ts.resolveModuleName(argument.text, file.fileName, options, host).resolvedModule;
  const destination = resolved && absolute(resolved.resolvedFileName);
  if (!destination || !files.has(destination) || !underSrc(destination) || destination.endsWith('.d.ts')) {
    return [offset, 'relative module is missing or outside the checked api/src scope'];
  }
  const source = program.getSourceFile(destination);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol || program.getSyntacticDiagnostics(source).length) return [offset, 'relative module has no readable exports'];
  const seen = new Set();
  const exposesDecorator = symbol => {
    symbol = target(checker, symbol);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return known.has(symbol) || Boolean(symbol.flags & ts.SymbolFlags.Module) &&
      checker.getExportsOfModule(symbol).some(exposesDecorator);
  };
  if (exposesDecorator(symbol)) return [offset, 'relative module exports a route or public metadata decorator'];
  return [offset, 'followed'];
}

function fixedPrototypeComparison(node, file) {
  // An inline fixed list consumes the prototype only as an identity comparison, never hands it to a writer.
  // Use the TS AST, not another source-text parser (D73); expressions, spreads and assigned results are refused.
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || node.questionDotToken ||
      !ts.isPropertyAccessExpression(node.expression) || node.expression.questionDotToken ||
      !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'Object' ||
      node.expression.name.text !== 'getPrototypeOf') return null;
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.questionDotToken || call.arguments.length !== 1 || call.arguments[0] !== node ||
      !ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken ||
      call.expression.name.text !== 'includes' || !ts.isArrayLiteralExpression(call.expression.expression)) return null;
  const elements = call.expression.expression.elements;
  if (!elements.length || !elements.every(element => element.kind === ts.SyntaxKind.NullKeyword ||
      ts.isPropertyAccessExpression(element) && !element.questionDotToken && element.name.text === 'prototype' &&
      ts.isIdentifier(element.expression) && ['Object', 'Array'].includes(element.expression.text))) return null;
  return codePoint(file, node.expression.name.getStart(file));
}

function constructorReturningAnotherObject(node, file) {
  // D1660 (D73 §15): only a `return <expression>` other than `return this` can substitute the instance Nest serves;
  // a bare `return;` ends the constructor early and keeps it. Nested callbacks and classes return from their own
  // scope, never replace the outer constructor's instance. Use TS's scope nodes rather than text.
  if (!ts.isConstructorDeclaration(node) || !node.body) return null;
  let substitutes = false;
  const visit = child => {
    if (ts.isReturnStatement(child)) {
      let value = child.expression;
      while (value && ts.isParenthesizedExpression(value)) value = value.expression;
      if (value && value.kind !== ts.SyntaxKind.ThisKeyword) substitutes = true;
      return;
    }
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  const keyword = node.getChildren(file).find(child => child.kind === ts.SyntaxKind.ConstructorKeyword);
  return substitutes && keyword ? codePoint(file, keyword.getStart(file)) : null;
}

// D1660 (D73 §15): every use of the global `process`, judged by the AST and the checker's binding instead of a
// source-text reader. A member reached by '.' or by one plain literal key is reported by name (the source contract
// lists the members that neither load nor evaluate code nor write metadata); every other use is reported as what it
// is: a computed key, an optional member, the value handed on, or a project declaration that rebinds the name.
function processUse(node, file, checker, files) {
  if (!ts.isIdentifier(node) || node.text !== 'process') return null;
  const parent = node.parent;
  if (!parent) return null;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent) ||
        ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node)) return null;
  const offset = codePoint(file, node.getStart(file));
  const symbol = target(checker, checker.getSymbolAtLocation(node));
  const declared = symbol && symbol.declarations && symbol.declarations.length ? symbol.declarations : [];
  if (declared.length && declared.every(d => files.has(absolute(d.getSourceFile().fileName)))) return [offset, 'shadow', null];
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.questionDotToken ? [offset, 'optional', parent.name.text] : [offset, 'member', parent.name.text];
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const key = parent.argumentExpression;
    if (!parent.questionDotToken && key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) return [offset, 'member', key.text];
    return [offset, 'computed', null];
  }
  return [offset, 'value', null];
}

// D1660 (D73 §15): every identifier `module`, judged by the AST and the checker's binding. 'key' is the name of an
// object-literal property assignment ({ module: AppModule, providers }, Nest's DynamicModule); 'local' is a const
// variable declared in the checked files whose declared type is not any (a loop variable over typed Nest modules),
// at its declaration and at each use; everything else - a shorthand property, a label, a parameter, an any-typed
// local, a member access on another value or the CommonJS `module` itself - is 'other' and stays a sealed word.
function moduleUse(node, file, checker, files) {
  if (!ts.isIdentifier(node) || node.text !== 'module' || !node.parent) return null;
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node)) return null;
  const offset = codePoint(file, node.getStart(file));
  if (ts.isPropertyAssignment(parent) && parent.name === node && ts.isObjectLiteralExpression(parent.parent)) return [offset, 'key'];
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol && symbol.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) &&
      files.has(absolute(declaration.getSourceFile().fileName)) &&
      !(checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.Any)) return [offset, 'local'];
  return [offset, 'other'];
}

// D1660 (D73 §15): Object.defineProperty(<identifier>, <key>, { <names>: ... }) read by the AST: the target's name,
// every key the call can name (a string literal, or a const for-of variable - plain or an array-binding element -
// over an `as const` array literal of string literals or of such arrays), the descriptor's property names and
// whether its value is a function. The fixture's sealed_forms says which file may hold which exact form; a key the
// reader cannot enumerate, a non-identifier target or a descriptor other than plain assignments is reported as such.
function constKeys(checker, key) {
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return [key.text];
  if (!ts.isIdentifier(key)) return null;
  const symbol = checker.getSymbolAtLocation(key);
  const declaration = symbol && symbol.valueDeclaration;
  if (!declaration) return null;
  let variable = declaration, index = null;
  if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent) && !declaration.dotDotDotToken &&
      !declaration.propertyName && ts.isVariableDeclaration(declaration.parent.parent)) {
    index = declaration.parent.elements.indexOf(declaration);
    variable = declaration.parent.parent;
  }
  if (!ts.isVariableDeclaration(variable) || !ts.isVariableDeclarationList(variable.parent) || !(variable.parent.flags & ts.NodeFlags.Const) ||
      !ts.isForOfStatement(variable.parent.parent) || variable.parent.parent.initializer !== variable.parent) return null;
  let tuple = variable.parent.parent.expression;
  if (!ts.isAsExpression(tuple) || !ts.isTypeReferenceNode(tuple.type) || !ts.isIdentifier(tuple.type.typeName) ||
      tuple.type.typeName.text !== 'const' || !ts.isArrayLiteralExpression(tuple.expression)) return null;
  const keys = [];
  for (const element of tuple.expression.elements) {
    let value = element;
    if (index !== null) {
      if (!ts.isArrayLiteralExpression(element) || element.elements.length <= index) return null;
      value = element.elements[index];
    }
    if (!ts.isStringLiteral(value)) return null;
    keys.push(value.text);
  }
  return keys.length ? keys : null;
}

function definePropertyUse(node, file, checker) {
  if (!ts.isCallExpression(node) || node.questionDotToken || !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.questionDotToken || !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== 'Object' || node.expression.name.text !== 'defineProperty') return null;
  const offset = codePoint(file, node.expression.name.getStart(file));
  const [target, key, descriptor] = node.arguments;
  if (node.arguments.length !== 3 || !ts.isIdentifier(target) || !ts.isObjectLiteralExpression(descriptor)) return [offset, null, null, null, false];
  const keys = constKeys(checker, key);
  const names = [];
  let functionValue = false;
  for (const property of descriptor.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return [offset, target.text, keys, null, false];
    names.push(property.name.text);
    if (property.name.text === 'value') functionValue = ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer);
  }
  return [offset, target.text, keys, names, functionValue];
}

function answer(request) {
  if (loadError) throw loadError;
  if (typeof request.classPropertySource === 'string') {
    // The heading reader must not confuse IdentifierName properties with the class keyword.
    // Only exclude AST-confirmed names; malformed headings still reach the existing refusal checks.
    const file = ts.createSourceFile('class-properties.ts', request.classPropertySource,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const properties = [];
    const visit = node => {
      const owner = node.parent;
      if (ts.isIdentifier(node) && node.text === 'class' && owner &&
          ((ts.isBindingElement(owner) && owner.propertyName === node) || (owner.name === node &&
          (ts.isEnumMember(owner) || ts.isPropertySignature(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner) ||
           ts.isShorthandPropertyAssignment(owner) || ts.isMethodDeclaration(owner) || ts.isMethodSignature(owner) ||
           ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner) || ts.isPropertyAccessExpression(owner))))) {
        properties.push(codePoint(file, node.getStart(file)));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return { class_properties: properties };
  }
  const set = new Map();
  for (const [name, text] of Object.entries(request.files)) {
    const at = absolute(path.join(SRC, name));
    if (!underSrc(at) || at === SRC) throw new Error('not a file under api/src: ' + name);
    const value = text === null ? texts.get(at) : text;
    if (typeof value !== 'string') throw new Error('no text for ' + name);
    set.set(at, value);
  }
  texts.clear();
  for (const [at, text] of set) texts.set(at, text);
  const names = new Set(Object.keys(request.names));
  const roots = [...texts.keys()].filter(file => file.endsWith('.ts'));
  for (const specifier of new Set(Object.values(request.names))) {
    const resolved = ts.resolveModuleName(specifier, SRC + '/__route_inventory__.ts', options, host).resolvedModule;
    if (resolved && !roots.includes(resolved.resolvedFileName)) roots.push(resolved.resolvedFileName);
  }
  const program = ts.createProgram({ rootNames: roots, options, host, oldProgram: previous });
  previous = program;
  const checker = program.getTypeChecker();
  const decorator = decorators(program, checker, request.names);
  const known = new Set([...decorator.values()].filter(Boolean));
  const files = new Set(texts.keys());
  const out = {}, contracts = {};
  for (const at of texts.keys()) {
    const file = program.getSourceFile(at);
    if (!file) continue;
    const broken = program.getSyntacticDiagnostics(file).length > 0;
    const found = [];
    const loads = [], comparisons = [], constructors = [], processUses = [], moduleUses = [], defineProperties = [];
    const visit = node => {
      if (!broken) {
        const constructor = constructorReturningAnotherObject(node, file);
        if (constructor !== null) constructors.push(constructor);
        const load = relativeLoad(node, file, program, checker, known, files);
        if (load) loads.push(load);
        const comparison = fixedPrototypeComparison(node, file);
        if (comparison !== null) comparisons.push(comparison);
        const use = processUse(node, file, checker, files);
        if (use) processUses.push(use);
        const moduleIdentifier = moduleUse(node, file, checker, files);
        if (moduleIdentifier) moduleUses.push(moduleIdentifier);
        const definition = definePropertyUse(node, file, checker);
        if (definition) defineProperties.push(definition);
      }
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const start = node.getStart(file);
        if (file.text.slice(start, node.end) === node.text) {
          found.push([codePoint(file, start), node.text, broken ? 'unresolved' : binding(checker, node, decorator, known, files)]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (found.length) out[at.slice(SRC.length + 1)] = found;
    contracts[at.slice(SRC.length + 1)] = { relative_loads: loads, prototype_comparisons: comparisons,
      constructors_returning_another_object: constructors, process_uses: broken ? null : processUses,
      module_uses: broken ? null : moduleUses, define_property_uses: broken ? null : defineProperties };
  }
  const declared = {};
  for (const [name, symbol] of decorator) {
    const where = symbol && symbol.declarations && symbol.declarations[0];
    declared[name] = where ? path.relative(API, where.getSourceFile().fileName).split(path.sep).join('/') : null;
  }
  return { typescript: ts.version, node: process.version, decorators: declared, files: out, contracts };
}

try {
  load();
} catch (error) {
  loadError = error;
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let reply;
  try {
    reply = answer(JSON.parse(line));
  } catch (error) {
    reply = { error: String(error && error.stack || error) };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
});
