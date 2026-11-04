import { Controller, Get, Header } from '@nestjs/common';
import { Public } from './auth.guard';
import { PRODUCT_FACTS } from './product-info-data';

const REVISION = /^[0-9a-f]{40}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * CD-01: the build facts of this API for the Product Information panel. The revision is the image's VCS_REF (the same
 * build argument as its org.opencontainers.image.revision label) and the tag is KIN_BUILD_TAG, the one tag that points
 * at that commit; a missing or malformed value is null, never "unknown" or a nearby tag. factsDigest and
 * productVersion come from config/product-info.json through the generated product-info-data.ts, so a page served from
 * another build reads Mismatch. Public like health: it carries no account, patient, path or environment beyond these.
 */
export function buildFacts(env: NodeJS.ProcessEnv = process.env) {
  const revision = env.KIN_BUILD_REVISION ?? '';
  const tag = env.KIN_BUILD_TAG ?? '';
  return {
    schema: 1,
    factsDigest: PRODUCT_FACTS.factsDigest,
    productVersion: { status: PRODUCT_FACTS.productVersion.status, value: PRODUCT_FACTS.productVersion.value },
    build: { revision: REVISION.test(revision) ? revision : null, tag: REVISION.test(revision) && TAG.test(tag) ? tag : null },
  };
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
