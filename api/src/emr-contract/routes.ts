import { RecordKind } from './classification';
import type { CauseKind } from './access-event';
import { freeze } from './validation';

export type RouteOperation = 'read' | 'write' | 'export' | 'auth';
export interface RouteContract {
  kinds: readonly RecordKind[];
  operation: RouteOperation;
  causes: readonly CauseKind[];
}

/**
 * Exact Nest route keys; /api is supplied by Nest. Kinds cover returned records and affected targets.
 * Operation describes the business request, not its HTTP verb or incidental audit/cache writes.
 * Causes enumerate call contexts, never a default or evidence that a person saw the response.
 * The caller must preserve the actual trigger (including through proxy subrequests); later units bind events.
 * authz/dicom only authorizes: its 204 is not evidence of image delivery (see EXTERNAL_SURFACES).
 * report-preview prepares print/PDF content; it does not prove printing or export completion.
 * Connect transfer routes manage requests/bases; actual delivery belongs to EXTERNAL_SURFACES.
 */
const groups: readonly (RouteContract & { routes: readonly string[] })[] = [
  { kinds: ['identity-access'], operation: 'write', causes: ['user-view'],
    routes: ['POST emr-audit/roster/:grantId'] },
  { kinds: ['access-audit'], operation: 'read', causes: ['user-view'],
    routes: ['POST emr-audit/investigations', 'POST emr-audit/exports'] },
  { kinds: ['disclosure'], operation: 'write', causes: ['user-view'],
    routes: ['POST emr-audit/requests', 'POST emr-audit/issuances', 'POST emr-audit/issuances/:id/issue', 'POST emr-audit/issuances/:id/delivery',
      'POST emr-audit/requests/:id/extend', 'POST emr-audit/requests/:id/resolve'] },
  { kinds: ['disclosure'], operation: 'read', causes: ['user-view'], routes: ['GET emr-audit/requests/:id'] },
  { kinds: ['image', 'external-sr-seg', 'pdf', 'thumbnail', 'download', 'study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET images/dicom-web', 'HEAD images/dicom-web'] },
  { kinds: ['system-operation'], operation: 'read', causes: ['user-view', 'service-job'],
    routes: ['GET health'] },
  { kinds: ['system-operation'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET admin/metrics'] },
  { kinds: ['authentication-session'], operation: 'auth', causes: ['user-view'],
    routes: ['GET auth/login', 'GET auth/register', 'GET auth/callback', 'POST auth/logout', 'POST auth/login', 'POST auth/register'] },
  { kinds: ['identity-access', 'authentication-session'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET me'] },
  { kinds: ['identity-access'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET colleagues', 'GET admin/users', 'GET study-access', 'GET admin/users/:id/study-access', 'GET reader-candidates', 'GET consultation-candidates', 'GET studies/:uid/critical-result-recipients'] },
  { kinds: ['identity-access'], operation: 'write', causes: ['user-view'],
    routes: ['POST admin/users', 'PATCH admin/users/:id', 'POST admin/users/:id/reset-password', 'POST admin/users/:id/study-access'] },
  { kinds: ['image', 'study-metadata'], operation: 'auth', causes: ['user-view', 'background-fetch', 'service-job'],
    routes: ['GET authz/dicom'] },
  { kinds: ['image', 'study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['POST dicom/lookup'] },
  { kinds: ['study-metadata'], operation: 'write', causes: ['service-job'],
    routes: ['POST gateway/announce'] },
  { kinds: ['study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET unassigned', 'GET clinician/studies', 'GET clinician/studies/:uid/timeline'] },
  { kinds: ['study-metadata'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/assign'] },
  { kinds: ['delivery-receipt'], operation: 'write', causes: ['service-job'],
    routes: ['POST gateway/receipt'] },
  { kinds: ['delivery-receipt'], operation: 'read', causes: ['service-job'],
    routes: ['GET gateway/retry-requests'] },
  { kinds: ['delivery-receipt'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/gateway-retry'] },
  { kinds: ['preferences', 'reading-template'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET prefs'] },
  { kinds: ['preferences'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET workspace-layout', 'GET reading-preferences', 'GET hanging-protocols', 'GET hanging-protocols/site', 'GET workspace-shortcuts', 'GET reading-appearance', 'GET worklist-columns', 'GET filter-folders', 'GET shared-filters'] },
  { kinds: ['preferences'], operation: 'write', causes: ['user-view'],
    routes: ['PUT workspace-layout', 'DELETE workspace-layout', 'PUT reading-preferences', 'PUT hanging-protocols', 'PUT hanging-protocols/site', 'PUT workspace-shortcuts', 'PUT reading-appearance', 'PUT worklist-columns', 'DELETE worklist-columns', 'POST filters', 'PATCH filters/:id/default', 'DELETE filters/:id', 'POST filter-folders', 'POST shared-filters', 'POST shared-filters/copy'] },
  { kinds: ['reading-template'], operation: 'write', causes: ['user-view'],
    routes: ['POST templates', 'DELETE templates/:id'] },
  { kinds: ['study-metadata', 'report-head', 'private-draft', 'order', 'received-order', 'institution', 'preferences', 'reading-template'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET bootstrap'] },
  { kinds: ['study-metadata', 'report-head', 'private-draft'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies'] },
  { kinds: ['study-metadata', 'study-correction', 'report-head', 'private-draft'], operation: 'write', causes: ['user-view'],
    routes: ['PATCH studies/:uid', 'DELETE studies/:uid'] },
  { kinds: ['patient-match', 'study-correction', 'order', 'received-order', 'report-head', 'private-draft'], operation: 'write', causes: ['user-view'],
    routes: ['POST match', 'POST unmatch'] },
  { kinds: ['tech-note', 'operational-note'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/tech-note', 'GET studies/:uid/tech-note/history'] },
  { kinds: ['tech-note', 'operational-note'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/tech-note'] },
  { kinds: ['private-draft', 'report-head', 'report-evidence', 'report-version'], operation: 'write', causes: ['user-view', 'background-fetch'],
    routes: ['PUT studies/:uid/report'] },
  { kinds: ['private-draft', 'report-head', 'report-evidence'], operation: 'write', causes: ['user-view'],
    routes: ['DELETE studies/:uid/draft', 'DELETE studies/:uid/draft/force'] },
  { kinds: ['report-head', 'report-version', 'private-draft', 'report-evidence'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/report/commit'] },
  { kinds: ['report-version', 'report-evidence'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/report/versions', 'GET studies/:uid/report/versions/:version/citations'] },
  { kinds: ['report-evidence', 'report-head', 'private-draft'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/report/citations', 'GET studies/:uid/report/structure'] },
  { kinds: ['assignment'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/hold', 'POST studies/:uid/release', 'POST studies/:uid/release/force', 'POST studies/:uid/reader-assignment'] },
  { kinds: ['assignment'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/reader-assignment'] },
  { kinds: ['access-audit'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET audit', 'GET admin/audit'] },
  // S8-CTX: the viewer reports a context-loss/recovery event about a study it was admitted to read; the server keeps one
  // access-audit row (viewer-context.event) and writes no clinical record. The page posts it on its own after the loss or
  // on the person's recovery action, so both causes are real.
  { kinds: ['access-audit'], operation: 'write', causes: ['user-view', 'background-fetch'],
    routes: ['POST studies/:uid/viewer-context-events'] },
  // W9-LITE: the ordered same-patient viewing set's minimal source metadata, read on the person's Open, page, compare or Retry.
  // Its access record is the read's own provision record, not a write of the business request.
  { kinds: ['study-metadata'], operation: 'read', causes: ['user-view'],
    routes: ['POST studies/viewing-set/resolve'] },
  { kinds: ['clinical-context', 'report-version', 'tech-note', 'study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/clinical-context'] },
  { kinds: ['report-version', 'report-head', 'key-image', 'study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET clinician/studies/:uid/report'] },
  { kinds: ['print', 'pdf', 'report-head', 'report-version', 'key-image', 'study-metadata'], operation: 'export', causes: ['user-view'],
    routes: ['GET studies/:uid/report-preview'] },
  { kinds: ['clinical-question', 'clinical-answer'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET questions', 'GET questions/:id', 'GET studies/:uid/questions'] },
  { kinds: ['clinical-question', 'clinical-answer'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/questions', 'POST questions/:id/entries', 'POST questions/:id/close'] },
  { kinds: ['consultation'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET consultations', 'GET consultations/:id'] },
  { kinds: ['consultation'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/consultations', 'POST consultations/:id'] },
  { kinds: ['critical-result', 'critical-result-ack', 'report-version'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/critical-results', 'POST critical-results/:id/ack', 'POST critical-results/:id/cancel', 'POST critical-results/:id/supersede'] },
  { kinds: ['critical-result', 'critical-result-ack', 'report-version'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET critical-results', 'GET critical-results/:id', 'GET studies/:uid/critical-results'] },
  { kinds: ['dictation'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/dictation'] },
  { kinds: ['study-organization'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET favorite-folders', 'GET study-tags'] },
  { kinds: ['study-organization'], operation: 'write', causes: ['user-view'],
    routes: ['POST favorite-folders', 'POST study-tags'] },
  { kinds: ['finding'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/findings', 'GET studies/:uid/findings/:id/revisions'] },
  { kinds: ['finding'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/findings', 'POST studies/:uid/findings/:id/revisions'] },
  { kinds: ['image-request'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET image-requests', 'GET image-requests/:id', 'GET studies/:uid/image-requests'] },
  { kinds: ['image-request'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/image-requests', 'POST image-requests/:id'] },
  { kinds: ['manual-sr'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/manual-sr', 'POST studies/:uid/manual-sr/:id/store'] },
  { kinds: ['measurement', 'key-image'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/viewer-items', 'GET studies/:uid/viewer-items/:id/revisions'] },
  { kinds: ['measurement', 'key-image'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/viewer-items', 'POST studies/:uid/viewer-items/:id/revisions'] },
  { kinds: ['comparison-layout', 'comparison-description', 'study-metadata'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['POST studies/:uid/viewer-jobs/preview', 'GET studies/:uid/viewer-jobs', 'GET studies/:uid/viewer-jobs/:id'] },
  { kinds: ['comparison-layout', 'comparison-description', 'study-metadata'], operation: 'write', causes: ['user-view'],
    routes: ['POST studies/:uid/viewer-jobs', 'POST studies/:uid/viewer-jobs/:id/revisions'] },
  { kinds: ['transfer-governance'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET admin/agreements', 'GET studies/:uid/basis', 'GET transfers'] },
  { kinds: ['transfer-governance'], operation: 'write', causes: ['user-view'],
    routes: ['POST admin/agreements', 'PATCH admin/agreements/:id', 'POST studies/:uid/basis', 'POST studies/:uid/basis/:id/revoke', 'POST studies/:uid/transfers', 'POST transfers/:id/revoke'] },
  { kinds: ['private-draft', 'report-evidence'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/draft'] },
  // S9-U4b (contract S9-U4p 6, U4P3-06): the self-institution import writes originals, the study's metadata and per-file
  // delivery results; the original download is the server-recorded `download` export of a fixed manifest, never `copy`.
  { kinds: ['image', 'study-metadata', 'delivery-receipt'], operation: 'write', causes: ['user-view'],
    routes: ['POST dicom-import'] },
  { kinds: ['delivery-receipt'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET dicom-import/:operationId'] },
  // D1489: the archive grant is the user-view start of that same export (it is not the supply; the archive GET is).
  { kinds: ['image', 'download'], operation: 'export', causes: ['user-view'],
    routes: ['POST studies/:uid/original-downloads', 'GET studies/:uid/original-downloads/:operationId/archive',
      'POST studies/:uid/original-downloads/:operationId/archive/grant'] },
  { kinds: ['download'], operation: 'read', causes: ['user-view', 'background-fetch'],
    routes: ['GET studies/:uid/original-downloads/:operationId'] },
  { kinds: ['delivery-receipt', 'study-metadata'], operation: 'write', causes: ['user-view'],
    routes: ['POST admin/dicom-import/:operationId/files/:index/recovery'] },
];

const routeEntries = groups.flatMap(({ routes, ...contract }) => routes.map(route => [route, contract] as const));
if (new Set(routeEntries.map(([route]) => route)).size !== routeEntries.length) throw new Error('Duplicate route classification');
export const ROUTE_CONTRACTS: Readonly<Record<string, RouteContract>> = freeze(Object.fromEntries(routeEntries));
/** Record-only projection retained for record inventory consumers. */
export const ROUTE_CLASSIFICATION: Readonly<Record<string, readonly RecordKind[]>> = freeze(
  Object.fromEntries(routeEntries.map(([route, contract]) => [route, contract.kinds])));

export function routeContract(route: string): RouteContract {
  if (!Object.prototype.hasOwnProperty.call(ROUTE_CONTRACTS, route)) throw new Error(`Unclassified route: ${route}`);
  return ROUTE_CONTRACTS[route];
}

export function classifyRoute(route: string): readonly RecordKind[] {
  return routeContract(route).kinds;
}

/** In-process server work that is not an HTTP request (EMR-B1). The executor is the service identity of that job, never
 * the member it affects; its events carry `not-applicable: in-process-service` instead of an invented client address.
 * Closed: a new background job adds its own entry here with the records it touches. */
export const INTERNAL_SURFACES: Readonly<Record<string, RouteContract>> = freeze({
  'server:doctor-key-management': { kinds: ['identity-access'], operation: 'write', causes: ['user-view'] },
  'service:auth-session-sweep': { kinds: ['authentication-session'], operation: 'auth', causes: ['service-job'] },
  'service:member-rights-import': { kinds: ['identity-access'], operation: 'write', causes: ['service-job'] },
  // S7-U3a / D1860: the receiving institution's reader allocation closes inside the member's PATCH/DELETE studies/:uid.
  // That close is the server's own allocation operation, not a record act of the study route: the study routes serve
  // record kinds, and a route that mixed them with the non-record allocation would demand a served-record manifest.
  'server:reader-assignment-close': { kinds: ['assignment'], operation: 'write', causes: ['user-view'] },
});
for (const surface of Object.keys(INTERNAL_SURFACES)) {
  if (Object.prototype.hasOwnProperty.call(ROUTE_CONTRACTS, surface)) throw new Error('Internal surface shadows an HTTP route');
}

/** Not Nest routes: unit N must bind actual SOP/frame manifests, not just auth_request success. */
export const EXTERNAL_SURFACES = freeze({
  'dicom-web-study-series-instance-frame': ['image', 'external-sr-seg', 'pdf', 'download', 'study-metadata'],
  'orthanc-instance-preview': ['thumbnail', 'image', 'key-image'],
  'browser-print-pdf-copy': ['print', 'pdf', 'copy'],
  'comparison-print': ['print', 'comparison-layout', 'comparison-description', 'report-version'],
  'authorized-disclosure': ['disclosure', 'signature-evidence', 'access-audit'],
} satisfies Record<string, readonly RecordKind[]>);
