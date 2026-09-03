"""DICOMLibrary 공개 CT를 재식별해 C-STORE 경로를 검증한다.

픽셀을 새로 만드는 팬텀은 실제 영상 특성을 검증하지 못했다. 이 도구는
``sample-data/public``의 공개 CT 픽셀만 사용하며, 테스트 격리를 위해 환자·검사
식별자와 UID만 새로 부여한다.
"""
import argparse
import sys
from datetime import datetime
from pathlib import Path

from pydicom import dcmread
from pydicom.uid import generate_uid

try:
    from pynetdicom import AE, debug_logger
except ImportError:
    sys.exit("pynetdicom이 필요합니다: pip install pynetdicom")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "sample-data" / "public"
WARNING_CODES = {
    0xB000: "Coercion of Data Elements",
    0xB007: "Data Set does not match SOP Class",
    0xB006: "Element Discarded",
}


def public_ct_series(source: Path, count: int, largest: bool = False):
    """공개 데이터의 한 CT 시리즈에서 필요한 수만큼 읽는다."""
    if largest:
        groups = {}
        for path in sorted(source.rglob("*.dcm")):
            try:
                ds = dcmread(path, defer_size=1024, force=True)
            except Exception:
                continue
            if (str(getattr(ds, "Modality", "")) != "CT" or "PixelData" not in ds or
                    not getattr(ds, "SeriesInstanceUID", None)):
                continue
            groups.setdefault(str(ds.SeriesInstanceUID), []).append(path)
        paths = max(groups.values(), key=lambda items: sum(path.stat().st_size for path in items), default=[])
        if len(paths) < count:
            sys.exit(
                f"가장 큰 공개 CT 시리즈가 부족합니다: {source} "
                f"(요청 {count}장, 발견 {len(paths)}장)"
            )
        return [(path, dcmread(path, force=True)) for path in paths[:count]]

    chosen = []
    series_uid = None
    for path in sorted(source.rglob("*.dcm")):
        try:
            ds = dcmread(path, force=True)
        except Exception:
            continue
        if str(getattr(ds, "Modality", "")) != "CT" or "PixelData" not in ds:
            continue
        candidate_series = str(getattr(ds, "SeriesInstanceUID", ""))
        if not candidate_series:
            continue
        if series_uid is None:
            series_uid = candidate_series
        if candidate_series != series_uid:
            continue
        chosen.append((path, ds))
        if len(chosen) == count:
            return chosen
    sys.exit(
        f"DICOMLibrary 공개 CT가 부족합니다: {source} "
        f"(요청 {count}장, 발견 {len(chosen)}장)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="DICOMLibrary 공개 CT → Orthanc C-STORE")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=4242)
    parser.add_argument("--called-aet", default="KINLAB")
    parser.add_argument("--calling-aet", default=None)
    parser.add_argument("--institution", default="한림병원")
    parser.add_argument("--name", required=True, help="격리된 테스트 환자명")
    parser.add_argument("--id", dest="pid", required=True, help="격리된 테스트 환자 ID")
    parser.add_argument("--birth", default="19800101")
    parser.add_argument("--sex", default="O")
    parser.add_argument("--desc", default="DICOMLibrary-derived C-STORE fixture")
    parser.add_argument("--slices", type=int, default=1)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--largest-series", action="store_true", help="바이트 합이 가장 큰 CT 시리즈 사용")
    parser.add_argument("--study-uid", help="늦게 도착한 인스턴스 시험용 기존 StudyInstanceUID")
    parser.add_argument("--instance-offset", type=int, default=0)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.slices < 1:
        parser.error("--slices는 1 이상이어야 합니다")
    if args.verbose:
        debug_logger()

    now = datetime.now()
    calling = args.calling_aet or (
        "KINC_CT" if "판독센터" in args.institution else "HALLYM_CT"
    )
    study_uid = args.study_uid or generate_uid()
    series_uid = generate_uid()
    frame_uid = generate_uid()
    datasets = []

    for index, (path, ds) in enumerate(
        public_ct_series(args.source_dir, args.slices, args.largest_series), args.instance_offset + 1,
    ):
        sop_uid = generate_uid()
        ds.SpecificCharacterSet = "ISO_IR 192"
        ds.PatientName = args.name
        ds.PatientID = args.pid
        ds.PatientBirthDate = args.birth
        ds.PatientSex = args.sex
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_uid
        ds.SOPInstanceUID = sop_uid
        ds.file_meta.MediaStorageSOPInstanceUID = sop_uid
        ds.StudyDate = now.strftime("%Y%m%d")
        ds.StudyTime = now.strftime("%H%M%S")
        ds.StudyDescription = args.desc
        ds.AccessionNumber = "CS" + now.strftime("%y%m%d%H%M%S")
        ds.InstitutionName = args.institution
        ds.InstanceNumber = index
        datasets.append((path, ds))

    ae = AE(ae_title=calling)
    contexts = {
        (str(ds.SOPClassUID), str(ds.file_meta.TransferSyntaxUID))
        for _, ds in datasets
    }
    for sop_class, transfer_syntax in contexts:
        ae.add_requested_context(sop_class, transfer_syntax)

    print(f"연결: {calling} → {args.called_aet}@{args.host}:{args.port}")
    print(f"공개 원본: {datasets[0][0]}")
    association = ae.associate(args.host, args.port, ae_title=args.called_aet)
    if not association.is_established:
        sys.exit("Association 실패 — Orthanc 상태·4242 포트·Called AE Title을 확인하세요")

    ok = fail = 0
    for _, ds in datasets:
        status = association.send_c_store(ds)
        code = getattr(status, "Status", None)
        if code == 0x0000:
            ok += 1
        else:
            fail += 1
            note = WARNING_CODES.get(code, "")
            shown = "없음" if code is None else f"0x{code:04X}"
            print(f"거절/경고 {shown} {note} — {ds.SOPInstanceUID}")
    association.release()

    print(f"C-STORE 완료: 성공 {ok} / 실패 {fail}")
    print(f"  환자      {args.name} ({args.pid})")
    print(f"  기관      {args.institution} (AET {calling})")
    print(f"  StudyUID  {study_uid}")
    if fail:
        sys.exit("일부 인스턴스가 저장되지 않았습니다")


if __name__ == "__main__":
    main()
