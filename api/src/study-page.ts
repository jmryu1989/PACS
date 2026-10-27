import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

// Bind continuation to the caller and the visible UID set. A study arriving before the cursor would otherwise be skipped
// while the last page still reads as the whole list; the client restarts from the first page on this 409.
// No expiry: elapsed time alone does not change the list.
const conflict = () => new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '검사 목록이 바뀌었습니다. 새로고침하세요.' });
export function studyPageQuery(query: any, owner: string[]) {
  if (!query || Object.keys(query).length === 0) return null;
  if (Object.keys(query).some(k => !['limit','after'].includes(k)) || typeof query.limit !== 'string'
    || !/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > 100
    || (query.after !== undefined && (typeof query.after !== 'string' || query.after.length > 4096))) {
    throw new BadRequestException('목록 페이지 요청 형식이 잘못되었습니다');
  }
  const size = Number(query.limit);
  if (query.after === undefined) return { size, after: '', stamp: null as string | null };
  try {
    const payload = query.after;
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw conflict();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // v1 (stamp + expiry) and v2 (no stamp) cursors predate this shape; they restart from the first page.
    if (data.v !== 3 || JSON.stringify(data.owner) !== JSON.stringify(owner) || data.size !== size
      || typeof data.after !== 'string' || typeof data.stamp !== 'string') throw conflict();
    return { size, after: data.after as string, stamp: data.stamp as string };
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
    const payload = Buffer.from(JSON.stringify({ v:3, owner, size:page.size, after:uid(picked[picked.length-1]), stamp })).toString('base64url');
    next = payload;
  }
  return { rows:picked, pagination:{ owner:owner.slice(0,2), next, total:sorted.length, offset:start, limit:page.size } };
}
