import { Injectable, NestInterceptor, ExecutionContext, CallHandler, ForbiddenException } from '@nestjs/common';
import { from, mergeMap } from 'rxjs';
import { StudyAccessService } from './study-access.service';
import type { Caller } from './pacs.service';

/** Services decide which studies are permitted. This final check only rejects
 * stale responses across policy edits or a validity-window boundary, including
 * services whose read transactions use RepeatableRead. It never grants access. */
@Injectable()
export class StudyAccessInterceptor implements NestInterceptor {
  constructor(private access:StudyAccessService) {}
  async intercept(context:ExecutionContext,next:CallHandler) {
    const req=context.switchToHttp().getRequest();
    if(req.kind!=='member'||!req.institution||!req.sub)return next.handle();
    // Administrators must retain policy-management access even when their own
    // study policy is malformed or expired. Those endpoints enforce admin scope.
    if(context.getClass().name==='PacsController'&&context.getHandler().name==='me')return next.handle();
    if(context.getClass().name==='StudyAccessController'||context.getClass().name==='AdminController'||context.getClass().name==='AuthController')return next.handle();
    const c:Caller={kind:req.kind,institution:req.institution,sub:req.sub,actor:req.actor,roles:req.roles??[]};
    const dicom=context.getHandler().name==='authzDicom';
    const check=async(fn:()=>Promise<any>)=>{try{return await fn();}catch(e){if(dicom)throw new ForbiddenException('열람 권한이 없습니다');throw e;}};
    const before=await check(()=>this.access.snapshot(c));
    return next.handle().pipe(mergeMap(value=>from(check(async()=>{await this.access.unchanged(c,before);return value;}))));
  }
}
