import { Injectable, ServiceUnavailableException, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ViewerSourceFailure, ViewerSourceUnavailable, warnViewerSource } from './viewer-source-warning';
import { STUDY_IDENTITY_UNRESOLVED, STUDY_IDENTITY_UNRESOLVED_MESSAGE } from './study-source-groups';
import type { ImageSource } from './emr-image/stream';
import { ImageManifest, verifiedManifest } from './emr-image/manifest';

// A lookup key is not a DICOM conformance assertion. Preserve legacy opaque
// keys verbatim, but exclude path/query syntax and plain-object map collisions.
const reservedStudyKeys = new Set(['prototype', ...Object.getOwnPropertyNames(Object.prototype)]);
function isStudyLookupKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    && !reservedStudyKeys.has(value);
}

/** What a source consumer may do with the owned body: read it. The owner keeps the reader itself. */
type SourceReader = { read(): Promise<ReadableStreamReadResult<Uint8Array>> };

/** The part of an HTTP response `relay()` writes: the Express response of the viewer read it answers. */
export interface RelayTarget {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  off(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  readonly destroyed?: boolean;
}

// S7-U4a header reads put an Orthanc resource id into a path: only Orthanc's own id shape passes.
const ORTHANC_RESOURCE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
function orthancResourceId(value: unknown): string {
  if (typeof value !== 'string' || !ORTHANC_RESOURCE_ID.test(value)) throw new BadRequestException('원본 식별이 올바르지 않습니다');
  return value;
}
// A thin-slice series lists thousands of instances and an enhanced multi-frame header carries per-frame groups;
// the viewer's 256 KiB bound would turn such a study into a failed read, so these reads take 16 MiB.
const CONTEXT_READ_LIMIT = 16777216;
/** The archive id of each object of a kept study manifest (imageSource().copy); the entry lives as long as the manifest. */
const objectIds = new WeakMap<ImageManifest, Map<string, string>>();

/**
 * Orthanc(DICOMweb) 클라이언트.
 *
 * 왜 서버가 대신 부르는가 — 예전엔 브라우저가 `/dicom-web/studies`를 직접 불렀다.
 * 그러면 기관 필터를 걸 곳이 화면밖에 없다. 화면 필터는 경계가 아니라 커튼이다
 * (주소창에 그 URL을 치면 전부 보인다). 역할 검사를 서버에 둔 것과 같은 이유로
 * 검사 목록도 서버가 만들어서 내려준다.
 *
 * 영상 픽셀(WADO)과 뷰어는 아직 브라우저가 Orthanc를 직접 본다.
 * 영상 자체의 기관 분리는 5단계(기관별 게이트웨이)의 몫이다 — 지금은 목록만 가른다.
 */
@Injectable()
export class OrthancService {
  private base = (process.env.ORTHANC_URL ?? 'http://orthanc:8042').replace(/\/$/, '');
  private auth: string;
  private readonly instanceStudy = new Map<string, string>();   // orthancId → StudyInstanceUID

