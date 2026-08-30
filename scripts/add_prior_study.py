"""Orthanc의 DICOMLibrary CT를 그대로 복제해 Related Exam prior를 만든다.

팬텀 픽셀을 새로 만들지 않는다. P-2004의 최신 CT 인스턴스를 Orthanc에서 읽고
픽셀과 임상 태그를 보존한 채 StudyDate만 1년 전으로 바꾼다. 별도 검사로 저장하는 데
필수인 Study/Series/SOP/Frame UID는 결정적으로 새로 발급하므로 재실행해도 중복되지
않고, 중간에 멈췄다면 빠진 인스턴스만 채워진다.

사용법:
    python add_prior_study.py
    python add_prior_study.py --orthanc http://localhost:8042 --patient-id P-2004
    python add_prior_study.py --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import io
import sys
import uuid
from datetime import datetime

import pydicom
import requests

from orthanc_auth import orthanc_auth

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UID_NAMESPACE = uuid.UUID("0d2f4751-2ef4-4e4b-a537-a2521930803b")


def qido_value(study: dict, key: str) -> str:
    value = (study.get(key, {}).get("Value") or [""])[0]
    if isinstance(value, dict):
        return str(value.get("Alphabetic", ""))
    return str(value)


def modalities(study: dict) -> list[str]:
    return [str(value) for value in study.get("00080061", {}).get("Value", [])]


def prior_date(source_date: str) -> str:
    parsed = datetime.strptime(source_date, "%Y%m%d")
    try:
        return parsed.replace(year=parsed.year - 1).strftime("%Y%m%d")
    except ValueError:  # 2월 29일은 전년 2월 28일로 맞춘다.
        return parsed.replace(year=parsed.year - 1, day=28).strftime("%Y%m%d")


def derived_uid(kind: str, *parts: str) -> str:
    key = "|".join((kind, *parts))
    return f"2.25.{uuid.uuid5(UID_NAMESPACE, key).int}"


def lookup_study(session: requests.Session, base: str, uid: str) -> str | None:
    response = session.post(
        f"{base}/tools/lookup",
        data=uid.encode("ascii"),
        headers={"Content-Type": "text/plain"},
        timeout=30,
    )
    response.raise_for_status()
    for item in response.json():
        if item.get("Type") == "Study":
            return str(item.get("ID"))
    return None


def instance_count(session: requests.Session, base: str, study_id: str) -> int:
    response = session.get(f"{base}/studies/{study_id}/instances", timeout=60)
    response.raise_for_status()
    return len(response.json())


def dicom_bytes(ds: pydicom.dataset.Dataset) -> bytes:
    buffer = io.BytesIO()
    ds.save_as(buffer, write_like_original=True)
    return buffer.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--orthanc", default="http://localhost:8042")
    parser.add_argument("--patient-id", default="P-2004")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    base = args.orthanc.rstrip("/")
    session = requests.Session()
    session.auth = orthanc_auth()

    response = session.get(
        f"{base}/dicom-web/studies?includefield=00080080,00081030,00080050,00201208",
        timeout=60,
    )
    response.raise_for_status()
    candidates = [
        study for study in response.json()
        if qido_value(study, "00100020") == args.patient_id and "CT" in modalities(study)
    ]
    if not candidates:
        sys.exit(f"{args.patient_id} CT를 찾지 못했습니다")

    # 이미 만든 prior보다 원본을 다시 기준으로 잡도록 최신 검사일부터 고른다.
    candidates.sort(key=lambda study: qido_value(study, "00080020"), reverse=True)
    source = candidates[0]
    source_uid = qido_value(source, "0020000D")
    source_date = qido_value(source, "00080020")
    target_date = prior_date(source_date)
    target_uid = derived_uid("study", source_uid, target_date)

    source_id = lookup_study(session, base, source_uid)
    if not source_id:
        sys.exit(f"Orthanc에서 원본 Study를 찾지 못했습니다: {source_uid}")
    source_instances_response = session.get(
        f"{base}/studies/{source_id}/instances", timeout=60
    )
    source_instances_response.raise_for_status()
    source_instances = source_instances_response.json()
    expected = len(source_instances)
    if not expected:
        sys.exit("원본 CT에 인스턴스가 없습니다")

    print(f"SOURCE_STUDY_UID={source_uid}")
    print(f"SOURCE_DATE={source_date}")
    print(f"PRIOR_STUDY_UID={target_uid}")
    print(f"PRIOR_DATE={target_date}")
    print(f"PATIENT_ID={qido_value(source, '00100020')}")
    print(f"PATIENT_NAME={qido_value(source, '00100010')}")
    print(f"DESCRIPTION={qido_value(source, '00081030')}")
    print(f"ACCESSION={qido_value(source, '00080050')}")
    print(f"EXPECTED_INSTANCES={expected}")

    existing_id = lookup_study(session, base, target_uid)
    existing = instance_count(session, base, existing_id) if existing_id else 0
    if args.dry_run:
        print(f"DRY_RUN existing={existing} upload={expected - existing}")
        return
    if existing == expected:
        print(f"ALREADY_COMPLETE={existing}")
        return
    if existing > expected:
        sys.exit(f"prior 인스턴스가 원본보다 많습니다: prior={existing}, source={expected}")

    first_source_pixel_hash = None
    first_target_sop_uid = None
    ok = 0
    for index, instance in enumerate(source_instances, 1):
        source_instance_id = str(instance.get("ID", ""))
        downloaded = session.get(f"{base}/instances/{source_instance_id}/file", timeout=60)
        downloaded.raise_for_status()
        ds = pydicom.dcmread(io.BytesIO(downloaded.content), force=True)

        old_series_uid = str(ds.SeriesInstanceUID)
        old_sop_uid = str(ds.SOPInstanceUID)
        new_sop_uid = derived_uid("instance", source_uid, target_date, old_sop_uid)
        ds.StudyInstanceUID = target_uid
        ds.SeriesInstanceUID = derived_uid("series", source_uid, target_date, old_series_uid)
        ds.SOPInstanceUID = new_sop_uid
        ds.file_meta.MediaStorageSOPInstanceUID = new_sop_uid
        if getattr(ds, "FrameOfReferenceUID", None):
            ds.FrameOfReferenceUID = derived_uid(
                "frame", source_uid, target_date, str(ds.FrameOfReferenceUID)
            )
        ds.StudyDate = target_date

        if first_source_pixel_hash is None and "PixelData" in ds:
            first_source_pixel_hash = hashlib.sha256(ds.PixelData).hexdigest()
            first_target_sop_uid = new_sop_uid

        uploaded = session.post(
            f"{base}/instances",
            data=dicom_bytes(ds),
            headers={"Content-Type": "application/dicom"},
            timeout=90,
        )
        uploaded.raise_for_status()
        ok += 1
        if index % 100 == 0 or index == expected:
            print(f"UPLOADED={index}/{expected}")

    target_id = lookup_study(session, base, target_uid)
    if not target_id:
        sys.exit("업로드 뒤 prior Study를 찾지 못했습니다")
    actual = instance_count(session, base, target_id)
    if actual != expected:
        sys.exit(f"prior 수량 불일치: source={expected}, prior={actual}")

    if first_source_pixel_hash and first_target_sop_uid:
        lookup = session.post(
            f"{base}/tools/lookup",
            data=first_target_sop_uid.encode("ascii"),
            headers={"Content-Type": "text/plain"},
            timeout=30,
        )
        lookup.raise_for_status()
        target_instance_id = next(
            (str(item.get("ID")) for item in lookup.json() if item.get("Type") == "Instance"),
            None,
        )
        if not target_instance_id:
            sys.exit("픽셀 검증용 prior 인스턴스를 찾지 못했습니다")
        target_file = session.get(f"{base}/instances/{target_instance_id}/file", timeout=60)
        target_file.raise_for_status()
        target_ds = pydicom.dcmread(io.BytesIO(target_file.content), force=True)
        target_hash = hashlib.sha256(target_ds.PixelData).hexdigest()
        if target_hash != first_source_pixel_hash:
            sys.exit("픽셀 해시가 원본과 다릅니다")
        print(f"PIXEL_SHA256={target_hash}")

    print(f"OK: DICOMLibrary CT prior {actual}/{expected} instances")
    print(f"STUDY_UID={target_uid}")


if __name__ == "__main__":
    main()
