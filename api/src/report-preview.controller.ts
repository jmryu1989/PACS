import { canReadPreliminary } from './preliminary-reader';
import { StudyAccessService } from './study-access.service';
import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Req } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller, PacsService } from './pacs.service';
import { viewerUid } from './viewer-input';
import { refuseDestroyed } from './pacs/values';
import { LocalReadResponse } from './emr-viewing/local-read';
import { consumerSource, viewerSources } from './emr-viewing/consumer-read';
import { prepareExamRead, resolveExamScope, scopeIncludesSeries, examScopeView, examScopeChanged, examParentAccess } from './exam-merge.service';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ReportPreviewController {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess:StudyAccessService,
    private pacs: PacsService) {}

  /**
   * S5-U1b clinician reads. They live here, beside the report preview, because both answer "what may this
   * person read of the report"; the controller is already no-store (main.ts API middleware). The worklist and preview also admit clinician readers under the same Preliminary rule.
   */
  @Get('clinician/studies')
  clinicianStudies(@Query() query: any, @Req() req: any) {
    return this.pacs.clinicianStudies(member(req), query);
  }

  /** Final head (approve/addendum at RS A): that row's body and key images. Anything else: status only (S5-F5). */
  @Get('clinician/studies/:uid/report')
  clinicianReport(@Param('uid') uid: string, @Req() req: any) {
    return this.pacs.clinicianReportRead(uid, member(req),req.query?.version);
  }

  /**
   * S5-U3 patient timeline: the listed studies with the anchor's server patient key, paged (limit required, after verbatim).
   * Here with the other clinician reads; pacs.controller.ts stays pinned.
   */
  @Get('clinician/studies/:uid/timeline')
  clinicianTimeline(@Param('uid') uid: string, @Query() query: any, @Req() req: any) {
    return this.pacs.clinicianTimeline(uid, member(req), query);
  }

  @Get('studies/:uid/report-preview')
  async read(@Param('uid') uid: string, @Req() caller: any) {
    viewerUid(uid);
    // Same read rule as PacsService.visible()/versions(): owner or current
    // tele grant, and the P author/reviewer pair. A hold only restricts writes.
    // patchState clears teleInstitutionId when the owner cancels the referral;
    // Connect transfer records do not grant report visibility.
    const allowed = (state: any) => {
      if (caller.kind !== 'member' || !caller.sub || !caller.actor || !caller.institution || !state ||
          (state.institutionId !== caller.institution && state.teleInstitutionId !== caller.institution) ||
          !canReadPreliminary(state, caller))
        throw new ForbiddenException('판독문 미리보기에 접근할 수 없습니다');
    };
    const state = await this.prisma.studyState.findUnique({ where: { uid } });
    allowed(state);
    // After the study's own access policy: a user it refuses keeps that answer, not the report's state.
    await prepareExamRead(this.prisma,this.studyAccess,caller,uid);
    await examParentAccess(this.prisma,this.studyAccess,caller,uid);
    refuseDestroyed(state);
    const query=caller.query??{};
    if(query.version!==undefined&&(!/^[1-9]\d*$/.test(String(query.version))||!Number.isSafeInteger(Number(query.version))))throw new BadRequestException('판 번호를 확인하세요');
    if(query.draft!==undefined&&query.draft!=='1'||query.draft&&query.version!==undefined)throw new BadRequestException('미리보기 대상을 하나만 선택하세요');
    const selected=async(db:any)=>query.draft?db.reportDraft.findUnique({where:{uid_author:{uid,author:caller.actor}}})
      :query.version!==undefined?db.reportVersion.findUnique({where:{uid_version:{uid,version:Number(query.version)}}}):db.report.findUnique({where:{uid}});
    const initial=await selected(this.prisma);
    if((query.draft&&!initial?.present||query.version!==undefined&&!initial))throw new BadRequestException('미리보기 대상을 찾을 수 없습니다');
    const before=await resolveExamScope(this.prisma,this.studyAccess,caller,{uid,purpose:initial?'stored':'current',...(initial?{record:initial}:{})});
    const original = await this.orthanc.reportPreviewStudy(before.sources[0].studyUid);
    // Fetch DICOM outside the database transaction; then bind the current
    // permission, report version, patient overlay and key revisions together.
    return this.prisma.$transaction(async tx => {
      const state = await tx.studyState.findUnique({ where: { uid } });
      allowed(state);
      const report = await selected(tx);
      if(query.draft&&!report?.present)throw examScopeChanged();
      const scope=await resolveExamScope(tx,this.studyAccess,caller,{uid,purpose:report?'stored':'current',...(report?{record:report}:{}),prepared:before});
      if(query.generation!==undefined&&query.generation!==scope.generation)throw examScopeChanged();
      const version = report?.version ? await tx.reportVersion.findUnique({ where: { uid_version: { uid, version: report.version } } }) : null;
      const candidates = await tx.viewerItem.findMany({ where: { studyUid: {in:scope.studies}, hidden: false,
        snapshot: { path: ['kind'], equals: 'key' } }, orderBy: { id: 'asc' } });
      const heads=candidates.filter(head=>scopeIncludesSeries(scope,head.studyUid, (head.snapshot as any)?.seriesUid));
      if (heads.length > 512) throw new ForbiddenException('키 이미지 목록 한도를 초과했습니다');
      const tag = (key: string) => OrthancService.tag(original, key);
      const study: Record<string, string> = { uid, id: tag('00100020'), name: tag('00100010').replace(/\^/g, ' '),
        birth: tag('00100030'), sex: tag('00100040'), date: tag('00080020'), acc: tag('00080050'),
        desc: tag('00081030'), modality: original['00080061']?.Value?.join(',') ?? '' };
      let overlay: any; try { overlay = JSON.parse(state.ov || '{}'); } catch { overlay = {}; }
      for (const key of ['id', 'name', 'birth', 'sex', 'date', 'acc', 'desc', 'modality'])
        if (typeof overlay?.[key] === 'string') study[key] = overlay[key];
      const body = { study, scope:examScopeView(scope), draft:!!query.draft, actor: caller.actor, canPreviewEditor: ['radiologist', 'admin'].some(role => caller.roles?.includes(role)),
        // The head version's own action: output must name an addendum instead of
        // reading as an ordinary approved save. It comes from the row already
        // read above, so this adds no query, no gate and no history field.
        report: { scope:examScopeView(scope), version: report?.version ?? 0, rs: state.rs, action: version?.action ?? null, author: version?.author ?? null,
          repDoc: state.repDoc ?? null, confirm: state.confirm ?? null,
          findings: report?.findings ?? '', conclusion: report?.conclusion ?? '', recommendation: report?.recommendation ?? '' },
        keys: heads.map(head => ({ id: head.id, revision: head.revision, sourceUid:head.studyUid, author: head.authorActor, item: head.snapshot })) };
      const identity = { sourcePatientId: tag('00100020') || null, sourceInstitution: tag('00080080') || null };
      const sources = [consumerSource('study-metadata', uid, state.institutionId, uid, null, ['study'], identity),
        ...viewerSources(uid, state.institutionId, body.keys, ['keys'], identity)];
      if (report) sources.push(consumerSource(query.draft?'private-draft':query.version?'report-version':'report-head', uid, state.institutionId,
        query.draft?JSON.stringify([uid,caller.actor]):query.version?String(report.id):uid, query.draft?report.revision:report.version, ['report'], identity));
      return new LocalReadResponse(body, sources);
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }
}
