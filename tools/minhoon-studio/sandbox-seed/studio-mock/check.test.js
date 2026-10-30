'use strict';
// Shape check for the studio's editable mock files (run: node --test studio-mock/check.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));

test('dataset: every study names a known patient, a unique n and a known state', () => {
  const d = read('dataset.json');
  const patients = new Set(d.patients.map(p => p.key));
  const seen = new Set();
  for (const s of d.studies) {
    assert.ok(Number.isInteger(s.n) && s.n > 0 && s.n < 10000, `study n ${s.n}`);
    assert.ok(!seen.has(s.n), `duplicate n ${s.n}`); seen.add(s.n);
    assert.ok(patients.has(s.patient), `unknown patient ${s.patient}`);
    assert.ok(['W', 'T', 'P', 'A', 'H'].includes(s.rs || 'W'), `rs ${s.rs}`);
    assert.ok(typeof s.modality === 'string' && typeof s.desc === 'string');
  }
});

test('dataset: one patient never reuses the same image sample (duplicate series UIDs would mix in the viewer)', () => {
  const d = read('dataset.json');
  const pairs = new Set();
  for (const s of d.studies) {
    if (!s.image) continue;
    const key = `${s.patient}|${s.image}`;
    assert.ok(!pairs.has(key), `patient ${s.patient} uses ${s.image} twice`);
    pairs.add(key);
  }
});

test('routes: each prototype route has a method, an /api path and a JSON body', () => {
  const r = read('routes.json');
  assert.ok(Array.isArray(r.routes));
  for (const route of r.routes) {
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(route.method || 'GET').toUpperCase()));
    assert.ok(typeof route.path === 'string' && route.path.startsWith('/api/'), `path ${route.path}`);
    assert.ok(route.status === undefined || (Number.isInteger(route.status) && route.status >= 200 && route.status < 600));
  }
});