  constructor() {
    const user = process.env.ORTHANC_USER;
    const pass = process.env.ORTHANC_PASS;
    if (!user || !pass) {
      throw new ServiceUnavailableException('ORTHANC_USER와 ORTHANC_PASS가 설정되지 않았습니다');
    }
    this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  /** E's fixed-manifest source. Raw frames retain the stored transfer syntax:
   * Orthanc's zero-based /raw endpoint bypasses decoding (Orthanc REST API).
   * The E stream checks bytes/hash before publishing any part of the response. */
  imageSource(): ImageSource {
    return { copy: async (input, prepared, unit, write, signal) => {
      const manifest = verifiedManifest(input), request = prepared.request;
      const source = manifest.objects.find(o => o.sopInstanceUid === unit.sopInstanceUid);
      if (prepared.manifestSha256 !== manifest.sha256 || request.studyUid !== manifest.studyUid ||
          !prepared.units.some(u => u === unit)) throw new BadRequestException('영상 제공 범위가 일치하지 않습니다');
      let path: string, syntax: string | null = null, patientId: string;
      if (unit.part === 'object' || unit.part === 'frame') {
        if (!source || source.unsupported) throw new BadRequestException('영상 표현 형식을 확인할 수 없습니다');
        // Every response reads, together: the study's current identity (the same reader and rule as D's current-study
        // read, studyPatientIdentity: a second patient's resource that arrived under this Study UID since the delivery
        // opened leaves the selected object's own header unchanged, so only this read notices it; R244-GPT-01), the
        // object's header tags and its file meta header. The object's archive id is looked up at its first response
        // under a kept manifest and reused after: Orthanc derives it from the identifiers the header check compares on
        // every response, so a stale id fails that check and is dropped. Read one after another, the lookup, the tags
        // and the meta header were about 140 ms of each frame's 273 ms staging on the served VM (R244-02 profile, run
        // e-route-diag3-fable-20261027a). None of these runs inside a ledger lane.
        let ids = objectIds.get(manifest);
        if (!ids) objectIds.set(manifest, ids = new Map());
        const known = ids.get(source.sopInstanceUid);
        const object = async () => {
          let id = known;
          if (!id) {
            const matches = await this.viewerJson('/tools/lookup', source.sopInstanceUid, signal);
            const instances = Array.isArray(matches) ? matches.filter(x => x?.Type === 'Instance') : [];
            if (instances.length !== 1) throw new ConflictException('영상 원본이 없거나 중복입니다');
            id = orthancResourceId(instances[0].ID);
          }
          try {
            const [tags, meta] = await Promise.all([
              this.viewerJson(`/instances/${id}/simplified-tags`, undefined, signal), this.viewerJson(`/instances/${id}/header`, undefined, signal)]);
            return { id, tags, meta };
          } catch (error) { if (known) ids.delete(source.sopInstanceUid); throw error; }
        };
        const [studyPatientId, { id, tags, meta }] = await Promise.all([this.studyPatientIdentity(manifest.studyUid, signal), object()]);
        if (studyPatientId !== manifest.patient.patientId) throw new ConflictException('영상 원본의 환자 식별이 변경되었습니다');
        syntax = meta?.['0002,0010']?.Value ?? null;
        if (tags?.StudyInstanceUID !== manifest.studyUid || tags?.SeriesInstanceUID !== source.seriesUid ||
            tags?.SOPInstanceUID !== source.sopInstanceUid || tags?.SOPClassUID !== source.sopClassUid ||
            syntax !== source.transferSyntaxUid) { ids.delete(source.sopInstanceUid); throw new ConflictException('영상 원본 판이 변경되었습니다'); }
        ids.set(source.sopInstanceUid, id);
        // The same header carries the object's current PatientID: a patient correction that keeps the UIDs and the
        // pixels is refused here, before the body is read, with no further archive call (R244-GPT-01). Exact text, as
        // D's study read compares it (no trim, no issuer: CS-02).
        if (typeof tags?.PatientID !== 'string' || tags.PatientID !== manifest.patient.patientId)
          throw new ConflictException('영상 원본의 환자 식별이 변경되었습니다');
        patientId = tags.PatientID;
        if (unit.part === 'frame') {
          const count = Number(tags.NumberOfFrames ?? 1);
          if (count !== source.declaredFrameCount || !source.frames.some(f => f.number === unit.frame))
            throw new ConflictException('영상 프레임 구성이 변경되었습니다');
          path = `/instances/${id}/frames/${unit.frame - 1}/raw`;
        } else path = `/instances/${id}/file`;
      } else {
        // The original digest cannot attest a generated PDF/preview/metadata
        // representation. Its owner must supply a snapshot of that exact body;
        // fetching a mutable URL here would silently substitute a later version.
        throw new ServiceUnavailableException('영상 표현의 고정 원본 연결이 필요합니다');
      }
      return this.withSourceResponse(path, { method: 'GET', redirect: 'error',
        headers: { Authorization: this.auth, Accept: '*/*', 'Accept-Encoding': 'identity' } }, signal,
      async (response, read, owned) => {
        if (response.status !== 200 || !response.body) throw new ServiceUnavailableException('영상 원본을 읽지 못했습니다');
        const reader = read();
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          owned.throwIfAborted(); await write(part.value);
        }
        owned.throwIfAborted();
        let contentType = response.headers.get('content-type') || 'application/octet-stream';
        if (unit.part === 'object') contentType = 'application/dicom';
        if (unit.part === 'frame') {
          const decoder = source.decoder;
          const media = decoder === 'jpeg-baseline' || decoder === 'jpeg-lossless' ? 'image/jpeg' :
            decoder === 'jpeg-ls' ? 'image/jls' : decoder === 'jpeg-2000' || decoder === 'htj2k' ? 'image/jp2' :
              decoder === 'rle' ? 'image/dicom-rle' : 'application/octet-stream';
          contentType = `${media}; transfer-syntax=${syntax}`;
        }
        return { contentType, transferSyntaxUid: syntax, source: path, patientId };
      });
    } };
  }

