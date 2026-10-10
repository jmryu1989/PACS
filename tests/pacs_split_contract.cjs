'use strict';
// D73 byte pins are intentional here: S9-U0b is an explicitly behaviour-preserving move.
// These are provenance/equivalence checks, not permission or business-rule assertions.
// Round 2 must review each receiver/wiring correspondence; never regenerate baselines from moved code.
// Text, SQL literal and binding hashes use the LF form (`lf`) so a CRLF checkout and the LF CI pin the same content.
//
// Split phase (S9-U0b round 2): a moved unit is compared with its unchanged baseline after undoing only the
// correspondence its spec entry records, and nothing else: a call `this.<concern>.<member>` that the original made as
// `this.<member>` (each pair with its exact count), a `private` the original carried, an `export` the original lacked,
// and the facade constructor's body (the original body was empty; the composition is checked by pacs_source.cjs).
// Anything else that differs still changes the hash.
const assert = require('node:assert/strict');
const { ts, sha256, lf } = require('./pacs_source.cjs');
// Historical byte proof uses the accepted landed split, never current feature text.
function historicalSource() {
  const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const landed = 'c8e4f1b485ec05ccbb97589c74a573b3f48b70ce';
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', landed, 'api/src'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f.endsWith('.ts'));
  const overrides = Object.fromEntries(files.map(file => [path.join(root, file),
    execFileSync('git', ['show', `${landed}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 8e6 })]));
  // SQL provenance includes imported Prisma declarations. A later additive
  // schema must not change the historical generator output used by that proof.
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'pacs-history-'));
  try {
    const output = path.join(dir, 'client');
    const schema = execFileSync('git', ['show', `${landed}:api/prisma/schema.prisma`], { cwd: root, encoding: 'utf8' })
      .replace('provider = "prisma-client-js"', `provider = ${JSON.stringify('node ' + path.join(root, 'api/node_modules/@prisma/client/generator-build/index.js').replace(/\\/g, '/'))}\n  output = ${JSON.stringify(output.replace(/\\/g, '/'))}`);
    fs.writeFileSync(path.join(dir, 'schema.prisma'), schema);
    execFileSync(process.execPath, [path.join(root, 'api/node_modules/prisma/build/index.js'), 'generate', '--schema', path.join(dir, 'schema.prisma')],
      { cwd: root, env: { ...process.env, PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true' }, maxBuffer: 8e6, timeout: 60000 });
    overrides[path.join(root, 'api/node_modules/.prisma/client/index.d.ts')] = fs.readFileSync(path.join(output, 'index.d.ts'), 'utf8');
  } finally {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('pacs-history-'));
    fs.rmSync(resolved, { recursive: true });
  }
  return require('./pacs_source.cjs').createSource({ overrides });
}

const pair = (field, member) => `${field}.${member}`;
/** The text of `node` with the recorded receivers read back as the original's `this.<member>`. */
function normalized(node, correspondence, counts = null) {
  const sf = node.getSourceFile(), base = node.getStart(sf), edits = [];
  const wanted = new Set((correspondence?.receivers ?? []).map(r => pair(r.field, r.member)));
  if (wanted.size) {
    const visit = child => {
      if (ts.isPropertyAccessExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
          child.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          wanted.has(pair(child.expression.name.text, child.name.text))) {
        edits.push([child.expression.expression.getEnd() - base, child.expression.getEnd() - base, '']);
        const key = pair(child.expression.name.text, child.name.text);
        if (counts) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  if (correspondence?.constructor_wiring && ts.isConstructorDeclaration(node) && node.body)
    edits.push([node.body.getStart(sf) - base, node.body.getEnd() - base, '{}']);
  let text = node.getText(sf);
  for (const [from, to, insert] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, from) + insert + text.slice(to);
  return lf(text);
}
/** The whole unit read back as the original: its modifiers too. */
function unitText(node, correspondence, counts = null) {
  let text = normalized(node, correspondence, counts);
  if (correspondence?.private_dropped) text = 'private ' + text;
  if (correspondence?.export_added) {
    if (!text.startsWith('export ')) return '\u0000 the recorded export is missing';
    text = text.slice('export '.length);
  }
  return text;
}
function fingerprint(source, node, correspondence = null, units = null) {
  const sql = [], sf = node.getSourceFile();
  const declarationText = declaration => {
    if (declaration.getSourceFile() === sf && declaration.pos >= node.pos && declaration.end <= node.end)
      return normalized(declaration, correspondence);
    if (units?.has(declaration)) return unitText(declaration, units.get(declaration));
    return lf(declaration.getText());
  };
  function walk(child) {
    if (ts.isTaggedTemplateExpression(child)) {
      const template = child.template;
      const literals = ts.isNoSubstitutionTemplateLiteral(template) ? [template] :
        [template.head, ...template.templateSpans.map(span => span.literal)];
      const expressions = ts.isNoSubstitutionTemplateLiteral(template) ? [] : template.templateSpans.map(span => {
        const bindings = [];
        function bind(part) {
          if (ts.isIdentifier(part) && !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part)) {
            const symbol = source.resolveSymbol(part);
            bindings.push({ name: part.text, declarations: symbol.declarations.map(declaration => ({
              kind: ts.SyntaxKind[declaration.kind], text_sha256: sha256(declarationText(declaration)),
            })) });
          }
          ts.forEachChild(part, bind);
        }
        bind(span.expression);
        return { expression: normalized(span.expression, correspondence), bindings };
      });
      sql.push({ receiver: normalized(child.tag, correspondence), raw: literals.map(literal => lf(literal.rawText ?? literal.text)),
        cooked: literals.map(literal => lf(literal.text)), expressions });
    }
    ts.forEachChild(child, walk);
  }
  walk(node);
  const counts = new Map();
  const text_sha256 = sha256(unitText(node, correspondence, counts));
  const receivers = [...counts].map(([key, count]) => ({ field: key.split('.')[0], member: key.split('.')[1], count }))
    .sort((a, b) => pair(a.field, a.member).localeCompare(pair(b.field, b.member)));
  return { text_sha256, sql, receivers };
}
function assertContract(source) {
  const counts = source.validate();
  assert.deepEqual(counts, { members: 125, declarations: 57 }, 'complete approved member/declaration map');
  // a moved declaration bound inside another unit's SQL is read back with its own entry's correspondence
  const units = new Map(source.spec.entries.filter(e => e.correspondence).map(e => [source.locate(e.live), e.correspondence]));
  for (const entry of source.spec.entries) {
    assertEntry(source, entry, units);
  }
  return counts;
}
function assertEntry(source, entry, units = null) {
  const actual = fingerprint(source, source.locate(entry.live), entry.correspondence ?? null, units);
  assert.deepEqual(actual.sql, entry.baseline.sql, `SQL text/binding provenance: ${entry.id}`);
  assert.equal(actual.text_sha256, entry.baseline.text_sha256, `Move equivalence: ${entry.id}`);
  assert.deepEqual(actual.receivers, entry.correspondence?.receivers ?? [], `Receiver correspondence: ${entry.id}`);
}
/**
 * Nest's own metadata of the compiled application (order S9-U0b section 7, DI and routes): AppModule tokens, every
 * provider's and controller's constructor tokens and scope, global enhancers, the middleware binding, and the route
 * table (method, path, handler, parameter decorators, Public, guards, interceptors, status code, headers). Read from the
 * decorators' metadata, never from source text. Compiled from api/src through the test loader unless /app/dist exists.
 */
function diSnapshot() {
  const fs = require('node:fs');
  if (!fs.existsSync('/app/dist/app.module.js')) require('./service_test_loader.cjs');
  require('/app/node_modules/reflect-metadata');
  const C = require('/app/node_modules/@nestjs/common/constants');
  const { RequestMethod } = require('/app/node_modules/@nestjs/common');
  const { AppModule } = require('/app/dist/app.module');
  const meta = (key, target, property) => (property === undefined ? Reflect.getMetadata(key, target) : Reflect.getMetadata(key, target, property));
  const name = token => (typeof token === 'function' ? token.name : typeof token === 'symbol' ? token.toString() : String(token));
  const providers = meta(C.MODULE_METADATA.PROVIDERS, AppModule) ?? [];
  const controllers = meta(C.MODULE_METADATA.CONTROLLERS, AppModule) ?? [];
  const provided = p => (typeof p === 'function' ? name(p) :
    `${name(p.provide)}=${p.useClass ? name(p.useClass) : p.useExisting ? 'existing:' + name(p.useExisting) : p.useFactory ? 'factory' : 'value'}`);
  const injectables = {};
  for (const cls of [...controllers, ...providers.map(p => (typeof p === 'function' ? p : p.useClass)).filter(Boolean)])
    injectables[cls.name] = { params: (meta(C.PARAMTYPES_METADATA, cls) ?? []).map(name), scope: meta(C.SCOPE_OPTIONS_METADATA, cls) ?? null,
      declared: (meta(C.SELF_DECLARED_DEPS_METADATA, cls) ?? []).map(d => `${d.index}:${name(d.param)}`),
      optional: meta(C.OPTIONAL_DEPS_METADATA, cls) ?? [] };
  const middleware = [];
  new AppModule().configure({ apply: (...fns) => {
    const binding = { apply: fns.map(name), exclude: [], forRoutes: [] };
    middleware.push(binding);
    const chain = { exclude: (...routes) => { binding.exclude.push(...routes.map(name)); return chain; },
      forRoutes: (...routes) => { binding.forRoutes.push(...routes.map(name)); return {}; } };
    return chain;
  } });
  const routes = [];
  for (const controller of controllers) {
    const prefixes = [].concat(meta(C.PATH_METADATA, controller) ?? '/');
    for (let proto = controller.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = key === 'constructor' ? null : Object.getOwnPropertyDescriptor(proto, key).value;
        if (typeof handler !== 'function' || !Reflect.hasMetadata(C.METHOD_METADATA, handler)) continue;
        const args = meta(C.ROUTE_ARGS_METADATA, controller, key) ?? {};
        routes.push({ controller: controller.name, handler: key, method: RequestMethod[meta(C.METHOD_METADATA, handler)],
          paths: prefixes.flatMap(prefix => [].concat(meta(C.PATH_METADATA, handler) ?? '/').map(at => `${prefix}|${at}`)),
          public: meta('public', handler) ?? meta('public', controller) ?? null,
          status: meta(C.HTTP_CODE_METADATA, handler) ?? null, headers: meta(C.HEADERS_METADATA, handler) ?? [],
          guards: [...(meta(C.GUARDS_METADATA, controller) ?? []), ...(meta(C.GUARDS_METADATA, handler) ?? [])].map(name),
          interceptors: [...(meta(C.INTERCEPTORS_METADATA, controller) ?? []), ...(meta(C.INTERCEPTORS_METADATA, handler) ?? [])].map(name),
          args: Object.entries(args).map(([slot, a]) => `${slot}@${a.index}:${JSON.stringify(a.data ?? null)}:${(a.pipes ?? []).length}`).sort() });
      }
    }
  }
  routes.sort((a, b) => `${a.controller}.${a.handler}`.localeCompare(`${b.controller}.${b.handler}`));
  return { controllers: controllers.map(name), providers: providers.map(provided),
    exports: (meta(C.MODULE_METADATA.EXPORTS, AppModule) ?? []).map(name), imports: (meta(C.MODULE_METADATA.IMPORTS, AppModule) ?? []).map(name),
    injectables, middleware, routes };
}
module.exports = { fingerprint, assertContract, assertEntry, unitText, diSnapshot, historicalSource };
