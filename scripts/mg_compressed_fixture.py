#!/usr/bin/env python3
"""Local EA1141 compressed derivatives, streamed one frame at a time. Never imports into an archive.

Requires pydicom/numpy; Pillow OpenJPEG for J2K, pyjpegls for JPEG-LS,
python-gdcm for JPEG lossless SV1. Missing codecs remain NOT_RUN in the manifest.
Use --limit-objects 2 for one full DBT and one 2D object, omit for the whole corpus.
Source corpus/license stays local. Outputs are DERIVED test images, never clinical originals.
"""
import argparse
import copy
import hashlib
import io
import json
import shutil
import struct
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import pydicom
from pydicom.uid import ExplicitVRLittleEndian

SYNTAXES = {
    'jpeg2000-lossless': '1.2.840.10008.1.2.4.90',
    'jpeg2000': '1.2.840.10008.1.2.4.91',
    'jpegls-lossless': '1.2.840.10008.1.2.4.80',
    'jpeg-lossless-sv1': '1.2.840.10008.1.2.4.70',
    'rle': '1.2.840.10008.1.2.5',
}


def uid(value):
    return '2.25.' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'kin-mg-compressed-test/' + value).int)


def finish_metadata(ds, destination, pixel_offset, ratio=None):
    # Pillow/CharLS and the GDCM single-frame input encode 16-bit samples even when the source's useful
    # values occupy fewer bits. DICOM's declared precision must match that codestream; values stay unchanged.
    ds.BitsStored = 16
    ds.HighBit = 15
    if ratio is not None:
        ds.LossyImageCompressionRatio = str(round(ratio, 6))
    temporary = destination.with_suffix('.normalized.dcm')
    pydicom.dcmwrite(str(temporary), ds, write_like_original=False)
    final_offset = temporary.stat().st_size
    with destination.open('rb') as src, temporary.open('ab') as out:
        src.seek(pixel_offset)
        shutil.copyfileobj(src, out, length=1024 * 1024)
    temporary.replace(destination)
    return final_offset


