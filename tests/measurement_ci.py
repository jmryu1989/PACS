# coding: utf-8
"""Fresh GitHub-hosted runner only; owned synthetic local stack CI profiles."""
import argparse, json, os, re, secrets, shutil, ssl, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SUITES = ['viewer_api_test.py', 'e2e/test_measurement_readback.py',
          'e2e/test_measurement_panel.py', 'e2e/test_held_measurements.py',
          'e2e/test_manual_sr.py', 'e2e/test_measurement_recheck.py',
          'e2e/test_viewer_recovery.py', 'e2e/test_measurement_calibration.py',
          'e2e/test_worklist_body_parts.py', 'reading_appearance_live.py',
          'reading_appearance_position_live.py', 'e2e/test_viewer_identity_position.py',
          'reading_appearance_fields_live.py', 'e2e/test_viewer_identity_fields.py',
          'e2e/test_cine.py', 'e2e/test_volume_cine.py']
SUITE_CLASSES = ['ViewerAPI', 'MeasurementReadbackE2E', 'MeasurementPanelE2E',
                 'HeldMeasurementE2E', 'ManualSrE2E', 'MeasurementRecheckE2E',
                 'ViewerRecoveryE2E', 'MeasurementCalibrationE2E', 'WorklistBodyPartsE2E',
                 'ReadingAppearanceLive', 'ReadingAppearancePositionLive', 'ViewerIdentityPositionE2E',
                 'ReadingAppearanceFieldsLive', 'ViewerIdentityFieldsE2E',
                 'CineE2E', 'VolumeCineE2E']
PROFILES = {
    'image-thumbnails': {
        'out': ROOT / 'tests/e2e/artifacts/image-thumbnails-ci',
        'project_prefix': 'kin-image-thumbs-ci-',
        'suite_timeout': 900,
        'suites': (('e2e/test_image_thumbnails.py', 'ImageThumbnailsE2E', 'ci-image-thumbnails'),),
    },
    'dicom-pdf': {
        'out': ROOT / 'tests/e2e/artifacts/dicom-pdf-ci',
        'project_prefix': 'kin-pdf-ci-',
        'suite_timeout': 900,
        'suites': (('e2e/test_dicom_pdf.py', 'DicomPdfE2E', 'ci-source-pdf'),),
    },
    'hanging-protocols': {
        'out': ROOT / 'tests/e2e/artifacts/hanging-protocols-ci',
        'project_prefix': 'kin-hp-ci-',
        'suite_timeout': 900,
        # Shared API/DB changes retain invariants then worklist before the new flow.
        'suites': (
            ('invariants_live.py', None, 'ci-hp-invariants'),
            ('e2e/test_worklist.py', None, 'ci-hp-worklist'),
            ('hanging_protocol_api_live.py', 'HangingProtocolApiLive', 'ci-hp-account'),
            ('e2e/test_hanging_protocol.py', 'HangingProtocolE2E', 'ci-hp-native'),
        ),
    },
    'measurements': {
        'out': ROOT / 'tests/e2e/artifacts/measurement-ci',
        'project_prefix': 'kin-measure-ci-',
        'suite_timeout': 540,
        'suites': tuple((suite, class_name, 'ci-'+Path(suite).stem.replace('_','-'))
                        for suite, class_name in zip(SUITES, SUITE_CLASSES)),
    },
    'volume-rendering': {
        'out': ROOT / 'tests/e2e/artifacts/volume-rendering-ci',
        'project_prefix': 'kin-vr-ci-',
        'suite_timeout': 1200,
        # This module's load_tests is the allowlist: declared test_vr_* only.
        'suites': (('e2e/test_volume_rendering.py', None,
                    'ci-volume-rendering'),),
    },
    'output-integration': {
        'out': ROOT / 'tests/e2e/artifacts/output-integration-ci',
        'project_prefix': 'kin-output-ci-',
        'suite_timeout': 900,
        # Explicit local classes exclude inherited tests and preserve the
        # requested comparison-report then viewer-job-report connection order.
        'suites': (
            ('e2e/test_compare_reports.py', 'CompareReportsE2E',
             'ci-output-compare-reports'),
            ('e2e/test_viewer_job_report.py', 'ViewerJobReportE2E',
             'ci-output-viewer-job-report'),
        ),
    },
    'vr-resize-probe': {
        'out': ROOT / 'tests/e2e/artifacts/vr-resize-probe-ci',
        'project_prefix': 'kin-vr-probe-ci-',
        'suite_timeout': 540,
        'suites': (('e2e/test_vr_resize_probe.py', 'VrResizeProbeE2E',
                    'ci-vr-resize-probe'),),
    },
    'identity-fields': {
        'out': ROOT / 'tests/e2e/artifacts/identity-fields-ci',
        'project_prefix': 'kin-identity-ci-',
        'suite_timeout': 540,
        'suites': (
            ('reading_appearance_live.py', 'ReadingAppearanceLive',
             'ci-identity-reading-appearance'),
            ('reading_appearance_position_live.py', 'ReadingAppearancePositionLive',
             'ci-identity-reading-position'),
            ('reading_appearance_fields_live.py', 'ReadingAppearanceFieldsLive',
             'ci-identity-reading-fields'),
            ('e2e/test_viewer_identity_position.py', 'ViewerIdentityPositionE2E',
             'ci-identity-viewer-position'),
            ('e2e/test_viewer_identity_fields.py', 'ViewerIdentityFieldsE2E',
             'ci-identity-viewer-fields'),
        ),
    },
}


