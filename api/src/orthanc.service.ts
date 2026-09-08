import { Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';

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

  /** New persistence validates original tags without holding a database lock or buffering an unbounded response. */
  private async viewerJson(path: string, body?: string, signal?: AbortSignal): Promise<any> {
    let response: Response, reader: ReadableStreamDefaultReader<Uint8Array>;
    // Keep cancellation wired for the entire streamed body, not just until
    // response headers arrive. The page deadline and per-fetch limit both own
    // this controller; completion releases their listener/timer explicitly.
    const controller = new AbortController(), abort = () => {
      controller.abort();
      void reader?.cancel().catch(() => {});
    };
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      response = await fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: this.auth, 'Content-Type': 'text/plain' }, body,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error('response');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > 262144) throw new Error('limit');
          chunks.push(value);
        }
        controller.signal.throwIfAborted();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } finally { await reader.cancel().catch(() => {}); }
    } catch {
      // Never echo tag values or Basic credentials in an error response.
      throw new ServiceUnavailableException('원본 영상 참조를 확인할 수 없습니다');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
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

  private async srBytes(path: string, limit: number, body?: Buffer, accept = 'application/octet-stream', signal?: AbortSignal): Promise<Buffer> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try {
      const res = await fetch(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: this.auth, Accept: accept, 'Content-Type': 'application/dicom' }, body: body ? new Uint8Array(body).buffer : undefined });
      if (!res.ok || !res.body) throw new Error('response');
      reader = res.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new Error('limit'); chunks.push(part.value); }
      controller.signal.throwIfAborted(); return Buffer.concat(chunks);
    } catch { throw new ServiceUnavailableException('SR 원본 조회 또는 저장을 확인할 수 없습니다. 같은 요청으로 다시 시도하세요'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await reader?.cancel().catch(() => {}); }
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

  private async get(path: string) {
    let res: Response;
    try {
      res = await fetch(this.base + path, { headers: { Authorization: this.auth } });
    } catch (e: any) {
      throw new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e.message}`);
    }
    if (!res.ok) throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`);
    return res.json();
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
      '/dicom-web/studies?includefield=00081030,00201206,00201208,00080080,00100020',
    );
  }

  async reportPreviewStudy(uid: string): Promise<any> {
    const rows = await this.viewerJson('/dicom-web/studies?StudyInstanceUID=' + encodeURIComponent(uid) +
      '&includefield=00081030,00100030,00100040');
    if (!Array.isArray(rows) || rows.length !== 1 || OrthancService.tag(rows[0], '0020000D') !== uid)
      throw new BadRequestException('출력할 원본 검사를 확인할 수 없습니다');
    return rows[0];
  }

  /** SOP Instance UID를 Orthanc 내부 ID로 찾는다. 기관 판정은 호출자가 Study로 환원한 뒤 한다. */
  async lookupInstance(sopUid: string): Promise<any[]> {
    let res: Response;
    try {
      res = await fetch(this.base + '/tools/lookup', {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'text/plain' },
        body: sopUid,
      });
    } catch (e: any) {
      throw new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e.message}`);
    }
    if (!res.ok) throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`);
    return res.json();
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

  /** DICOM 태그 한 칸 꺼내기 (PN 타입은 {Alphabetic: "..."} 로 온다) */
  static tag(st: any, key: string): string {
    const v = st?.[key]?.Value?.[0];
    if (v == null) return '';
    if (typeof v === 'object') return v.Alphabetic ?? '';
    return String(v);
  }
}
