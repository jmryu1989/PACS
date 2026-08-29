"""
공개 샘플 DICOM(zip 또는 폴더)을 검사하고 기관을 붙여 Orthanc에 넣는다.

왜 이 스크립트가 따로 있나
--------------------------
합성 두부 CT 팬텀만으로는 알 수 없는 것들이 있다. 모달리티마다 태그가 다르고,
장비 제조사마다 빠뜨리는 태그가 다르고, InstitutionName 표기가 제각각이다.
실물 다양성이 있어야 워크리스트·썸네일·뷰어가 진짜로 버티는지 알 수 있다.

**받은 파일의 익명화를 맹신하지 않는다.** dicomlibrary는 브라우저에서 익명화하고
올린다고 하지만, 그건 *태그*를 지운다는 뜻이지 픽셀에 구워진 글자까지는 아니다
(장비가 환자명을 영상에 태워 보내는 사례가 실제로 있다). 그래서 이 스크립트는
업로드 **전에** 사람 식별 태그가 남아 있는지 먼저 훑고 보여준다.

사용법
------
    # 1) 먼저 내용을 확인만 한다 (업로드 안 함)
    python import_public_samples.py --dry-run

    # 2) 괜찮으면 기관을 붙여 올린다
    python import_public_samples.py --institution "한림병원"

    # 옵션
    --dir DIR           기본: ../sample-data/public   (여기에 zip이나 .dcm을 둔다)
    --orthanc URL       기본: http://localhost:8042   (프록시가 아니라 Orthanc 직통.
                        프록시는 POST /instances를 막아 둔다 — 의도된 것)
    --institution NAME  DICOM InstitutionName(0008,0080)에 넣을 값.
                        생략하면 파일에 있는 값을 그대로 둔다 → 대개 **미배정**이 되고,
                        관리자 계정 메뉴바의 [⚠ 미배정]에서 배정하게 된다.
                        그 흐름을 시험하고 싶으면 일부러 생략하면 된다.

필요: pip install pydicom requests
"""
import argparse
import glob
import io
import os
import sys
import zipfile

# 윈도우 콘솔(CP949)이 못 옮기는 글자 하나 때문에 스크립트가 죽지 않게.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests

try:
    import pydicom
except ImportError:
    sys.exit("pydicom이 필요합니다:  pip install pydicom requests")


HERE = os.path.dirname(os.path.abspath(__file__))

# 사람을 가리킬 수 있는 태그. 익명화가 놓쳤는지 보려고 훑는다.
# "비어 있어야 정상"이지, 값이 있다고 무조건 실제 인물인 것은 아니다 —
# 공개 샘플은 대개 'Anonymized' 같은 문자열이 들어 있다. 그래서 지우지 않고 **보여준다.**
IDENTIFYING = [
    "PatientName", "PatientID", "PatientBirthDate", "PatientAddress",
    "PatientTelephoneNumbers", "OtherPatientIDs", "OtherPatientNames",
    "ReferringPhysicianName", "PerformingPhysicianName", "OperatorsName",
    "InstitutionAddress", "AccessionNumber",
]


