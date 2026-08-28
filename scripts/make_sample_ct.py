"""
합성 CT 시리즈 생성기 — 외부 다운로드 없이 실습용 DICOM을 만든다.

머리를 단순화한 팬텀(타원 두개골 + 뇌 + 병변 하나)을 60 슬라이스로 생성.
실제 CT처럼 HU(Hounsfield Unit) 값과 Rescale Slope/Intercept를 사용하므로
OHIF에서 윈도잉(W/L) 조작을 연습할 수 있다.

사용법:
    python3 make_sample_ct.py            # ../sample-data/ 에 60개 .dcm 생성
"""
import math
import os
from datetime import datetime

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "sample-data")
N_SLICES = 60
SIZE = 256           # 256 x 256 매트릭스
SLICE_THICKNESS = 2.5  # mm

# 시리즈 전체가 공유하는 UID (같은 Study/Series로 묶이게)
study_uid = generate_uid()
series_uid = generate_uid()
frame_of_reference_uid = generate_uid()
now = datetime.now()


def make_slice_pixels(z_frac: float) -> np.ndarray:
    """z_frac: 0.0(발끝쪽)~1.0(정수리쪽). HU 값의 2D 배열을 반환."""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    cx, cy = SIZE / 2, SIZE / 2

    # 슬라이스 위치에 따라 머리 단면 크기가 변함 (구에 가깝게).
    # 0.18~0.82 구간만 사용해 첫/마지막 슬라이스에도 의미 있는 단면이 보이게 함
    z_eff = 0.18 + 0.64 * z_frac
    head_scale = math.sin(math.pi * z_eff)
    rx, ry = 95 * head_scale, 110 * head_scale

    img = np.full((SIZE, SIZE), -1000.0)  # 공기

    if rx > 4:
        ellipse = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        img[ellipse <= 1.0] = 700.0            # 두개골 (뼈)
        inner = ((xx - cx) / (rx - 6)) ** 2 + ((yy - cy) / (ry - 6)) ** 2
        img[inner <= 1.0] = 40.0               # 뇌 실질
        # 뇌실 모양의 저음영 영역
        vent = ((xx - cx) / (rx * 0.25)) ** 2 + ((yy - (cy - 10)) / (ry * 0.12)) ** 2
        img[vent <= 1.0] = 8.0
        # 병변: 우측 상부에 고음영 결절 (중간 슬라이스 부근에서만)
        if 0.45 < z_frac < 0.62:
            lesion = (xx - (cx + rx * 0.45)) ** 2 + (yy - (cy - ry * 0.3)) ** 2
            img[lesion <= 8 ** 2] = 75.0

    # 약간의 노이즈로 실제 CT 질감 흉내
    img += np.random.default_rng(int(z_frac * 1000)).normal(0, 6, img.shape)
    return img


def make_dataset(index: int) -> Dataset:
    z_frac = index / (N_SLICES - 1)
    hu = make_slice_pixels(z_frac)

    # HU -> 저장 픽셀값: stored = (HU - intercept) / slope, 여기선 slope=1, intercept=-1024
    stored = np.clip(hu + 1024, 0, 4095).astype(np.uint16)

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = meta
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    # 환자/검사 정보 (가상의 인물)
    ds.PatientName = "KIN^Phantom"
    ds.PatientID = "KIN-0001"
    ds.PatientBirthDate = "19890101"
    ds.PatientSex = "M"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.FrameOfReferenceUID = frame_of_reference_uid
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "CT"
    ds.StudyDescription = "KIN Lab Synthetic Head CT"
    ds.SeriesDescription = "Axial 2.5mm (synthetic)"
    ds.StudyDate = now.strftime("%Y%m%d")
    ds.StudyTime = now.strftime("%H%M%S")
    ds.AccessionNumber = "KIN20260001"
    ds.StudyID = "1"
    ds.SeriesNumber = 1
    ds.InstanceNumber = index + 1

    # 기하 정보 — MPR(다면 재구성)이 되려면 정확해야 함
    ds.ImagePositionPatient = [-(SIZE / 2), -(SIZE / 2), index * SLICE_THICKNESS]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = SLICE_THICKNESS

    # 픽셀 표현
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = SIZE
    ds.Columns = SIZE
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 1
    ds.WindowCenter = 40    # 뇌 윈도우
    ds.WindowWidth = 80
    ds.PixelData = stored.tobytes()
    return ds


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for i in range(N_SLICES):
        ds = make_dataset(i)
        path = os.path.join(OUT_DIR, f"ct_{i + 1:03d}.dcm")
        try:
            ds.save_as(path, enforce_file_format=True)   # pydicom 3.x
        except TypeError:
            ds.save_as(path, write_like_original=False)  # pydicom 2.x
    print(f"OK: {N_SLICES}개 슬라이스 생성 → {os.path.abspath(OUT_DIR)}")


if __name__ == "__main__":
    main()
