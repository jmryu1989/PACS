import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export type SearchFolder = { path: string; description: string; ordinal: number };
export type FolderSearch = { id: number; folder: string };

export function folderPath(value: unknown, root = false): string {
  if (typeof value !== 'string') throw new BadRequestException('폴더 경로를 확인하세요');
  const parts = value.trim() ? value.trim().split('/').map(part => part.trim()) : [];
  if ((!root && !parts.length) || parts.length > 5 || parts.some(part => !part || part.length > 40 ||
      part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part)))
    throw new BadRequestException('폴더는 /로 구분한 5단계, 각 1~40자로 입력하세요');
  return parts.join('/');
}

const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
const keys = (value: any, expected: string) => object(value) && Object.keys(value).sort().join(',') === expected;

export function folderEntries(value: unknown): SearchFolder[] {
  if (!Array.isArray(value) || value.length > 200) throw new BadRequestException('폴더는 200개까지 저장할 수 있습니다');
  const seen = new Set<string>();
  return value.map(entry => {
    if (!keys(entry, 'description,ordinal,path') || typeof entry.description !== 'string' || entry.description.length > 1000 ||
        !Number.isInteger(entry.ordinal) || entry.ordinal < 0 || entry.ordinal > 9999)
      throw new BadRequestException('폴더 설명은 1000자, 순서는 0~9999로 입력하세요');
    const path = folderPath(entry.path);
    if (seen.has(path)) throw new BadRequestException('중복된 폴더 경로입니다');
    seen.add(path);
    return { path, description: entry.description, ordinal: entry.ordinal };
  });
}

export function allFolderPaths(folders: SearchFolder[], searches: FolderSearch[]): Set<string> {
  const paths = new Set<string>();
  for (const value of [...folders.map(folder => folder.path), ...searches.map(search => search.folder)]) {
    const parts = folderPath(value, true).split('/').filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) paths.add(parts.slice(0, depth).join('/'));
  }
  return paths;
}

/** Return only explicit metadata and exact row-field changes; never rewrite search criteria. */
export function folderAction(rawFolders: unknown, searches: FolderSearch[], command: any) {
  const folders = folderEntries(rawFolders), paths = allFolderPaths(folders, searches);
  const next = new Map(folders.map(folder => [folder.path, { ...folder }]));
  const moves: { id: number; folder: string }[] = [];
  let deletes: number[] = [];
  function parents(path: string) {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) {
      const part = parts.slice(0, depth).join('/');
      if (!next.has(part)) next.set(part, { path: part, description: '', ordinal: 0 });
    }
  }
  function selected(ids: unknown): FolderSearch[] {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0))
      throw new BadRequestException('검색을 1~200개 선택하세요');
    const requested = new Set(ids), found = searches.filter(search => requested.has(search.id));
    if (found.length !== ids.length) throw new NotFoundException('선택한 검색이 변경되었습니다. 목록을 다시 불러오세요');
    return found;
  }
  if (keys(command, 'action,description,ordinal,path') && command.action === 'save-folder') {
    const [folder] = folderEntries([{ path: command.path, description: command.description, ordinal: command.ordinal }]);
    parents(folder.path); next.set(folder.path, folder);
  } else if (keys(command, 'action,from,to') && command.action === 'move-folder') {
    const from = folderPath(command.from), to = folderPath(command.to);
    if (!paths.has(from)) throw new NotFoundException('폴더가 변경되었습니다. 목록을 다시 불러오세요');
    if (inside(to, from)) throw new BadRequestException('같은 폴더나 자기 하위 폴더로 이동할 수 없습니다');
    if (paths.has(to)) throw new ConflictException('대상 폴더가 이미 있습니다. 다른 경로를 사용하세요');
    const mapped = (path: string) => folderPath(to + path.slice(from.length));
    for (const path of paths) if (inside(path, from)) mapped(path);
    for (const folder of folders) if (inside(folder.path, from)) {
      next.delete(folder.path); const path = mapped(folder.path); next.set(path, { ...folder, path });
    }
    for (const path of paths) if (inside(path, from)) parents(mapped(path));
    for (const search of searches) if (inside(search.folder, from)) moves.push({ id: search.id, folder: mapped(search.folder) });
  } else if (keys(command, 'action,path') && command.action === 'remove-folder') {
    const path = folderPath(command.path), parent = path.split('/').slice(0, -1).join('/');
    if (!paths.has(path)) throw new NotFoundException('폴더가 변경되었습니다. 목록을 다시 불러오세요');
    for (const folder of folders) if (inside(folder.path, path)) next.delete(folder.path);
    if (parent) parents(parent);
    for (const search of searches) if (inside(search.folder, path)) moves.push({ id: search.id, folder: parent });
  } else if (keys(command, 'action,ids,to') && command.action === 'move-searches') {
    const to = folderPath(command.to, true), rows = selected(command.ids);
    if (to) parents(to);
    for (const row of rows) if (row.folder !== to) moves.push({ id: row.id, folder: to });
  } else if (keys(command, 'action,ids') && command.action === 'delete-searches') {
    deletes = selected(command.ids).map(row => row.id);
  } else throw new BadRequestException('폴더 작업 형식을 확인하세요');
  const result = folderEntries([...next.values()]);
  result.sort((a, b) => a.path.localeCompare(b.path));
  return { folders: result, moves, deletes };
}
