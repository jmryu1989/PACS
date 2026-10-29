const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto, randomBytes} = require('node:crypto');
const D = require('../worklist-v0/hpacs-lite/preload-disk.js');
// REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-DISK-READABLE / CORRUPT-FRAME -> R1/R2/R9.
test('R1 R2 R9 authenticated envelope: roundtrip, nonextractable key, zeroed input, tamper and identity rejection', async () => {
  const raw = new Uint8Array(randomBytes(32));
  const key = await D.importKey(raw);
  assert.deepEqual([...raw], Array(32).fill(0));
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  const bytes = new Uint8Array([31,139,1,2,3]);
  const aad = D.frameAAD('k', 'uid', '/frame/1', 'r1', 1);
  const record = await D.seal(key, bytes, aad);
  assert.deepEqual(new Uint8Array(await D.open(key, record, aad)), bytes);
  assert.equal(record.iv.length,12);
  assert.equal(record.ct.byteLength,bytes.byteLength+16);
  const flipped = record.ct.slice(0); new Uint8Array(flipped)[0]^=1;
  await assert.rejects(D.open(key,{...record,ct:flipped},aad), {name:'OperationError'});
  for (const other of [D.frameAAD('k','uid','/frame/2','r1',1),D.frameAAD('k','uid','/frame/1','r2',1),D.frameAAD('k','uid','/frame/1','r1',2),D.studyAAD('k','manifest')])
    await assert.rejects(D.open(key,record,other), {name:'OperationError'});
  const second = await D.seal(key,bytes,aad);
  assert.notDeepEqual(second.iv,record.iv);
});
