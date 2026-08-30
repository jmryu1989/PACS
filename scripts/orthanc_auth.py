"""도구마다 기본 비밀번호를 복제하지 않아 교체 누락을 한 곳에서 차단한다."""
import os
import sys


def orthanc_auth() -> tuple[str, str]:
    user = os.environ.get("ORTHANC_USER", "admin")
    password = os.environ.get("ORTHANC_PASS")
    if not password:
        sys.exit("ORTHANC_PASS 환경변수를 설정하세요 (.env의 값을 셸에 내보내야 합니다).")
    return user, password
