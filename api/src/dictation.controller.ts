import { Controller, Post, Param, Req, Res, HttpCode } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsrService, dictationError } from './asr.service';
import { PacsService, Caller } from './pacs.service';
import { inspectDictationWav } from './dictation-audio';

/** req.close also fires after a normal completed body; it is not a cancellation signal. */
export function dictationDisconnect(req: IncomingMessage, res: ServerResponse) {
  const abort = new AbortController();
  const lostUpload = () => abort.abort();
  const lostResponse = () => { if (!res.writableEnded) abort.abort(); };
  req.once('aborted', lostUpload);
  res.once('close', lostResponse);
  if (req.aborted || res.destroyed) abort.abort();
  return { signal: abort.signal, cleanup() {
    req.removeListener('aborted', lostUpload);
    res.removeListener('close', lostResponse);
  } };
}

@Controller('studies')
export class DictationController {
  constructor(private pacs: PacsService, private asr: AsrService) {}

  @Post(':uid/dictation')
  @HttpCode(200)
  async dictate(@Param('uid') uid: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const caller: Caller = { sub: req.sub, actor: req.actor, roles: req.roles ?? [],
      institution: req.institution ?? null, kind: req.kind ?? 'member' };
    const channel = dictationDisconnect(req, res);
    try {
      await this.pacs.dictationGate(uid, caller);
      const started = Date.now();
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const audio = inspectDictationWav(bytes, this.asr.capability().maxBytes);
      let outcome = 'DICTATION_ENGINE_FAILED';
      try {
        if (req.dictationError) throw dictationError(req.dictationError.code, req.dictationError.status);
        if (audio.ok === false) throw dictationError(audio.reason === 'too-large' ? 'DICTATION_AUDIO_TOO_LARGE' : 'DICTATION_AUDIO_INVALID', audio.reason === 'too-large' ? 413 : 400);
        const result = await this.asr.transcribe(bytes, channel.signal);
        // Recheck the existing refusal helpers after inference. No report mutation occurs.
        await this.pacs.dictationGate(uid, caller);
        if (channel.signal.aborted) throw dictationError('DICTATION_ENGINE_FAILED');
        outcome = 'success';
        return result;
      } catch (error) {
        const code = error?.getResponse?.()?.code;
        if (typeof code === 'string' && /^DICTATION_[A-Z_]+$/.test(code)) outcome = code;
        throw error;
      } finally {
        await this.pacs.dictationAudit(uid, caller, { bytes: bytes.length, seconds: audio.ok ? audio.seconds : 0,
          ms: Date.now() - started, engine: this.asr.capability().enginePin, outcome });
      }
    } finally { channel.cleanup(); }
  }
}
