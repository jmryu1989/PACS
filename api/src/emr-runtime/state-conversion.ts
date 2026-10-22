import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { StateCoordinator } from './coordinator';
import { FailureJournal } from './failure-journal';
import { AccessSeal } from './seal';
import { PrismaLedgerSql } from './store';
import { EMR_STATE_VERIFY_CONCURRENCY } from './limits';
import { databaseIdentity, EMR_STATE_IDENTITIES, verifyStateServiceConnection } from './manifest';
import { ConversionReceipt, CopyMapping, exportV4ToV3, importV3ToV4, inspectFingerprint, parseCopyMapping, samePair, storedFormat } from './external-writer';
import { PairIdentity } from './state-protocol';

/**
 * The one-shot conversion root of the two launcher modes `state-convert-v4` (v3 source -> new v4 target, order
 * section 5.3) and `state-export-v3` (v4 source -> new v3 target, section 5.6). It runs as the service identity with
 * the same reader credential and pair observation as the serving root, takes the source's ordinary writer fence (no
 * owner can start while it runs), admits the source exactly as the serving root would, reads the DB facts for the
 * witness, and streams the logical state into the separate empty target. The source is never rewritten by a
 * conversion: its byte identity is compared before and after. The receipt is printed as one line
 * (`EMR_STATE_CONVERSION_RECEIPT {...}`) and, when `KIN_EMR_STATE_RECEIPT` names a file outside both roots, written
 * there; the caller (ops_backup.py) binds it into the capture manifest. No production cutover happens here.
 */
export async function runStateConversion(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let db: PrismaClient | undefined, coordinator: StateCoordinator | undefined;
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  try {
    if (process.platform !== 'linux' || process.getuid() !== EMR_STATE_IDENTITIES.serviceUid) fail('FORBIDDEN');
    const mode = environment.KIN_EMR_STATE_MODE;
    if (mode !== 'convert-v4' && mode !== 'export-v3') fail('PROTOCOL');
    const sourceFormat: 3 | 4 = mode === 'convert-v4' ? 3 : 4, targetFormat: 3 | 4 = mode === 'convert-v4' ? 4 : 3;
    const source = environment.KIN_EMR_STATE_DIR, target = environment.KIN_EMR_STATE_TARGET, instanceId = environment.KIN_EMR_INSTANCE_ID;
    if (!source || !target || !instanceId || instanceId.includes('\0') || Buffer.byteLength(instanceId) > 256) fail('PROTOCOL');
    for (const directory of [source, target]) {
      if (!path.isAbsolute(directory) || directory.includes('\0') || path.resolve(directory) !== directory) fail('PROTOCOL');
    }
    if (source === target || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) fail('PROTOCOL');
    const receiptFile = environment.KIN_EMR_STATE_RECEIPT;
    if (receiptFile !== undefined) {
      if (!path.isAbsolute(receiptFile) || path.resolve(receiptFile) !== receiptFile || fs.existsSync(receiptFile)) fail('PROTOCOL');
      for (const directory of [source, target]) if (receiptFile.startsWith(directory + path.sep)) fail('PROTOCOL');
    }
    // The target: an existing empty private directory of this identity (the caller's labelled volume), or absent.
    const targetInfo = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || targetInfo.uid !== process.getuid() ||
      (targetInfo.mode & 0o077) !== 0 || fs.readdirSync(target).length)) fail('FORBIDDEN');
    if (storedFormat(source) !== sourceFormat) fail('FORMAT');
    // The pair, observed on the database exactly as the serving root observes it.
    const url = new URL(environment.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'kin_emr_reader') fail('FORBIDDEN');
    url.searchParams.set('connection_limit', String(EMR_STATE_VERIFY_CONCURRENCY));
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await db.$connect();
    await verifyStateServiceConnection(db);
    const database = await databaseIdentity(db);
    const sql = new PrismaLedgerSql(db);
    const viewing = await sql.tail('viewing'), history = await sql.tail('history');
    const observed: PairIdentity = { instanceId, database, chains: { viewing: viewing.chainId, history: history.chainId } };
    let copy: CopyMapping | null = null;
    if (environment.KIN_EMR_COPY_MAPPING !== undefined) {
      try { copy = parseCopyMapping(JSON.parse(environment.KIN_EMR_COPY_MAPPING)); } catch { fail('PROTOCOL'); }
      if (!samePair(copy!.target, observed)) fail('CONFLICT');
    }
    const sourcePair = copy ? copy.source : observed;
    // The source's ordinary fence and admission (the serving root's own path: the stored format must be the mode's;
    // a second owner is refused). The fence is held until this process exits.
    const before = inspectFingerprint(source);
    coordinator = new StateCoordinator(source, undefined, { format: sourceFormat });
    coordinator.call('admit-pair', copy ? { pair: observed, copy } : observed);
    const journal = new FailureJournal(source, coordinator);
    const seal = new AccessSeal(source, sql, journal);
    let receipt: ConversionReceipt;
    if (mode === 'convert-v4') {
      // A v3 source must be exactly as captured: a repair at admission (torn suffix, in-flight publication) is a
      // source that was not quiesced, and a conversion never rewrites its source.
      if (inspectFingerprint(source) !== before) fail('SOURCE_CHANGED');
      const facts = await seal.conversionFacts(sql);
      receipt = importV3ToV4(source, target, sourcePair, facts);
      if (inspectFingerprint(source) !== before) fail('SOURCE_CHANGED');
    } else {
      // The v4 source is the live state being rolled back: its admission may complete an outstanding publication
      // (the serving root's recovery); the export then carries the recovered, fully validated state.
      receipt = exportV4ToV3(source, target, sourcePair);
    }
    const bound = { ...receipt, mode, pair: sourcePair, copyMapping: copy !== null, sourceFingerprintBefore: before,
      sourceFingerprintAfter: inspectFingerprint(source), sourceFormat, targetFormat };
    const line = JSON.stringify(bound);
    if (receiptFile !== undefined) {
      const fd = fs.openSync(receiptFile, 'wx', 0o600);
      try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    process.stdout.write('EMR_STATE_CONVERSION_RECEIPT ' + line + '\n');
    process.stdout.write('EMR_STATE_CONVERTED\n');
    return 0;
  } catch (error: any) {
    process.stderr.write('EMR_STATE_CONVERSION_FAILED ' + String(error?.code ?? error?.name ?? 'unknown') + '\n');
    return 1;
  } finally {
    try { coordinator?.close(); } catch { /* the fence is released by exit */ }
    if (db) await db.$disconnect().catch(() => undefined);
  }
}
