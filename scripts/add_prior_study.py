"""
KIM CHULSOO(P-1001)에게 과거 검사(prior) 1건 추가 — Related List 시험용.

6개월 전 Brain CT를 별도 Study로 생성해 Orthanc에 업로드한다.

사용법:
    python add_prior_study.py
"""
import io
import sys

import requests
from pydicom.uid import generate_uid

import make_sample_ct as gen

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8042"
AUTH = ("admin", "admin")
N_SLICES = 20


def dcm_bytes(ds) -> bytes:
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)
    except TypeError:
        ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def main() -> None:
    gen.N_SLICES = N_SLICES
    gen.study_uid = generate_uid()
    gen.series_uid = generate_uid()
    gen.frame_of_reference_uid = generate_uid()

    for i in range(N_SLICES):
        ds = gen.make_dataset(i)
        ds.PatientName = "KIM^CHULSOO"
        ds.PatientID = "P-1001"
        ds.InstitutionName = "한림병원"   # prior는 본검사와 같은 기관이어야 Related List에 뜬다
        ds.PatientBirthDate = "19620304"
        ds.PatientSex = "M"
        ds.StudyDate = "20260210"          # 약 6개월 전
        ds.StudyTime = "103000"
        ds.StudyDescription = "Brain CT initial (synthetic)"
        ds.AccessionNumber = "KIN20260950"

        r = requests.post(f"{BASE}/instances", data=dcm_bytes(ds),
                          auth=AUTH, timeout=30,
                          headers={"Content-Type": "application/dicom"})
        r.raise_for_status()

    print(f"OK: KIM^CHULSOO prior study (2026-02-10) {N_SLICES}슬라이스 업로드 완료")


if __name__ == "__main__":
    main()
