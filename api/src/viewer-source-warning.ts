import { Logger, ServiceUnavailableException } from '@nestjs/common';

export type ViewerSourceFailure = 'http_401' | 'http_404' | 'http_other' | 'missing_body' |
  'size_limit' | 'decode' | 'parse' | 'parent_abort' | 'timeout' | 'transport' |
  'unexpected' | 'reference_invalid' | 'digest_mismatch' | 'page_deadline';

const logger = new Logger('ViewerSource');
const lastWarning = new Map<ViewerSourceFailure, number>();

// Only fixed categories reach the logger: never an exception, URL, UID, tag,
// response body or credential. The finite category set also bounds memory.
export function warnViewerSource(category: ViewerSourceFailure) {
  const now = performance.now(), previous = lastWarning.get(category);
  if (previous !== undefined && now - previous < 30000) return;
  lastWarning.set(category, now);
  logger.warn('viewer_source category=' + category);
}

export class ViewerSourceUnavailable extends ServiceUnavailableException {
  constructor() { super('원본 영상 참조를 확인할 수 없습니다'); }
}
