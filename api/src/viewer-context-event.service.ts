import { ForbiddenException, Injectable } from '@nestjs/common';
import { Caller, PacsService } from './pacs.service';
import { PrismaService } from './prisma.service';
import { viewerContextEvent, viewerUid } from './viewer-input';

@Injectable()
export class ViewerContextEventService {
  constructor(private prisma: PrismaService, private pacs: PacsService) {}

  async record(uid: string, raw: Buffer, c: Caller) {
    if (c.kind !== 'member' || !c.institution || !c.sub ||
        !c.roles.some(role => ['radiologist', 'technician', 'admin', 'clinician'].includes(role)))
      throw new ForbiddenException('회원 뷰어 전용입니다');
    viewerUid(uid);
    const event = viewerContextEvent(raw);
    // The image-read gate enforces institution, tele-institution and StudyAccess.
    await this.pacs.authzDicom('/dicom-web/studies/' + uid, 'GET', c);
    const receivedAt = new Date();
    await this.prisma.auditLog.create({ data: {
      actor: c.actor, action: 'viewer-context.event', target: uid,
      detail: JSON.stringify({ ...event, institution: c.institution, subject: c.sub, receivedAt: receivedAt.toISOString() }),
    } });
    return { recorded: true, eventId: event.eventId, receivedAt: receivedAt.toISOString() };
  }
}
