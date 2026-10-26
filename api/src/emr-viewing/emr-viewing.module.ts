import { CallHandler, DynamicModule, ExecutionContext, Injectable, Logger, Module, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { mergeMap } from 'rxjs';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from '../emr-runtime/request-context';
import { LocalReadResponse } from './local-read';
import { ReportObservationController } from './report-observation.controller';
import { ReportObservationService } from './report-observation.service';
import { ViewingRecordService } from './viewing-record.service';

@Injectable()
export class ViewingResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ViewingResponseInterceptor.name);
  constructor(private readonly records: ViewingRecordService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(mergeMap(async value => {
      if (!(value instanceof LocalReadResponse)) return value;
      const http = context.switchToHttp();
      const delivery = await this.records.prepare(http.getRequest(), http.getResponse(), value);
      void delivery.settled.catch(() => this.logger.error('Local read follow-up did not settle; consult the ledger failure record.'));
      // Nest pipes this exact serialized stream only after every interceptor has
      // accepted the response. An outer refusal leaves it unconsumed -> aborted.
      return delivery.body;
    }));
  }
}

@Module({})
export class EmrViewingModule {
  static withRequests(source: RequestContextSource): DynamicModule {
    // A4's display report shares the same request source; the guard and interceptors of the application apply to it.
    return { module: EmrViewingModule, controllers: [ReportObservationController], providers: [
      { provide: REQUEST_CONTEXT_SOURCE, useValue: source }, ViewingRecordService, ReportObservationService,
      { provide: APP_INTERCEPTOR, useClass: ViewingResponseInterceptor },
    ], exports: [ViewingRecordService] };
  }
}
