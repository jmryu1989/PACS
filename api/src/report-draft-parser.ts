/**
 * Image Report: before Nest's JSON parser (registered beside the other route parsers in main.ts), the draft write
 * (PUT /api/studies/:uid/report) is parsed as JSON with room for one attached drawing - its PNG (at most 1.2 MB, base64)
 * and strokes (at most 256 KB) - within the proxy's 2 MB for /api/. Every other path or method is left as it was, and
 * the draft write's own checks (owner, revision, snapshot, the drawing's shape and limits) are unchanged.
 */
export const REPORT_DRAFT_ROUTE = /^\/api\/studies\/[^/]+\/report$/i;
export const REPORT_DRAFT_BODY_LIMIT = 2 * 1024 * 1024;

export function reportDraftParser() {
  const json = require('express').json({ limit: REPORT_DRAFT_BODY_LIMIT });
  return (req: any, res: any, next: () => void) => {
    if (req.method !== 'PUT' || !REPORT_DRAFT_ROUTE.test(String(req.originalUrl ?? '').split('?')[0])) return next();
    json(req, res, next);
  };
}
