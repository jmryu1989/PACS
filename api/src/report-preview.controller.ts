import { StudyAccessService } from './study-access.service';
import { Controller, ForbiddenException, Get, Param, Query, Req } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller, PacsService } from './pacs.service';
import { viewerUid } from './viewer-input';
import { CLINICIAN_ROUTE_DENIED, clinicianOnly } from './clinician-policy';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ReportPreviewController {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess:StudyAccessService,
    private pacs: PacsService) {}

  /**
   * S5-U1b clinician reads. They live here, beside the report preview, because both answer "what may this
   * person read of the report"; the controller is already no-store (app.module adminNoStore) and under the
   * StudyAccess interceptor. The worklist route GET studies stays denied for clinician-only.
   */
  @Get('clinician/studies')
  clinicianStudies(@Query() query: any, @Req() req: any) {
    return this.pacs.clinicianStudies(member(req), query);
  }

  /** Final head (approve/addendum at RS A): that row's body and key images. Anything else: status only (S5-F5). */
  @Get('clinician/studies/:uid/report')
  clinicianReport(@Param('uid') uid: string, @Req() req: any) {
    return this.pacs.clinicianReportRead(uid, member(req));
  }

  @Get('studies/:uid/report-preview')
  async read(@Param('uid') uid: string, @Req() caller: any) {
    viewerUid(uid);
    // S5-U1b: this answer carries the body at every RS (T/P/H/W included). clinician-only never reaches it
    // through the guard allowlist; this second line keeps a widened allowlist from turning it into a
    // non-final body for clinicians. Their read is GET clinician/studies/:uid/report.
    if (clinicianOnly(caller.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });
    // Same read rule as PacsService.visible()/versions(): owner or current
    // tele grant, and the P author/reviewer pair. A hold only restricts writes.
    // patchState clears teleInstitutionId when the owner cancels the referral;
    // Connect transfer records do not grant report visibility.
    const allowed = (state: any) => {
      if (caller.kind !== 'member' || !caller.sub || !caller.actor || !caller.institution || !state ||
          (state.institutionId !== caller.institution && state.teleInstitutionId !== caller.institution) ||
          (state.rs === 'P' && state.preDoc !== caller.actor && state.preReviewer !== caller.actor))
        throw new ForbiddenException('판독문 미리보기에 접근할 수 없습니다');
    };
    allowed(await this.prisma.studyState.findUnique({ where: { uid } }));
    await this.studyAccess.require(caller,[uid]);
    const original = await this.orthanc.reportPreviewStudy(uid);
    // Fetch DICOM outside the database transaction; then bind the current
    // permission, report version, patient overlay and key revisions together.
    return this.prisma.$transaction(async tx => {
      const state = await tx.studyState.findUnique({ where: { uid } });
      allowed(state);
      await this.studyAccess.require(caller,[uid],tx);
      const report = await tx.report.findUnique({ where: { uid } });
      const version = report ? await tx.reportVersion.findUnique({ where: { uid_version: { uid, version: report.version } } }) : null;
      const heads = await tx.viewerItem.findMany({ where: { studyUid: uid, hidden: false,
        snapshot: { path: ['kind'], equals: 'key' } }, orderBy: { id: 'asc' }, take: 513 });
      if (heads.length > 512) throw new ForbiddenException('키 이미지 목록 한도를 초과했습니다');
      const tag = (key: string) => OrthancService.tag(original, key);
      const study: Record<string, string> = { uid, id: tag('00100020'), name: tag('00100010').replace(/\^/g, ' '),
        birth: tag('00100030'), sex: tag('00100040'), date: tag('00080020'), acc: tag('00080050'),
        desc: tag('00081030'), modality: original['00080061']?.Value?.join(',') ?? '' };
      let overlay: any; try { overlay = JSON.parse(state.ov || '{}'); } catch { overlay = {}; }
      for (const key of ['id', 'name', 'birth', 'sex', 'date', 'acc', 'desc', 'modality'])
        if (typeof overlay?.[key] === 'string') study[key] = overlay[key];
      return { study, actor: caller.actor, canPreviewEditor: ['radiologist', 'admin'].some(role => caller.roles?.includes(role)),
        // The head version's own action: output must name an addendum instead of
        // reading as an ordinary approved save. It comes from the row already
        // read above, so this adds no query, no gate and no history field.
        report: { version: report?.version ?? 0, rs: state.rs, action: version?.action ?? null, author: version?.author ?? null,
          repDoc: state.repDoc ?? null, confirm: state.confirm ?? null,
          findings: report?.findings ?? '', conclusion: report?.conclusion ?? '', recommendation: report?.recommendation ?? '' },
        keys: heads.map(head => ({ id: head.id, revision: head.revision, author: head.authorActor, item: head.snapshot })) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }
}
