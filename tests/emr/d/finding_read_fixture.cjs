// Synthetic persistence-only limit fixture. This completes the SQL-seeded Finding
// histories for D's signed read contract; it is not an approval-path test.
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const { randomUUID } = require('node:crypto');
const { planClinicalWrite, applyPlan } = require('/app/dist/emr-clinical/records');
const { clinicalSigningContent } = require('/app/dist/emr-clinical/signing');
const { generateServerKeyPair, signServerPayload } = require('/app/dist/emr-signature/server-crypto');
const db = new PrismaClient();
async function main() {
  const [uid, exampleId] = process.argv.slice(2);
  const [example] = await db.$queryRaw`SELECT c.body, v.signature FROM emr_clinical.online_version v
    JOIN emr_clinical.online_command c USING (operation_id)
    WHERE v.record_type='finding' AND v.record_id=${exampleId} AND v.sequence=1`;
  if (!example) throw new Error('Run-owned signed example is required');
  const input = JSON.parse(example.body).input;
  if (input.study.studyId !== uid) throw new Error('Fixture study does not match the signed example');
  const pair = generateServerKeyPair(), kid = randomUUID();
  // Match the SQL fixture's author; the archived registration and signatures
  // are synthetic read data. Online approval/key custody is exercised separately.
  const identity = { id: randomUUID(), issuer: input.actor.identity.issuer, subject: 'SYNTHETIC' };
  input.actor = { ...input.actor, identity, signingRegistrationId: 'synthetic-read:' + identity.id };
  const registration = { kid, publicKey: pair.publicKey, doctor: { identity,
    identityRegistrationId: input.actor.signingRegistrationId, institutionId: input.actor.institutionId, canSign: true },
    registeredAt: new Date().toISOString(), endedAt: null, status: 'active' };
  const heads = await db.finding.findMany({ where: { studyUid: uid, authorSub: 'SYNTHETIC' }, orderBy: { id: 'asc' } });
  let total = 0;
  for (const head of heads) {
    const revisions = await db.findingRevision.findMany({ where: { findingId: head.id }, orderBy: { revision: 'asc' } });
    let unit = null;
    for (const revision of revisions) {
      const item = revision.snapshot, requestId = revision.requestId;
      const body = revision.revision === 1 ? { requestId, item } :
        { requestId, expectedRevision: revision.revision - 1, action: 'edit', item };
      const plan = planClinicalWrite({ ...input, surface: revision.revision === 1 ? 'finding.create' : 'finding.edit',
        unit, body, content: JSON.stringify(item), attachments: [],
        navigation: [...new Set(item.sources.map(source => source.studyUid))].filter(study => study !== uid),
        ids: { recordId: head.id, versionId: randomUUID() }, at: revision.at.toISOString() });
      const signed = signServerPayload(clinicalSigningContent(plan.signing), kid, pair.privateKey);
      const signature = { envelope: signed.envelope, registration, signedAt: signed.signedAt, payloadSha256: signed.versionSha256 };
      const operation = randomUUID();
      await db.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO emr_clinical.online_command (record_type,actor_id,request_id,operation_id,body)
          VALUES ('finding',${input.actor.identity.id},${requestId},${operation}::uuid,${JSON.stringify({ plan })})`;
        await tx.$executeRaw`INSERT INTO emr_clinical.online_version (record_type,record_id,version_id,sequence,operation_id,body,signature)
          VALUES ('finding',${head.id},${plan.version.versionId},${revision.revision},${operation}::uuid,${JSON.stringify(plan)},${JSON.stringify(signature)})`;
      });
      unit = applyPlan(unit, plan); total++;
    }
  }
  console.log(JSON.stringify({ fixture: 'finding-read-limits', findings: heads.length, revisions: total }));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
