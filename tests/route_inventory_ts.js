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

function answer(request) {
  if (loadError) throw loadError;
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
  const out = {};
  for (const at of texts.keys()) {
    const file = program.getSourceFile(at);
    if (!file) continue;
    const broken = program.getSyntacticDiagnostics(file).length > 0;
    const found = [];
    const visit = node => {
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
  }
  const declared = {};
  for (const [name, symbol] of decorator) {
    const where = symbol && symbol.declarations && symbol.declarations[0];
    declared[name] = where ? path.relative(API, where.getSourceFile().fileName).split(path.sep).join('/') : null;
  }
  return { typescript: ts.version, node: process.version, decorators: declared, files: out };
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
