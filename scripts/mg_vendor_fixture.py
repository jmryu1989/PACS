#!/usr/bin/env python3
"""Create only synthetic MG vendor phantoms. No archive connection or patient input.

Uses the #295 encoder for compressed frames. Requires the existing fixture dependencies
(pydicom/numpy and GDCM for precision-aware compression); unavailable encoders are NOT_RUN.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.encaps import encapsulate
from mg_compressed_fixture import encoder, SYNTAXES

ROOT = Path(__file__).resolve().parents[1]
SYNTAXES = {**SYNTAXES, 'explicit-le': '1.2.840.10008.1.2.1', 'implicit-le': '1.2.840.10008.1.2',
            'explicit-be': '1.2.840.10008.1.2.2', 'jpeg-extended': '1.2.840.10008.1.2.4.51'}


def precision(data):
    """Read the component precision declared by JPEG SOF / JPEG 2000 SIZ, before image data."""
    if data[:4] == b'\xff\x4f\xff\x51':
        return (data[42] & 127) + 1
    if data[:2] != b'\xff\xd8':
        raise ValueError('not a JPEG/JPEG-LS/J2K codestream')
    offset = 2
    while offset + 5 < len(data):
        if data[offset] != 255:
            raise ValueError('invalid JPEG marker')
        marker = data[offset + 1]
        if marker in (0xc0, 0xc1, 0xc3, 0xf7):
            return data[offset + 4]
        if marker == 0xda:
            break
        length = int.from_bytes(data[offset + 2:offset + 4], 'big')
        if length < 2:
            break
        offset += length + 2
    raise ValueError('missing precision marker')


def pixels(ds, frame):
    high = 2 ** int(ds.BitsStored) - 1
    data = np.linspace(0, high, int(ds.Rows) * int(ds.Columns), dtype=np.uint16).reshape(ds.Rows, ds.Columns)
    data = np.roll(data, frame, axis=0).copy()
    # Includes LUT boundary values, both extrema and high-bit values, on every frame.
    data[0, :12] = [0, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, high]
    return data


def make_dataset(case, syntax_index, instance):
    ds = FileDataset(None, {}, file_meta=FileMetaDataset(), preamble=b'\0' * 128)
    ds.update(Dataset.from_json(case['dicom']))
    ds.PatientName = 'MGVENDOR^SYNTHETIC'
    ds.InstitutionName = 'SYNTHETIC LOCAL TEST'
    ds.SeriesDescription = 'Synthetic ' + case['id']
    ds.StudyInstanceUID += '.' + str(syntax_index)
    ds.SeriesInstanceUID = ds.StudyInstanceUID + '.1'
    ds.SOPInstanceUID = ds.SeriesInstanceUID + '.' + str(instance + 1)
    ds.InstanceNumber = instance + 1
    if case['instances'] > 1:
        ds.ImagePositionPatient = [0, 0, instance]
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    return ds


def generate(output, native_only=False):
    output.mkdir(parents=True, exist_ok=False)
    spec = json.loads((ROOT / 'tests/fixtures/mg_vendor_cases.json').read_text(encoding='utf-8'))
    report = {'sources': spec['sources'], 'pydicom': pydicom.__version__, 'numpy': np.__version__,
              'synthetic_only': True, 'served': 'NOT_RUN', 'records': []}
    for case in spec['cases']:
        for index, name in enumerate(case['syntaxes'], 1):
            if native_only and name.startswith('jpeg'):
                continue
            for instance in range(case['instances']):
                row = {'case': case['id'], 'syntax': name, 'transfer_syntax': SYNTAXES[name],
                       'instance': instance + 1, 'status': 'RUNNING'}
                report['records'].append(row)
                try:
                    ds = make_dataset(case, index, instance)
                    count = int(getattr(ds, 'NumberOfFrames', 1))
                    arrays = [pixels(ds, i + instance) for i in range(count)]
                    row.update(bits_stored=int(ds.BitsStored), frames=count, sop=str(ds.SOPInstanceUID))
                    compressed = name.startswith('jpeg')
                    if compressed:
                        encode = encoder(name, output, bits_stored=int(ds.BitsStored))
                        encoded = [encode(a) for a in arrays]
                        precisions = [precision(data) for data, _ in encoded]
                        if any(p != ds.BitsStored for p in precisions):
                            raise ValueError('codestream precision differs from BitsStored: ' + str(precisions))
                        ds.PixelData = encapsulate([data for data, _ in encoded])
                        ds['PixelData'].is_undefined_length = True
                        row.update(codestream_precision=precisions, encoder_errors=[error for _, error in encoded])
                        if name == 'jpeg-extended':
                            ds.ImageType[0] = 'DERIVED'
                            for group in getattr(ds, 'PerFrameFunctionalGroupsSequence', []):
                                for frame_type in getattr(group, 'XRay3DFrameTypeSequence', []):
                                    frame_type.FrameType[0] = 'DERIVED'
                            ds.LossyImageCompression = '01'
                            ds.LossyImageCompressionMethod = 'ISO_10918_1'
                            ds.LossyImageCompressionRatio = str(round(sum(a.nbytes for a in arrays) / sum(len(d) for d, _ in encoded), 5))
                    else:
                        ds.PixelData = b''.join(a.astype('>u2' if name == 'explicit-be' else '<u2').tobytes() for a in arrays)
                    ds.is_little_endian = name != 'explicit-be'
                    ds.is_implicit_VR = name == 'implicit-le'
                    ds.file_meta.TransferSyntaxUID = SYNTAXES[name]
                    path = output / (case['id'] + '-' + name + '-' + str(instance + 1) + '.dcm')
                    ds.save_as(path, write_like_original=False)
                    saved = pydicom.dcmread(path)
                    decoded = saved.pixel_array.reshape(count, ds.Rows, ds.Columns)
                    if name != 'jpeg-extended' and not np.array_equal(decoded, np.stack(arrays)):
                        raise ValueError('stored pixel round-trip mismatch')
                    row.update(status='PASS', path=path.name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                               reference_sha256=[hashlib.sha256(a.astype('<u2').tobytes()).hexdigest() for a in arrays])
                except (ImportError, ModuleNotFoundError) as error:
                    row.update(status='NOT_RUN', reason=str(error))
                except Exception as error:
                    row.update(status='FAIL', reason=str(error))
    (output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-only', action='store_true')
    args = parser.parse_args()
    result = generate(args.output, args.native_only)
    totals = {status: sum(r['status'] == status for r in result['records']) for status in ['PASS', 'FAIL', 'NOT_RUN']}
    print(json.dumps(totals))
    sys.exit(1 if totals['FAIL'] else 2 if totals['NOT_RUN'] else 0)
