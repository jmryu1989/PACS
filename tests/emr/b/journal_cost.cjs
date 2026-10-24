'use strict';
// FAIL-01 primitive tests. Real local files; no claim of Linux ENOSPC/failed-fsync
// or process-kill qualification. DB idempotence is tested at the PG boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { FailureSpool } = require(path.join(process.env.KIN_B2R_BUILD, 'emr-runtime/journal-file.js'));
const root = path.resolve(__dirname,'../../../tmp/emr-b2-replace-20261023/spool-tests');
const record = () => ({id:randomUUID(),operationId:null,eventId:randomUUID(),at:new Date().toISOString(),cause:'ledger-unreachable'});
async function fixture(work) {
  const directory = path.join(root,randomUUID());
  const file = path.join(directory,'failure-spool.jsonl');
  let spool = new FailureSpool(directory), passed = false;
  try {
    await work({directory,file,get spool(){return spool;},restart:async()=>{
      await spool.close(); spool = new FailureSpool(directory);
    }});
    passed = true;
  } finally {
    await spool.close();
    if (passed) {
      for (const owned of [file,file+'.partial']) if(fs.existsSync(owned)) fs.unlinkSync(owned);
      fs.rmdirSync(directory);
    } else console.error('Preserved failed spool fixture: '+directory);
  }
}
test('failure spool retains complete facts across a failed import and repeated restart',async()=>fixture(async f=>{
  const a=record(), b=record();
  await f.spool.append(a); await f.spool.append(b);
  const imported = new Map();
  await assert.rejects(f.spool.replay(async row=>{
    if(row.id===b.id)throw new Error('Database unavailable');
    imported.set(row.id,row);
  }),/Database unavailable/);
  assert.ok(fs.statSync(f.file).size>0);
  await f.restart();
  assert.equal(await f.spool.replay(async row=>imported.set(row.id,row)),2);
  assert.equal(imported.size,2); assert.deepEqual(imported.get(a.id),a);
  assert.equal(fs.statSync(f.file).size,0);
  await f.restart(); assert.equal(await f.spool.replay(async()=>{throw new Error('Unexpected duplicate');}),0);
}));
test('incomplete final bytes survive the archive-before-truncate crash cut',async()=>fixture(async f=>{
  const a=record(); await f.spool.append(a);
  const partial=Buffer.from('{"id":"incomplete');
  fs.appendFileSync(f.file,partial);
  // A prior restart saved these bytes but died before truncating the main file.
  fs.writeFileSync(f.file+'.partial',partial);
  await f.restart();
  const seen=[]; assert.equal(await f.spool.replay(async r=>seen.push(r)),1);
  assert.equal(seen[0].id,a.id); assert.deepEqual(fs.readFileSync(f.file+'.partial'),partial);
  assert.equal(fs.statSync(f.file).size,0);
  await f.spool.append(record());
  await f.restart(); assert.equal(await f.spool.replay(async()=>{}),1);
}));
test('append waits for import before accepting another fact and close refuses new work',async()=>fixture(async f=>{
  await f.spool.append(record());
  let release,started;
  const hold=new Promise(resolve=>release=resolve), observed=new Promise(resolve=>started=resolve);
  const replay=f.spool.replay(async()=>{started();await hold;});
  await observed;
  const b=record();let accepted=false;
  const append=f.spool.append(b).then(()=>{accepted=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(accepted,false);
  release(); await replay; await append;
  const seen=[];await f.spool.replay(async r=>seen.push(r));assert.equal(seen[0].id,b.id);
  await f.spool.close();await assert.rejects(f.spool.append(record()),/FailureSpoolClosed/);
}));
