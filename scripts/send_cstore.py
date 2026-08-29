"""
가짜 CT 장비가 되어 Orthanc에 **진짜 DICOM 프로토콜(C-STORE)로** 검사를 보낸다.

지금까지 검사를 넣는 길은 두 가지였다: REST로 업로드(`upload_samples.py`)하거나,
화면에서 "장비 수신 시뮬" 버튼을 눌러 localStorage에 가짜 행을 만드는 것.
둘 다 진짜 병원에서 일어나는 일이 아니다. 실제 CT/MR 장비는 HTTP를 모른다 —
DICOM 상위 프로토콜로 TCP 연결을 맺고(Association), 어떤 SOP Class를 어떤
전송구문으로 보낼지 협상한 뒤, C-STORE로 인스턴스를 하나씩 밀어넣는다.
이 스크립트가 그 장비 역할을 한다.

왜 중요한가: 5단계 Connect는 결국 "기관 사이를 오가는 전송"이고, 그 밑바닥이
이 협상과 C-STORE다. 여기서 AET·전송구문·거절 코드를 한 번 겪어두면
게이트웨이를 만들 때 처음 보는 개념이 없다.

DCMTK의 `storescu`와 하는 일이 같다. 윈도우에 DCMTK를 따로 깔지 않아도 되게
pynetdicom을 쓴다. DCMTK가 있다면 아래와 같다:

    storescu -aec KINLAB -aet HALLYM_CT localhost 4242 파일.dcm

준비:
    pip install pynetdicom

사용법:
    python3 send_cstore.py                                   # 한림병원 CT 1건
    python3 send_cstore.py --institution "KIN 판독센터"
    python3 send_cstore.py --name "HONG^GILDONG" --id P-1006 --slices 30
    python3 send_cstore.py --host 192.168.0.10 --port 4242
"""
import argparse
import sys

# 윈도우 콘솔은 기본이 CP949다. 출력에 CP949로 못 옮기는 글자가 하나라도 있으면
# UnicodeEncodeError로 죽고, **전송은 성공했는데 종료코드는 실패**가 된다.
# 스크립트를 자동화에 물릴 때 이게 제일 헷갈리는 실패다. 안내문 때문에 죽지 않게 한다.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from pydicom.uid import ExplicitVRLittleEndian, generate_uid

try:
    from pynetdicom import AE, debug_logger
    from pynetdicom.sop_class import CTImageStorage
except ImportError:
    sys.exit("pynetdicom이 필요합니다:  pip install pynetdicom")

import make_sample_ct as gen   # 같은 폴더의 팬텀 생성기 재사용

# C-STORE 응답 상태. 0x0000이 성공이고 나머지는 전부 거절·경고다.
# 장비가 "보냈다"고 말해도 이 값이 0이 아니면 안 들어간 것이다 —
# 전송 성공과 저장 성공은 다른 사건이다. (교훈 §10의 수량 불일치가 여기서 시작된다)
WARNING_CODES = {0xB000: "Coercion of Data Elements", 0xB007: "Data Set does not match SOP Class",
                 0xB006: "Element Discarded"}


