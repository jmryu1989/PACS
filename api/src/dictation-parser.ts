import { asrConfiguration } from './asr.service';

/** Before Nest's JSON parser: bounded streaming collection only on this route. */
export function dictationParser() {
  const raw = require('express').raw;
  return (req: any, res: any, next: () => void) => {
    if (!/^\/api\/studies\/[^/]+\/dictation\/?$/i.test(String(req.originalUrl ?? '').split('?')[0])) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return next();
    const fail = (status: number, code: string) => {
      // Preserve the global guard and report refusal ordering even for invalid audio.
      // body-parser 1.20.4 uses _body to skip subsequent JSON/urlencoded parsers.
      req._body = true;
      req.body = Buffer.alloc(0);
      req.dictationError = { status, code };
      next();
    };
    // Do not inflate compressed content or let JSON/urlencoded parsers buffer this path.
    if (!/^audio\/wav(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '') ||
        (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity'))
      return fail(400, 'DICTATION_AUDIO_INVALID');
    const maxBytes = asrConfiguration().maxBytes;
    raw({ type: () => true, limit: maxBytes, inflate: false })(req, res, (error: any) => {
      if (error) return fail(error.type === 'entity.too.large' ? 413 : 400,
        error.type === 'entity.too.large' ? 'DICTATION_AUDIO_TOO_LARGE' : 'DICTATION_AUDIO_INVALID');
      next();
    });
  };
}
