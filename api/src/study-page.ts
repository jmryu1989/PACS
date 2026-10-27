import { BadRequestException, ConflictException } from '@nestjs/common';

// Continue by UID; new arrivals and removed rows do not invalidate the reader's cursor.
const conflict = () => new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '이어받기 조건이 현재 사용자 또는 페이지 크기와 다릅니다. 새로고침하세요.' });
export function studyPageQuery(query: any, owner: string[]) {
  if (!query || Object.keys(query).length === 0) return null;
  if (Object.keys(query).some(k => !['limit','after'].includes(k)) || typeof query.limit !== 'string'
    || !/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > 100
    || (query.after !== undefined && (typeof query.after !== 'string' || query.after.length > 4096))) {
    throw new BadRequestException('목록 페이지 요청 형식이 잘못되었습니다');
  }
  const size = Number(query.limit);
  if (query.after === undefined) return { size, after: '' };
  try {
    const payload = query.after;
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw conflict();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (![1, 2].includes(data.v) || JSON.stringify(data.owner) !== JSON.stringify(owner) || data.size !== size
      || typeof data.after !== 'string') throw conflict();
    return { size, after: data.after as string };
  } catch { throw conflict(); }
}

export function studyPageSlice<T>(rows: T[], uid: (row: T) => string, page: ReturnType<typeof studyPageQuery>, owner: string[]) {
  if (!page) return { rows, pagination: undefined };
  const sorted = [...new Map(rows.map(row => [uid(row), row])).values()].sort((a,b) => uid(a) < uid(b) ? -1 : uid(a) > uid(b) ? 1 : 0);
  const found = page.after ? sorted.findIndex(row => uid(row) > page.after) : 0;
  const start = found < 0 ? sorted.length : found;
  const picked = sorted.slice(start, start + page.size);
  let next: string | null = null;
  if (start + picked.length < sorted.length) {
    const payload = Buffer.from(JSON.stringify({ v:2, owner, size:page.size, after:uid(picked[picked.length-1]) })).toString('base64url');
    next = payload;
  }
  return { rows:picked, pagination:{ owner:owner.slice(0,2), next, total:sorted.length, offset:start, limit:page.size } };
}