def encoder(name, scratch, bits_stored=16):
    if name.startswith('jpeg2000') and bits_stored == 16:
        from PIL import Image, features
        if not features.check('jpg_2000'):
            raise RuntimeError('Pillow OpenJPEG codec missing')
        def encode(array):
            target = io.BytesIO()
            options = {'no_jp2': True, 'irreversible': name == 'jpeg2000'}
            if name == 'jpeg2000':
                options.update(quality_mode='rates', quality_layers=[8])
            Image.fromarray(array).save(target, format='JPEG2000', **options)
            data = target.getvalue()
            decoded = np.array(Image.open(io.BytesIO(data)))
            if name.endswith('lossless') and not np.array_equal(array, decoded):
                raise ValueError('JPEG 2000 lossless pixel mismatch')
            return data, {'max_absolute_error': int(np.abs(array.astype('int32') - decoded.astype('int32')).max())}
        return encode
    if name == 'rle':
        from pydicom.pixel_data_handlers.rle_handler import rle_encode_frame, _rle_decode_frame
        def encode(array):
            data = bytes(rle_encode_frame(array))
            decoded = np.frombuffer(_rle_decode_frame(data, *array.shape, 1, 16), dtype='<u2').reshape(array.shape)
            if not np.array_equal(array, decoded):
                raise ValueError('RLE lossless pixel mismatch')
            return data, {'max_absolute_error': 0}
        return encode
    if name == 'jpegls-lossless' and bits_stored == 16:
        import jpeg_ls
        def encode(array):
            data = bytes(jpeg_ls.encode(array, 0))
            decoded = jpeg_ls.decode(np.frombuffer(data, dtype='uint8'))
            if not np.array_equal(array, decoded):
                raise ValueError('JPEG-LS lossless pixel mismatch')
            return data, {'max_absolute_error': 0}
        return encode
    import gdcm
    def encode(array):
        from pydicom.dataset import FileDataset, FileMetaDataset
        from pydicom.encaps import generate_pixel_data_frame
        meta = FileMetaDataset()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID = pydicom.uid.SecondaryCaptureImageStorage
        meta.MediaStorageSOPInstanceUID = uid('codec-frame')
        ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
        ds.SOPClassUID = meta.MediaStorageSOPClassUID
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.Rows, ds.Columns = array.shape
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 16
        ds.BitsStored = bits_stored
        ds.HighBit = bits_stored - 1
        ds.PixelRepresentation = 0
        ds.PixelData = array.tobytes()
        ds.is_little_endian = True
        ds.is_implicit_VR = False
        source, target = scratch / 'codec-input.dcm', scratch / 'codec-output.dcm'
        pydicom.dcmwrite(str(source), ds, write_like_original=False)
        reader = gdcm.ImageReader(); reader.SetFileName(str(source))
        if not reader.Read(): raise RuntimeError('GDCM input read failed')
        change = gdcm.ImageChangeTransferSyntax()
        # Unlike Pillow's uint16 path, GDCM receives the actual stored precision. The vendor
        # fixtures must test 10/12/14-bit codestreams, not a 16-bit stream relabelled afterwards.
        syntax = {'jpeg-lossless-sv1': 'JPEGLosslessProcess14_1', 'jpegls-lossless': 'JPEGLSLossless',
                  'jpeg2000-lossless': 'JPEG2000Lossless', 'jpeg-extended': 'JPEGExtendedProcess2_4'}[name]
        change.SetTransferSyntax(gdcm.TransferSyntax(getattr(gdcm.TransferSyntax, syntax)))
        change.SetInput(reader.GetImage())
        if not change.Change(): raise RuntimeError('GDCM ' + name + ' encode failed')
        writer = gdcm.ImageWriter(); writer.SetFileName(str(target))
        writer.SetFile(reader.GetFile()); writer.SetImage(change.GetOutput())
        if not writer.Write(): raise RuntimeError('GDCM output write failed')
        compressed = pydicom.dcmread(str(target))
        expected_syntax = '1.2.840.10008.1.2.4.51' if name == 'jpeg-extended' else SYNTAXES[name]
        if str(compressed.file_meta.TransferSyntaxUID) != expected_syntax: raise ValueError('wrong codec syntax')
        decoded = compressed.pixel_array
        error = int(np.abs(array.astype('int32') - decoded.astype('int32')).max())
        if name != 'jpeg-extended' and error: raise ValueError(name + ' lossless pixel mismatch')
        return next(generate_pixel_data_frame(compressed.PixelData)), {'max_absolute_error': error}
    return encode


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--limit-objects', type=int)
    parser.add_argument('--max-frames', type=int, help='Optional smoke subset; manifest records the reduced frame count')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    paths = sorted((args.corpus / 'studies').rglob('*.dcm'), key=lambda p: p.stat().st_size)
    if args.limit_objects == 2: paths = [paths[0], paths[-1]]
    elif args.limit_objects: paths = paths[:args.limit_objects]
    manifest = {'corpus': str(args.corpus), 'pydicom_version': pydicom.__version__, 'records': records,
                'attribution': 'Comstock et al. (2023), EA1141 Version 2, TCIA, DOI 10.7937/2BAS-HR33, CC BY 4.0.',
                'use': 'Local DERIVED test fixtures only. Lossy JPEG2000 is explicitly marked. No archive import.'}
    def save(): (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    for source in paths:
        with source.open('rb') as stream:
            original = pydicom.dcmread(stream, stop_before_pixels=True)
            pixel_offset = stream.tell()
            if str(original.file_meta.TransferSyntaxUID) != str(ExplicitVRLittleEndian): raise ValueError('source is not explicit LE')
            header = stream.read(12)
            if header[:4] != b'\xe0\x7f\x10\x00': raise ValueError('source pixel offset mismatch')
        count = int(getattr(original, 'NumberOfFrames', 1))
        selected = min(count, args.max_frames) if args.max_frames else count
        frame_bytes = int(original.Rows) * int(original.Columns) * 2
        if int(original.BitsAllocated) != 16 or int(original.SamplesPerPixel) != 1 or int(original.PixelRepresentation) != 0:
            raise ValueError('unsupported source geometry')
        for name, syntax in SYNTAXES.items():
            record = {'source': str(source.relative_to(args.corpus)), 'syntax': syntax, 'name': name,
                      'source_frames': count, 'frames': selected, 'source_bytes': source.stat().st_size,
                      'rows': int(original.Rows), 'columns': int(original.Columns), 'frame_bytes': frame_bytes,
                      'status': 'running'}
            records.append(record); save()
            started = time.perf_counter()
            try:
                encode = encoder(name, args.output)
                ds = copy.deepcopy(original)
                for tag in ['ExtendedOffsetTable', 'ExtendedOffsetTableLengths']:
                    if tag in ds: del ds[tag]
                ds.PatientName = 'SYNTHETIC^MG-COMPRESSED'
                ds.PatientID = 'SYN-MG-COMPRESSED'
                ds.InstitutionName = 'SYNTHETIC LOCAL TEST'
                ds.StudyInstanceUID = uid(str(original.StudyInstanceUID) + name)
                ds.SeriesInstanceUID = uid(str(original.SeriesInstanceUID) + name)
                ds.SOPInstanceUID = uid(str(original.SOPInstanceUID) + name)
                ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
                ds.file_meta.TransferSyntaxUID = syntax
                ds.ImageType = ['DERIVED', 'SECONDARY']
                ds.DerivationDescription = 'Local compression test derived from public EA1141; not for clinical use'
                ds.NumberOfFrames = selected
                if 'PerFrameFunctionalGroupsSequence' in ds:
                    ds.PerFrameFunctionalGroupsSequence = ds.PerFrameFunctionalGroupsSequence[:selected]
                if name == 'jpeg2000':
                    ds.LossyImageCompression = '01'
                    ds.LossyImageCompressionMethod = 'ISO_15444_1'
                    ds.LossyImageCompressionRatio = '8'
                destination = args.output / (str(ds.SOPInstanceUID) + '.dcm')
                ds.is_implicit_VR = False; ds.is_little_endian = True
                pydicom.dcmwrite(str(destination), ds, write_like_original=False)
                stored_offset = destination.stat().st_size
                hashes = []; offsets = []; sizes = []; errors = []
                with source.open('rb') as src, destination.open('r+b') as out:
                    out.seek(0, 2); out.write(b'\xe0\x7f\x10\x00OB\0\0\xff\xff\xff\xff')
                    out.write(struct.pack('<HHI', 0xfffe, 0xe000, selected * 4))
                    table_at = out.tell(); out.write(b'\0' * (selected * 4)); base = out.tell()
                    src.seek(pixel_offset + 12)
                    for frame in range(selected):
                        raw = src.read(frame_bytes)
                        if len(raw) != frame_bytes: raise ValueError('short source frame')
                        pixels = np.frombuffer(raw, dtype='<u2').reshape(int(ds.Rows), int(ds.Columns))
                        data, accuracy = encode(pixels)
                        if len(data) % 2: data += b'\0'
                        offsets.append(out.tell() - base); sizes.append(len(data))
                        out.write(struct.pack('<HHI', 0xfffe, 0xe000, len(data))); out.write(data)
                        hashes.append(hashlib.sha256(data).hexdigest()); errors.append(accuracy['max_absolute_error'])
                        print(name, selected, 'frame', frame + 1, 'bytes', len(data), flush=True)
                    out.write(struct.pack('<HHI', 0xfffe, 0xe0dd, 0)); out.seek(table_at)
                    out.write(struct.pack('<' + 'I' * selected, *offsets))
                stored_offset = finish_metadata(ds, destination, stored_offset,
                    frame_bytes * selected / sum(sizes) if name == 'jpeg2000' else None)
                record.update(status='complete', file=str(destination.resolve()), pixel_data_offset=stored_offset,
                              bytes=destination.stat().st_size, encoded_frame_bytes=sizes, frame_sha256=hashes,
                              decoded_max_absolute_error=max(errors), study=str(ds.StudyInstanceUID),
                              series=str(ds.SeriesInstanceUID), sop=str(ds.SOPInstanceUID),
                              photometric=str(ds.PhotometricInterpretation), bits_stored=int(ds.BitsStored))
            except (ImportError, RuntimeError, ValueError) as error:
                record.update(status='NOT_RUN' if isinstance(error, ImportError) else 'FAILED', error=str(error))
                print(name, record['status'], str(error), flush=True)
            finally:
                record['generation_seconds'] = time.perf_counter() - started; save()
    return 0 if all(r['status'] == 'complete' for r in records) else 1


if __name__ == '__main__':
    raise SystemExit(main())
