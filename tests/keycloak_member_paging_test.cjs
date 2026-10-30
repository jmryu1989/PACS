'use strict';
// C30: public roster consumers traverse all pages; only Keycloak HTTP is synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../api/node_modules/typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
    experimentalDecorators: true, emitDecoratorMetadata: true }, fileName: filename,
}).outputText, filename);
const { KeycloakService } = require('../api/src/keycloak.service.ts');

for (const method of ['assignmentReaders', 'institutionMembers']) {
  for (const total of [1000, 1007]) {
    test(`${method} includes the final member of a ${total}-member institution`, async t => {
      const pages = [];
      t.mock.method(globalThis, 'fetch', async address => {
        const url = new URL(address), path = url.pathname;
        let body;
        if (path.endsWith('/token')) body = { access_token: 'synthetic', expires_in: 300 };
        else if (path.endsWith('/groups')) body = [{ id: 'syn-group', name: 'SYN' }];
        else if (path.endsWith('/members')) {
          const first = Number(url.searchParams.get('first')), size = Number(url.searchParams.get('max'));
          pages.push(first);
          body = Array.from({ length: Math.max(0, Math.min(size, total - first)) }, (_, i) => ({ id: String(first + i) }));
        } else if (path.endsWith('/role-mappings/realm')) body = [{ name: 'radiologist' }];
        else if (/\/users\/\d+$/.test(path)) {
          const id = path.split('/').pop();
          body = { id, username: 'SYN-' + id, enabled: id !== '0' };
        } else throw new Error('Unexpected synthetic HTTP request: ' + path);
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const previous = process.env.KC_CLIENT_SECRET;
      process.env.KC_CLIENT_SECRET = 'synthetic-only';
      t.after(() => { if (previous === undefined) delete process.env.KC_CLIENT_SECRET; else process.env.KC_CLIENT_SECRET = previous; });
      const members = await new KeycloakService()[method]('SYN');
      assert.equal(members.length, total - 1, 'disabled members still stay out');
      assert.equal(members.at(-1).id, String(total - 1));
      assert.equal(new Set(members.map(member => member.id)).size, members.length);
      assert.equal(pages.at(-1), 1000, 'read beyond a full tenth page, including its empty continuation');
    });
  }
}
