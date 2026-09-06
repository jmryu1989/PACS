"""C12M worker: bind a frozen synthetic store to its real DICOM study UID."""
import io
import json
import os
import re
import sys
import tarfile

import ops_orthanc_transfer_worker as base


def study_uid(instance):
    tags = base.strict_json(base.call('/instances/'+instance+'/simplified-tags'))
    value = tags['StudyInstanceUID']
    base.require(type(value) is str and len(value) <= 64
                 and re.fullmatch(r'[0-9]+(?:\.[0-9]+)+', value))
    return value


def produce():
    process = base.start()
    try:
        created = base.strict_json(base.call('/tools/create-dicom', dict(Tags={
            'PatientID': 'SYNTHETIC-C12K', 'PatientName': 'SYNTHETIC^C12K', 'Modality': 'OT'}, Force=True)))
        instance = created['ID']
        for kind, data in base.SAMPLES.items():
            base.call('/instances/'+instance+'/attachments/'+str(kind), data, 'PUT')
        uid = study_uid(instance)
    finally:
        # Capture the DICOM UID before freezing, never substitute Orthanc's ID.
        base.stop(process)
    snapshot = base.observe(instance)
    with tarfile.open(base.ROOT/'store.tar', 'w', format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(snapshot['files']):
            value = (base.ROOT/name).read_bytes()
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(value), 0o600
            archive.addfile(member, io.BytesIO(value))
    originals = base.archive_files((base.ROOT/'store.tar').read_bytes(), snapshot)
    process = base.start()
    try:
        base.verify_rest(snapshot, originals)
        base.require(study_uid(instance) == uid)
    finally:
        base.stop(process)
    return dict(snapshot=snapshot, study_uid=uid)


def consume(body, raw):
    base.require(type(body) is dict and set(body) == {'snapshot', 'study_uid'})
    result = base.consume(body['snapshot'], raw)
    process = base.start()
    try:
        base.require(study_uid(body['snapshot']['instance']) == body['study_uid'])
    finally:
        base.stop(process)
    return dict(result, study_uid=body['study_uid'])


if __name__ == '__main__':
    base.require(os.geteuid() == 65534 and base.ROOT.is_dir())
    if sys.argv[1] == 'produce':
        result = produce()
    else:
        base.require(sys.argv[1] == 'consume' and len(sys.argv) == 3)
        result = consume(base.strict_json(sys.argv[2]), sys.stdin.buffer.read(base.LIMIT+1))
    print(json.dumps(result, sort_keys=True))
