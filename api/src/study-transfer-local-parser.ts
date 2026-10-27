/**
 * Before Nest's JSON/urlencoded parsers (registered beside dictationParser in main.ts): the one exact member import route
 * takes its body raw, and only as application/dicom without a content encoding (contract S9-U4p 6, U4P-02).
 * A refusal is recorded on the request and answered by the route after the global guard, so an unauthenticated request
 * still meets 401 first. Every other path, method or alias is left to the existing parsers (and to nginx's 2m /api/).
 */

export function studyTransferLocalParser() {
  const raw = require('express').raw;
  return (req: any, res: any, next: () => void) => {
    if (req.method !== 'POST' || !/^\/api\/dicom-import$/i.test(String(req.originalUrl ?? '').split('?')[0])) return next();
    const fail = (status: number, code: string) => {
      // body-parser 1.20 skips a request whose _body is set: no JSON/urlencoded parser buffers this path either.
      req._body = true;
      req.body = Buffer.alloc(0);
      req.dicomImportError = { status, code };
      next();
    };
    const encoding = req.headers['content-encoding'];
    if (!/^application\/dicom(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')
        || (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity'))
      return fail(415, 'IMPORT_CONTENT_TYPE_UNSUPPORTED');
    raw({ type: () => true, limit: Infinity, inflate: false })(req, res, (error: any) => {
      if (error) return fail(error.type === 'entity.too.large' ? 413 : 400,
        error.type === 'entity.too.large' ? 'DICOM_IMPORT_TOO_LARGE' : 'IMPORT_REQUEST_INVALID');
      next();
    });
  };
}
