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
      const name = ts.isIdentifier(node.expression) ? node.expression.text :
        ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(name)) {
        const command = node.arguments[0] && constant(node.arguments[0]);
        const argv = node.arguments[1];
        if (argv && ts.isArrayLiteralExpression(argv)) {
          const args = argv.elements.map(item => constant(item));
          files.push(...args.filter(value => value && /\.(py|cjs)$/.test(value)).map(value => value.replaceAll('\\', '/')));
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
  const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(requests.map(row => scan(row.source, row.filename))));
}
module.exports = { consumes, scan };
