# coding: utf-8
"""D-MEASURE2 B1: fresh GitHub-hosted runner only; owned synthetic local stack."""
import json, os, re, secrets, ssl, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/e2e/artifacts/measurement-ci'
SUITES = ['viewer_api_test.py', 'e2e/test_measurement_readback.py',
          'e2e/test_measurement_panel.py', 'e2e/test_held_measurements.py',
          'e2e/test_manual_sr.py', 'e2e/test_measurement_recheck.py',
          'e2e/test_viewer_recovery.py', 'e2e/test_measurement_calibration.py']
SUITE_CLASSES = ['ViewerAPI', 'MeasurementReadbackE2E', 'MeasurementPanelE2E',
                 'HeldMeasurementE2E', 'ManualSrE2E', 'MeasurementRecheckE2E',
                 'ViewerRecoveryE2E', 'MeasurementCalibrationE2E']


def guarded_suite_command(suite, class_name, remaining):
    # The inner supervisor must terminate its descendants before the outer CI
    # deadline kills the supervisor and starts disposable-stack cleanup.
    seconds = min(540, int(remaining)-35)
    if seconds < 1:
        raise RuntimeError('Insufficient CI time for a supervised test run')
    return [sys.executable, str(ROOT/'scripts/run-tests.py'), '--module', 'tests/'+suite,
            '--class', class_name, '--mode', 'live',
            '--unit', 'ci-'+Path(suite).stem.replace('_','-'), '--timeout', str(seconds)]


def sanitize(output, secrets_to_hide):
    for value in secrets_to_hide: output = output.replace(value, '[REDACTED]')
    output = re.sub(r'eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,4}', '[REDACTED JWT]', output)
    output = re.sub(r'(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [REDACTED]', output)
    output = re.sub(r'(?im)((?:set-cookie|cookie):)[^\r\n]*', r'\1 [REDACTED]', output)
    return re.sub(r'(?i)("(?:access_token|refresh_token|id_token|temporaryPassword|password|client_secret|cookie|authorization)"\s*:\s*)"[^"\r\n]*"', r'\1"[REDACTED]"', output)


