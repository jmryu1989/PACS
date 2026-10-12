// REQ-W2C-05 -> RISK-CI-UNHASHED-INPUT: use the installed TS AST, never grep JS.
const fs = require('node:fs');
const ts = require('../api/node_modules/typescript');

function scan(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse ${filename}`);
  const literals = [];
  const modules = [];
  function visit(node) {
    // Template pieces count too: `${root}/.github/workflows` has no plain string literal.
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) literals.push(node.text.replaceAll('\\', '/'));
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.arguments.length &&
               (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
                (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
                 ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require'))) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      modules.push(specifier.text.replaceAll('\\', '/').split('/').pop().replace(/\.[^.]*$/, ''));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {
    reads: consumesLiterals(literals),
    modules,
    files: literals.map(s => s.split('/').pop()).filter(s => s.includes('.')),
  };
}

function consumesLiterals(literals) {
  return literals.some(s => s.includes('.github/workflows') || /(^|\/)ci_workflows(\.py)?$/.test(s)) ||
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
