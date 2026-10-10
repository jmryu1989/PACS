/*
 * 판독 점유 선언·하트비트·해제·관리자 강제 해제. 다른 사람의 살아 있는 점유는 막지 않고 알린다(확정은 REPORT_HELD로 거절).
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary } from '../preliminary-reader';
import type { StudyAccessService } from '../study-access.service';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { noteTransactionError, holdAlive } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';

export class PacsHold {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess) {}

  /**
   * 판독문 점유 선언 / 하트비트.
   *
   * 점유는 **열람이 아니라 쓰기**로 시작한다(프론트가 두 글자 이상 입력했을 때 부른다).
   * 검사를 열어보는 건 흔한 일이라 그걸 점유로 치면 경고가 남발되고, 남발된 경고는 무시된다.
   * (HPACS도 2021년에 이 기준으로 바꿨다 — 교훈 §2)
   *
   * 이미 다른 사람이 살아 있는 점유를 갖고 있으면 **막지 않고 알려준다.**
   * 응급 판독을 자물쇠로 막는 건 위험하다. 실제 충돌은 저장 시점의 버전 비교가 잡는다.
   *
   * 원격판독으로 넘어간 검사는 두 기관의 판독의가 동시에 열 수 있다 —
   * 점유가 기관을 넘어 보여야 하는 이유가 여기 있다.
   */
  async hold(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 점유');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c,[uid],tx);
      const rows=await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid=${uid} FOR UPDATE`;
      const prev=rows[0];
      if(!prev||!this.access.visible(prev,inst(c)))throw new NotFoundException('검사를 찾을 수 없습니다');
      if(prev.ss==='Unverified'&&prev.em!=='E')throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
      if(!canReadPreliminary(prev,c))throw new ForbiddenException('예비 판독(RS: P) 중인 검사입니다');
      const other=holdAlive(prev)&&prev.holder!==c.actor?prev.holder:null;
      if(!other){
        await tx.studyState.update({where:{uid},data:{holder:c.actor,heldAt:new Date()}});
        if(!holdAlive(prev))await tx.auditLog.create({data:{actor:c.actor,action:'report.hold',target:uid}});
      }
      return {holder:other??c.actor,mine:!other,conflict:!!other};
    },{maxWait:4000,timeout:8000}).catch(noteTransactionError);
  }

  /** 점유 해제 (검사를 옮기거나 판독을 확정할 때) */
  async release(uid: string, c: Caller) {
    return this.access.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'radiologist', '판독문 점유 해제');   // hold와 같은 역할 경계
    const prev = await this.access.gate(uid,c,tx);
    if (!prev || prev.holder !== c.actor) return { ok: true };   // 내 것이 아니면 건드리지 않는다
    await tx.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    return { ok: true };
    });
  }

  async forceRelease(uid: string, c: Caller) {
    return this.access.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'admin', '판독 점유 강제 해제');
    const prev = await this.access.gate(uid,c,tx);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    await tx.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    // 점유가 없었어도 관리자 조치의 호출 흔적은 남긴다.
    await audit(c.actor, 'hold.force-release', uid, {
      by: inst(c), holder: prev.holder ?? null, heldAt: prev.heldAt ?? null, alive: holdAlive(prev),
    });
    return { ok: true, released: prev.holder ?? null };
    });
  }
}
