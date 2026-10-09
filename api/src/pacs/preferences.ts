/*
 * 계정·기관에 붙는 작업 설정(배치·Hanging Protocol·단축키·글자·열·메모 자동 열기)과 판독 상용구.
 * 설정마다 형식 검사와 revision CAS 쓰기를 같은 자리에 둔다 — 검사와 쓰기가 갈라지면 옛 화면이 새 형식을 지운다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { SEED_TEMPLATES } from '../seed';
import { normalizeWorklistColumns } from '../worklist-columns';
import { normalizeHangingProtocol } from '../hanging-protocol';
import type { HangingProtocolLibrary } from '../hanging-protocol';
import { parse } from './values';
import { need, inst } from './access';
import type { Caller } from './access';

export class PacsPreferences {
  constructor(
    private readonly prisma: PrismaService) {}

  // ══════════════════ 쓰기 ══════════════════

  // ══════════════════ 개인 설정 (필터·상용구) ══════════════════
  //
  // 둘 다 **계정에 붙는다.** 브라우저가 아니라.
  // 판독의는 자기 필터를 하루 종일 쓴다. PC를 바꿨다고 초기화되면 깨지는 건
  // 작업이 아니라 신뢰다 (교훈 §6 — HPACS가 5년간 반복한 버그 카테고리).
  //
  // 반대로 **모니터 구성에 딸린 것(필름박스 레이아웃 등)은 계정에 두면 안 된다.**
  // HPACS도 Hanging Protocol만은 "계정 + 컴퓨터"별로 기억하도록 따로 만들었다 —
  // 집의 1대 모니터와 병원의 3대 모니터에 같은 레이아웃을 강요할 수 없기 때문.
  // 계정에 저장할 것과 기기에 남길 것을 나누는 기준이 여기 있다.

  /** 내 필터 + 내 상용구. 처음 보는 계정이면 기본 상용구를 넣어준다. */
  async prefs(c: Caller) {
    const owner = c.actor;
    /**
     * 새 계정에는 기본 상용구를 넣어준다 — 빈 목록은 버그로 보이기 때문.
     * (HPACS도 "신규계정인 경우 Reading Template 생성이 되지 않았던 오류"를 고친 적이 있다)
     *
     * **단, 판독의에게만.** 상용구는 판독문을 쓰는 도구다. 방사선사는 판독문을 안 쓰므로
     * 그 사람 계정에 판독 상용구가 세 개 생기면, 못 쓰는 기능이 목록에 놓여 있는 셈이다.
     * 화면에 있는데 아무것도 못 하는 것은 안내가 아니라 소음이다.
     */
    const canRead = c.roles?.includes('radiologist') || c.roles?.includes('admin');
    const n = await this.prisma.readingTemplate.count({ where: { owner } });
    if (n === 0 && canRead)
      await this.prisma.readingTemplate.createMany({
        data: SEED_TEMPLATES.map(t => ({ ...t, owner })),
      });

    const [filters, templates] = await Promise.all([
      this.prisma.userFilter.findMany({ where: { owner }, orderBy: { createdAt: 'asc' } }),
      this.prisma.readingTemplate.findMany({ where: { owner }, orderBy: [{ ord: 'asc' }, { id: 'asc' }] }),
    ]);
    return {
      filters: filters.map(f => ({ ...f, cols: parse(f.cols) ?? {} })),
      templates,
    };
  }

  private workspaceOwner(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용 배치입니다');
    need(c.roles, c.roles.includes('technician') ? 'technician' : 'radiologist', '작업공간 배치');
    const institution = inst(c);
    if (![institution, c.sub].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256))
      throw new ForbiddenException('계정 정보를 확인할 수 없습니다');
    return { institution, subject: c.sub };
  }

  private workspaceValue(value: any) {
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fields = value?.version === 2 ? 'landscape,mode,portrait,reading,version' : 'landscape,mode,portrait,version';
    if (!object(value) || Object.keys(value).sort().join(',') !== fields ||
        ![1, 2].includes(value.version) || !['auto', 'portrait', 'landscape'].includes(value.mode) || JSON.stringify(value).length > 2048)
      throw new BadRequestException('작업공간 배치 형식이 잘못되었습니다');
    const clean: any = { version: value.version, mode: value.mode, portrait: {}, landscape: {} };
    for (const axis of ['portrait', 'landscape']) {
      if (!object(value[axis]) || Object.keys(value[axis]).some(k => !['main', 'top', 'related', 'prior'].includes(k)))
        throw new BadRequestException('작업공간 패널 형식이 잘못되었습니다');
      for (const [key, size] of Object.entries(value[axis])) {
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 1 || size > 16384)
          throw new BadRequestException('작업공간 패널 크기가 잘못되었습니다');
        clean[axis][key] = Math.round(size);
      }
    }
    if (value.version === 2) {
      const reading = value.reading;
      if (!object(reading) || Object.keys(reading).sort().join(',') !==
          'imageHeight,relatedHeight,relatedHidden,relatedListHeight,reportWidth,version' ||
          reading.version !== 1 || typeof reading.relatedHidden !== 'boolean')
        throw new BadRequestException('판독 작업공간 배치 형식이 잘못되었습니다');
      clean.reading = { version: 1 };
      for (const key of ['reportWidth', 'imageHeight', 'relatedHeight', 'relatedListHeight']) {
        const size = reading[key];
        if (size !== null && (!Number.isInteger(size) || size < 1 || size > 16384))
          throw new BadRequestException('판독 작업공간 패널 크기가 잘못되었습니다');
        clean.reading[key] = size;
      }
      clean.reading.relatedHidden = reading.relatedHidden;
    }
    return clean;
  }

  private readingPreferencesResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      autoNote: row?.autoNote ?? null };
  }

  async readingPreferences(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.readingPreferences.findUnique({ where: { institution_subject: owner } });
    return this.readingPreferencesResult(owner, row);
  }

  async saveReadingPreferences(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'autoNote,expectedOwner,revision' ||
        typeof body.autoNote !== 'boolean' || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('메모 자동 열기 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.readingPreferences.create({ data: { ...owner, revision: 1, autoNote: body.autoNote } });
        const changed = await tx.readingPreferences.updateMany({ where: { ...owner, revision: body.revision },
          data: { autoNote: body.autoNote, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.readingPreferences.findUnique({ where: { institution_subject: owner } });
      });
      return this.readingPreferencesResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  /**
   * 기관 공용(SITE) 행의 주인. 개인 행과 같은 표를 쓰되 `subject=''` 센티널로 구분한다
   * (StudyTagCatalog의 `ownerSub=''`와 같은 방식). 개인 경로의 `workspaceOwner()`는
   * subject가 비어 있지 않음을 계속 요구하므로, 빈 subject는 오직 이 경로에서만 나온다.
   */
  private siteOwner(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용 배치입니다');
    need(c.roles, c.roles.includes('technician') ? 'technician' : 'radiologist', '기관 Hanging Protocol');
    const institution = inst(c);
    if (typeof institution !== 'string' || institution.length === 0 || institution.length > 256)
      throw new ForbiddenException('계정 정보를 확인할 수 없습니다');
    return { institution, subject: '' };
  }

  private hangingProtocolResult(owner: { institution: string; subject: string }, row: any) {
    if (!row) return { owner, revision: 0, value: null };
    const value = row.value === null ? null : normalizeHangingProtocol(row.value);
    if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647 || value === undefined)
      throw new ServiceUnavailableException('저장된 Hanging Protocol 설정을 확인할 수 없습니다');
    return { owner, revision: row.revision, value };
  }

  async hangingProtocols(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
    return this.hangingProtocolResult(owner, row);
  }

  /**
   * 저장 요청의 형식·소유자·값 검사. 개인과 기관(SITE)이 같은 표·같은 스키마·같은 CAS를
   * 쓰므로 검사도 하나만 둔다. 기관은 `expectedOwner.subject`가 빈 문자열이어야 하고,
   * 개인은 비어 있지 않아야 하므로 소유자 대조만으로 두 범위가 서로 섞이지 않는다.
   */
  private hangingProtocolRequest(body: any, owner: { institution: string; subject: string }) {
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
    if (!object(body) || Object.keys(body).sort().join(',') !== 'expectedOwner,revision,value' ||
        !object(body.expectedOwner) || Object.keys(body.expectedOwner).sort().join(',') !== 'institution,subject' ||
        typeof body.expectedOwner.institution !== 'string' || typeof body.expectedOwner.subject !== 'string' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('Hanging Protocol 저장 요청 형식이 잘못되었습니다');
    if (body.expectedOwner.institution !== owner.institution || body.expectedOwner.subject !== owner.subject)
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const value = body.value === null ? null : normalizeHangingProtocol(body.value);
    if (value === undefined) throw new BadRequestException('Hanging Protocol 설정 형식이 잘못되었습니다');
    return value;
  }

  private async writeHangingProtocol(owner: { institution: string; subject: string }, revision: number,
      value: HangingProtocolLibrary | null, audit: ((tx: Prisma.TransactionClient, saved: any) => Promise<unknown>) | null) {
    const conflict = () => new ConflictException('Hanging Protocol 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    const stored: any = value === null ? Prisma.DbNull : value;
    try {
      return await this.prisma.$transaction(async tx => {
        let row: any;
        if (revision === 0) row = await tx.hangingProtocolPreference.create({ data: { ...owner, revision: 1, value: stored } });
        else {
          const changed = await tx.hangingProtocolPreference.updateMany({ where: { ...owner, revision },
            data: { value: stored, revision: { increment: 1 } } });
          if (changed.count !== 1) throw conflict();
          row = await tx.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
        }
        if (audit) await audit(tx, row);
        return row;
      });
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  async saveHangingProtocols(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    const value = this.hangingProtocolRequest(body, owner);
    return this.hangingProtocolResult(owner, await this.writeHangingProtocol(owner, body.revision, value, null));
  }

  private siteHangingProtocolResult(owner: { institution: string; subject: string }, row: any, c: Caller) {
    // 개인 응답은 한 글자도 바꾸지 않는다. 기관 전용 필드는 이 응답에만 붙인다.
    return { ...this.hangingProtocolResult(owner, row),
      canManageSite: c.roles.includes('admin'), updatedAt: row?.updatedAt ?? null };
  }

  async siteHangingProtocols(c: Caller) {
    const owner = this.siteOwner(c);
    const row = await this.prisma.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
    return this.siteHangingProtocolResult(owner, row, c);
  }

  async saveSiteHangingProtocols(body: any, c: Caller) {
    const owner = this.siteOwner(c);
    // 형식보다 권한을 먼저 본다. 관리자가 아닌 호출자는 본문으로 저장 경로를 떠볼 수 없다.
    need(c.roles, 'admin', '기관 Hanging Protocol 배포');
    const value = this.hangingProtocolRequest(body, owner);
    const row = await this.writeHangingProtocol(owner, body.revision, value, (tx, saved) =>
      tx.auditLog.create({ data: { actor: c.actor, action: 'hanging-protocol.site.' + (value === null ? 'reset' : 'save'),
        target: owner.institution, detail: JSON.stringify({ revision: saved?.revision ?? null }) } }));
    return this.siteHangingProtocolResult(owner, row, c);
  }

  private validShortcutBindings(v: any) {
    const names = ['list','image','prior','report','context','note','tools','nativeTools','previous','next'];
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.slice().sort().join(',') && new Set(Object.values(v)).size === names.length && Object.values(v).every((key: any) => typeof key === 'string' && /^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key) && !['KeyC','Digit8'].includes(key));
  }

  private shortcutPreferencesResult(owner: { institution: string; subject: string }, row: any) {
    const invalid = !!row && !this.validShortcutBindings(row.bindings);
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      bindings: invalid ? null : row?.bindings ?? null, invalid };
  }

  async workspaceShortcuts(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.workspaceShortcuts.findUnique({ where: { institution_subject: owner } });
    return this.shortcutPreferencesResult(owner, row);
  }

  async saveWorkspaceShortcuts(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'bindings,expectedOwner,revision' ||
        !this.validShortcutBindings(body.bindings) || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('단축키 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.workspaceShortcuts.create({ data: { ...owner, revision: 1, bindings: body.bindings } });
        const changed = await tx.workspaceShortcuts.updateMany({ where: { ...owner, revision: body.revision },
          data: { bindings: body.bindings, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.workspaceShortcuts.findUnique({ where: { institution_subject: owner } });
      });
      return this.shortcutPreferencesResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  private appearanceResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0, sizes: row?.sizes ?? null };
  }

  async readingAppearance(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.readingAppearance.findUnique({ where: { institution_subject: owner } });
    return this.appearanceResult(owner, row);
  }

  async saveReadingAppearance(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
    const choices = (v: any, allowed: string[]) => object(v) && Object.keys(v).sort().join(',') === 'current,list,prior,version' &&
      v.version === 1 && ['list', 'current', 'prior'].every(k => typeof v[k] === 'string' && allowed.includes(v[k]));
    const validDock = (v: any, version: number) => object(v) && Object.keys(v).sort().join(',') === (version >= 5 ? 'autoHide,panel,placement,version' : 'panel,placement,version') &&
      v.version === (version >= 5 ? 2 : 1) && (version < 5 || typeof v.autoHide === 'boolean') && ['top', 'bottom'].includes(v.placement) && [-1, 0, 1].includes(v.panel);
    const toolbarIds = ['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools'];
    const validToolbar = (v: any) => object(v) && v.version === 1 && Object.keys(v).sort().join(',') === 'hidden,order,version' &&
      Array.isArray(v.order) && v.order.length === toolbarIds.length && new Set(v.order).size === toolbarIds.length && v.order.every((id: any) => toolbarIds.includes(id)) &&
      Array.isArray(v.hidden) && new Set(v.hidden).size === v.hidden.length && v.hidden.every((id: any) => toolbarIds.includes(id) && id !== 'Zoom');
    const positions = ['top-left','top-right','bottom-left','bottom-right'], modalities = ['CT','MR','CR','DX','US','MG','XA','RF','PT','NM','OT'];
    const validViewerProfile = (p: any, overrides: boolean) => object(p) && Object.keys(p).sort().join(',') === (overrides ? 'color,date,description,fieldPositions,font,name,overrides,position,size' : 'color,date,description,fieldPositions,font,name,position,size') &&
      [12,14,16,18,20].includes(p.size) && ['default','sans','serif','mono'].includes(p.font) && ['default','warm','cool','white'].includes(p.color) && positions.includes(p.position) &&
      ['name','date','description'].every(k => typeof p[k] === 'boolean') && object(p.fieldPositions) && Object.keys(p.fieldPositions).sort().join(',') === 'date,description,name' &&
      ['name','date','description'].every(k => positions.includes(p.fieldPositions[k])) && (!overrides || object(p.overrides) && Object.keys(p.overrides).every(k => modalities.includes(k) && validViewerProfile(p.overrides[k], false)));
    const validViewer = (v: any, appearanceVersion: number) => object(v) && v.version === (appearanceVersion === 9 ? 3 : appearanceVersion === 8 ? 2 : 1) && Object.keys(v).sort().join(',') === 'current,prior,version' &&
      ['current', 'prior'].every(role => { const p = v[role]; return v.version === 3 ? validViewerProfile(p, true) : object(p) && Object.keys(p).sort().join(',') === (v.version === 2 ? 'color,date,description,font,name,position,size' : 'color,date,description,font,name,size') &&
        [12,14,16,18,20].includes(p.size) && ['default','sans','serif','mono'].includes(p.font) && ['default','warm','cool','white'].includes(p.color) &&
        (v.version === 1 || positions.includes(p.position)) && ['name','date','description'].every(k => typeof p[k] === 'boolean'); });
    const validMpr = (v: any) => object(v) && v.version === 1 && Object.keys(v).sort().join(',') === 'display,mouse,progressive,sync,version' && typeof v.progressive === 'boolean' &&
      object(v.display) && Object.keys(v.display).sort().join(',') === 'autoHideCrosshair,cube,demographics,orientation,sample,scale,thickness,windowing,zoom' && Object.values(v.display).every(x => typeof x === 'boolean') &&
      object(v.mouse) && Object.keys(v.mouse).sort().join(',') === 'left,middle,right' && new Set(Object.values(v.mouse)).size === 3 && Object.values(v.mouse).every(x => ['WindowLevel','Pan','Zoom','StackScroll'].includes(x as string)) &&
      object(v.sync) && Object.keys(v.sync).sort().join(',') === 'windowing,zoom' && Object.values(v.sync).every(x => typeof x === 'boolean');
    const validAppearance = (v: any) => object(v) && ['list', 'current', 'prior'].every(k => [12, 14, 16, 18, 20].includes(v[k])) &&
      (v.version === 1 ? Object.keys(v).sort().join(',') === 'current,list,prior,version' :
        [2, 3, 4, 5, 6, 7, 8, 9].includes(v.version) && Object.keys(v).sort().join(',') === (v.version >= 7 ? 'colors,current,dock,fonts,list,mpr,prior,toolbar,version,viewer' : v.version === 6 ? 'colors,current,dock,fonts,list,prior,toolbar,version,viewer' : v.version >= 4 ? 'colors,current,dock,fonts,list,prior,version,viewer' : v.version === 3 ? 'colors,current,dock,fonts,list,prior,version' : 'colors,current,fonts,list,prior,version') &&
        (v.version < 3 || validDock(v.dock, v.version)) && (v.version < 4 || validViewer(v.viewer, v.version)) && (v.version < 6 || validToolbar(v.toolbar)) && (v.version < 7 || validMpr(v.mpr)) &&
        choices(v.fonts, ['default', 'sans', 'serif', 'mono']) && choices(v.colors, ['default', 'warm', 'cool', 'white']));
    if (!object(body) || Object.keys(body).sort().join(',') !== 'expectedOwner,revision,sizes' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647 ||
        !validAppearance(body.sizes))
      throw new BadRequestException('글자 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const select = (v: any) => ({ version: 1, list: v.list, current: v.current, prior: v.prior });
    const sizes = body.sizes.version === 1 ? select(body.sizes) :
      { ...select(body.sizes), version: body.sizes.version, fonts: select(body.sizes.fonts), colors: select(body.sizes.colors),
        ...(body.sizes.version >= 3 ? { dock: { version: body.sizes.dock.version, placement: body.sizes.dock.placement, panel: body.sizes.dock.panel, ...(body.sizes.version >= 5 ? { autoHide: body.sizes.dock.autoHide } : {}) } } : {}),
        ...(body.sizes.version >= 6 ? { toolbar: { version: 1, order: body.sizes.toolbar.order.slice(), hidden: body.sizes.toolbar.hidden.slice() } } : {}),
        ...(body.sizes.version >= 7 ? { mpr: { version: 1, progressive: body.sizes.mpr.progressive, display: { ...body.sizes.mpr.display }, mouse: { ...body.sizes.mpr.mouse }, sync: { ...body.sizes.mpr.sync } } } : {}),
        ...(body.sizes.version >= 4 ? { viewer: { version: body.sizes.viewer.version, ...Object.fromEntries(['current','prior'].map(role => { const p = body.sizes.viewer[role];
          const copyProfile = (value: any) => ({ size:value.size, font:value.font, color:value.color, name:value.name, date:value.date, description:value.description, position:value.position, fieldPositions:{ name:value.fieldPositions.name, date:value.fieldPositions.date, description:value.fieldPositions.description } });
          return [role, body.sizes.viewer.version === 3 ? { ...copyProfile(p), overrides:Object.fromEntries(Object.keys(p.overrides).map(modality => [modality, copyProfile(p.overrides[modality])])) } : { size:p.size, font:p.font, color:p.color, name:p.name, date:p.date, description:p.description, ...(body.sizes.viewer.version === 2 ? { position:p.position } : {}) }]; })) } } : {}) };
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.readingAppearance.create({ data: { ...owner, revision: 1, sizes } });
        // Check the stored format in the same update as CAS; old clients must not
        // erase fields introduced by a newer display-preference version.
        const changed = await tx.readingAppearance.updateMany({ where: { ...owner, revision: body.revision,
          OR: Array.from({ length: body.sizes.version }, (_, i) => ({ sizes: { path: ['version'], equals: i + 1 } })) },
          data: { sizes, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.readingAppearance.findUnique({ where: { institution_subject: owner } });
      });
      return this.appearanceResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  private workspaceResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      layout: row?.value == null ? null : this.workspaceValue(JSON.parse(row.value)), updatedAt: row?.updatedAt ?? null };
  }

  async workspaceLayout(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.workspaceLayout.findUnique({ where: { institution_subject: owner } });
    return this.workspaceResult(owner, row);
  }

  async writeWorkspaceLayout(body: any, c: Caller, clear: boolean) {
    const owner = this.workspaceOwner(c);
    const fields = clear ? 'expectedOwner,revision' : 'expectedOwner,layout,revision';
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== fields ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('배치 저장 요청 형식이 잘못되었습니다');
    // A stale tab must not write its old account's preferences under a newly logged-in session.
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException({ code: 'WORKSPACE_OWNER_CHANGED', message: '계정이 변경되었습니다. 다시 로그인한 뒤 여세요.' });
    const layout = clear ? null : this.workspaceValue(body.layout);
    const value = clear ? null : JSON.stringify(layout);
    const conflict = () => new ConflictException({ code: 'WORKSPACE_CONFLICT', message: '다른 창에서 서버 배치가 변경되었습니다. 서버 배치를 불러온 뒤 다시 시도하세요.' });
    try {
      const row = await this.prisma.$transaction(async tx => {
        const current = await tx.workspaceLayout.findUnique({ where: { institution_subject: owner } });
        if ((current?.revision ?? 0) !== body.revision) throw conflict();
        // A v1 client can know the latest revision but cannot retain v2 reading
        // settings. CAS ties this version check to the row being replaced.
        if (!clear && current?.value != null && this.workspaceValue(JSON.parse(current.value)).version > layout.version)
          throw conflict();
        if (!current) return tx.workspaceLayout.create({ data: { ...owner, revision: 1, value } });
        const updated = await tx.workspaceLayout.updateMany({ where: { ...owner, revision: body.revision },
          data: { value, revision: { increment: 1 } } });
        if (updated.count !== 1) throw conflict();
        return tx.workspaceLayout.findUnique({ where: { institution_subject: owner } });
      });
      return this.workspaceResult(owner, row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw conflict();
      throw error;
    }
  }

  private columnsResult(owner: { institution: string; subject: string }, row: any) {
    const columns = row?.value == null ? null : normalizeWorklistColumns(JSON.parse(row.value));
    if (row?.value != null && !columns) throw new ServiceUnavailableException('저장된 열 설정 형식을 확인할 수 없습니다');
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      columns, updatedAt: row?.updatedAt ?? null };
  }

  async worklistColumns(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.worklistColumns.findUnique({ where: { institution_subject: owner } });
    return this.columnsResult(owner, row);
  }

  async writeWorklistColumns(body: any, c: Caller, clear: boolean) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join() !== (clear ? 'expectedOwner,revision' : 'columns,expectedOwner,revision') ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('열 설정 저장 요청 형식이 잘못되었습니다');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException({ code: 'COLUMNS_OWNER_CHANGED', message: '계정이 변경되었습니다. 다시 로그인하세요.' });
    const columns = clear ? null : normalizeWorklistColumns(body.columns);
    if (!clear && !columns) throw new BadRequestException('열 설정 형식이 잘못되었습니다');
    const value = clear ? null : JSON.stringify(columns);
    const conflict = () => new ConflictException({ code: 'COLUMNS_CONFLICT', message: '다른 창에서 열 설정이 변경되었습니다. 서버 설정을 다시 확인하세요.' });
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.worklistColumns.create({ data: { ...owner, revision: 1, value } });
        const updated = await tx.worklistColumns.updateMany({ where: { ...owner, revision: body.revision }, data: { value, revision: { increment: 1 } } });
        if (updated.count !== 1) throw conflict();
        return tx.worklistColumns.findUnique({ where: { institution_subject: owner } });
      });
      return this.columnsResult(owner, row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw conflict();
      throw error;
    }
  }

  private async nextTemplateOrd(owner: string) {
    const last = await this.prisma.readingTemplate.findFirst({
      where: { owner }, orderBy: { ord: 'desc' }, select: { ord: true },
    });
    return (last?.ord ?? 0) + 1;
  }

  /** 상용구 저장 (id가 있으면 수정) */
  async saveTemplate(body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 편집');
    const owner = c.actor;
    const title = String(body.title ?? '').trim();
    if (!title) throw new BadRequestException('제목이 필요합니다');
    const data = {
      title,
      shortcut: String(body.shortcut ?? '').trim(),
      modality: String(body.modality ?? '').trim(),
      bodypart: String(body.bodypart ?? '').trim(),
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
      // 새로 만든 건 목록 끝에 붙는다. 0으로 두면 맨 위로 올라가서, 방금 만든 하나가
      // 매일 쓰던 상용구들을 밀어낸다. 순서는 사용자가 정할 것이지 우연히 정해질 게 아니다.
      ord: +body.ord || (body.id ? 0 : await this.nextTemplateOrd(owner)),
    };
    if (body.id) {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0)
        throw new BadRequestException(`잘못된 상용구 id입니다: ${body.id}`);
      const r = await this.prisma.readingTemplate.updateMany({ where: { id, owner }, data });
      if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
      return this.prisma.readingTemplate.findUnique({ where: { id } });
    }
    return this.prisma.readingTemplate.create({ data: { owner, ...data } });
  }

  async deleteTemplate(id: number, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 삭제');   // saveTemplate과 같은 역할 경계
    const r = await this.prisma.readingTemplate.deleteMany({ where: { id, owner: c.actor } });
    if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
    return { ok: true };
  }
}