def seed_source():
    # Only send_cstore's input is generated here. The suites still create,
    # ingest, authorize, exercise and clean their own real DICOM fixtures.
    import numpy as np
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
    dest = ROOT / 'sample-data/public'
    dest.mkdir(parents=True, exist_ok=False)
    study, series, frame = (generate_uid() for _ in range(3))
    for z in range(8):
        sop = generate_uid()
        meta = FileMetaDataset()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = CTImageStorage, sop
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0'*128)
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
        ds.PatientName, ds.PatientID = 'SYNTHETIC^CI', 'SYNTHETIC-CI'
        ds.PatientBirthDate, ds.PatientSex, ds.AccessionNumber = '', 'O', 'CI-SYNTHETIC'
        ds.StudyID, ds.StudyDescription, ds.SeriesDescription = 'CI', 'Synthetic CI', 'Synthetic CT'
        ds.Manufacturer = 'SYNTHETIC'
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.StudyDate, ds.StudyTime, ds.Modality = '20260909', '120000', 'CT'
        ds.SeriesNumber, ds.InstanceNumber = 1, z+1
        ds.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
        ds.ImageOrientationPatient, ds.ImagePositionPatient = [1,0,0,0,1,0], [0,0,z*2]
        ds.PixelSpacing, ds.SliceThickness = [1,1], 2
        ds.Rows = ds.Columns = 256
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 0
        ds.RescaleSlope, ds.RescaleIntercept, ds.RescaleType = 1, -1000, 'HU'
        ds.WindowCenter, ds.WindowWidth = 0, 2000
        yy, xx = np.mgrid[:256,:256]
        ds.PixelData = (xx+yy+z).astype('<u2').tobytes()
        ds.save_as(dest / f'{z}.dcm', write_like_original=False)


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Requires a disposable GitHub-hosted runner')
    if (ROOT/'.env').exists() or (ROOT/'sample-data').exists():
        raise RuntimeError('Refusing pre-existing local secrets or DICOM source')
    if subprocess.check_output(['docker','ps','-aq']).strip() or subprocess.check_output(['docker','volume','ls','-q']).strip():
        raise RuntimeError('Requires an empty Docker daemon')
    endpoint = subprocess.check_output(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}']).decode().strip()
    if not endpoint.startswith('unix:///') or os.environ.get('DOCKER_HOST'):
        raise RuntimeError('Requires the runner local Docker socket')
    OUT.mkdir(parents=True, exist_ok=False)
    values = {key: secrets.token_hex(32) for key in ['POSTGRES_PASSWORD','ORTHANC_PASS',
              'KC_ADMIN_PASSWORD','KC_CLIENT_SECRET','KC_WEB_SECRET','KIN_COOKIE_SECRET']}
    for value in values.values(): print('::add-mask::'+value, flush=True)
    env = {**os.environ, **values, 'PYTHONIOENCODING':'utf-8', 'PUBLIC_PORT':'9443', 'PUBLIC_ORIGIN':'https://localhost:9443'}
    env.pop('COMPOSE_FILE', None)
    project = 'kin-measure-ci-'+secrets.token_hex(6)
    # Fixed container names mean isolation comes from the empty hosted daemon,
    # not this project name. Helpers must still address the same Compose project.
    env['COMPOSE_PROJECT_NAME'] = project
    compose = ['docker','compose','-p',project]
    results = []; deadline = time.monotonic()+25*60
    def run(name, command, timeout=600, finalizing=False):
        started = time.monotonic()
        if not finalizing: timeout = max(.1, min(timeout, deadline-started))
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=timeout)
            code, output = result.returncode, result.stdout+result.stderr
        except subprocess.TimeoutExpired as error:
            code, output = 124, (error.stdout or b'')+(error.stderr or b'')+b'\nCI command deadline\n'
        output = sanitize(output.decode('utf-8', errors='replace'), values.values())
        (OUT/(name+'.log')).write_text(output, encoding='utf-8')
        results.append(dict(name=name, exit=code, seconds=time.monotonic()-started))
        print(name+': '+str(code), flush=True)
        if code and not finalizing: raise RuntimeError(name+' failed; see sanitized artifact')
        return code
    try:
        seed_source()
        run('database', compose+['up','-d','--wait','db'])
        # The image's temporary initdb server only listens on its local socket.
        run('database-tcp', ['docker','exec','kin-db','sh','-c',
            'for n in $(seq 1 60); do pg_isready -h 127.0.0.1 -U kin && exit 0; sleep 1; done; exit 1'], timeout=70)
        run('keycloak-database', ['docker','exec','kin-db','createdb','-U','kin','keycloak'])
        run('stack', compose+['up','-d','--build'], timeout=900)
        for path in ['/api/health','/auth/realms/kin/.well-known/openid-configuration']:
            ready_by = min(time.monotonic()+180, deadline)
            while True:
                try:
                    with urlopen('https://localhost:9443'+path, context=ssl._create_unverified_context(), timeout=5) as response:
                        assert response.status == 200
                    break
                except Exception:
                    if time.monotonic() >= ready_by: raise RuntimeError('Stack readiness deadline')
                    time.sleep(1)
        run('ports', compose+['ps'])
        for suite, class_name in zip(SUITES, SUITE_CLASSES):
            run(Path(suite).stem, guarded_suite_command(suite, class_name, deadline-time.monotonic()))
    finally:
        # This project was generated after proving an empty runner daemon.
        # Never use this cleanup against a developer or production stack.
        failed = sys.exc_info()[0] is not None
        try:
            run('services', compose+['logs','--no-color','--timestamps'], timeout=30, finalizing=True)
        finally:
            try:
                cleanup = run('cleanup', compose+['down','--volumes','--remove-orphans'], timeout=60, finalizing=True)
                if cleanup and not failed: raise RuntimeError('CI cleanup failed; see sanitized artifact')
            finally:
                (OUT/'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')


if __name__ == '__main__': main()
