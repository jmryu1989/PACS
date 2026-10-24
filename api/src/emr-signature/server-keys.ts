import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { identity } from '../emr-contract/access-event';
import { freeze, refuse, string } from '../emr-contract/validation';
import { parseVerifiedActor } from '../emr-report/contract';
import { OnlineSigningStore } from '../emr-report/online-store';
import { generateServerKeyPair, unwrapServerPrivateKey, wrapServerPrivateKey } from './server-crypto';
import type { DoctorRegistration, LedgerPort, RequestIdentity, RequestIdentityPort, ServerKeyRegistration,
  SigningEvent, SigningTransaction, WrappingSecrets } from './server-contract';

/** Explicit deployment paths; there is no DB/environment-secret fallback or default credential. */
export class FileWrappingSecrets implements WrappingSecrets {
  constructor(readonly currentId: string, private readonly files: Readonly<Record<string, string>>) {
    string(currentId);
    if (!files[currentId] || Object.values(files).some(path => !isAbsolute(path))) refuse('WrappingSecretPathRequired');
  }
  async read(id: string): Promise<Buffer> {
    const path = this.files[string(id)];
    if (!path) refuse('WrappingSecretUnavailable');
    const bytes = await readFile(path);
    if (bytes.length !== 32) { bytes.fill(0); refuse('ServerWrappingKeyRequired'); }
    return bytes;
  }
}

export function clinicalIdentity(input: RequestIdentity): RequestIdentity {
  const actor = parseVerifiedActor(input.actor);
  if (!input.online || input.capacity !== 'clinical' || actor.kind !== 'member' ||
      actor.sessionState !== 'active' || !actor.canSign ||
      !actor.roles.some(role => ['radiologist', 'clinician', 'technician'].includes(role))) refuse('OnlineDoctorApprovalRequired');
  return { ...input, actor };
}

export class ServerKeys {
  constructor(private readonly ledger: LedgerPort, private readonly identities: RequestIdentityPort,
    readonly store: OnlineSigningStore, private readonly secrets: WrappingSecrets) {}

  /** Provision/suspend/revoke/replace only; this administrative boundary cannot sign clinical content. */
  async manage(request: object, command: {
    action: 'provision' | 'suspend' | 'revoke' | 'replace'; institutionId: string; doctorId: string;
    expectedKid: string | null; reason: string;
  }): Promise<ServerKeyRegistration> {
    if (!['provision', 'suspend', 'revoke', 'replace'].includes(command.action)) refuse('KeyManagementActionRequired');
    const institutionId = string(command.institutionId), doctorId = string(command.doctorId), reason = string(command.reason);
    return this.ledger.transactionWithRecords(async (tx, record) => {
      const operator = await this.identities.authorizeKeyManagement(tx, request, institutionId);
      const actor = parseVerifiedActor(operator.actor);
      if (!operator.online || operator.capacity !== 'operator' || actor.kind !== 'member' || actor.sessionState !== 'active' ||
          actor.institutionId !== institutionId) refuse('KeyCustodianRequired');
      await this.store.lockDoctor(tx, institutionId, doctorId);
      const active = await this.store.currentKey(tx, institutionId, doctorId);
      const previous = command.expectedKid === null ? null : await this.store.key(tx, string(command.expectedKid));
      if (previous && (previous.doctor.institutionId !== institutionId || previous.doctor.identity.id !== doctorId)) refuse('KeyDoctorMismatch');
      if (command.action === 'provision' ? active !== null || previous !== null || command.expectedKid !== null :
          !previous || (active !== null && active.kid !== previous.kid)) refuse('KeyManagementConflict');
      if (previous?.status === 'revoked' && command.action !== 'replace') refuse('KeyAlreadyRevoked');
      let doctor: DoctorRegistration | null = null;
      if (command.action === 'provision' || command.action === 'replace') {
        doctor = await this.identities.doctor(tx, institutionId, doctorId);
        if (!doctor.canSign || doctor.institutionId !== institutionId || doctor.identity.id !== doctorId) refuse('DoctorRegistrationRequired');
        doctor = { identity: identity(doctor.identity), identityRegistrationId: string(doctor.identityRegistrationId), institutionId, canSign: true };
      }
      const at = new Date().toISOString(), kid = doctor ? randomUUID() : previous.kid;
      const event: SigningEvent = { eventId: randomUUID(), operationId: randomUUID(), actor: actor.identity, institutionId, at,
        roles: actor.roles, managingInstitutionId: institutionId,
        ingress: operator.ingress, task: command.action === 'provision' ? 'key-grant' : `key-${command.action}` as SigningEvent['task'],
        result: 'succeeded', doctorId, kid, patient: null, studyId: null, recordId: null, versionId: null };
      let result: ServerKeyRegistration;
      await record(event, async () => {
        if (previous) {
          const status = command.action === 'suspend' ? 'suspended' : 'revoked';
          await this.store.endKey(tx, previous, status, at);
          result = { ...previous, status, endedAt: previous.endedAt ?? at };
          await this.store.keyHistory(tx, previous.kid, { ...event, kid: previous.kid,
            before: previous.status, after: status, reason, replacementKid: doctor ? kid : null });
        }
        if (doctor) {
          const pair = generateServerKeyPair(), secret = await this.secrets.read(this.secrets.currentId);
          try {
            const wrapped = wrapServerPrivateKey(pair.privateKey, kid, this.secrets.currentId, secret);
            result = { kid, publicKey: pair.publicKey, doctor, status: 'active', registeredAt: at, endedAt: null };
            await this.store.insertKey(tx, result, wrapped);
          } finally { secret.fill(0); }
          await this.store.keyHistory(tx, kid, { ...event, before: null, after: 'active', reason, previousKid: previous?.kid ?? null });
        }
        return { kind: 'server-signing-key', id: kid, version: null };
      });
      if (!result) refuse('KeyChangeNotRecorded');
      return freeze(result);
    });
  }

  /** The caller retains this doctor lock through signing, storage and ledger COMMIT. */
  async forApproval(tx: SigningTransaction, current: RequestIdentity): Promise<ServerKeyRegistration> {
    const { actor } = clinicalIdentity(current);
    await this.store.lockDoctor(tx, actor.institutionId, actor.identity.id);
    const key = await this.store.currentKey(tx, actor.institutionId, actor.identity.id);
    if (!key || key.doctor.identityRegistrationId !== actor.identityRegistrationId ||
        JSON.stringify(identity(key.doctor.identity)) !== JSON.stringify(identity(actor.identity))) refuse('DoctorSigningKeyUnavailable');
    return key;
  }

  async privateFor(tx: SigningTransaction, key: ServerKeyRegistration) {
    const wrapped = await this.store.privateKey(tx, key.kid), secret = await this.secrets.read(wrapped.wrappingKeyId);
    try { return unwrapServerPrivateKey(wrapped, key.kid, wrapped.wrappingKeyId, secret); }
    finally { secret.fill(0); }
  }
}
