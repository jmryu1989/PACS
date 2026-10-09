/*
 * 역할(need·needExact)·소속 기관(inst)·기관 경계(visible)와 쓰기 관문(gate·scopeWrite), 내 초안 한 건(myDraft).
 * AGENTS §1의 서버 강제 지점이다. 다른 concern은 이 판정을 다시 만들지 않고 이 객체를 부른다 — 관문이 두 벌이면
 * 한쪽만 고쳐지는 날이 온다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { noteTransactionError, dump } from './values';

/**
 * 호출자. 다섯 필드 모두 **서명된 토큰**과 가드 판정에서 나온다 — 클라이언트가 정할 수 없다.
 *  sub         KC 사용자 ID    (세션 일괄 폐기 키)
 *  actor       누구인가        (감사로그)
 *  roles       무엇을 할 수 있나 (판독의/기사)
 *  institution 어디 소속인가    (어떤 데이터를 볼 수 있나)  ← 이번 작업에서 추가
 *  kind        사람인가 gateway인가 (허용되는 API 면)
 */
export interface Caller {
  sub: string;
  actor: string;
  roles: string[];
  institution: string | null;
  kind: 'member' | 'gateway';
}

/**
 * 역할 검사. HPACS의 Radiology / Technician 두 탭이 그냥 화면 분리가 아니라
 * 권한 분리라는 것이 핵심 — 방사선사는 검사를 확인(Verify)하고 오더를 매칭하지만
 * 판독문을 승인하지 않는다. 판독의는 그 반대다.
 * admin은 둘 다 할 수 있다(개발·운영 편의).
 */
export function need(roles: string[], role: string, what: string) {
  if (!roles?.includes(role) && !roles?.includes('admin'))
    throw new ForbiddenException(`${what}은(는) ${role} 권한이 필요합니다`);
}

/** Gateway 라우트에는 admin 예외가 없다. 신원 종류와 전용 역할이 모두 맞아야 한다. */
export function needExact(c: Caller, role: string, what: string) {
  if (c.kind !== 'gateway' || !c.roles?.includes(role))
    throw new ForbiddenException(`${what}은(는) ${role} 전용입니다`);
}

/**
 * 소속 기관 확인.
 *
 * **admin에게도 예외를 주지 않는다.** 역할(role)은 "무엇을 할 수 있는가"이고
 * 기관은 "무엇을 볼 수 있는가"다. 둘은 다른 축이라, admin이라고 남의 병원 환자를
 * 보게 하면 그건 편의가 아니라 구멍이다. 운영자용 전역 조회가 정말 필요해지면
 * 그때 별도 경로로 만들고 감사로그를 남긴다.
 *
 * 기관이 비어 있으면 조용히 빈 목록을 주지 않고 **소리 내어 막는다.**
 * 매퍼 설정이 틀렸을 때 "검사가 하나도 없네" 로 보이면 그게 최악이다.
 */
export function inst(c: Caller): string {
  if (!c.institution)
    throw new ForbiddenException(
      '소속 기관이 없는 계정입니다. Keycloak에서 이 사용자를 기관 그룹에 넣어주세요.');
  return c.institution;
}

export class PacsAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService) {}

  /**
   * 이 검사를 이 기관이 다룰 수 있는가.
   *  - 소유 기관이면 된다
   *  - 원격판독을 받은 기관이어도 된다  ← **기관 경계를 넘는 유일한 통로**
   */
  visible(s: any, institution: string) {
    return s.institutionId === institution || s.teleInstitutionId === institution;
  }

  /** 쓰기 전 관문. 없는 검사와 남의 검사는 같은 메시지로 막는다(존재 여부도 정보다). */
  /**
   * 내 초안 한 건. **모든 `toClient` 호출이 이걸 실어야 한다.**
   *
   * 안 실으면 `draft: null`이 나가고, 클라이언트의 `{...기존, ...응답}`이
   * 방금 쓰고 있던 초안을 지운다 — 점유 하트비트나 Verify 한 번에 화면의 판독문이
   * 사라지는 것이다. §14("비움도 값이다")의 정확히 반대편 함정이고,
   * 같은 실수를 `holder`에서 한 번, `toClient`의 7개 필드에서 또 했다.
   */
  myDraft(uid: string, actor: string, db:any=this.prisma) {
    return db.reportDraft.findUnique({ where: { uid_author: { uid, author: actor } } });
  }

  async scopeWrite<T>(uid:string,c:Caller,work:(tx:Prisma.TransactionClient,audit:(actor:string,action:string,target:string,detail?:any)=>Promise<any>)=>Promise<T>):Promise<T> {
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c,[uid],tx);
      const audit=(actor:string,action:string,target:string,detail?:any)=>tx.auditLog.create({data:{actor:actor||'unknown',action,target,detail:dump(detail)}});
      return work(tx,audit);
    },{maxWait:4000,timeout:8000}).catch(noteTransactionError);
  }

  async gate(uid: string, c: Caller, db:any=this.prisma) {
    const me = inst(c);
    const s = await db.studyState.findUnique({ where: { uid } });
    if (s && !this.visible(s, me))
      throw new NotFoundException('검사를 찾을 수 없습니다');
    if(s)await this.studyAccess.require(c,[uid],db===this.prisma?undefined:db);
    return s;
  }
}
