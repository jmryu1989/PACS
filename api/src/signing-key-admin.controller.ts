import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException,
  Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { ContractError } from './emr-contract/validation';
import { EMR_SIGNING_KEY_ADMIN, SigningKeyAdmin } from './emr-clinical/startup';
import { OnlineSigningStore } from './emr-report/online-store';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestWorkContext } from './emr-runtime/request-context';
import { PrismaService } from './prisma.service';

const ACTIONS = ['provision', 'replace', 'revoke'] as const;
const KID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The administrator's entry to the C2 online approval keys (D1770: one server-held key per doctor). Every change goes
 * through the existing ServerKeys.manage: it re-checks the operator inside the transaction, locks the doctor, checks
 * the doctor's current clinical rights and records server:doctor-key-management in the same B2 transaction. This
 * controller adds no authority of its own and never touches private material; doctors keep approving with no new step.
 */
@Controller()
export class SigningKeyAdminController {
  constructor(private readonly prisma: PrismaService,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(EMR_SIGNING_KEY_ADMIN) private readonly keys: SigningKeyAdmin) {}

  @Get('admin/users/:id/signing-key')
  read(@Param('id') id: string, @Req() req: any) {
    return this.requests.withWork(req, async request => {
      const institution = await this.operator(request), member = await this.member(id);
      // A read never enrolls the member's identity; none means no key was ever issued.
      const [row] = await this.prisma.$queryRaw<{ id: string | null }[]>`
        SELECT emr_access.existing_member_identity(${request.facts.issuer}::text, ${member}::text)::text AS id`;
      return this.view(institution, member, row?.id ?? null);
    });
  }

  @Post('admin/users/:id/signing-key')
  change(@Param('id') id: string, @Body() body: unknown, @Req() req: any) {
    return this.requests.withWork(req, async request => {
      const institution = await this.operator(request), member = await this.member(id), command = parse(body);
      // The member is known to this deployment; the identity binding is the one their own login resolves.
      const doctorId = await request.work.resolveRequestIdentity(request.facts.issuer, member);
      try {
        await this.keys.manage(request, { ...command, institutionId: institution, doctorId });
      } catch (error) { refusal(error); }
      return this.view(institution, member, doctorId);
    });
  }

  private async operator(request: RequestWorkContext): Promise<string> {
    await request.requireCurrent();
    const { roles, institution } = request.facts;
    if (!roles.includes('admin') || !institution) throw new ForbiddenException('소속 기관의 서명키 관리는 admin 권한이 필요합니다.');
    return institution;
  }

  private async member(id: string): Promise<string> {
    const row = typeof id === 'string' && id.length <= 512 ? await this.prisma.memberRights.findUnique({ where: { sub: id } }) : null;
    if (!row) throw new NotFoundException('회원을 찾을 수 없습니다.');
    return row.sub;
  }

  /** Public registrations only, newest first: the admin sees which key approvals use now and which ended. */
  private async view(institutionId: string, subject: string, doctorId: string | null) {
    const keys = doctorId ? await new OnlineSigningStore().doctorKeys(this.prisma, institutionId, doctorId) : [];
    return { subject, institutionId, current: keys.find(key => key.status === 'active')?.kid ?? null,
      keys: keys.map(key => ({ kid: key.kid, status: key.status, registeredAt: key.registeredAt, endedAt: key.endedAt })) };
  }
}

function parse(body: unknown): { action: typeof ACTIONS[number]; expectedKid: string | null; reason: string } {
  const value = body as Record<string, unknown>;
  const invalid = () => new BadRequestException('서명키 작업·현재 키·사유를 확인하세요.');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'action,expectedKid,reason') throw invalid();
  const { action, expectedKid, reason } = value;
  if (!ACTIONS.includes(action as typeof ACTIONS[number]) || (action === 'provision') !== (expectedKid === null) ||
      (expectedKid !== null && (typeof expectedKid !== 'string' || !KID.test(expectedKid))) ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || /[\x00-\x1f\x7f]/.test(reason)) throw invalid();
  return { action: action as typeof ACTIONS[number], expectedKid: expectedKid as string | null, reason };
}

/** manage() refuses with contract codes; the page needs an HTTP class and a message it can act on. */
function refusal(error: unknown): never {
  const custody = ['WrappingSecretPathRequired', 'WrappingSecretUnavailable', 'ServerWrappingKeyRequired'];
  if (error instanceof ContractError) {
    const body = (message: string) => ({ code: error.code, message });
    if (['KeyManagementConflict', 'KeyAlreadyRevoked', 'KeyDoctorMismatch'].includes(error.code))
      throw new ConflictException(body('서명키 상태가 바뀌었습니다. 다시 불러온 뒤 확인하세요.'));
    if (error.code === 'DoctorRegistrationRequired')
      throw new ForbiddenException(body('현재 소속 기관의 임상 기록 권한이 있는 회원만 서명키를 받을 수 있습니다.'));
    if (error.code === 'KeyCustodianRequired') throw new ForbiddenException(body('소속 기관의 서명키 관리는 admin 권한이 필요합니다.'));
    if (custody.includes(error.code)) throw new ServiceUnavailableException(body('서명키 보관 파일 설정을 확인하세요.'));
    throw new ServiceUnavailableException(body('서명키를 변경하지 못했습니다. 다시 불러온 뒤 확인하세요.'));
  }
  // A configured custody path the API cannot read is a deployment fact, not an unknown server failure.
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && ['ENOENT', 'EACCES', 'EISDIR'].includes(code))
    throw new ServiceUnavailableException({ code: 'WrappingSecretUnavailable', message: '서명키 보관 파일 설정을 확인하세요.' });
  throw error;
}
