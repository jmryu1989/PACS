'use strict';
// B2D-05 audit support, not a sandbox or a whole-program proof. Runtime sentinels and review of delegated calls
// complement this inventory of the actual root's import/constructor/factory/field-initializer closure.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..'), source = path.join(root, 'api/src');
const ts = require(path.join(root, 'api/node_modules/typescript'));
function inventory() {
  const pending = [path.join(source, 'app.module.ts')], seen = new Set(), rows = [];
  while (pending.length) {
    const filename = pending.pop();
    if (seen.has(filename)) continue;
    seen.add(filename);
    const text = fs.readFileSync(filename, 'utf8'), ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const locations = [];
    const calls = node => {
      const found = [];
      const walk = value => {
        if (ts.isCallExpression(value) || ts.isNewExpression(value)) found.push(value.expression.getText(ast).slice(0, 160));
        ts.forEachChild(value, walk);
      };
      walk(node); return [...new Set(found)];
    };
    const add = (kind, node) => locations.push({ kind, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, calls: calls(node) });
    const visit = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        const imported = node.moduleSpecifier.text;
        if (imported.startsWith('.')) {
          const base = path.resolve(path.dirname(filename), imported);
          const resolved = [base + '.ts', path.join(base, 'index.ts')].find(name => fs.existsSync(name));
          if (!resolved) throw Error('unresolved construction import: ' + imported);
          pending.push(resolved);
        }
      }
      if (ts.isConstructorDeclaration(node)) add('constructor', node);
      if (ts.isPropertyDeclaration(node) && node.initializer) add('field', node.initializer);
      if (ts.isClassStaticBlockDeclaration(node)) add('static-block', node);
      if (ts.isPropertyAssignment(node) && ['useFactory', 'useValue'].includes(node.name.getText(ast))) add(node.name.getText(ast), node.initializer);
      if (ts.isVariableStatement(node) && node.parent === ast) for (const declaration of node.declarationList.declarations) if (declaration.initializer) add('import-initializer', declaration.initializer);
      if (ts.isExpressionStatement(node) && node.parent === ast) add('import-expression', node.expression);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    rows.push({ file: path.relative(root, filename).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(text).digest('hex'), locations });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
module.exports = { inventory };
if (require.main === module) console.log(JSON.stringify({ inventory: inventory() }, null, 2));
