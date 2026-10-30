#!/usr/bin/env python3
"""Count first-ingest DICOM header shapes locally; no pixel reads, archive writes or patient identifiers."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys
import pydicom


def census(root):
    counts = Counter()
    failed = 0
    paths = [root] if root.is_file() else sorted(root.rglob('*.dcm'))
    for path in paths:
        try:
            ds = pydicom.dcmread(path, stop_before_pixels=True)
            key = (str(getattr(ds, 'Manufacturer', '')), str(getattr(ds, 'ManufacturerModelName', '')),
                   str(getattr(ds, 'SOPClassUID', '')), str(ds.file_meta.TransferSyntaxUID),
                   tuple(getattr(ds, 'ImageType', [])), str(getattr(ds, 'BitsStored', '')),
                   str(getattr(ds, 'PixelRepresentation', '')), str(getattr(ds, 'PhotometricInterpretation', '')))
            counts[key] += 1
        except Exception:
            failed += 1
    names = ['vendor', 'model', 'sop_class', 'transfer_syntax', 'image_type', 'bits_stored', 'pixel_representation', 'photometric']
    return {'headers': [dict(zip(names, k), count=v) for k, v in sorted(counts.items())],
            'files': len(paths), 'unreadable': failed}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='One DICOM file or a directory of .dcm files')
    args = parser.parse_args()
    result = census(args.input)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(1 if not result['files'] or result['unreadable'] else 0)
