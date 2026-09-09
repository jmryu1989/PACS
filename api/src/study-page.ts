import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Process-local signing means a restart expires continuations instead of keeping
// patient metadata snapshots alive or accepting a caller-supplied offset/owner.
const secret = randomBytes(32);
const conflict = () => new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '검사 목록 또는 이어받기 유효기간이 바뀌었습니다. 새로고침하세요.' });
export function studyPageQuery(query: any, owner: string[]) {
  if (!query || Object.keys(query).length === 0) return null;
  if (Object.keys(query).some(k => !['limit','after'].includes(k)) || typeof query.limit !== 'string'
    || !/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > 100
    || (query.after !== undefined && (typeof query.after !== 'string' || query.after.length > 4096))) {
    throw new BadRequestException('목록 페이지 요청 형식이 잘못되었습니다');
  }
  const size = Number(query.limit);
  if (query.after === undefined) return { size, after: '', stamp: null as string | null, expires: Date.now() + 300000 };
  try {
    const [payload, signature, extra] = query.after.split('.');
    if (extra !== undefined || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw conflict();
    const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', secret).update(payload).digest();
    if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw conflict();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || JSON.stringify(data.owner) !== JSON.stringify(owner) || data.size !== size
      || !Number.isSafeInteger(data.expires) || data.expires < Date.now() || typeof data.after !== 'string'
      || typeof data.stamp !== 'string') throw conflict();
    return { size, after: data.after, stamp: data.stamp, expires: data.expires };
  } catch { throw conflict(); }
}

export function studyPageSlice<T>(rows: T[], uid: (row: T) => string, page: ReturnType<typeof studyPageQuery>, owner: string[]) {
  if (!page) return { rows, pagination: undefined };
  const sorted = [...new Map(rows.map(row => [uid(row), row])).values()].sort((a,b) => uid(a) < uid(b) ? -1 : uid(a) > uid(b) ? 1 : 0);
  const stamp = createHash('sha256').update(JSON.stringify(sorted.map(uid))).digest('hex');
  if (page.stamp !== null && (page.stamp !== stamp || !sorted.some(row => uid(row) === page.after))) throw conflict();
  const start = page.stamp === null ? 0 : sorted.findIndex(row => uid(row) === page.after) + 1;
  const picked = sorted.slice(start, start + page.size);
  let next: string | null = null;
  if (start + picked.length < sorted.length) {
    const payload = Buffer.from(JSON.stringify({ v:1, owner, size:page.size, after:uid(picked[picked.length-1]), stamp, expires:page.expires })).toString('base64url');
    next = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  }
  return { rows:picked, pagination:{ owner:owner.slice(0,2), next, total:sorted.length, offset:start, limit:page.size } };
}
