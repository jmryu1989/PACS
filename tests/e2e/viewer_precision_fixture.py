# coding: utf-8
"""Owned synthetic fixture adapted from fixed product test_prior_selection.py."""
import time
import numpy as np
from pydicom.dataset import FileDataset,FileMetaDataset
from pydicom.uid import CTImageStorage,ExplicitVRLittleEndian,generate_uid
from pynetdicom import AE
from invariants_live import Fixture

def synthetic_ct(stack, patient, label, date, position, orientation, spacing, slices=2):
    """D00's asymmetric 256px phantom, with real StudyDate before C-STORE."""
    uid, series, frame = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(uid, patient, "한림병원", "jmryu", "D05C5-SYNTHETIC-" + label)
    # Register before the first write so any partial C-STORE is owned by cleanup.
    stack.active[uid] = fixture
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic CT association failed")
    try:
        for z in range(slices):
            sop = generate_uid()
            meta = FileMetaDataset()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.MediaStorageSOPClassUID = CTImageStorage
            meta.MediaStorageSOPInstanceUID = sop
            meta.ImplementationClassUID = generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.is_little_endian, ds.is_implicit_VR = True, False
            ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
            ds.SpecificCharacterSet = "ISO_IR 192"
            ds.PatientName, ds.PatientID = "D05C5^SYNTHETIC", patient
            ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = uid, series, frame
            ds.StudyDate = ds.SeriesDate = date
            ds.StudyTime = ds.SeriesTime = "120000"
            ds.AccessionNumber, ds.StudyID = "D5C5" + label[:12], "D05C5"
            ds.StudyDescription = ds.SeriesDescription = "D05C5 " + label
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", 1, z + 1
            ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
            # Serialize bounded DS text; analysis later reads actual Orthanc DICOM bytes.
            u,v=orientation[:3],orientation[3:]
            normal=np.cross(u,v); normal=normal/np.linalg.norm(normal)
            ds.ImageOrientationPatient=[format(x,'.10g') for x in orientation]
            ds.ImagePositionPatient=[format(position[k]+z*2*normal[k],'.12g') for k in range(3)]
            ds.PixelSpacing=[format(x,'.10g') for x in spacing]
            ds.SliceThickness = ds.SpacingBetweenSlices = 2
            ds.Rows = ds.Columns = 256
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated = ds.BitsStored = 16
            ds.HighBit, ds.PixelRepresentation = 15, 0
            ds.WindowCenter, ds.WindowWidth = -500, 1000
            ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1000, 1, "HU"
            yy, xx = np.mgrid[:256, :256]
            pixels = np.where((xx - 125) ** 2 + (yy - 128) ** 2 < 95 ** 2, 300 + xx * 2, 0).astype(np.uint16)
            pixels[50:82, 45:88], pixels[145:171, 178:194], pixels[205:214, 60:120] = 950, 750, 500
            pixels[105:116, 35:45], pixels[190:200, 30:30 + (z + 1) * 9] = 1000, 1000
            ds.PixelData = pixels.astype("<u2").tobytes()
            status = assoc.send_c_store(ds)
            if status is None or status.Status != 0:
                raise RuntimeError("Synthetic CT C-STORE failed")
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic CT did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic CT verification failed")
    return fixture

