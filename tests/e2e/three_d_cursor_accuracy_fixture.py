# coding: utf-8
"""Owned synthetic DICOM whose patient coordinates are known exactly (TEST-3D-CURSOR-ACCURACY).

Four classic CT series share one study, one patient and — except where a refusal is the point —
one FrameOfReferenceUID:

  AXIAL    IOP [1,0,0, 0,1,0]      PixelSpacing [0.7, 0.9] (row, column), 3.0 mm slice gap
  OBLIQUE  IOP [1,0,0, 0,0.8,0.6]  PixelSpacing [1.0, 1.0], 1.0 mm slice gap
  FOREIGN  a different FrameOfReferenceUID, otherwise valid
  SKEWED   ImageOrientationPatient whose column cosines are neither unit nor orthogonal

AXIAL carries an anisotropic voxel (0.9 x 0.7 x 3.0 mm) with row and column spacing deliberately
different, so a row/column swap cannot cancel out; OBLIQUE carries an isotropic 1.0 mm voxel.
OBLIQUE is a *normal* oblique: its direction cosines are orthonormal, it is simply not at 90
degrees to AXIAL, so it must be transported to, not refused (DICOM PS3.3 C.7.6.2). Every cosine
here is exactly representable in decimal, so the number a scanner would store, the number Orthanc
returns and the number this module computes with are the same number, and no comparison spends
its tolerance budget on the fixture itself.

Every slice of every series carries three saturated fiducial squares at fixed, asymmetric pixel
positions in three different sizes. A test measures the image-pixel -> screen affine from those
three squares alone, so no product or renderer transform is trusted when a click position or an
expected marker position is computed. A pick target is a fourth, larger saturated square present
on exactly one slice of one series. Nothing else in the phantom reaches the saturation threshold.
"""
import time

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE

from invariants_live import Fixture

ROWS = COLUMNS = 256
SATURATED = 3000          # stored value; with the tags below this clips to pure white
# Kept well inside the frame: the pinned viewer preserves the camera across a window resize, so a
# fiducial near the edge leaves the canvas as soon as the image is zoomed or the pane is narrowed,
# and an affine can no longer be measured. Non-collinear by a wide margin, and four clearly distinct
# sizes so a rotated or flipped frame still identifies each square by area alone. Large enough that
# the centroid of a square is worth well under a tenth of an image pixel.
FIDUCIALS = (
    {"name": "f0", "column": 44, "row": 38, "half": 2},     # 5x5
    {"name": "f1", "column": 212, "row": 58, "half": 4},    # 9x9
    {"name": "f2", "column": 52, "row": 206, "half": 6},    # 13x13
)
TARGET_HALF = 8                                             # 17x17, the largest square in any frame

SERIES = {
    "AXIAL": dict(number=1, description="ACC axial", orientation=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                  spacing=[0.7, 0.9], gap=3.0, origin=[-101.3, -88.7, -15.0], slices=24, own_frame=False),
    "OBLIQUE": dict(number=2, description="ACC oblique", orientation=[1.0, 0.0, 0.0, 0.0, 0.8, 0.6],
                    spacing=[1.0, 1.0], gap=1.0, origin=[-120.0, -95.556, -79.392], slices=48, own_frame=False),
    "FOREIGN": dict(number=3, description="ACC foreign frame", orientation=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                    spacing=[0.8, 0.8], gap=3.0, origin=[-100.0, -100.0, -6.0], slices=6, own_frame=True),
    "SKEWED": dict(number=4, description="ACC skewed axes", orientation=[1.0, 0.0, 0.0, 0.0, 1.0, 0.3],
                   spacing=[0.8, 0.8], gap=3.0, origin=[-100.0, -100.0, -6.0], slices=6, own_frame=False),
}

# Pick targets, named by the series they are picked from. Column/row are exact pixel indices and
# slice is the DICOM index within that series, so each target's patient coordinate is a voxel
# centre this module never has to approximate.
TARGETS = (
    {"id": "A1", "series": "AXIAL", "column": 64, "row": 48, "slice": 5},
    {"id": "A2", "series": "AXIAL", "column": 181, "row": 77, "slice": 11},
    {"id": "A3", "series": "AXIAL", "column": 97, "row": 190, "slice": 16},
    {"id": "A4", "series": "AXIAL", "column": 203, "row": 141, "slice": 19},
    {"id": "B1", "series": "OBLIQUE", "column": 60, "row": 150, "slice": 12},
    {"id": "B2", "series": "OBLIQUE", "column": 150, "row": 95, "slice": 30},
    {"id": "B3", "series": "OBLIQUE", "column": 220, "row": 120, "slice": 22},
)


def stored(value, digits=12):
    """The float a receiver actually reads back after DICOM decimal-string serialization."""
    return float(format(float(value), "." + str(digits) + "g"))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def unit(a):
    length = dot(a, a) ** 0.5
    return [x / length for x in a]


def _square(pixels, column, row, half, value):
    pixels[row - half:row + half + 1, column - half:column + half + 1] = value


def _frame(name, index):
    """One asymmetric slice. Only fiducials and the pick target reach the saturation threshold."""
    yy, xx = np.mgrid[:ROWS, :COLUMNS]
    # Deliberately dim: the whole body must stay below the threshold that isolates the squares, with
    # margin left for the renderer's interpolation, so a saturated region is never anatomy.
    body = 250.0 + xx * 0.35 + yy * 0.5 + index * 3
    body = np.where((xx - 96) ** 2 / 110.0 ** 2 + (yy - 136) ** 2 / 92.0 ** 2 < 1, body + 180, body)
    pixels = body.astype(np.uint16)
    # A per-slice ruler makes a wrong frame visible in a screenshot without being bright enough
    # to be mistaken for a fiducial by the threshold the tests use.
    pixels[8:13, 40:40 + (index + 1) * 3] = 900
    for mark in FIDUCIALS:
        _square(pixels, mark["column"], mark["row"], mark["half"], SATURATED)
    for target in TARGETS:
        if target["series"] == name and target["slice"] == index:
            _square(pixels, target["column"], target["row"], TARGET_HALF, SATURATED)
    return pixels


