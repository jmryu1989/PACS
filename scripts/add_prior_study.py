"""P-200x CT 환자에게 Related Exam 시연용 prior 한 건을 추가한다.

현재 Orthanc에서 P-200x의 CT를 찾아 환자·기관 태그를 그대로 이어받고, 검사일만
1년 전으로 만든 합성 CT를 올린다. 같은 accession의 prior가 있으면 UID만 다시 출력한다.

사용법:
    python add_prior_study.py
    python add_prior_study.py http://localhost:8042
"""
import io
import re
import sys
from datetime import datetime, timedelta

import requests
from pydicom.uid import generate_uid

import make_sample_ct as gen
from orthanc_auth import orthanc_auth

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8042"
AUTH = orthanc_auth()
N_SLICES = 20

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def tag(study: dict, key: str) -> str:
    value = (study.get(key, {}).get("Value") or [""])[0]
    if isinstance(value, dict):
        return str(value.get("Alphabetic", ""))
    return str(value)


def modalities(study: dict) -> list[str]:
    return [str(v) for v in study.get("00080061", {}).get("Value", [])]


def dcm_bytes(ds) -> bytes:
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)
    except TypeError:
        ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def main() -> None:
    response = requests.get(
        f"{BASE}/dicom-web/studies?includefield=00080080,00081030,00080050,00201208",
        auth=AUTH,
        timeout=30,
    )
    response.raise_for_status()
    studies = response.json()

    candidates = [
        study for study in studies
        if re.fullmatch(r"P-200\d+", tag(study, "00100020")) and "CT" in modalities(study)
    ]
    if not candidates:
        sys.exit("P-200x CT 검사를 찾지 못했습니다. 공개 샘플을 먼저 업로드하세요.")

    # 이미 만든 prior보다 원 검사를 기준으로 잡아야 재실행 때 날짜가 계속 과거로 밀리지 않는다.
    candidates.sort(key=lambda study: tag(study, "00080020"), reverse=True)
    source = candidates[0]
    patient_id = tag(source, "00100020")
    accession = f"KINPRIOR{patient_id.replace('-', '')}"
    existing = next((study for study in studies if tag(study, "00080050") == accession), None)
    if existing:
        print(f"이미 있음: {patient_id} Related Exam prior")
        print(f"STUDY_UID={tag(existing, '0020000D')}")
        return

    source_date = tag(source, "00080020")
    try:
        prior_date = (datetime.strptime(source_date, "%Y%m%d") - timedelta(days=365)).strftime("%Y%m%d")
    except ValueError:
        prior_date = "20250101"

    patient_name = tag(source, "00100010")
    birth = tag(source, "00100030")
    sex = tag(source, "00100040")
    institution = tag(source, "00080080")
    description = tag(source, "00081030") or "CT"

    gen.N_SLICES = N_SLICES
    gen.study_uid = generate_uid()
    gen.series_uid = generate_uid()
    gen.frame_of_reference_uid = generate_uid()

    for i in range(N_SLICES):
        ds = gen.make_dataset(i)
        ds.PatientName = patient_name
        ds.PatientID = patient_id
        ds.InstitutionName = institution
        ds.PatientBirthDate = birth
        ds.PatientSex = sex
        ds.StudyDate = prior_date
        ds.StudyTime = "103000"
        ds.StudyDescription = f"{description} prior (synthetic)"
        ds.AccessionNumber = accession

        uploaded = requests.post(
            f"{BASE}/instances",
            data=dcm_bytes(ds),
            auth=AUTH,
            timeout=30,
            headers={"Content-Type": "application/dicom"},
        )
        uploaded.raise_for_status()

    print(f"OK: {patient_name} ({patient_id}) prior {prior_date} — {N_SLICES}슬라이스 업로드")
    print(f"STUDY_UID={gen.study_uid}")


if __name__ == "__main__":
    main()