def iter_dicom(path_dir):
    """폴더 안의 .dcm과 zip 속 파일을 (이름, 바이트)로 흘려보낸다."""
    for z in sorted(glob.glob(os.path.join(path_dir, "*.zip"))):
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                if n.endswith("/"):
                    continue
                data = zf.read(n)
                # DICOM은 128바이트 preamble 뒤에 'DICM'이 온다. 아니면 건너뛴다
                # (zip 안에는 readme·미리보기 이미지가 섞여 있곤 하다).
                if len(data) > 132 and data[128:132] == b"DICM":
                    yield f"{os.path.basename(z)}:{n}", data
    for f in sorted(glob.glob(os.path.join(path_dir, "**", "*.dcm"), recursive=True)):
        with open(f, "rb") as fh:
            yield os.path.relpath(f, path_dir), fh.read()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(HERE, "..", "sample-data", "public"))
    ap.add_argument("--orthanc", default="http://localhost:8042")
    ap.add_argument("--institution", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    src = os.path.abspath(a.dir)
    if not os.path.isdir(src):
        os.makedirs(src, exist_ok=True)
        sys.exit(f"{src} 를 만들었습니다. 여기에 내려받은 zip을 넣고 다시 실행하세요.")

    auth = ("admin", "admin")
    studies = {}      # StudyInstanceUID -> 요약
    flagged = {}      # 태그명 -> 값 예시(중복 제거)
    payload = []      # (이름, 바이트) — dry-run이 아니면 업로드한다

    for name, raw in iter_dicom(src):
        try:
            ds = pydicom.dcmread(io.BytesIO(raw), stop_before_pixels=True, force=True)
        except Exception as e:
            print(f"  건너뜀 (읽기 실패): {name} — {e}")
            continue

        uid = getattr(ds, "StudyInstanceUID", "(없음)")
        s = studies.setdefault(uid, {
            "modality": set(), "series": set(), "n": 0,
            "desc": str(getattr(ds, "StudyDescription", "") or ""),
            "inst": str(getattr(ds, "InstitutionName", "") or ""),
            "date": str(getattr(ds, "StudyDate", "") or ""),
            "rows": getattr(ds, "Rows", None), "cols": getattr(ds, "Columns", None),
        })
        s["n"] += 1
        s["modality"].add(str(getattr(ds, "Modality", "?")))
        s["series"].add(str(getattr(ds, "SeriesInstanceUID", "?")))

        for tag in IDENTIFYING:
            v = getattr(ds, tag, None)
            if v not in (None, ""):
                flagged.setdefault(tag, set()).add(str(v)[:60])

        payload.append((name, raw))

    if not studies:
        sys.exit(f"{src} 에서 DICOM을 못 찾았습니다. zip 또는 .dcm을 넣어주세요.")

    print(f"\n== {src} ==")
    print(f"검사 {len(studies)}건 / 인스턴스 {sum(s['n'] for s in studies.values())}개\n")
    for uid, s in studies.items():
        print(f"  [{','.join(sorted(s['modality']))}] {s['desc'] or '(설명 없음)'}")
        print(f"      시리즈 {len(s['series'])} · 인스턴스 {s['n']} · {s['rows']}x{s['cols']} · {s['date']}")
        print(f"      InstitutionName: {s['inst'] or '(비어 있음)'}")
        print(f"      StudyInstanceUID: {uid}")

    print("\n== 사람을 가리킬 수 있는 태그 ==")
    if flagged:
        for tag, vals in sorted(flagged.items()):
            print(f"  {tag}: {', '.join(sorted(vals)[:3])}")
        print("\n  공개 샘플은 보통 'Anonymized' 같은 자리표시자가 들어 있다. 실제 사람 이름처럼")
        print("  보이는 것이 있으면 **올리지 말고** 그 파일을 빼라.")
    else:
        print("  없음")
    print("\n  ※ 태그가 깨끗해도 **픽셀에 글자가 구워져 있을 수 있다.** 업로드 뒤")
    print("     뷰어에서 첫 장과 중간 장을 눈으로 확인할 것.")

    if a.dry_run:
        print("\n--dry-run 이므로 업로드하지 않았습니다.")
        return

    if a.institution:
        print(f"\nInstitutionName을 \"{a.institution}\" 으로 바꿔서 올립니다.")
    else:
        print("\nInstitutionName을 그대로 둡니다 → 대부분 '미배정'이 되고,")
        print("관리자 계정 메뉴바 [⚠ 미배정]에서 배정하게 됩니다.")

    ok = fail = 0
    for name, raw in payload:
        body = raw
        if a.institution:
            ds = pydicom.dcmread(io.BytesIO(raw), force=True)
            # 한글을 넣으려면 **먼저** 문자셋을 선언해야 한다. 안 하면 DICOM 기본값이
            # ASCII(ISO_IR 6)라 "한림병원"이 "????"로 저장된다 — 경고 한 줄 없이.
            ds.SpecificCharacterSet = "ISO_IR 192"      # UTF-8
            ds.InstitutionName = a.institution
            buf = io.BytesIO()
            ds.save_as(buf, write_like_original=True)
            body = buf.getvalue()
        r = requests.post(f"{a.orthanc}/instances", data=body, auth=auth, timeout=60,
                          headers={"Content-Type": "application/dicom"})
        if r.status_code // 100 == 2:
            ok += 1
        else:
            fail += 1
            print(f"  실패 {r.status_code}: {name}")

    # 보낸 수와 저장된 수가 어긋나는 것이 원격판독에서 가장 흔한 사고다 (교훈 §10).
    print(f"\n업로드: 성공 {ok} / 실패 {fail}")
    if fail:
        sys.exit("일부가 저장되지 않았다. 보낸 수와 저장된 수가 다르면 그건 실패다.")
    print("Technician 탭에 SS=Unverified 로 뜬다. Verify해야 Radiology 탭에 올라온다.")
    print("기관명을 못 알아보면 어느 워크리스트에도 안 뜬다 → 관리자 [⚠ 미배정].")


if __name__ == "__main__":
    main()
