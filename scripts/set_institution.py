"""
이미 Orthanc에 올라가 있는 검사에 InstitutionName(0008,0080)을 넣는다.

왜 필요한가: 멀티 기관 테넌시 이전에 올린 합성 검사에는 기관 태그가 없다.
태그가 없으면 API가 그 검사를 "(미배정)"으로 보고 어느 기관에도 안 보여준다.
새로 만드는 검사는 make_sample_patients.py가 알아서 넣는다 — 이 스크립트는
기존 데이터를 한 번 따라잡기 위한 것이다.

**StudyInstanceUID를 보존한다.** UID가 바뀌면 DB의 StudyState·판독문·감사로그가
전부 고아가 된다. StudyState의 PK가 StudyInstanceUID이기 때문(인계문서 §4-1).
그래서 Orthanc의 modify를 쓰지 않고, 인스턴스를 내려받아 태그만 고쳐
지우고 다시 올린다. 중간에 죽어도 잃지 않도록 **전부 메모리에 받은 뒤** 지운다.

사용법:
    python3 set_institution.py                       # localhost:8042
    python3 set_institution.py http://다른주소:8042
"""
import io
import sys

import requests
from pydicom import dcmread

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8042").rstrip("/")
AUTH = ("admin", "admin")

# PatientID → InstitutionName.
# 값은 api/src/seed.ts 의 Institution.dicomNames 별칭 중 하나여야 한다.
BY_PATIENT = {
    "KIN-0001": "한림병원",   # make_sample_ct.py가 만든 원래 팬텀 검사
    "P-1001": "한림병원",
    "P-1002": "한림병원",
    "P-1003": "한림병원",
    "P-1004": "KIN 판독센터",
    "P-1005": "KIN 판독센터",
}
# 표에 없는 환자를 만나면 어디로 보낼까. None이면 건드리지 않고 넘어간다.
# 기본값으로 아무 기관에나 밀어넣지 않는다 — 조용히 섞이는 것이 가장 나쁘다.
FALLBACK = None


def dcm_bytes(ds) -> bytes:
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)   # pydicom 3.x
    except TypeError:
        ds.save_as(buf, write_like_original=False)  # pydicom 2.x
    return buf.getvalue()


def main() -> None:
    studies = requests.get(f"{BASE}/studies", auth=AUTH, timeout=15).json()
    if not studies:
        sys.exit("Orthanc에 검사가 없습니다.")

    changed = skipped = 0
    for sid in studies:
        info = requests.get(f"{BASE}/studies/{sid}", auth=AUTH, timeout=15).json()
        tags = info.get("MainDicomTags", {})
        pid = info.get("PatientMainDicomTags", {}).get("PatientID", "")
        uid = tags.get("StudyInstanceUID", "")
        desc = tags.get("StudyDescription", "(no desc)")

        want = BY_PATIENT.get(pid, FALLBACK)
        if not want:
            print(f"  건너뜀: {pid} / {desc} — 표에 없는 환자")
            skipped += 1
            continue

        inst_ids = requests.get(f"{BASE}/studies/{sid}/instances", auth=AUTH, timeout=30).json()

        # 1) 전부 내려받아 태그를 고친다 (아직 아무것도 지우지 않는다)
        payload = []
        already = True
        for inst in inst_ids:
            raw = requests.get(f"{BASE}/instances/{inst['ID']}/file", auth=AUTH, timeout=30).content
            ds = dcmread(io.BytesIO(raw))
            if getattr(ds, "InstitutionName", "") != want:
                already = False
            # 한글을 쓰려면 문자셋을 먼저 선언해야 한다. 이게 없으면 DICOM 기본값이
            # ASCII(ISO_IR 6)여서 "한림병원"이 "????"로 저장된다 — 조용히.
            # 그러면 API가 그 검사의 기관을 못 알아보고 전부 미배정이 된다.
            ds.SpecificCharacterSet = "ISO_IR 192"   # UTF-8
            ds.InstitutionName = want
            payload.append(dcm_bytes(ds))

        if already:
            print(f"  그대로: {pid} / {desc} — 이미 '{want}'")
            skipped += 1
            continue

        # 2) 원본을 지운다. Orthanc는 같은 SOPInstanceUID를 덮어쓰지 않고 무시하므로
        #    "지우고 다시 올리기"가 아니면 태그가 반영되지 않는다.
        requests.delete(f"{BASE}/studies/{sid}", auth=AUTH, timeout=60).raise_for_status()

        # 3) 다시 올린다. UID는 그대로이므로 DB의 StudyState가 계속 붙어 있다.
        for body in payload:
            r = requests.post(f"{BASE}/instances", data=body, auth=AUTH, timeout=30,
                              headers={"Content-Type": "application/dicom"})
            r.raise_for_status()

        print(f"  설정: {pid} / {desc} → '{want}' ({len(payload)}개 인스턴스, UID 유지 {uid[:24]}…)")
        changed += 1

    print(f"\n완료: {changed}개 검사 변경, {skipped}개 그대로 — {BASE}")
    print("API 컨테이너는 다음 목록 조회 때 이 태그를 읽어 기관을 확정한다.")


if __name__ == "__main__":
    main()
