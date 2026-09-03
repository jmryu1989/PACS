import { Injectable, ServiceUnavailableException } from '@nestjs/common';

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