def main() -> None:
    p = argparse.ArgumentParser(description="가짜 CT 장비 → Orthanc C-STORE")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=4242)
    p.add_argument("--called-aet", default="KINLAB", help="받는 쪽 AE Title (Orthanc의 DicomAet)")
    p.add_argument("--calling-aet", default=None, help="보내는 쪽 AE Title. 기본은 기관에 맞춰 정해진다")
    p.add_argument("--institution", default="한림병원", help="DICOM InstitutionName(0008,0080)")
    p.add_argument("--name", default="NEW^PATIENT", help="환자명 (성^이름)")
    p.add_argument("--id", dest="pid", default=None, help="환자 ID. 기본은 시각으로 자동 생성")
    p.add_argument("--birth", default="19800101")
    p.add_argument("--sex", default="M")
    p.add_argument("--desc", default="Brain CT (C-STORE)")
    p.add_argument("--slices", type=int, default=20)
    p.add_argument("--verbose", action="store_true", help="DICOM 협상 로그를 전부 보여준다")
    a = p.parse_args()

    if a.verbose:
        debug_logger()

    from datetime import datetime
    now = datetime.now()
    pid = a.pid or ("P-" + now.strftime("%m%d%H%M"))
    calling = a.calling_aet or ("KINC_CT" if "판독센터" in a.institution else "HALLYM_CT")

    # 검사 하나 = Study UID 하나. 안 바꾸면 기존 검사에 슬라이스가 덧붙는다.
    gen.N_SLICES = a.slices
    gen.study_uid = generate_uid()
    gen.series_uid = generate_uid()
    gen.frame_of_reference_uid = generate_uid()

    datasets = []
    for i in range(a.slices):
        ds = gen.make_dataset(i)
        ds.PatientName = a.name
        ds.PatientID = pid
        ds.PatientBirthDate = a.birth
        ds.PatientSex = a.sex
        ds.StudyDate = now.strftime("%Y%m%d")
        ds.StudyTime = now.strftime("%H%M%S")
        ds.StudyDescription = a.desc
        ds.AccessionNumber = "CS" + now.strftime("%y%m%d%H%M")
        ds.InstitutionName = a.institution     # 이 태그로 API가 소속 기관을 정한다
        datasets.append(ds)

    ae = AE(ae_title=calling)
    # 협상할 것을 미리 선언한다: "CT 영상을 Explicit VR Little Endian으로 보내겠다".
    # 받는 쪽이 이 조합을 받아주지 않으면 연결은 되어도 전송이 거절된다.
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)

    print(f"연결: {calling} → {a.called_aet}@{a.host}:{a.port}")
    assoc = ae.associate(a.host, a.port, ae_title=a.called_aet)
    if not assoc.is_established:
        sys.exit(
            "Association 실패 — 받는 쪽이 거절했거나 포트가 안 열렸다.\n"
            "  · docker compose ps 로 orthanc가 떠 있는지\n"
            "  · 4242 포트가 게시돼 있는지 (compose의 ports)\n"
            f"  · Called AE Title이 맞는지 (지금 '{a.called_aet}', Orthanc의 DicomAet과 같아야 한다)")

    ok = fail = 0
    for ds in datasets:
        st = assoc.send_c_store(ds)
        code = getattr(st, "Status", None)
        if code == 0x0000:
            ok += 1
        else:
            fail += 1
            note = WARNING_CODES.get(code, "")
            print(f"  거절/경고 0x{code:04X} {note} — {ds.SOPInstanceUID}")
    assoc.release()

    print(f"C-STORE 완료: 성공 {ok} / 실패 {fail}")
    print(f"  환자      {a.name} ({pid})")
    print(f"  기관      {a.institution}  (AET {calling})")
    print(f"  StudyUID  {gen.study_uid}")
    if fail:
        sys.exit("일부 인스턴스가 저장되지 않았다. 보낸 수와 저장된 수가 다르면 그건 실패다.")
    # 기관명을 API가 못 알아보면 이 검사는 **어느 워크리스트에도 안 뜬다.**
    # 그걸 모르고 "Technician 탭에서 보인다"고만 안내하면, 안 보이는 이유를
    # 엉뚱한 데서 찾게 된다. 등록된 별칭은 Institution.dicomNames에 있다.
    print(
        f'\n기관명 "{a.institution}"이 등록된 별칭과 맞으면 '
        "Technician 탭에 SS=Unverified 로 뜬다. Verify해야 Radiology 탭에 올라온다.\n"
        "맞지 않으면 **미배정**이 되어 어느 워크리스트에도 안 뜬다 — "
        "관리자 계정의 메뉴바 [⚠ 미배정]에서 배정하거나 별칭을 고칠 것.")


if __name__ == "__main__":
    main()
