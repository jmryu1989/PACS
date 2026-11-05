import { Controller, Get, Header } from '@nestjs/common';
import { Public } from './auth.guard';

const REVISION = /^[0-9a-f]{40}$/;

/**
 * CD-01: the build commit of this API for the Product Information panel, which shows it as given. It is the image's
 * VCS_REF (the same build argument as its org.opencontainers.image.revision label); a missing or malformed value
 * (the Dockerfile's default "unknown") is null, so the panel says unknown instead of a made-up commit. Public like
 * health: it carries no account, patient, path or environment beyond this.
 */
export function buildFacts(env: NodeJS.ProcessEnv = process.env) {
  const revision = env.KIN_BUILD_REVISION ?? '';
  return { schema: 1, build: { revision: REVISION.test(revision) ? revision : null } };
}

@Controller()
export class ProductInfoController {
  @Public()
  @Get('version')
  @Header('Cache-Control', 'no-store')
  version() {
    return buildFacts();
  }
}
