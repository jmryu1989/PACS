import { Controller, ForbiddenException, Get, Header, Req } from '@nestjs/common';
import { PreloadKeyService } from './preload-key.service';

@Controller()
export class PreloadKeyController {
  constructor(private readonly keys: PreloadKeyService) {}

  @Get('preload/cache-key')
  @Header('Cache-Control', 'no-store')
  read(@Req() req: any) {
    // The ordinary guard has already checked the cookie's X-KIN-Session binding.
    if (req.authMethod !== 'session' || !req.sessionId) throw new ForbiddenException('로그인 세션이 필요합니다');
    return this.keys.issue({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
      institution: req.institution ?? null, kind: req.kind });
  }
}
