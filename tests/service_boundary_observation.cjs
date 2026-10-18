'use strict';
/* W4X-03 (Astra consult consult-w4x03-20261017, R3-2/R3-4/R3-8): the two observations behind test (4) of
 * clinician_question_service_test.cjs and image_request_service_test.cjs, each made with an installed tool, never with a
 * parser of our own (AGENTS.md section 15) and never by matching the compiled text.
 *   staticRequires(): a STATIC check of the ordinary direct imports of one compiled CommonJS module. Every literal
 *     `require("...")` call in its TypeScript AST, wherever it sits (top level, an unexecuted branch, a catch, the
 *     CommonJS form tsc emits for a TS `import()`), resolved with Node's resolver from that module's file. A comment or
 *     an unused string is no call. A specifier Node cannot resolve is reported, never dropped.
 *   rawStatement() + sqlRelations(): an OBSERVATION of the raw statements a run actually sends. The statement is
 *     assembled by the product's own Prisma (`Prisma.sql` over the tagged template, a `Prisma.Sql` passed as is, the text
 *     of an *Unsafe call), and its `$1` text goes to PostgreSQL 16's own parser (libpg-query); bound values stay data.
 *     The relations are every node the parser marks with a relation name: a FROM/JOIN/subquery reference and the target
 *     of INSERT/UPDATE/DELETE/MERGE alike. A statement the parser refuses is an error, never "no relation".
 * Not claimed (accepted limits, not all of them adversarial): computed module names, a require alias that does not run,
 * createRequire or another loader, a native import() written into compiled JS, the transitive import graph; statements
 * on paths the tests do not run, helpers that build SQL elsewhere, views and server functions, CTE name shadowing.
 * Hosted (kin-api:ci): typescript and libpg-query are api/node_modules (api/package-lock.json, npm ci) mounted read-only
 * at /test-tools/node_modules by the two validate.yml runtime steps; /app/dist and /app/node_modules stay the image's.
 */
const { createRequire } = require('node:module');
const ts = require('/test-tools/node_modules/typescript');
const { parse } = require('/test-tools/node_modules/libpg-query');
// The product's Prisma, as its PrismaService loads it, so Sql fragments the service builds are the same class.
const { Prisma } = createRequire(require.resolve('/app/dist/prisma.service'))('@prisma/client');
const Sql = Prisma.empty.constructor;

/** Resolved files of every literal require(...) call in `source`, compiled module `filename`; 'unresolved:<spec>' if Node cannot. */
function staticRequires(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error('the compiled module does not parse: ' + filename);
  const resolve = createRequire(filename).resolve, found = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const name = node.arguments[0].text;
      try { found.push(resolve(name)); } catch (_) { found.push('unresolved:' + name); }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** CommonJS that tsc emits for `source` (TypeScript) with api/tsconfig.json's module settings. */
const emitted = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2021, esModuleInterop: true, removeComments: true } }).outputText;

/**
 * The compiled module with the text of every `$executeRaw` tagged template without values replaced by `sql`: the
 * service's own raw-write site sending another statement, found in the AST rather than by matching its SQL.
 */
function withRawExecuteText(source, filename, sql) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];
  const visit = node => {
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag) && node.tag.name.text === '$executeRaw'
      && ts.isNoSubstitutionTemplateLiteral(node.template)) sites.push([node.template.getStart(file), node.template.end]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const literal = '`' + sql.replace(/[\\`$]/g, '\\$&') + '`';
  return sites.reverse().reduce((text, [start, end]) => text.slice(0, start) + literal + text.slice(end), source);
}

/**
 * Module code to append to compiled service `name`: each puts a real require of a forbidden service module in a
 * contractual branch the suites' flows never run (a list cursor page, a list `filter`, the error path of create, a TS
 * `import()` in a function nobody calls, a specifier with its .js extension), so only the static check can see it (SRC2-1).
 */
function latentRequires(name, filter) {
  const patch = (method, body) => `\n{ const original = exports.${name}.prototype.${method};\n`
    + `  exports.${name}.prototype.${method} = ${body}; }\n`;
  const inList = (condition, file) => patch('list',
    `function (c, q) { if (q && ${condition}) require(${JSON.stringify(file)}); return original.call(this, c, q); }`);
  return {
    cursorConnect: inList('q.cursor !== undefined', './connect.service'),
    filterOrthanc: inList(`q.${filter} !== undefined`, './orthanc.service'),
    catchConnect: patch('create',
      'async function (...args) { try { return await original.apply(this, args); } catch (e) { require("./connect.service"); throw e; } }'),
    importConnect: `\n(function (exports) {\n${emitted("export async function latent() { return import('./connect.service'); }")}\n})({});\n`,
    extensionOrthanc: inList('q.cursor !== undefined', './orthanc.service.js'),
  };
}

/** {text, values} of one raw call as Prisma assembles it: `$1` text, values apart (R3-4). */
function rawStatement(method, args) {
  const [first, ...rest] = args;
  if (method.endsWith('Unsafe')) {
    if (typeof first !== 'string') throw new Error(method + ' without a SQL string');
    return { text: first, values: rest };
  }
  const statement = first instanceof Sql ? first : Array.isArray(first) ? Prisma.sql(first, ...rest) : null;
  if (!statement) throw new Error(method + ' with neither a tagged template nor a Prisma.Sql');
  return { text: statement.text, values: statement.values };
}

/** Relation names and row-lock strengths PostgreSQL's parser finds in `text`; rejects when it does not parse. */
async function sqlRelations(text) {
  const tree = await parse(text);
  const relations = [], locks = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.relname === 'string') relations.push(value.relname);
    if (value.LockingClause) locks.push(value.LockingClause.strength);
    for (const child of Object.values(value)) walk(child);
  };
  walk(tree);
  return { relations, locks };
}

module.exports = { Prisma, staticRequires, latentRequires, withRawExecuteText, rawStatement, sqlRelations };