def guarded_suite_command(suite, class_name, remaining, unit=None, maximum=540):
    # The inner supervisor must terminate its descendants before the outer CI
    # deadline kills the supervisor and starts disposable-stack cleanup.
    seconds = min(maximum, int(remaining)-35)
    if seconds < 1:
        raise RuntimeError('Insufficient CI time for a supervised test run')
    command = [sys.executable, str(ROOT/'scripts/run-tests.py'), '--module', 'tests/'+suite]
    if class_name:
        command += ['--class', class_name]
    return command + ['--mode', 'live', '--unit',
            unit or 'ci-'+Path(suite).stem.replace('_','-'), '--timeout', str(seconds)]


def guarded_profile_run(profile, suite, class_name, unit, remaining):
    command = guarded_suite_command(
        suite, class_name, remaining, unit, profile['suite_timeout'])
    # run() also caps this request by the shared deadline. Requesting the inner
    # maximum plus its reserved margin prevents the outer supervisor from
    # preempting run-tests.py before it terminates descendants and records state.
    return command, profile['suite_timeout'] + 35


def sanitize(output, secrets_to_hide):
    for value in secrets_to_hide: output = output.replace(value, '[REDACTED]')
    output = re.sub(r'eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,4}', '[REDACTED JWT]', output)
    output = re.sub(r'(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [REDACTED]', output)
    output = re.sub(r'(?im)((?:set-cookie|cookie):)[^\r\n]*', r'\1 [REDACTED]', output)
    return re.sub(r'(?i)("(?:access_token|refresh_token|id_token|temporaryPassword|password|client_secret|cookie|authorization)"\s*:\s*)"[^"\r\n]*"', r'\1"[REDACTED]"', output)


def profile_environment(profile_name, out, values, evidence_stage=None):
    env = {**os.environ, **values, 'PYTHONIOENCODING':'utf-8', 'PUBLIC_PORT':'9443',
           'PUBLIC_ORIGIN':'https://localhost:9443',
           'KIN_TEST_PROXY':'https://localhost:9443',
           'KIN_TEST_API':'https://localhost:9443/api',
           'KIN_TEST_TOKEN_URL':'http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token',
           'KIN_TEST_ORTHANC':'http://127.0.0.1:8042',
           'KIN_TEST_ORTHANC_USER':'admin',
           'KIN_TEST_ORTHANC_PASSWORD':values['ORTHANC_PASS']}
    if profile_name == 'volume-rendering':
        if evidence_stage is None:
            raise RuntimeError('VR evidence requires private staging')
        env['KIN_EVIDENCE_DIR'] = str(evidence_stage)
    else:
        env.pop('KIN_EVIDENCE_DIR', None)
    env.pop('COMPOSE_FILE', None)
    return env


def publish_vr_evidence(stage, out):
    expected = stage/'volume-rendering.png'
    files = sorted(path.relative_to(stage).as_posix() for path in stage.rglob('*') if path.is_file())
    if files != ['volume-rendering.png']:
        raise RuntimeError('Unexpected or missing VR suite evidence: '+', '.join(files))
    if expected.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
        raise RuntimeError('VR suite evidence is not a PNG')
    shutil.copyfile(expected, out/expected.name)


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


def main(profile_name):
    if profile_name not in PROFILES:
        raise RuntimeError('Unknown CI profile')
    profile = PROFILES[profile_name]
    out = profile['out']
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Requires a disposable GitHub-hosted runner')
    if (ROOT/'.env').exists() or (ROOT/'sample-data').exists():
        raise RuntimeError('Refusing pre-existing local secrets or DICOM source')
    if subprocess.check_output(['docker','ps','-aq']).strip() or subprocess.check_output(['docker','volume','ls','-q']).strip():
        raise RuntimeError('Requires an empty Docker daemon')
    endpoint = subprocess.check_output(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}']).decode().strip()
    if not endpoint.startswith('unix:///') or os.environ.get('DOCKER_HOST'):
        raise RuntimeError('Requires the runner local Docker socket')
    out.mkdir(parents=True, exist_ok=False)
    values = {key: secrets.token_hex(32) for key in ['POSTGRES_PASSWORD','ORTHANC_PASS',
              'KC_ADMIN_PASSWORD','KC_CLIENT_SECRET','KC_WEB_SECRET','KIN_COOKIE_SECRET']}
    for value in values.values(): print('::add-mask::'+value, flush=True)
    evidence_stage = None
    if profile_name == 'volume-rendering':
        runner_temp = os.environ.get('RUNNER_TEMP')
        if not runner_temp or not Path(runner_temp).is_absolute():
            raise RuntimeError('VR evidence requires absolute RUNNER_TEMP')
        evidence_stage = Path(runner_temp)/('kin-vr-suite-evidence-'+secrets.token_hex(6))
        evidence_stage.mkdir(parents=True, exist_ok=False)
    env = profile_environment(profile_name, out, values, evidence_stage)
    project = profile['project_prefix']+secrets.token_hex(6)
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
        (out/(name+'.log')).write_text(output, encoding='utf-8')
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
        for suite, class_name, unit in profile['suites']:
            command, outer_timeout = guarded_profile_run(
                profile, suite, class_name, unit, deadline-time.monotonic())
            run(Path(suite).stem, command, timeout=outer_timeout)
        if evidence_stage is not None:
            publish_vr_evidence(evidence_stage, out)
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
                (out/'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
                if evidence_stage is not None:
                    shutil.rmtree(evidence_stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, choices=tuple(PROFILES))
    main(parser.parse_args().profile)
