/*
 * 개인 검색 모음과 기관 공유 검색. 두 모음을 함께 잠그는 쓰기는 언제나 개인 → 기관 순서다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { folderAction, folderEntries, folderPath } from '../filter-folders';
import { copySearchFolder, mergeCopiedFolders, sharedKeys, sharedLibrary, sharedSearch } from '../shared-filters';
import { parse, dump } from './values';
import { need, inst } from './access';
import type { Caller } from './access';

export class PacsFilters {
  constructor(
    private readonly prisma: PrismaService) {}

  /** 필터 저장 (같은 이름이면 덮어쓴다 — 이름이 곧 사용자에게는 그 필터다) */
  async saveFilter(body: any, c: Caller) {
    const owner = c.actor;
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('필터 이름이 필요합니다');

    // Old clients omit these fields; undefined must preserve existing metadata.
    let folder: string | undefined;
    if (body.folder !== undefined) folder = folderPath(body.folder, true);
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000))
      throw new BadRequestException('검색 설명은 1000자 이내로 입력하세요');
    if (body.ordinal !== undefined && (!Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal > 9999))
      throw new BadRequestException('표시 순서는 0~9999의 정수로 입력하세요');
    const data = {
      folder, description: body.description, ordinal: body.ordinal,
      mode: body.mode ?? 'Radiology',
      quick: String(body.quick ?? ''),
      days: Number.isFinite(+body.days) ? +body.days : -1,
      cols: dump(body.cols ?? {}) ?? '{}',
      sortKey: body.sortKey ?? null,
      sortDir: +body.sortDir || 0,
      isDefault: !!body.isDefault,
    };

    // Copies are create-only even when another tab just claimed the name.
    if (body.createOnly === true) {
      try {
        const saved = await this.prisma.$transaction(async tx => {
          await this.lockFilterCollection(tx, owner);
          const created = await tx.userFilter.create({ data: { owner, name, ...data } });
          if (data.isDefault) await tx.userFilter.updateMany({
            where: { owner, id: { not: created.id } }, data: { isDefault: false },
          });
          return created;
        });
        return { ...saved, cols: parse(saved.cols) ?? {} };
      } catch (error) {
        if ((error as any)?.code === 'P2002') throw new ConflictException('같은 이름의 검색이 있습니다. 다른 이름으로 저장하세요. 기존 검색은 변경하지 않았습니다.');
        throw error;
      }
    }

    // 기본 필터는 하나뿐이다. 새로 지정하면 이전 것이 풀린다 —
    // 두 개가 기본이면 로그인할 때마다 어느 쪽이 걸릴지 모른다.
    const saved = await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, owner);
      if (data.isDefault) await tx.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });
      return tx.userFilter.upsert({
        where: { owner_name: { owner, name } },
        create: { owner, name, ...data }, update: data,
      });
    });
    return { ...saved, cols: parse(saved.cols) ?? {} };
  }

  /** 기본 필터 지정/해제 */
  async setDefaultFilter(id: number, on: boolean, c: Caller) {
    const owner = c.actor;
    await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, owner);
      const f = await tx.userFilter.findUnique({ where: { id } });
      if (!f || f.owner !== owner) throw new NotFoundException('필터를 찾을 수 없습니다');
      if (on) await tx.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });
      await tx.userFilter.update({ where: { id }, data: { isDefault: on } });
    });
    return { ok: true };
  }

  async deleteFilter(id: number, c: Caller) {
    // 남의 것을 지우지 못하게 owner를 조건에 넣는다. 찾아서 검사하고 지우면
    // 그 사이가 벌어질 수 있으므로 조건을 삭제문 안에 둔다.
    await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, c.actor);
      const r = await tx.userFilter.deleteMany({ where: { id, owner: c.actor } });
      if (!r.count) throw new NotFoundException('필터를 찾을 수 없습니다');
    });
    return { ok: true };
  }

  private lockFilterCollection(tx: Prisma.TransactionClient, owner: string, increment = 1) {
    // A single PostgreSQL upsert locks this owner's row until the transaction ends.
    return tx.userFilterCollection.upsert({
      where: { owner }, create: { owner, revision: increment, folders: [] },
      update: { revision: { increment } },
    });
  }

  private filterCollectionOwner(c: Caller) {
    if (c.kind !== 'member' || !c.sub || !c.actor) throw new ForbiddenException('개인 계정으로 로그인하세요');
    return [inst(c), c.sub];
  }

  private async filterCollectionSnapshot(tx: Prisma.TransactionClient, c: Caller) {
    const collection = await tx.userFilterCollection.findUnique({ where: { owner: c.actor } });
    const filters = await tx.userFilter.findMany({ where: { owner: c.actor }, orderBy: { id: 'asc' } });
    return { owner: this.filterCollectionOwner(c), revision: collection?.revision ?? 0,
      folders: folderEntries(collection?.folders ?? []),
      filters: filters.map(filter => ({ ...filter, cols: parse(filter.cols) ?? {} })) };
  }

  async readFilterFolders(c: Caller) {
    this.filterCollectionOwner(c);
    return this.prisma.$transaction(tx => this.filterCollectionSnapshot(tx, c),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async writeFilterFolders(body: any, c: Caller) {
    const owner = this.filterCollectionOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'command,expectedOwner,revision' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('검색 모음 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    return this.prisma.$transaction(async tx => {
      const collection = await this.lockFilterCollection(tx, c.actor);
      if (collection.revision !== body.revision + 1)
        throw new ConflictException('다른 화면에서 검색 모음이 변경되었습니다. 편집 내용을 확인한 뒤 다시 불러오세요');
      const searches = await tx.userFilter.findMany({ where: { owner: c.actor }, select: { id: true, folder: true } });
      const result = folderAction(collection.folders, searches, body.command);
      for (const move of result.moves) {
        const changed = await tx.userFilter.updateMany({ where: { id: move.id, owner: c.actor }, data: { folder: move.folder } });
        if (changed.count !== 1) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      if (result.deletes.length) {
        const changed = await tx.userFilter.deleteMany({ where: { owner: c.actor, id: { in: result.deletes } } });
        if (changed.count !== result.deletes.length) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      await tx.userFilterCollection.update({ where: { owner: c.actor }, data: { folders: result.folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }

  private lockSharedFilters(tx: Prisma.TransactionClient, c: Caller, increment: number) {
    return tx.sharedFilterLibrary.upsert({
      where: { institution: inst(c) },
      create: { institution: inst(c), revision: increment, folders: [], filters: [], updatedBy: increment ? c.actor : '' },
      update: { revision: { increment }, ...(increment ? { updatedBy: c.actor, updatedAt: new Date() } : {}) },
    });
  }

  private sharedFilterSnapshot(row: any, c: Caller) {
    return { owner: this.filterCollectionOwner(c), revision: row?.revision ?? 0,
      canManage: c.roles.includes('admin'), updatedBy: row?.updatedBy || '', updatedAt: row?.updatedAt || null,
      ...sharedLibrary(row?.folders ?? [], row?.filters ?? []) };
  }

  async readSharedFilters(c: Caller) {
    this.filterCollectionOwner(c);
    return this.sharedFilterSnapshot(await this.prisma.sharedFilterLibrary.findUnique({ where: { institution: inst(c) } }), c);
  }

  private sharedFilterRequest(body: any, c: Caller, fields: string) {
    const owner = this.filterCollectionOwner(c);
    if (!sharedKeys(body, fields) || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('기관 검색 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner)) throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
  }

  async writeSharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'command,expectedOwner,revision');
    need(c.roles, 'admin', '기관 검색 배포');
    const publish = body.command?.action === 'publish-folder';
    if (publish && (!sharedKeys(body.command, 'action,from,namePrefix,replace,sourceRevision,to') ||
        !Number.isInteger(body.command.sourceRevision) || body.command.sourceRevision < 0 ||
        typeof body.command.replace !== 'boolean')) throw new BadRequestException('폴더 배포 요청 형식을 확인하세요');
    return this.prisma.$transaction(async tx => {
      // Every operation needing both locks uses personal -> institution order.
      const personal = publish ? await this.lockFilterCollection(tx, c.actor, 0) : null;
      if (publish && personal.revision !== body.command.sourceRevision)
        throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 1);
      if (row.revision !== body.revision + 1) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      let library = sharedLibrary(row.folders, row.filters);
      if (publish) {
        const from = folderPath(body.command.from, true);
        const owned = await tx.userFilter.findMany({ where: { owner: c.actor } });
        const sources = owned.filter(filter => !from || filter.folder === from || filter.folder.startsWith(from + '/'))
          .map(filter => sharedSearch(filter, filter.id));
        const copied = copySearchFolder(folderEntries(personal.folders), sources, from, body.command.to, body.command.namePrefix);
        const folders = mergeCopiedFolders(library.folders, library.filters, copied.folders, body.command.replace);
        const filters = new Map(library.filters.map(filter => [filter.name, filter]));
        let nextId = row.revision * 201;
        for (const copy of copied.filters) {
          const existing = filters.get(copy.name);
          if (existing && !body.command.replace) throw new ConflictException('같은 이름의 기관 검색이 있습니다. 이름 접두사 또는 명시적 교체를 사용하세요');
          filters.set(copy.name, { ...copy, id: existing?.id ?? ++nextId });
        }
        library = sharedLibrary(folders, [...filters.values()]);
      } else {
        const changes = folderAction(library.folders, library.filters, body.command);
        const moves = new Map(changes.moves.map(move => [move.id, move.folder]));
        const deleted = new Set(changes.deletes);
        library = sharedLibrary(changes.folders, library.filters.filter(filter => !deleted.has(filter.id))
          .map(filter => moves.has(filter.id) ? { ...filter, folder: moves.get(filter.id) } : filter));
      }
      const saved = await tx.sharedFilterLibrary.update({ where: { institution: inst(c) }, data: library });
      return this.sharedFilterSnapshot(saved, c);
    });
  }

  async copySharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'expectedOwner,from,namePrefix,personalRevision,revision,to');
    if (!Number.isInteger(body.personalRevision) || body.personalRevision < 0 || body.personalRevision >= 2147483647)
      throw new BadRequestException('개인 검색 버전을 확인하세요');
    return this.prisma.$transaction(async tx => {
      const personal = await this.lockFilterCollection(tx, c.actor);
      if (personal.revision !== body.personalRevision + 1) throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 0);
      if (row.revision !== body.revision) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      const library = sharedLibrary(row.folders, row.filters);
      if (row.revision === 0 && !library.folders.length && !library.filters.length)
        throw new NotFoundException('배포된 기관 검색이 없습니다');
      const copied = copySearchFolder(library.folders, library.filters, body.from, body.to, body.namePrefix);
      const owned = await tx.userFilter.findMany({ where: { owner: c.actor } });
      const folders = mergeCopiedFolders(folderEntries(personal.folders), owned, copied.folders, false);
      const names = new Set(owned.map(filter => filter.name));
      if (copied.filters.some(filter => names.has(filter.name))) throw new ConflictException('같은 이름의 개인 검색이 있습니다. 이름 접두사를 입력하세요');
      for (const filter of copied.filters) {
        const { id, cols, ...definition } = filter;
        await tx.userFilter.create({ data: { ...definition, owner: c.actor, cols: JSON.stringify(cols), isDefault: false } });
      }
      await tx.userFilterCollection.update({ where: { owner: c.actor }, data: { folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }
}
