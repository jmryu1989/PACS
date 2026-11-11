/*
 * FA-090 EMR Link: the hospital EMR's web address template, one per institution. The worklist's Open EMR fills its
 * placeholders with the row's values and opens it in a new browser tab; the opening itself never passes this server.
 * This module only checks a template an administrator saves. The address format and any sign-in hand-over belong to the
 * hospital's EMR, so nothing beyond these rules is assumed: a web address (http:// or https://) with at least one
 * placeholder, at most 2000 characters; an empty value clears the setting.
 */
import { BadRequestException } from '@nestjs/common';

export const EMR_LINK_PLACEHOLDERS = Object.freeze(['patientId', 'accession', 'studyUid'] as const);
export const EMR_LINK_MAX = 2000;

/** The placeholders a template uses, in the fixed order above. */
export function emrLinkPlaceholders(template: string): string[] {
  return EMR_LINK_PLACEHOLDERS.filter(name => template.includes(`{${name}}`));
}

/** The host part as written (after the scheme, before the path; any user part dropped) - for the audit row only. */
export function emrLinkHost(template: string): string {
  const authority = template.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  return authority.slice(authority.lastIndexOf('@') + 1);
}

/** `{ template }` from the request body → the value to store (null clears). Throws 400 with the screen's wording. */
export function normalizeEmrLinkTemplate(body: any): string | null {
  if (!body || typeof body !== 'object' || !('template' in body)) throw new BadRequestException('EMR 주소 요청 형식이 잘못되었습니다');
  const raw = body.template;
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException('EMR 주소는 http:// 또는 https://로 시작해야 합니다');
  const template = raw.trim();
  if (!template) return null;
  if (template.length > EMR_LINK_MAX) throw new BadRequestException(`EMR 주소는 ${EMR_LINK_MAX}자 이내여야 합니다`);
  if (!/^https?:\/\/[^/?#\s]/i.test(template)) throw new BadRequestException('EMR 주소는 http:// 또는 https://로 시작해야 합니다');
  if (!emrLinkPlaceholders(template).length)
    throw new BadRequestException('{patientId}, {accession}, {studyUid} 중 하나는 있어야 합니다');
  return template;
}
