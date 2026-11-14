import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** The legacy row was signed before nullable scope columns existed. Never add those nulls to its signed bytes. */
export function nativeReportSnapshot(row: Record<string, any>): string {
  const { snapshotFormat, ...record } = row;
  if ((snapshotFormat ?? 1) === 1) {
    if (record.groupId == null) delete record.groupId;
    return JSON.stringify(record);
  }
  if (snapshotFormat !== 2) throw new Error('Unsupported native report snapshot');
  return JSON.stringify({ formatVersion: 'native-report/2', report: record,
    exam: { reportUid: row.uid, groupId: row.groupId ?? null } });
}

export function nativeReportDigest(row: Record<string, any>, signedBody?: string) {
  if (signedBody !== undefined && !nativeReportMatches(row, signedBody)) throw new Error('Native report snapshot mismatch');
  return createHash('sha256').update(signedBody ?? nativeReportSnapshot(row)).digest('hex');
}

/** Used by fixed copies and retention; a scope reference is part of the testimony, including an explicit null. */
export function nativeReportMatches(row: Record<string, any>, body: string): boolean {
  try {
    const parsed = JSON.parse(body), expected = JSON.parse(nativeReportSnapshot(row));
    // Both legacy writers existed: before the nullable scope column and with an explicit null column.
    // Keep the supplied signed bytes; this comparison only establishes that they describe the same immutable row.
    if ((row.snapshotFormat ?? 1) === 1 && row.groupId == null && parsed.groupId === null) delete parsed.groupId;
    return isDeepStrictEqual(parsed, expected);
  }
  catch { return false; }
}

/** An unsigned legacy predecessor may be attested by the next signature in either historical row shape. */
export function nativeReportSnapshots(row: Record<string, any>): string[] {
  const standard = nativeReportSnapshot(row);
  if ((row.snapshotFormat ?? 1) !== 1 || row.groupId != null) return [standard];
  const { snapshotFormat, ...record } = row;
  return [standard, JSON.stringify({ ...record, groupId: null })];
}

export function nativeReportContent(body: string): Record<string, any> {
  const parsed = JSON.parse(body);
  return parsed?.formatVersion === 'native-report/2' ? parsed.report : parsed;
}
