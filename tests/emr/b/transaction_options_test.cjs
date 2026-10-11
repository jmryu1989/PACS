/* D931/R4d-01 -> RISK-EMR-POOL-STARVATION -> TX-01.
 * Explicit transaction budgets are a source contract. Use the installed TS AST
 * and symbol resolver; comments, formatting and function names are immaterial.
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
const directory = path.join(root, 'api/src/emr-runtime');
const files = fs.readdirSync(directory, { recursive: true }).filter(f => f.endsWith('.ts')).map(f => path.join(directory, f));
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS });
const checker = program.getTypeChecker(), limits = path.join(directory, 'limits.ts');
function inspect(source) {
  const failures = [], calls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === '$transaction') ||
        (ts.isElementAccessExpression(node.expression) && node.expression.argumentExpression?.text === '$transaction'))) {
      calls.push(node);
      const options = node.arguments[1];
      for (const name of ['maxWait', 'timeout']) {
        const property = options && ts.isObjectLiteralExpression(options) && options.properties.find(p => p.name?.text === name);
        let symbol = property && ts.isPropertyAssignment(property) && checker.getSymbolAtLocation(property.initializer);
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const origin = symbol?.valueDeclaration;
        if (!origin || path.resolve(origin.getSourceFile().fileName) !== limits || !ts.isVariableDeclaration(origin) ||
            !origin.initializer || !ts.isNumericLiteral(origin.initializer) || Number(origin.initializer.text) <= 0)
          failures.push(`${path.basename(source.fileName)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, failures };
}
test('TX-01 every runtime transaction has both positive budgets from the named limits module', () => {
  const results = files.map(f => inspect(program.getSourceFile(f)));
  assert(results.some(r => r.calls.length), 'inventory cannot pass vacuously');
  const failures = results.flatMap(r => r.failures);
  console.log(JSON.stringify({ transactions: results.reduce((n, r) => n + r.calls.length, 0), transactions_without_options: failures.length, failures }));
  assert.deepEqual(failures, []);
});
test('TX-02 missing, one-sided, default and unrelated literal transaction budgets are rejected', () => {
  for (const text of ['db.$transaction(work)', 'db.$transaction(work, { timeout: 15000 })',
    'db.$transaction(work, { maxWait: 10000 })', 'db["$transaction"](work, {maxWait: 10000, timeout: 15000})']) {
    assert(inspect(ts.createSourceFile('negative.ts', text, ts.ScriptTarget.Latest, true)).failures.length, text);
  }
});
