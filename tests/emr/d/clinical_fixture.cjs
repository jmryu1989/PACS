'use strict';
// Synthetic Module A identity/study facts; keys, signatures, B2 transactions,
// controllers and service projections are the actual product implementations.
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const product = name => require(path.join(api, 'dist', name));

async function clinicalFixture(db, records, issuer, members) {
  const { createOnlineClinicalServices, onlineClinicalProviders } = product('emr-clinical/services');
  const { ClinicalStore } = product('emr-clinical/store');
  const { OnlineSigningStore } = product('emr-report/online-store');
  const crypto = product('emr-signature/server-crypto');
  const wrap = randomBytes(32), registrations = new Map(), keys = new Map();
  const resolveId = async (tx, sub) => {
    const work = records.begin();
    try { return await work.resolveIdentity(tx, issuer, sub); } finally { work.end(); }
  };
  for (const member of members) {
    const id = await db.$transaction(tx => resolveId(tx, member.sub));
    const doctor = { identity: { id, issuer, subject: member.sub }, identityRegistrationId: 'fixture:' + member.sub,
      institutionId: member.institution, canSign: member.roles.some(r => ['radiologist', 'clinician', 'technician'].includes(r)) };
    registrations.set(id, doctor);
    if (doctor.canSign) {
      const pair = crypto.generateServerKeyPair(), kid = randomUUID();
      const registration = { kid, publicKey: pair.publicKey, doctor, status: 'active', registeredAt: new Date().toISOString(), endedAt: null };
      await new OnlineSigningStore().insertKey(db, registration, crypto.wrapServerPrivateKey(pair.privateKey, kid, 'fixture-wrap', wrap));
      keys.set(member.sub, registration);
    }
  }
  const identity = {
    async resolve(tx, request) {
      const member = await tx.memberRights.findUnique({ where: { sub: request.sub } });
      if (!member || !member.approved || member.suspended) throw new Error('SyntheticAccountInactive');
      const id = await resolveId(tx, member.sub), doctor = registrations.get(id);
      return { online: true, capacity: doctor.canSign ? 'clinical' : 'operator',
        ingress: { requestId: randomUUID(), ip: { status: 'known', value: { address: '192.0.2.23', source: 'trusted-proxy' } } },
        actor: { identity: doctor.identity, kind: 'member', roles: member.roles, institutionId: member.institution,
          identityRegistrationId: doctor.identityRegistrationId, canSign: doctor.canSign, canCancel: doctor.canSign,
          rightsVersion: 'fixture:1', sessionState: 'active' } };
    },
    async doctor(_tx, institution, id) {
      const doctor = registrations.get(id);
      if (!doctor || doctor.institutionId !== institution) throw new Error('SyntheticDoctorMissing');
      return doctor;
    },
  };
  const services = createOnlineClinicalServices({ records, store: new ClinicalStore(db), identity,
    secrets: { currentId: 'fixture-wrap', read: async () => Buffer.from(wrap) },
    context: {
      async facts(tx, request) {
        const current = await identity.resolve(tx, request);
        return { actor: { identity: current.actor.identity, kind: 'member', roles: current.actor.roles,
          institutionId: current.actor.institutionId, signingRegistrationId: current.actor.identityRegistrationId },
          requestId: current.ingress.requestId, ip: current.ingress.ip };
      },
      async study(tx, request, uid) {
        const state = await tx.studyState.findUnique({ where: { uid } });
        if (!state || ![state.institutionId, state.teleInstitutionId].includes(request.institution)) product('emr-contract/validation').refuse('NotFound');
        return { studyId: uid, managingInstitutionId: state.institutionId, teleInstitutionId: state.teleInstitutionId,
          patient: { linkId: 'fixture:' + uid, patientId: 'synthetic:' + uid, assigningAuthority: state.institutionId } };
      },
    }, async project() { throw new Error('Real route projector required'); },
  });
  return { services, providers: onlineClinicalProviders(services), keys };
}
module.exports = { clinicalFixture };
