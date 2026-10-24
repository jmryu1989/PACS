'use strict';
// Invoked only for a newly created synthetic LiveStack member. Uses C2's real
// key format and wrapping; approval itself uses the real runtime and ledger.
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const { EmrRuntime } = require('/app/dist/emr-runtime/application');
const crypto = require('/app/dist/emr-signature/server-crypto');
const { OnlineSigningStore } = require('/app/dist/emr-report/online-store');
const { configuredWrappingSecrets, memberSigningRegistration } = require('/app/dist/emr-clinical/startup');
const { randomUUID } = require('node:crypto');

async function main() {
  const subject = process.argv[2];
  const db = new PrismaClient();
  const runtime = new EmrRuntime(process.env.DATABASE_URL, '/tmp/d-synthetic-key-' + randomUUID());
  let started = false;
  try {
    const member = await db.memberRights.findUnique({ where: { sub: subject } });
    if (!member?.username?.startsWith('kin-test-') || !member.approved || member.suspended)
      throw new Error('OwnedSyntheticMemberRequired');
    if (!member.roles.some(role => ['radiologist', 'clinician', 'technician'].includes(role))) return;
    await runtime.start(); started = true;
    const id = async sub => {
      const work = runtime.port.begin();
      try { return { id: await work.resolveRequestIdentity(process.env.KC_ISSUER, sub), issuer: process.env.KC_ISSUER, subject: sub }; }
      finally { work.end(); }
    };
    const identity = await id(subject);
    const doctor = { identity, identityRegistrationId: memberSigningRegistration(identity.id), institutionId: member.institution, canSign: true };
    const pair = crypto.generateServerKeyPair(), kid = randomUUID();
    const custody = configuredWrappingSecrets(), wrappingKey = await custody.read(custody.currentId);
    // Fixture installation is not an administrator's key-management request.
    // Keep its seed data separate from the real requests' attribution evidence.
    await db.$transaction(tx => new OnlineSigningStore().insertKey(tx,
      { kid, publicKey: pair.publicKey, doctor, status: 'active', registeredAt: new Date().toISOString(), endedAt: null },
      crypto.wrapServerPrivateKey(pair.privateKey, kid, custody.currentId, wrappingKey)));
  } finally { if (started) await runtime.stop(Date.now() + 10000); await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
