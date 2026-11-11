/**
 * FC-076: before Nest's JSON/urlencoded parsers (registered beside studyTransferLocalParser in main.ts), the one exact
 * attach route takes its body raw: one file of at most 20 MB, or 64 MB declared as PNG (a JPG the page redrew as PNG can
 * outgrow the file chosen; what the body is, PNG or not, is still decided from its first bytes). A refusal is recorded on the request and answered by the
 * route after the global guard, so an unauthenticated request still meets 401 first. The file's kind is decided by the
 * service from its first bytes; this parser only bounds the body. Every other path or method is left as it was.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_PNG_MAX_BYTES, declaredFormat } from './study-attachment';

export const ATTACH_ROUTE = /^\/api\/studies\/[^/]+\/attachments$/i;

export function studyAttachmentParser() {
  const raw = require('express').raw;
  return (req: any, res: any, next: () => void) => {
    if (req.method !== 'POST' || !ATTACH_ROUTE.test(String(req.originalUrl ?? '').split('?')[0])) return next();
    const fail = (status: number) => {
      // body-parser skips a request whose _body is set: no JSON/urlencoded parser buffers this path either.
      req._body = true;
      req.body = Buffer.alloc(0);
      req.attachmentError = status;
      next();
    };
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') return fail(415);
    const png = declaredFormat(req.headers['content-type']) === 'png';
    if (png) req.attachmentPng = true;
    raw({ type: () => true, limit: png ? ATTACHMENT_PNG_MAX_BYTES : ATTACHMENT_MAX_BYTES, inflate: false })(req, res, (error: any) => {
      if (error) return fail(error.type === 'entity.too.large' ? 413 : 400);
      next();
    });
  };
}