def geometry(name):
    """This module's own record of what it wrote, in the precision a receiver reads back."""
    definition = SERIES[name]
    orientation = [stored(value, 10) for value in definition["orientation"]]
    spacing = [stored(value, 10) for value in definition["spacing"]]
    normal = unit(cross(orientation[:3], orientation[3:]))
    origin = definition["origin"]
    positions = [[stored(origin[axis] + index * definition["gap"] * normal[axis])
                  for axis in range(3)] for index in range(definition["slices"])]
    return dict(name=name, description=definition["description"], orientation=orientation,
                spacing=spacing, gap=definition["gap"], normal=normal, positions=positions,
                rows=ROWS, columns=COLUMNS, slices=definition["slices"])


def world(plane, index, column, row):
    """Patient coordinate of a pixel centre, straight from the tags: IPP + i*ds*u + j*dr*v."""
    position, u, v = plane["positions"][index], plane["orientation"][:3], plane["orientation"][3:]
    step_column, step_row = plane["spacing"][1], plane["spacing"][0]
    return [position[axis] + column * step_column * u[axis] + row * step_row * v[axis] for axis in range(3)]


def project(plane, point):
    """Where `point` falls on this stack: nearest slice, its separation, and the in-plane pixel."""
    u, v, normal = plane["orientation"][:3], plane["orientation"][3:], plane["normal"]
    along = dot(point, normal)
    offsets = [abs(along - dot(position, normal)) for position in plane["positions"]]
    index = min(range(len(offsets)), key=lambda i: offsets[i])
    delta = [point[axis] - plane["positions"][index][axis] for axis in range(3)]
    ordered = sorted(offsets)
    return dict(index=index, separation=offsets[index],
                column=dot(delta, u) / plane["spacing"][1], row=dot(delta, v) / plane["spacing"][0],
                runnerUp=ordered[1] if len(ordered) > 1 else None)


def build(stack, patient, label="accuracy"):
    """C-STORE the four series as one study and return (fixture, specification)."""
    study, frame, foreign_frame = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(study, patient, "한림병원", "jmryu", "D-3DCURSOR-ACC-" + label)
    # Register before the first write so any partial C-STORE is owned by cleanup.
    stack.active[study] = fixture
    specification = {"study": study, "frameOfReference": frame, "foreignFrameOfReference": foreign_frame,
                     "patientId": patient, "series": {}, "targets": []}
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    association = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not association.is_established:
        raise RuntimeError("Local synthetic CT association failed")
    try:
        for name, definition in SERIES.items():
            plane = geometry(name)
            series_uid = generate_uid()
            plane.update(seriesInstanceUID=series_uid, frameOfReferenceUID=foreign_frame if definition["own_frame"] else frame,
                         sopInstanceUIDs=[])
            for index in range(definition["slices"]):
                sop = generate_uid()
                plane["sopInstanceUIDs"].append(sop)
                meta = FileMetaDataset()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                meta.MediaStorageSOPClassUID = CTImageStorage
                meta.MediaStorageSOPInstanceUID = sop
                meta.ImplementationClassUID = generate_uid()
                ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
                ds.is_little_endian, ds.is_implicit_VR = True, False
                ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
                ds.SpecificCharacterSet = "ISO_IR 192"
                ds.PatientName, ds.PatientID = "D3DACC^SYNTHETIC", patient
                ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
                ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series_uid
                ds.FrameOfReferenceUID = plane["frameOfReferenceUID"]
                ds.StudyDate = ds.SeriesDate = "20260801"
                ds.StudyTime = ds.SeriesTime = "120000"
                ds.AccessionNumber, ds.StudyID = "D3DACC", "D3DACC"
                ds.StudyDescription = "D3DACC accuracy"
                ds.SeriesDescription = definition["description"]
                ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", definition["number"], index + 1
                ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
                ds.ImageOrientationPatient = [format(value, ".10g") for value in definition["orientation"]]
                ds.ImagePositionPatient = [format(value, ".12g") for value in plane["positions"][index]]
                ds.PixelSpacing = [format(value, ".10g") for value in definition["spacing"]]
                ds.SliceThickness = ds.SpacingBetweenSlices = definition["gap"]
                ds.Rows, ds.Columns = ROWS, COLUMNS
                ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
                ds.BitsAllocated = ds.BitsStored = 16
                ds.HighBit, ds.PixelRepresentation = 15, 0
                # Window 2000 @ 0 HU with intercept -1000: the phantom body stays below a third of
                # full scale and only the 3000-valued squares clip to white.
                ds.WindowCenter, ds.WindowWidth = 0, 2000
                ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1000, 1, "HU"
                ds.PixelData = _frame(name, index).astype("<u2").tobytes()
                status = association.send_c_store(ds)
                if status is None or status.Status != 0:
                    raise RuntimeError("Synthetic accuracy CT C-STORE failed")
            specification["series"][name] = plane
    finally:
        association.release()
    for target in TARGETS:
        plane = specification["series"][target["series"]]
        specification["targets"].append(dict(target, world=world(plane, target["slice"], target["column"], target["row"]),
                                             sop=plane["sopInstanceUIDs"][target["slice"]]))
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(row.get("uid") == study for row in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic accuracy CT did not reach the real API")
    if stack.request("PATCH", "/studies/" + study, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic accuracy CT verification failed")
    return fixture, specification
