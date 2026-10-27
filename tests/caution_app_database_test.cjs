'use strict';
// Synthetic PostgreSQL only: removed quotas must not block real inserts or discard earlier rows.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PrismaClient}=require('/app/node_modules/@prisma/client');
test('retained histories, nine sources and question closure pass the former lifetime bounds',async()=>{
  assert.ok(process.env.KIN_CAUTION_DATABASE_URL, 'explicit synthetic database required');
  const db=new PrismaClient({datasources:{db:{url:process.env.KIN_CAUTION_DATABASE_URL}}});
  try {
    await db.$transaction(async tx=>{
      const uid='2.25.'+BigInt('0x'+randomUUID().replaceAll('-','')).toString();
      await tx.studyState.create({data:{uid,institutionId:'synthetic-caution'}});
      await tx.viewerStorageBudget.create({data:{studyUid:uid,itemCount:513,revisionCount:4097,payloadBytes:16777217}});
      const id=randomUUID(), snapshot={schemaVersion:1,title:'SYN',text:'',primary:8,
        sources:Array.from({length:9},()=>({itemId:randomUUID(),revision:1}))};
      await tx.finding.create({data:{id,studyUid:uid,authorSub:'synthetic',authorActor:'Synthetic',revision:1001,snapshot,updatedAt:new Date()}});
      await tx.$executeRaw`INSERT INTO "FindingRevision" ("findingId",revision,snapshot,action,reason,actor,"authorSub","requestId",fingerprint,"payloadBytes")
        SELECT ${id}::uuid,n,snapshot,'edit','','Synthetic','synthetic',gen_random_uuid(),repeat('0',64),octet_length(convert_to(snapshot::text,'UTF8'))
        FROM "Finding",generate_series(1,1001) n WHERE id=${id}::uuid`;
      assert.equal(await tx.findingRevision.count({where:{findingId:id}}),1001);
      assert.equal((await tx.findingRevision.findUnique({where:{findingId_revision:{findingId:id,revision:1}}})).revision,1);
      const qid=randomUUID();
      await tx.studyQuestion.create({data:{id:qid,studyUid:uid,institutionId:'synthetic-caution',authorSub:'synthetic',
        authorActor:'Synthetic',authorName:'Synthetic',state:'Open',revision:100,entryCount:100,changedBy:'Synthetic',updatedAt:new Date()}});
      await tx.studyQuestion.update({where:{id:qid},data:{state:'Closed',revision:101,entryCount:101,
        closedAt:new Date(),closedByActor:'Synthetic',closedByName:'Synthetic',closedByRole:'clinician'}});
      await tx.studyQuestionEntry.create({data:{id:randomUUID(),questionId:qid,seq:101,kind:'close',body:'SYN'.repeat(1000),authorSub:'synthetic',
        authorActor:'Synthetic',authorName:'Synthetic',authorRole:'clinician',reportRs:'W',fingerprint:'0'.repeat(64),appliedRevision:101,result:{}}});
      assert.equal((await tx.studyQuestion.findUnique({where:{id:qid}})).state,'Closed');
      const note='SYN'.repeat(4000), message='SYN'.repeat(1000);
      await tx.techNoteRevision.create({data:{studyUid:uid,version:1,text:note,reason:'',author:'Synthetic',authorSub:'synthetic',institutionId:'synthetic-caution'}});
      assert.equal((await tx.techNoteRevision.findFirst({where:{studyUid:uid}})).text,note);
      const consult=await tx.studyConsultation.create({data:{id:randomUUID(),studyUid:uid,institutionId:'synthetic-caution',
        requesterSub:'synthetic',requesterActor:'Synthetic',recipientSub:'recipient',recipientActor:'Recipient',recipientName:'Synthetic recipient',
        reason:message,reply:message,cancelReason:'',state:'Completed',revision:1,changedBy:'Synthetic',creationFingerprint:'0'.repeat(64),
        lastRequest:randomUUID(),lastFingerprint:'0'.repeat(64)}});
      assert.equal(consult.reply,message);
      // Frozen annotation references are server-derived, so their total is not a user payload bound.
      const frozen={version:3,studies:[uid],rows:1,cols:1,active:0,cells:[null],
        annotations:Array.from({length:200},()=>({id:randomUUID(),study:uid,revision:1}))};
      assert.ok(Buffer.byteLength(JSON.stringify(frozen))>20000);
      const job=await tx.viewerJob.create({data:{id:randomUUID(),studyUid:uid,authorSub:'synthetic',authorActor:'Synthetic',
        studies:[uid],fingerprint:'0'.repeat(64),snapshot:frozen,title:'SYN',description:'',revision:1,updatedAt:new Date()}});
      assert.deepEqual((await tx.viewerJob.findUnique({where:{id:job.id}})).snapshot,frozen);

    });
  } finally { await db.$disconnect(); }
});
