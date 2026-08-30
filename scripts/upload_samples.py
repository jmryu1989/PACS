"""
sample-data/ 의 DICOM 파일을 Orthanc REST API로 업로드한다.

사용법:
    python3 upload_samples.py                      # localhost:8042, 자격증명은 환경변수
    python3 upload_samples.py http://다른주소:8042  # 대상 지정
"""
import glob
import os
import sys

import requests
from orthanc_auth import orthanc_auth

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8042"
AUTH = orthanc_auth()
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "sample-data")


def main() -> None:
    files = sorted(glob.glob(os.path.join(DATA_DIR, "*.dcm")))
    if not files:
        sys.exit("sample-data/ 에 .dcm 파일이 없습니다. 먼저 make_sample_ct.py를 실행하세요.")

    ok = 0
    for path in files:
        with open(path, "rb") as f:
            r = requests.post(f"{BASE}/instances", data=f.read(),
                              auth=AUTH, timeout=30,
                              headers={"Content-Type": "application/dicom"})
        r.raise_for_status()
        ok += 1
    print(f"OK: {ok}개 업로드 완료 → {BASE}")

    studies = requests.get(f"{BASE}/studies", auth=AUTH, timeout=10).json()
    print(f"현재 Orthanc에 저장된 Study 수: {len(studies)}")
    for sid in studies:
        info = requests.get(f"{BASE}/studies/{sid}", auth=AUTH, timeout=10).json()
        tags = info.get("MainDicomTags", {})
        print(f"  - {tags.get('StudyDescription', '(no description)')} "
              f"/ StudyInstanceUID: {tags.get('StudyInstanceUID')}")


if __name__ == "__main__":
    main()
