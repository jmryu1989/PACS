'use strict';
// Invoked only for a newly created synthetic LiveStack member. Uses C2's real
// key format and wrapping; approval itself uses the real runtime and ledger.
// The fixture does not start a second EmrRuntime beside the API's own (pending
// recovery and journal replay belong to the serving process): it resolves the
// member identity with the ledger's own SQL function and inserts the key in one
// ordinary transaction, on the API's database login.
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const crypto = require('/app/dist/emr-signature/server-crypto');
const { OnlineSigningStore } = require('/app/dist/emr-report/online-store');
const { configuredWrappingSecrets, memberSigningRegistration } = require('/app/dist/emr-clinical/startup');
const { randomUUID } = require('node:crypto');

async function main() {
  const subject = process.argv[2], issuer = process.env.KC_ISSUER;
  if (typeof subject !== 'string' || !subject || typeof issuer !== 'string' || !issuer) throw new Error('SubjectAndIssuerRequired');
  const db = new PrismaClient();
  try {
    const member = await db.memberRights.findUnique({ where: { sub: subject } });
    if (!member?.username?.startsWith('kin-test-') || !member.approved || member.suspended)
      throw new Error('OwnedSyntheticMemberRequired');
    if (!member.roles.some(role => ['radiologist', 'clinician', 'technician'].includes(role))) return;
    const custody = configuredWrappingSecrets(), wrappingKey = await custody.read(custody.currentId);
    const pair = crypto.generateServerKeyPair(), kid = randomUUID();
    await db.$transaction(async tx => {
      const [row] = await tx.$queryRaw`SELECT emr_access.resolve_member_identity(${issuer}::text, ${subject}::text)::text AS id`;
      const id = String(row.id);
      const doctor = { identity: { id, issuer, subject }, identityRegistrationId: memberSigningRegistration(id),
        institutionId: member.institution, canSign: true };
      // Fixture installation is not an administrator's key-management request.
      // Keep its seed data separate from the real requests' attribution evidence.
      await new OnlineSigningStore().insertKey(tx,
        { kid, publicKey: pair.publicKey, doctor, status: 'active', registeredAt: new Date().toISOString(), endedAt: null },
        crypto.wrapServerPrivateKey(pair.privateKey, kid, custody.currentId, wrappingKey));
    });
    console.log(JSON.stringify({ provisioned: kid }));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
