"""
가짜 환자 5명 생성 + Orthanc 직접 업로드 (워크리스트 채우기용).

make_sample_ct.py의 팬텀 생성기를 재사용하되, 환자마다 이름·ID·검사일·UID를
바꿔서 별도 Study로 만든다. 파일로 저장하지 않고 REST API로 바로 올린다.

사용법:
    python make_sample_patients.py            # localhost:8042, admin/admin
"""
import io
import sys

import requests
from pydicom.uid import generate_uid

import make_sample_ct as gen  # 같은 폴더의 생성기 재사용

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8042"
AUTH = ("admin", "admin")

# 마지막 칸은 DICOM InstitutionName(0008,0080) — 이 검사를 찍은 기관.
# API가 이 태그로 검사의 소속을 정하므로, 여기가 곧 멀티 기관 테스트 데이터다.
# 한림병원 3건 / KIN 판독센터 2건으로 갈라 두 기관이 서로를 못 보는 것을 시험한다.
PATIENTS = [
    # (이름 DICOM 형식: 성^이름, ID, 생년월일, 성별, 검사일, 검사설명, 기관)
    ("KIM^CHULSOO",  "P-1001", "19620304", "M", "20260828", "Brain CT (synthetic)",     "한림병원"),
    ("LEE^YOUNGHEE", "P-1002", "19751122", "F", "20260827", "Brain CT (synthetic)",     "한림병원"),
    ("PARK^MINJUN",  "P-1003", "19881009", "M", "20260827", "Brain CT f/u (synthetic)", "한림병원"),
    ("CHOI^SUJIN",   "P-1004", "19930517", "F", "20260826", "Brain CT (synthetic)",     "KIN 판독센터"),
    ("JUNG^DOHYUN",  "P-1005", "19570228", "M", "20260825", "Brain CT f/u (synthetic)", "KIN 판독센터"),
]

N_SLICES = 20  # 환자당 20슬라이스면 충분 (업로드 빠르게)


def dcm_bytes(ds) -> bytes:
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)   # pydicom 3.x
    except TypeError:
        ds.save_as(buf, write_like_original=False)  # pydicom 2.x
    return buf.getvalue()


def main() -> None:
    gen.N_SLICES = N_SLICES
    total = 0

    for pi, (name, pid, birth, sex, date, desc, institution) in enumerate(PATIENTS):
        # 환자(=Study)마다 새 UID — 이걸 안 바꾸면 전부 한 검사로 합쳐진다
        gen.study_uid = generate_uid()
        gen.series_uid = generate_uid()
        gen.frame_of_reference_uid = generate_uid()

        for i in range(N_SLICES):
            ds = gen.make_dataset(i)
            ds.PatientName = name
            ds.PatientID = pid
            ds.PatientBirthDate = birth
            ds.PatientSex = sex
            ds.StudyDate = date
            ds.StudyTime = f"{9 + pi}3000"
            ds.StudyDescription = desc
            ds.AccessionNumber = f"KIN2026{1000 + pi}"
            ds.InstitutionName = institution

            r = requests.post(f"{BASE}/instances", data=dcm_bytes(ds),
                              auth=AUTH, timeout=30,
                              headers={"Content-Type": "application/dicom"})
            r.raise_for_status()
            total += 1
        print(f"OK: {name} ({pid}) — {N_SLICES}슬라이스 업로드 / 기관: {institution}")

    print(f"완료: 환자 {len(PATIENTS)}명, 인스턴스 {total}개 → {BASE}")


if __name__ == "__main__":
    main()
