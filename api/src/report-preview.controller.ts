import { StudyAccessService } from './study-access.service';
import { Controller, ForbiddenException, Get, Param, Req } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { viewerUid } from './viewer-input';

@Controller()
export class ReportPreviewController {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess:StudyAccessService) {}

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
        report: { version: report?.version ?? 0, rs: state.rs, author: version?.author ?? null,
          repDoc: state.repDoc ?? null, confirm: state.confirm ?? null,
          findings: report?.findings ?? '', conclusion: report?.conclusion ?? '', recommendation: report?.recommendation ?? '' },
        keys: heads.map(head => ({ id: head.id, revision: head.revision, author: head.authorActor, item: head.snapshot })) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }
}
