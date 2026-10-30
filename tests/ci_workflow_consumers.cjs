// REQ-W2C-05 -> RISK-CI-UNHASHED-INPUT: use the installed TS AST, never grep JS.
const fs = require('node:fs');
const ts = require('../api/node_modules/typescript');

function scan(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse ${filename}`);
  // Bind identifiers to declarations so shadowed constants cannot hide a reader.
  const host = ts.createCompilerHost({ noLib: true, allowJs: true });
  host.getSourceFile = name => name === filename ? tree : undefined;
  host.fileExists = name => name === filename;
  host.readFile = name => name === filename ? source : undefined;
  const program = ts.createProgram([filename], { noLib: true, allowJs: true }, host);
  const checker = program.getTypeChecker();
  function constant(node, seen = new Set()) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return constant(node.expression, seen);
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !(declaration.parent.flags & ts.NodeFlags.Const) || seen.has(declaration)) return undefined;
    return constant(declaration.initializer, new Set([...seen, declaration]));
  }
  const literals = [];
  const modules = [];
  const files = [];
  let unresolved = false;
  const mutatedArrays = new Set();
  function findArrayMutations(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'copyWithin'].includes(node.expression.name.text)) {
      mutatedArrays.add(checker.getSymbolAtLocation(node.expression.expression));
    }
    if (ts.isBinaryExpression(node) && ts.isElementAccessExpression(node.left)) {
      mutatedArrays.add(checker.getSymbolAtLocation(node.left.expression));
    }
    ts.forEachChild(node, findArrayMutations);
  }
  findArrayMutations(tree);
  function argvValues(node, seen = new Set()) {
    if (!node || seen.has(node)) return [undefined];
    seen = new Set([...seen, node]);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(item => argvValues(item, seen));
    if (ts.isSpreadElement(node)) return argvValues(node.expression, seen);
    if (ts.isConditionalExpression(node)) return [...argvValues(node.whenTrue, seen), ...argvValues(node.whenFalse, seen)];
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const values = argvValues(declaration.initializer, seen);
        return mutatedArrays.has(symbol) || !(declaration.parent.flags & ts.NodeFlags.Const) ? [...values, undefined] : values;
      }
    }
    return [constant(node)];
  }
  function visit(node) {
    // Template pieces count too: `${root}/.github/workflows` has no plain string literal.
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) literals.push(node.text.replaceAll('\\', '/'));
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isCallExpression(node) && node.arguments.length &&
               (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
                (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
                 ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require'))) {
      specifier = node.arguments[0];
    }
    if (specifier) {
      const value = constant(specifier);
      if (value === undefined) unresolved = true; // Conservative inclusion of unsupported dynamic loading.
      else modules.push(value.replaceAll('\\', '/'));
    }
    if (ts.isCallExpression(node)) {
      let name = ts.isIdentifier(node.expression) ? node.expression.text :
        ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const declaration = symbol?.valueDeclaration || symbol?.declarations?.find(ts.isBindingElement);
        if (declaration && ts.isBindingElement(declaration) && declaration.propertyName) {
          name = declaration.propertyName.text;
        }
      }
      if (['exec', 'execSync'].includes(name)) unresolved = true;
      if (name === 'fork') {
        const target = node.arguments[0] && constant(node.arguments[0]);
        if (target === undefined) unresolved = true;
        else files.push(target);
      }
      if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(name)) {
        const command = node.arguments[0] && constant(node.arguments[0]);
        const argv = node.arguments[1];
        const values = argvValues(argv);
        files.push(...values.filter(value => value && /\.(py|cjs|js|mjs|ts)$/.test(value)).map(value => value.replaceAll('\\', '/')));
        if (values.includes(undefined)) unresolved = true;
        if (values.some(value => ['-e', '--eval', '-r', '--require'].includes(value))) unresolved = true;
        if (argv && ts.isArrayLiteralExpression(argv)) {
          const args = argv.elements.map(item => constant(item));
          files.push(...args.filter(value => value && /\.(py|cjs|js|mjs|ts)$/.test(value)).map(value => value.replaceAll('\\', '/')));
          if (command && /(^|[/\\])python(?:[\d.]*)?(?:\.exe)?$/.test(command) && args[0] === '-m' && args[1]) {
            files.push(args[1].replaceAll('.', '/') + '.py');
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {
    reads: unresolved || consumesLiterals(literals),
    modules,
    files,
    // Browser pages also load workers/importScripts and constructed script URLs.
    // Keep executable path literals conservatively; comments never enter the AST.
    scriptPaths: literals.filter(value => /\.(?:js|mjs|cjs)(?:[?#].*)?$/.test(value)),
  };
}

function consumesLiterals(literals) {
  literals = literals.map(s => s.replace(/\/+$/, ''));
  return literals.some(s => s.includes('.github/workflows')) ||
    (literals.includes('.github') && literals.includes('workflows'));
}

function consumes(source, filename) {
  return scan(source, filename).reads;
}

if (require.main === module) {
  if (process.argv[2] === '--audit') {
    const result = require('node:child_process').spawnSync(process.env.PYTHON || 'python',
      ['-B', require('node:path').join(__dirname, 'ci_workflow_consumers_test.py'), '--audit', process.argv[3] || '.'],
      { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } else {
    const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(requests.map(row => scan(row.source, row.filename))));
  }
}
module.exports = { consumes, scan };
