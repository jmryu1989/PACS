import { Inject, Injectable, Logger, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalReadAccessEventV2 } from '../emr-contract/access-event';
import { isDurableReceipt } from '../emr-runtime/contract';
import type { EmrRecordWork } from '../emr-runtime/record-port';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from '../emr-runtime/request-context';
import { LocalReadResponse, localReadEvents, localReadFollowup } from './local-read';
import { LOCAL_READ_UNAVAILABLE, observeLocalReadResponse } from './response-lifecycle';

const unavailable = () => new ServiceUnavailableException(LOCAL_READ_UNAVAILABLE);

/** The source owns the one request work. This singleton holds no request state. */
@Injectable()
export class ViewingRecordService {
  private readonly logger = new Logger(ViewingRecordService.name);
  constructor(@Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource) {}

  async prepare(request: IncomingMessage, response: ServerResponse, selection: LocalReadResponse):
    Promise<{ body: StreamableFile; settled: Promise<void> }> {
    const lifecycle = observeLocalReadResponse(request, response, selection.signal);
    const refuseBody = () => new ServiceUnavailableException(selection.unavailable);
    let publish: (body: StreamableFile) => void, refuse: (error: unknown) => void;
    const ready = new Promise<StreamableFile>((resolve, reject) => { publish = resolve; refuse = reject; });
    let published = false;
    // The response deadline does not cancel an admitted append. Refuse the HTTP
    // body immediately, but let that work retain a late COMMIT and its outcome.
    void lifecycle.outcome.then(outcome => {
      if (outcome === 'aborted' && !published) refuse(refuseBody());
    });
    const settled = this.requests.withWork(request, async context => {
      const prepared: Readonly<LocalReadAccessEventV2>[] = [];
      try {
        const events = localReadEvents(context.facts, selection);
        for (const event of events) {
          context.assertActive();
          lifecycle.assertActive();
          await this.append(context.work, event);
          // Retain even a receipt that arrives after close. No body is then selected.
          prepared.push(event);
          context.assertActive();
          lifecycle.assertActive();
        }
        context.assertActive();
        lifecycle.assertActive();
        if (response.statusCode !== 200) throw unavailable();
        const body = lifecycle.select(selection.json, selection.unavailable);
        published = true;
        publish(body);
      } catch (error) {
        lifecycle.abort();
        refuse(refuseBody());
      }
      const outcome = await lifecycle.outcome;
      // Finish every committed target even if an earlier follow-up fails. B2
      // retains its failure/unknown; a replacement attempt cannot turn it into success.
      const errors: unknown[] = [];
      for (const event of prepared) {
        try { await this.append(context.work, localReadFollowup(event, outcome)); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    });
    // RF deliberately rejects a callback that finishes after the response ends.
    // Follow-ups have already drained inside it; no second begin or session re-check.
    const completion = settled.catch(error => {
      lifecycle.abort();
      if (!published) refuse(refuseBody());
      if (error?.name !== 'RequestContextUnavailable') {
        if (!published) this.logger.error('Local read follow-up did not settle; consult the ledger failure record.');
        throw error;
      }
    });
    // The interceptor owns reporting for the returned completion. Also attach a
    // rejection handler before ready settles, so failed admission cannot leak one.
    void completion.catch(() => undefined);
    return { body: await ready, settled: completion };
  }

  private async append(work: EmrRecordWork, event: LocalReadAccessEventV2): Promise<void> {
    const keys = { operationId: randomUUID(), attemptId: randomUUID() };
    let receipt;
    try { receipt = await work.append(event, undefined, keys); }
    catch (error) {
      // A lost COMMIT reply is resolved only through this operation's stored
      // result. Missing, pending or unavailable stays unknown; never re-append.
      const result = await work.lookup(keys.operationId);
      if (!result || result.outcome !== 'committed' || result.eventId !== event.eventId) throw error;
      receipt = await work.confirm({ provisional: true, operationId: keys.operationId, eventId: event.eventId });
    }
    if (!isDurableReceipt(receipt) || receipt.eventId !== event.eventId) throw unavailable();
  }
}
