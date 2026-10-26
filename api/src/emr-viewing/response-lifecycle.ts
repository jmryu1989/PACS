import { StreamableFile } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export const LOCAL_READ_UNAVAILABLE = Object.freeze({ code: 'EMR_VIEWING_UNAVAILABLE',
  message: '열람 기록을 저장하지 못했습니다. 잠시 후 다시 시도하세요.' });

/** One observer for the selected stream. A 200 for another body is not evidence
 * that this clinical projection reached the response adapter. A3 replaces W9's
 * old observer with this one; the RF listeners retain their ownership role.
 */
export function observeLocalReadResponse(request: IncomingMessage, response: ServerResponse, signal?: AbortSignal) {
  let consumed = false, selected = false, terminal: 'ended' | 'aborted' | undefined;
  let resolve: (outcome: 'ended' | 'aborted') => void;
  const outcome = new Promise<'ended' | 'aborted'>(done => { resolve = done; });
  const settle = (value: 'ended' | 'aborted') => {
    if (terminal) return;
    terminal = value;
    response.off('finish', finish); response.off('close', abort); response.off('error', abort);
    request.off('aborted', abort); request.off('error', abort);
    signal?.removeEventListener('abort', abort);
    resolve(value);
  };
  const abort = () => settle('aborted');
  const finish = () => settle(selected && consumed && response.statusCode === 200 ? 'ended' : 'aborted');
  response.once('finish', finish); response.once('close', abort); response.once('error', abort);
  request.once('aborted', abort); request.once('error', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted || request.aborted || response.destroyed || response.writableEnded) abort();
  return {
    outcome, abort,
    assertActive() { if (terminal) throw new Error('Local read response ended'); },
    select(json: string, unavailable: Readonly<{ code: string; message: string }> = LOCAL_READ_UNAVAILABLE): StreamableFile {
      if (terminal || selected) throw new Error('Local read response is no longer selectable');
      selected = true;
      const bytes = Buffer.from(json, 'utf8');
      const stream = new Readable({ read() {
        // An outer interceptor may wait after preparation. Revisit only this
        // response's cancellation at the actual adapter read, never the session.
        if (terminal === 'aborted' || signal?.aborted || request.aborted || response.destroyed) {
          this.destroy(new Error('Local read response ended'));
          return;
        }
        this.push(bytes); this.push(null);
      } });
      stream.once('end', () => { consumed = true; });
      stream.once('error', abort);
      return new StreamableFile(stream, { type: 'application/json; charset=utf-8', length: bytes.length })
        .setErrorHandler(() => {
          if (response.destroyed) return;
          if (response.headersSent) { response.end(); return; }
          response.statusCode = 503;
          response.removeHeader('Content-Length');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify(unavailable));
        });
    },
  };
}
