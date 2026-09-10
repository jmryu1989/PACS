import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { allFolderPaths, folderEntries, folderPath, SearchFolder } from './filter-folders';

export type SharedSearch = {
  id: number; name: string; mode: string; quick: string; days: number; cols: Record<string, any>;
  sortKey: string | null; sortDir: number; folder: string; description: string; ordinal: number;
};
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (path: string, from: string) => path === from || path.startsWith(from + '/');
export const sharedKeys = (value: any, expected: string) => object(value) && Object.keys(value).sort().join(',') === expected;

/** Copy only search definitions, without personal ownership, default status or database IDs. */
export function sharedSearch(value: any, id: number): SharedSearch {
  let cols = value?.cols;
  if (typeof cols === 'string') { try { cols = JSON.parse(cols); } catch (_) { cols = null; } }
  if (!object(value) || !Number.isSafeInteger(id) || id <= 0 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.trim() !== value.name || value.name.length > 200 ||
      !['Radiology', 'Technician'].includes(value.mode) || typeof value.quick !== 'string' ||
      !Number.isInteger(value.days) || !object(cols) ||
      !(value.sortKey === null || typeof value.sortKey === 'string') || ![-1, 0, 1].includes(value.sortDir))
    throw new BadRequestException('공유할 검색 이름과 조건 형식을 확인하세요');
  const folder = folderPath(value.folder, true);
  // Validate common metadata even for an ungrouped search.
  folderEntries([{ path: folder || 'Ungrouped', description: value.description, ordinal: value.ordinal }]);
  return { id, name: value.name, mode: value.mode, quick: value.quick, days: value.days, cols,
    sortKey: value.sortKey, sortDir: value.sortDir, folder, description: value.description, ordinal: value.ordinal };
}

export function sharedLibrary(rawFolders: unknown, rawFilters: unknown) {
  const folders = folderEntries(rawFolders);
  if (!Array.isArray(rawFilters) || rawFilters.length > 200) throw new BadRequestException('기관 검색은 200개까지 배포할 수 있습니다');
  const names = new Set<string>(), ids = new Set<number>();
  const filters = rawFilters.map(value => {
    if (!sharedKeys(value, 'cols,days,description,folder,id,mode,name,ordinal,quick,sortDir,sortKey'))
      throw new BadRequestException('공유 검색 형식을 확인하세요');
    const filter = sharedSearch(value, value.id);
    if (names.has(filter.name) || ids.has(filter.id)) throw new BadRequestException('중복된 공유 검색입니다');
    names.add(filter.name); ids.add(filter.id); return filter;
  });
  if (Buffer.byteLength(JSON.stringify({ folders, filters }), 'utf8') > 256 * 1024)
    throw new BadRequestException('기관 검색 모음은 256KiB까지 저장할 수 있습니다');
  return { folders, filters };
}

/** Select and remap one complete source subtree; retain metadata and criteria. */
export function copySearchFolder(folders: SearchFolder[], filters: SharedSearch[], fromValue: unknown, toValue: unknown, prefixValue: unknown) {
  const from = folderPath(fromValue, true), to = folderPath(toValue);
  if (typeof prefixValue !== 'string' || prefixValue.length > 80 || prefixValue.trimStart() !== prefixValue || /[\u0000-\u001f\u007f]/.test(prefixValue))
    throw new BadRequestException('이름 접두사는 앞 공백 없이 80자 이내로 입력하세요');
  const paths = allFolderPaths(folders, filters), metadata = new Map(folders.map(folder => [folder.path, folder]));
  if (from && !paths.has(from)) throw new NotFoundException('원본 폴더가 변경되었습니다. 다시 불러오세요');
  const mapped = (path: string) => folderPath(from ? to + path.slice(from.length) : to + (path ? '/' + path : ''));
  const selectedPaths = from ? [...paths].filter(path => inside(path, from)) : ['', ...paths];
  const nextFolders = selectedPaths.map(path => ({
    path: mapped(path), description: metadata.get(path)?.description || '', ordinal: metadata.get(path)?.ordinal || 0,
  }));
  const nextFilters = filters.filter(filter => !from || inside(filter.folder, from)).map(filter =>
    sharedSearch({ ...filter, name: prefixValue + filter.name, folder: mapped(filter.folder) }, filter.id));
  return sharedLibrary(nextFolders, nextFilters);
}

/** Destination folders already in use are never silently overwritten during a personal copy. */
export function mergeCopiedFolders(existing: SearchFolder[], searches: {id: number; folder: string}[], copied: SearchFolder[], replace: boolean) {
  const paths = allFolderPaths(existing, searches), result = new Map(existing.map(folder => [folder.path, folder]));
  for (const folder of copied) {
    if (!replace && paths.has(folder.path)) throw new ConflictException('대상 폴더가 이미 있습니다. 다른 경로로 복사하세요');
    result.set(folder.path, folder);
  }
  for (const folder of copied) {
    const parts = folder.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const path = parts.slice(0, depth).join('/');
      if (!result.has(path)) result.set(path, { path, description: '', ordinal: 0 });
    }
  }
  return folderEntries([...result.values()]);
}
