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
  private auth =
    'Basic ' +
    Buffer.from(
      `${process.env.ORTHANC_USER ?? 'admin'}:${process.env.ORTHANC_PASS ?? 'admin'}`,
    ).toString('base64');

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
   * includefield에 00080080(InstitutionName)이 들어 있는 것이 이번 작업의 핵심이다.
   * QIDO는 기본 응답에 이 태그를 넣어주지 않는다 — 명시하지 않으면 모든 검사의
   * 기관이 조용히 "미배정"이 된다.
   */
  studies(): Promise<any[]> {
    return this.get(
      '/dicom-web/studies?includefield=00081030,00201206,00201208,00080080',
    );
  }

  /** DICOM 태그 한 칸 꺼내기 (PN 타입은 {Alphabetic: "..."} 로 온다) */
  static tag(st: any, key: string): string {
    const v = st?.[key]?.Value?.[0];
    if (v == null) return '';
    if (typeof v === 'object') return v.Alphabetic ?? '';
    return String(v);
  }
}