  /**
   * W9A2-1 (D1562/D1564): the one owner of a source request's I/O. It owns a per-request controller that follows the
   * caller's signal from before dispatch until the consumer has materialised its answer, the Response and any reader the
   * consumer takes through `read()`. On every exit - answer, refusal, throw, early return, abort - it aborts first (so
   * cleanup never waits for the remote end), then cancels the tracked reader or the unlocked body, releases the reader
   * lock and detaches from the caller's signal. It drains nothing and has no clock: the callers keep their own limits.
   * `transport` maps a failure to obtain the response (connection, already-aborted signal) for callers that name it.
   * An abort while the body is pending also cancels the reader (or the unlocked body) at once: after the headers, native
   * fetch follows its signal only weakly, and an abort alone was observed not to reach the connection
   * (tmp/w9-api/runs/r9-counterexample-signal-only). A consumer reads only through `read()` and calls
   * `signal.throwIfAborted()` after its read loop, since a cancelled reader ends like a finished body.
   * A body read to its end (or a response without one) is complete and is not aborted afterwards: its connection may go
   * back to the pool (D1562: returning a fully consumed connection is valid).
   */
  private async withSourceResponse<T>(path: string, init: RequestInit, signal: AbortSignal | undefined,
      consume: (response: Response, read: () => SourceReader, signal: AbortSignal) => Promise<T>,
      transport?: (error: any) => Error): Promise<T> {
    const controller = new AbortController();
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, drained = false;
    const stop = () => {
      controller.abort();
      const cancelling = reader ? reader.cancel() : response?.body && !response.body.locked ? response.body.cancel() : undefined;
      void cancelling?.catch(() => {});
    };
    const read = (): SourceReader => {
      const owned = (reader = response!.body!.getReader());
      return { read: async () => { const part = await owned.read(); if (part.done) drained = true; return part; } };
    };
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', stop, { once: true });
    try {
      try {
        controller.signal.throwIfAborted();
        response = await fetch(this.base + path, { ...init, signal: controller.signal });
      } catch (error) { throw transport ? transport(error) : error; }
      controller.signal.throwIfAborted();
      return await consume(response, read, controller.signal);
    } finally {
      signal?.removeEventListener('abort', stop);
      const complete = !controller.signal.aborted && (drained || (response !== undefined && !response.body));
      if (!complete) stop();
      if (reader) {
        if (!complete) await reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }
  }

  /** The whole body through the owner's reader, decoded by native Response.json (the same JSON semantics as before). */
  private static async jsonBody(response: Response, read: () => SourceReader, signal: AbortSignal) {
    if (!response.body) return response.json();
    const reader = read(), chunks: Uint8Array[] = [];
    for (let part = await reader.read(); !part.done; part = await reader.read()) chunks.push(part.value);
    signal.throwIfAborted();
    return new Response(Buffer.concat(chunks), { headers: response.headers }).json();
  }

  /**
   * New persistence validates original tags without holding a database lock or buffering an unbounded response.
   * `limit` stays 256 KiB for every viewer read; only the S7-U4a header reads below pass a larger bound.
   */
  private async viewerJson(path: string, body?: string, signal?: AbortSignal, limit = 262144): Promise<any> {
    let failure: ViewerSourceFailure = 'unexpected', timedOut = false;
    // The per-fetch limit and the caller's deadline both end the request; withSourceResponse owns its I/O.
    const bounds = OrthancService.readLimit(signal, () => { timedOut = true; }), bound = bounds.signal;
    try {
      failure = 'transport';
      return await this.withSourceResponse(path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: this.auth, 'Content-Type': 'text/plain' }, body,
      }, bound, async (response, read, owned) => {
        if (!response.ok || !response.body) {
          failure = !response.ok ? response.status === 401 ? 'http_401' : response.status === 404 ? 'http_404' : 'http_other' : 'missing_body';
          throw new Error('response');
        }
        const reader = read();
        const chunks: Uint8Array[] = []; let total = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > limit) { failure = 'size_limit'; throw new Error('limit'); }
          chunks.push(value);
        }
        owned.throwIfAborted();
        failure = 'decode';
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        failure = 'parse';
        return JSON.parse(decoded);
      });
    } catch (error) {
      // Never echo tag values or Basic credentials in an error response.
      warnViewerSource(signal?.aborted ? 'parent_abort' : timedOut ? 'timeout' :
        failure === 'transport' && !(error instanceof TypeError) && error?.name !== 'AbortError' ? 'unexpected' : failure);
      throw new ViewerSourceUnavailable();
    } finally { bounds.release(); }
  }

  /**
   * The existing 5 s per-read limit joined with the caller's signal into the one signal the source owner follows; a
   * plain controller whose listener on the caller's signal is removed when the read ends.
   */
  private static readLimit(signal: AbortSignal | undefined, onTimeout?: () => void) {
    const bound = new AbortController(), follow = () => bound.abort();
    const timer = setTimeout(() => { onTimeout?.(); bound.abort(); }, 5000);
    if (signal?.aborted) bound.abort(); else signal?.addEventListener('abort', follow, { once: true });
    return { signal: bound.signal, release: () => { clearTimeout(timer); signal?.removeEventListener('abort', follow); } };
  }

  async viewerReference(sopUid: string, measurement = false, signal?: AbortSignal): Promise<any> {
    const found = await this.viewerJson('/tools/lookup', sopUid, signal);
    if (!Array.isArray(found)) throw new BadRequestException('영상 참조가 올바르지 않습니다');
    const instances = found.filter(x => x?.Type === 'Instance');
    if (instances.length !== 1 || typeof instances[0].ID !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(instances[0].ID))
      throw new BadRequestException('영상 참조가 없거나 중복입니다');
    const tags = await this.viewerJson(`/instances/${instances[0].ID}/simplified-tags`, undefined, signal);
    if (!measurement) return tags;
    const info = await this.viewerJson(`/instances/${instances[0].ID}/attachments/dicom/info`, undefined, signal);
    if (typeof info?.UncompressedMD5 !== 'string' || !/^[a-f0-9]{32}$/i.test(info.UncompressedMD5))
      throw new ServiceUnavailableException('측정 원본의 무결성을 확인할 수 없습니다');
    return { ...tags, _kinSourceDigest: info.UncompressedMD5.toLowerCase() };
  }

  async viewerSeriesManifest(seriesUid: string, signal?: AbortSignal): Promise<string[]> {
    const found = await this.viewerJson('/tools/lookup', seriesUid, signal);
    const hits = Array.isArray(found) ? found.filter(x => x?.Type === 'Series') : [];
    if (hits.length !== 1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(hits[0]?.ID || ''))
      throw new BadRequestException('원본 시리즈가 없거나 중복입니다');
    const series = await this.viewerJson('/series/' + hits[0].ID, undefined, signal);
    if (series?.MainDicomTags?.SeriesInstanceUID !== seriesUid || !Array.isArray(series.Instances) || series.Instances.length < 2 || series.Instances.length > 256 ||
        new Set(series.Instances).size !== series.Instances.length || series.Instances.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(id)))
      throw new BadRequestException('MPR 작업은 원본2~256프레임의 완전한 시리즈에서 저장할 수 있습니다');
    return [...series.Instances].sort();
  }

  private async srBytes(path: string, limit: number, body?: Buffer, accept = 'application/octet-stream', signal?: AbortSignal): Promise<Buffer> {
    const bounds = OrthancService.readLimit(signal), bound = bounds.signal;
    try {
      return await this.withSourceResponse(path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: this.auth, Accept: accept, 'Content-Type': 'application/dicom' }, body: body ? new Uint8Array(body).buffer : undefined },
      bound, async (res, read, owned) => {
        if (!res.ok || !res.body) throw new Error('response');
        const reader = read(); const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new Error('limit'); chunks.push(part.value); }
        owned.throwIfAborted(); return Buffer.concat(chunks);
      });
    } catch { throw new ServiceUnavailableException('SR 원본 조회 또는 저장을 확인할 수 없습니다. 같은 요청으로 다시 시도하세요'); }
    finally { bounds.release(); }
  }

  async manualSrPixels(sopUid: string, signal?: AbortSignal): Promise<Buffer> {
    const found = await this.viewerJson('/tools/lookup', sopUid, signal);
    const instances = Array.isArray(found) ? found.filter(x => x?.Type === 'Instance') : [];
    if (instances.length !== 1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(instances[0].ID)) throw new BadRequestException('측정 원본을 확인할 수 없습니다');
    // Preserve decoded stored samples. Orthanc's default float32 rescale would
    // round fractional HU before the independent double-precision calculation.
    return this.srBytes(`/instances/${instances[0].ID}/numpy?rescale=0`, 33558528, undefined, 'application/octet-stream', signal);
  }

  async manualSrLocation(sopUid: string, bytes: Buffer, signal?: AbortSignal): Promise<string | null> {
    const hash = (await import('node:crypto')).createHash('md5').update(bytes).digest('hex');
      const found = await this.viewerJson('/tools/lookup', sopUid, signal);
      if (!Array.isArray(found)) throw new ServiceUnavailableException('SR 저장을 확인할 수 없습니다');
      const hits = found.filter(x => x?.Type === 'Instance');
      if (hits.length > 1) throw new BadRequestException('SR 문서 식별이 중복입니다');
      if (!hits.length) return null;
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(hits[0].ID)) throw new BadRequestException('SR 문서 식별이 올바르지 않습니다');
      const info = await this.viewerJson(`/instances/${hits[0].ID}/attachments/dicom/info`, undefined, signal);
      if (info?.UncompressedMD5 !== hash) throw new BadRequestException('동일 SR 식별자의 원문이 다릅니다');
      return hits[0].ID as string;
  }

  async storeManualSr(sopUid: string, bytes: Buffer): Promise<string> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    const locate = () => this.manualSrLocation(sopUid, bytes, controller.signal);
    try {
    const existing = await locate(); if (existing) return existing;
    const result = JSON.parse((await this.srBytes('/instances', 4096, bytes, 'application/json', controller.signal)).toString('utf8'));
    if (!['Success', 'AlreadyStored'].includes(result.Status)) throw new ServiceUnavailableException('SR 저장 결과를 확인할 수 없습니다');
    const stored = await locate(); if (!stored) throw new ServiceUnavailableException('SR 저장을 다시 확인하세요'); return stored;
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async connectStudyIdentity(studyUid: string): Promise<{ patientId: string }> {
    const found = await this.viewerJson('/tools/lookup', studyUid);
    if (!Array.isArray(found)) throw new BadRequestException('원본 검사 식별을 확인할 수 없습니다');
    const studies = found.filter(x => x?.Type === 'Study');
    if (studies.length !== 1 || typeof studies[0].ID !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(studies[0].ID))
      throw new BadRequestException('원본 검사가 없거나 중복입니다');
    const study = await this.viewerJson(`/studies/${studies[0].ID}`);
    const patientId = study?.PatientMainDicomTags?.PatientID;
    if (study?.MainDicomTags?.StudyInstanceUID !== studyUid || typeof patientId !== 'string' || !patientId.trim() || patientId.length > 64)
      throw new BadRequestException('원본 환자 식별을 확인할 수 없습니다');
    return { patientId };
  }

  /** `signal` (optional) is the caller's deadline: it cancels the fetch and, after the headers, the body read. */
  private get(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    return this.withSourceResponse(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: this.auth, 'Content-Type':'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) }, signal, async (res, read, owned) => {
      // A refusal leaves its body to the owner, which cancels it: an error body is never read to its end.
      if (!res.ok) throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`);
      return OrthancService.jsonBody(res, read, owned);
    }, (e: any) => new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e?.message}`));
  }

  /**
   * 서버 전체 통계 원문은 unknown이며 값의 유효성·관측 불가 판정은 소비자가 맡는다.
   * 실패는 rejection이다. 전송·HTTP 오류는 503 ServiceUnavailableException이며 그 메시지를
   * 클라이언트에 보내면 안 된다. JSON 해석 오류는 그대로 전파한다.
   * 자체 기한·취소·재시도는 없다. 대기 상한은 호출자 몫이며 PacsMetrics.metricsTimeoutMs가
   * 이를 정한다. 호출자의 대기 종료는 진행 중인 fetch를 취소하지 않는다.
   */
  statistics(): Promise<unknown> {
    return this.get('/statistics');
  }

  /**
   * QIDO-RS 검사 목록.
   *
   * 기관과 환자 키의 원본 태그를 includefield에 명시한다. Orthanc가 지금은 PatientID를
   * 기본 응답에 주더라도 그 동작에 기대면 업그레이드 뒤 Related 경계가 조용히 바뀔 수 있다.
   * InstitutionName은 명시하지 않으면 모든 검사가 "미배정"이 된다.
   */
  studies(): Promise<any[]> {
    return this.get(
      '/dicom-web/studies?includefield=00081030,00201206,00201208,00080080,00100020,00080020,00080061',
    );
  }

  /**
   * Indexed identity/institution only; patient tags and counts belong to the chosen page.
   * `accession` (S4-U2 order reconciliation) adds the indexed AccessionNumber. An unreadable value is
   * unknown for pairing, never a failure of the whole list, so it is carried as '' (not comparable).
   * WORKLIST-SPLIT-UID: one row per original Study resource. Two resources that share a Study UID (two
   * patients) are both returned; a repeat is an observation for the consumer to group, never a reason to
   * fail the whole institution's list or to keep one of them.
   * `signal`: a caller with a deadline (the W9 viewing-set resolve's StudyAccess preparation) cancels the find and its body.
   */
  async studyIdentities(accessMetadata = false, accession = false, signal?: AbortSignal): Promise<any[]> {
    const rows = await this.get('/tools/find', { Level:'Study', Query:{},
      ResponseContent:['RequestedTags'], RequestedTags:['StudyInstanceUID','InstitutionName',
        ...(accessMetadata ? ['PatientID','StudyDate','ModalitiesInStudy'] : []), ...(accession ? ['AccessionNumber'] : [])] }, signal);
    if (!Array.isArray(rows)) throw new ServiceUnavailableException('원본 검사 목록 형식을 확인할 수 없습니다');
    return rows.map(row => {
      const uid = row?.RequestedTags?.StudyInstanceUID;
      if (!isStudyLookupKey(uid))
        throw new ServiceUnavailableException('원본 검사 식별이 없거나 올바르지 않습니다');
      const institution = row?.RequestedTags?.InstitutionName;
      if (institution != null && typeof institution !== 'string')
        throw new ServiceUnavailableException('원본 기관 형식을 확인할 수 없습니다');
      const source = { '0020000D': { Value:[uid] }, '00080080': { Value:[institution ?? ''] } };
      if(accessMetadata){
        const tags=row.RequestedTags;
        for(const name of ['PatientID','StudyDate','ModalitiesInStudy'])
          if(tags[name]!=null&&typeof tags[name]!=='string')throw new ServiceUnavailableException('원본 접근 조건 태그를 확인할 수 없습니다');
        Object.assign(source,{'00100020':{Value:[tags.PatientID??'']},'00080020':{Value:[tags.StudyDate??'']},
          '00080061':{Value:(tags.ModalitiesInStudy??'').split('\\').map((v:string)=>v.trim().toUpperCase()).filter(Boolean)}});
      }
      if (accession) {
        const value = row.RequestedTags.AccessionNumber;
        Object.assign(source, { '00080050': { Value:[typeof value === 'string' ? value : ''] } });
      }
      return source;
    });
  }

  /**
   * D1882: the sending device of a study is the calling AE title Orthanc recorded on each received instance (metadata
   * RemoteAET). One title on every instance is the device; an instance without one (REST/STOW upload), two titles or no
   * instance is null, so the study stays held rather than being attached by a guess.
   */
  async sendingDevice(studyUid: string): Promise<string | null> {
    if (!isStudyLookupKey(studyUid)) return null;
    const rows = await this.get('/tools/find', { Level: 'Instance', Query: { StudyInstanceUID: studyUid }, ResponseContent: ['Metadata'] });
    if (!Array.isArray(rows)) throw new ServiceUnavailableException('원본 수신 장비를 확인할 수 없습니다');
    const titles = new Set(rows.map(row => {
      const title = row?.Metadata?.RemoteAET;
      return typeof title === 'string' ? title.trim() : '';
    }));
    const [only] = titles;
    return titles.size === 1 && only ? only : null;
  }

  /**
   * D1882: what an arriving instance changes for a study — each Study resource answering the UID with its instance count
   * and the LastUpdate Orthanc records on every store. A sendingDevice() answer read after a stamp holds only while the
   * stamp is unchanged; null when no resource answers. One indexed Study lookup, not the instance list sendingDevice reads.
   */
  async studyArrivalStamp(studyUid: string): Promise<string | null> {
    if (!isStudyLookupKey(studyUid)) return null;
    const rows = await this.get('/tools/find', { Level: 'Study', Query: { StudyInstanceUID: studyUid },
      ResponseContent: ['Metadata', 'RequestedTags'], RequestedTags: ['NumberOfStudyRelatedInstances'] });
    if (!Array.isArray(rows)) throw new ServiceUnavailableException('원본 수신 상태를 확인할 수 없습니다');
    if (!rows.length) return null;
    const stamps = rows.map(row => [row?.ID, row?.Metadata?.LastUpdate, row?.RequestedTags?.NumberOfStudyRelatedInstances]);
    // Without both change signals an unchanged stamp would prove nothing.
    if (stamps.some(([id, at, count]) => typeof id !== 'string' || typeof at !== 'string' || !at || count == null || count === ''))
      throw new ServiceUnavailableException('원본 수신 상태를 확인할 수 없습니다');
    return JSON.stringify(stamps.map(stamp => stamp.map(String)).sort());
  }

  async studyAccessMetadata(uid:string):Promise<any> {
    const rows=await this.viewerJson('/dicom-web/studies?StudyInstanceUID='+encodeURIComponent(uid)+
      '&includefield=00100020,00080020,00080061');
    if(Array.isArray(rows)&&rows.length===0)return null;
    if(!Array.isArray(rows)||rows.length!==1||OrthancService.tag(rows[0],'0020000D')!==uid)
      throw new ServiceUnavailableException('원본 접근 조건의 검사 소속을 확인할 수 없습니다');
    return rows[0];
  }

  /**
   * WORKLIST-SPLIT-UID: every original Study resource that answers one Study UID, for a request-scoped source
   * observation and the single-UID access preparation. A normal study is a one-element array, a UID that two
   * patient resources share returns both, and no resource is []. A row naming another UID, or a malformed answer,
   * is a failed read (503) — never a smaller array. studyAccessMetadata() keeps its single-row contract.
   * InstitutionName is not a QIDO default attribute: unnamed, every source institution would read as not observed.
   */
  async studyIdentityResources(uid: string, signal?: AbortSignal): Promise<any[]> {
    const rows = await this.viewerJson('/dicom-web/studies?StudyInstanceUID=' + encodeURIComponent(uid) +
      '&includefield=00100020,00080020,00080061,00080080', undefined, signal);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || OrthancService.tag(row, '0020000D') !== uid))
      throw new ServiceUnavailableException('원본 검사의 소속을 확인할 수 없습니다');
    return rows;
  }

  /**
   * The one patient the study's original resources currently name: D's current-study read (emr-clinical/startup.ts)
   * and E's per-response source check share this rule. WORKLIST-SPLIT-UID: a UID that two patient resources share
   * has no resolved patient; the product's own refusal answers, never an invented link. No resource is "no study".
   */
  async studyPatientIdentity(uid: string, signal?: AbortSignal): Promise<string> {
    const resources = await this.studyIdentityResources(uid, signal);
    if (!resources.length) throw new NotFoundException('검사가 없습니다.');
    if (resources.length > 1) throw new ConflictException({ code: STUDY_IDENTITY_UNRESOLVED, message: STUDY_IDENTITY_UNRESOLVED_MESSAGE });
    const patientId = OrthancService.tag(resources[0], '00100020');
    if (!patientId.trim() || patientId.length > 64) throw new BadRequestException('원본 환자 식별을 확인할 수 없습니다');
    return patientId;
  }

  /**
   * One QIDO read for a page of UIDs. Every row of every requested UID is returned, grouped in the request's UID
   * order (the order inside one UID carries no meaning); a UID that two resources share is not a changed list. The
   * answer's UID set must equal the request's: a missing, extra or malformed row is STUDY_LIST_CHANGED.
   */
  async studiesByUid(uids: string[]): Promise<any[]> {
    if (!Array.isArray(uids) || uids.length > 100 || new Set(uids).size !== uids.length
      || uids.some(uid => !isStudyLookupKey(uid)))
      throw new BadRequestException('원본 검사 페이지 식별이 잘못되었습니다');
    if (!uids.length) return [];
    // QIDO UID-list matching uses commas, not DIMSE's backslash separator.
    const rows = await this.get('/dicom-web/studies?StudyInstanceUID=' + encodeURIComponent(uids.join(','))
      + '&includefield=00081030,00201206,00201208,00080080,00100020,00080020,00080061');
    const changed = () => new ConflictException({ code:'STUDY_LIST_CHANGED', message:'원본 검사 목록이 바뀌었습니다. 새로고침하세요.' });
    if (!Array.isArray(rows)) throw changed();
    const byUid = new Map<string, any[]>(uids.map(uid => [uid, []]));
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw changed();
      const group = byUid.get(OrthancService.tag(row, '0020000D'));
      if (!group) throw changed();
      group.push(row);
    }
    if (uids.some(uid => !byUid.get(uid)!.length)) throw changed();
    return uids.flatMap(uid => byUid.get(uid)!);
  }

  async reportPreviewStudy(uid: string): Promise<any> {
    const rows = await this.viewerJson('/dicom-web/studies?StudyInstanceUID=' + encodeURIComponent(uid) +
      '&includefield=00081030,00100030,00100040,00080080');
    // Two patient resources under one UID: printing either one's header over the report would name the wrong patient.
    if (Array.isArray(rows) && rows.length > 1 && rows.every(row => OrthancService.tag(row, '0020000D') === uid))
      throw new ConflictException({ code: STUDY_IDENTITY_UNRESOLVED, message: STUDY_IDENTITY_UNRESOLVED_MESSAGE });
    if (!Array.isArray(rows) || rows.length !== 1 || OrthancService.tag(rows[0], '0020000D') !== uid)
      throw new BadRequestException('출력할 원본 검사를 확인할 수 없습니다');
    return rows[0];
  }

  // ── S7-U4a CTX-TAGS (계약 S7-U4p §5.4): 기준 검사의 원본 영상 인스턴스 **한 개**의 DICOM 헤더 ──
  // 요청 태그 다섯 개는 Orthanc 색인 태그가 아니라서(config/orthanc.json에 ExtraMainDicomTags가 없다) QIDO includefield로는
  // "헤더에 없음"과 "색인이 주지 않음"을 가를 수 없다. 그래서 저장된 파일의 헤더를 읽는다. 여기는 Orthanc 답을 그대로
  // 돌려주기만 하고, 어느 시리즈·인스턴스를 고를지와 답의 모양은 clinical-context-policy.ts가 판정한다. 모두 GET/조회다.

  /** /tools/lookup 답 그대로. 기준 검사의 Orthanc id를 찾는 데 쓴다. */
  async contextLookup(studyUid: string): Promise<any> {
    return this.viewerJson('/tools/lookup', studyUid);
  }

  /** 검사의 시리즈 목록. 시리즈마다 MainDicomTags의 Modality·SeriesInstanceUID와 인스턴스 id가 온다. */
  async contextSeries(orthancStudyId: string): Promise<any> {
    return this.viewerJson(`/studies/${orthancResourceId(orthancStudyId)}/series`, undefined, undefined, CONTEXT_READ_LIMIT);
  }

  /** 시리즈의 인스턴스 목록. 인스턴스마다 MainDicomTags.SOPInstanceUID가 온다. */
  async contextInstances(orthancSeriesId: string): Promise<any> {
    return this.viewerJson(`/series/${orthancResourceId(orthancSeriesId)}/instances`, undefined, undefined, CONTEXT_READ_LIMIT);
  }

  /**
   * 인스턴스 한 개의 헤더 전체(파일 기반 /tags, 요소마다 Type·Value). Orthanc는 256자를 넘는 값을 TooLong으로 가리므로
   * 요청 태그는 ignore-length로 원문 전체를 받는다. 형식은 8자리 hex를 쉼표로 잇는 것이다 — "0032,1030"처럼 쉼표가 든
   * 태그 표기는 쉼표에서 갈라져 Orthanc 1.12.5가 500으로 답했다(합성 자료를 넣은 Orthanc 24.12.0 이미지에서 관측).
   */
  async contextHeader(orthancInstanceId: string, tags: readonly string[]): Promise<any> {
    if (!Array.isArray(tags) || !tags.length || tags.some(tag => typeof tag !== 'string' || !/^[0-9A-F]{8}$/i.test(tag)))
      throw new BadRequestException('헤더 태그 목록이 올바르지 않습니다');
    return this.viewerJson(`/instances/${orthancResourceId(orthancInstanceId)}/tags?ignore-length=${tags.join(',')}`,
      undefined, undefined, CONTEXT_READ_LIMIT);
  }

  /** SOP Instance UID를 Orthanc 내부 ID로 찾는다. 기관 판정은 호출자가 Study로 환원한 뒤 한다. */
  /** `signal` (optional): a caller-owned cancellation; the current caller (PacsDicomGateway) passes none and keeps no deadline. */
  lookupInstance(sopUid: string, signal?: AbortSignal): Promise<any[]> {
    return this.withSourceResponse('/tools/lookup', {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'text/plain' },
      body: sopUid,
    }, signal, async (res, read, owned) => {
      if (!res.ok) throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`);
      return OrthancService.jsonBody(res, read, owned);
    }, (e: any) => new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e?.message}`));
  }

  /**
   * MG-LOADING: what the direct frame reader (dicom-frame.service.ts) needs to know about one stored object. The
   * simplified tags name the object and its frame geometry; the attachment info gives the stored file's identity and
   * sizes; the two metadata values are the transfer syntax and the pixel data offset Orthanc records at ingestion.
   * A missing PixelDataOffset is `null` (an encapsulated or unindexed object): the caller then leaves it to Orthanc.
   */
  async frameFacts(id: string, signal?: AbortSignal): Promise<{ tags: any; attachment: any; transferSyntax: string | null; pixelDataOffset: string | null }> {
    const rid = orthancResourceId(id);
    const [tags, attachment, transferSyntax, pixelDataOffset] = await Promise.all([
      this.viewerJson(`/instances/${rid}/simplified-tags`, undefined, signal, CONTEXT_READ_LIMIT),
      this.viewerJson(`/instances/${rid}/attachments/dicom/info`, undefined, signal),
      this.viewerText(`/instances/${rid}/metadata/TransferSyntax`, signal),
      this.viewerText(`/instances/${rid}/metadata/PixelDataOffset`, signal),
    ]);
    return { tags, attachment, transferSyntax, pixelDataOffset };
  }

  /**
   * MG-08: the archive's own revision of one study - its Orthanc resource and the LastUpdate stamp Orthanc advances
   * for every instance stored into or removed from the study - which the study delivery's 열람 record names as the
   * version of what it delivers (image-delivery-record.ts). A UID two study resources answer has no one revision: the
   * recorder reads this for every image read, before the study's other reads, so it answers with the archive reader's
   * own refusals (studyPatientIdentity: no resource is no study, two resources is the split UID), not a generic 503.
   */
  async studyRevision(uid: string, signal?: AbortSignal): Promise<{ id: string; lastUpdate: string }> {
    if (typeof uid !== 'string' || !/^[0-9.]{1,64}$/.test(uid)) throw new BadRequestException('검사 식별자가 올바르지 않습니다');
    const found = await this.viewerJson('/tools/lookup', uid, signal);
    if (!Array.isArray(found)) throw new ServiceUnavailableException('원본 검사를 하나로 확인할 수 없습니다');
    const studies = found.filter(x => x?.Type === 'Study');
    if (!studies.length) throw new NotFoundException('검사가 없습니다.');
    if (studies.length > 1) throw new ConflictException({ code: STUDY_IDENTITY_UNRESOLVED, message: STUDY_IDENTITY_UNRESOLVED_MESSAGE });
    if (typeof studies[0].ID !== 'string' || !ORTHANC_RESOURCE_ID.test(studies[0].ID)) throw new ServiceUnavailableException('원본 검사를 하나로 확인할 수 없습니다');
    const study = await this.viewerJson(`/studies/${studies[0].ID}`, undefined, signal);
    const lastUpdate = study?.LastUpdate;
    if (typeof lastUpdate !== 'string' || !/^\d{8}T\d{6}$/.test(lastUpdate)) throw new ServiceUnavailableException('원본 검사의 갱신 시각을 확인할 수 없습니다');
    return { id: studies[0].ID, lastUpdate };
  }

  /** A short text value of the Orthanc REST API (instance metadata); a 404 is `null`, any other failure throws. */
  private async viewerText(path: string, signal?: AbortSignal, limit = 4096): Promise<string | null> {
    const bounds = OrthancService.readLimit(signal), bound = bounds.signal;
    try {
      return await this.withSourceResponse(path, { method: 'GET', redirect: 'error', headers: { Authorization: this.auth } },
        bound, async (response, read, owned) => {
          if (response.status === 404) return null;
          if (!response.ok || !response.body) throw new Error('response');
          const reader = read(), chunks: Uint8Array[] = []; let total = 0;
          for (let part = await reader.read(); !part.done; part = await reader.read()) {
            total += part.value.byteLength;
            if (total > limit) throw new Error('limit');
            chunks.push(part.value);
          }
          owned.throwIfAborted();
          return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        });
    } catch { throw new ViewerSourceUnavailable(); }
    finally { bounds.release(); }
  }

  /**
   * Orthanc's own answer to an image read (status, media type, body) copied to the API's response: the image reads nginx
   * routes to the API so their study delivery is recorded first (image-relay.controller.ts), and the viewer reads the direct frame
   * reader (dicom-frame.service.ts) does not serve itself. Backpressure follows the client. The response's own lifetime is
   * the source owner's signal, joined with the caller's: a client that goes away while the headers or a body chunk are
   * still pending aborts the Orthanc fetch and cancels its reader at once (the owner's `stop`), instead of leaving the
   * request open until Orthanc happens to produce the next bytes. The caller has set no headers and writes nothing else.
   * `origin` is the public origin the browser used: Orthanc's DICOMweb answers name their parts (Content-Location) from
   * the forwarded host, as they did when nginx proxied to Orthanc, instead of from the internal `orthanc:8042`.
   * `selected` runs once Orthanc has answered - it has chosen what its body is of - and before anything of that answer
   * is copied: the image routes confirm there that the archive still holds what their record names
   * (DeliveryLease.confirm). A refusal cancels Orthanc's answer unread; `false` (the record moved to the archive's newer
   * revision) cancels it unread and asks Orthanc again.
   */
  async relay(path: string, accept: string, target: RelayTarget, signal?: AbortSignal, origin?: string,
    selected?: () => Promise<boolean>): Promise<void> {
    const forwarded = /^(https?):\/\/([A-Za-z0-9.:\-\[\]]{1,255})$/.exec(origin ?? '');
    const lifetime = new AbortController(), stop = () => lifetime.abort();
    if (signal?.aborted || target.destroyed) lifetime.abort();
    else { signal?.addEventListener('abort', stop, { once: true }); target.once('close', stop); target.once('error', stop); }
    const settled = () => new Promise<void>(resolve => {
      const done = () => { for (const event of ['drain', 'close', 'error'] as const) target.off(event, done); resolve(); };
      for (const event of ['drain', 'close', 'error'] as const) target.once(event, done);
    });
    try {
      for (let again = true; again;) again = await this.withSourceResponse(path, { method: 'GET', redirect: 'error',
        headers: { Authorization: this.auth, Accept: accept, 'Accept-Encoding': 'identity',
          ...(forwarded ? { 'X-Forwarded-Proto': forwarded[1], 'X-Forwarded-Host': forwarded[2] } : {}) } }, lifetime.signal,
      async (response, read, owned) => {
        if (selected) {
          const current = await selected();
          owned.throwIfAborted();
          if (!current) return true;
        }
        target.status(response.status);
        for (const name of ['content-type', 'content-length']) {
          const value = response.headers.get(name);
          if (value) target.setHeader(name, value);
        }
        if (!response.body) { target.end(); return false; }
        const reader = read();
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          owned.throwIfAborted();
          if (!target.write(part.value)) await settled();
          owned.throwIfAborted();
        }
        owned.throwIfAborted();
        target.end();
        return false;
      }, (e: any) => new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e?.message}`));
    } finally {
      signal?.removeEventListener('abort', stop);
      target.off('close', stop); target.off('error', stop);
    }
  }

  /** 썸네일 경로(/instances/{id})의 기관 관문용. 실패는 던진다 — 관문에서 403이 된다. */
  async instanceStudyUid(id: string): Promise<string> {
    const hit = this.instanceStudy.get(id);
    if (hit) return hit;
    const study = await this.get(`/instances/${id}/study`);
    const uid = study?.MainDicomTags?.StudyInstanceUID;
    if (!uid) throw new Error(`instance ${id}의 StudyInstanceUID를 찾을 수 없습니다`);
    if (this.instanceStudy.size > 50000) this.instanceStudy.clear();   // 단순 상한
    this.instanceStudy.set(id, uid);
    return uid;
  }

  /**
   * W9-LITE viewing set: every original Study resource that answers one UID, with the member's minimal display tags named
   * explicitly (PatientName, PatientID, InstitutionName, StudyDate, ModalitiesInStudy, StudyDescription, AccessionNumber).
   * Like studyIdentityResources(): one row for a normal study, two or more for a UID two patient resources share, [] for
   * none; a row naming another UID or a malformed answer is a failed read (503), never a smaller array. The caller's
   * signal cancels the fetch and its body.
   */
  async viewingSetStudy(uid: string, signal: AbortSignal): Promise<any[]> {
    const rows = await this.viewerJson('/dicom-web/studies?StudyInstanceUID=' + encodeURIComponent(uid) +
      '&includefield=00100010,00100020,00080080,00080020,00080061,00081030,00080050', undefined, signal);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || OrthancService.tag(row, '0020000D') !== uid))
      throw new ServiceUnavailableException('원본 검사의 소속을 확인할 수 없습니다');
    return rows;
  }

  /** DICOM 태그 한 칸 꺼내기 (PN 타입은 {Alphabetic: "..."} 로 온다) */
  static tag(st: any, key: string): string {
    const v = st?.[key]?.Value?.[0];
    if (v == null) return '';
    if (typeof v === 'object') return v.Alphabetic ?? '';
    return String(v);
  }
}
