// REQ-W2C-05 -> RISK-CI-UNHASHED-INPUT: use the installed TS AST, never grep JS.
const fs = require('node:fs');
const ts = require('../api/node_modules/typescript');

function consumes(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse ${filename}`);
  const literals = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node)) literals.push(node.text.replaceAll('\\', '/'));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return literals.some(s => s.includes('.github/workflows') || /(^|\/)ci_workflows(\.py)?$/.test(s)) ||
    (literals.includes('.github') && literals.includes('workflows'));
}

if (require.main === module) {
  const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(requests.map(row => consumes(row.source, row.filename))));
}
module.exports = { consumes };
