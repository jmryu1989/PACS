#!/usr/bin/env python3
"""A11-VOI-1 mutation experiments on frozen candidate d6271d2: one purpose, one attempt per variant.

check     pure: baseline identity, patch hashes, detector anchors and pixel predictions, derived profile, wrapper and workflow text
predict   pure: the candidate oracle's first failing probe under each pixel-oracle variant's preregistered sampling behaviour
guard     hosted: refuse reruns, prove the checkout is the candidate plus harness paths only, apply exactly one patch
select    hosted venv: freeze the exact single-case plan with scripts/run-tests.py's own module_plan
native    hosted: measurement_ci.py's unchanged volume-mip-voi stack, cap and shared deadline, on that one case
classify  hosted, always: recorded facts plus a conservative observation; never a verdict on the experiment
"""
import argparse, ast, hashlib, importlib.util, itertools, json, math, os, re, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((Path(__file__).resolve().parent / 'manifest.json').read_text(encoding='utf-8'))
EVIDENCE = ROOT / 'tmp/voi-mutation-ci'
OUT = ROOT / 'tests/e2e/artifacts/volume-mip-voi-ci'
WRAPPER = 'tests/' + MANIFEST['suite']
WRAPPER_CLASS = 'VolumeMipVoiMutationE2E'
SUITE = Path(MANIFEST['suite']).stem
ORACLE = 'tests/e2e/test_volume_mip.py'
RETIRED_WORKFLOW = '.github/workflows/voi-mutations.yml'
SETUP_STAGES = ('database', 'database-tcp', 'keycloak-database', 'stack', 'ports')
PINS = ('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4',
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1')
FRAME = re.compile(r'^  File "(?P<file>[^"]+)", line (?P<line>\d+), in (?P<function>\S+)$')
BLOCK = re.compile(r'^(?P<kind>FAIL|ERROR): (?P<method>\w+) \((?P<test>[^)]+)\)$')
SEPARATOR = re.compile(r'^(-{70}|={70})$')
SUMMARY = re.compile(r'^(OK|FAILED)( \([a-z_]+=\d+(, [a-z_]+=\d+)*\))?$')
# unittest's assertLessEqual(first, second, msg) text for voi_pixels: 'first not less than or equal to second : msg'.
PIXEL_MESSAGE = re.compile(r'^(?P<gap>\d+(?:\.\d+)?(?:e[+-]?\d+)?) not less than or equal to (?P<delta>\d+) : (?P<detail>\(.*\))$', re.S)
# The candidate oracle's pure geometry (no browser, numpy or stack): exactly these top-level names of tests/e2e/test_volume_mip.py.
ORACLE_FUNCTIONS = ('band', 'level', 'rodrigues', 'voi_record', 'mm_text', 'voi_label', 'nearest', 'value_edges', 'voxel_hu',
                    'ray_segments', 'kept_segment', 'clipped_parts', 'project_hu', 'zero_fill_hu', 'gray', 'voi_margins', 'voi_probe',
                    'voi_probes', 'voi_plan')
ORACLE_CONSTANTS = ('BASE', 'X', 'Y', 'Z', 'COLUMN', 'EDGES', 'MODES', 'ORIENTATIONS', 'BLENDS', 'TOTAL', 'SPACING', 'COUNTS', 'RAY',
                    'STEP', 'VOI_DISCRIMINATION', 'VOI_DELTA', 'VOI_MEAN_BOUND', 'VOI_STUDIES', 'VOI_CASES', 'PRESET_NORMALS', 'WORLD_AXES')
# scripts/run-tests.py prints this for every failed or skipped live plan; it is not a selection refusal.
UNFINISHED_PLAN = 'Tests failed or skipped; this is not a completed plan'
RULE = ('An observation is not a verdict. Only assertion-failure-at-preregistered-detector is a detection candidate; Astra '
        'decides it against the raw suite log, the before/after hashes and the contract. Every other observation, including '
        'any nonzero exit, is not evidence that the mutation was detected.')


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_id(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def snapshot(paths):
    rows = []
    for path in paths:
        try:
            data = (ROOT / path).read_bytes()
            rows.append({'path': path, 'sha256': sha256(data), 'lf_sha256': sha256(data.replace(b'\r\n', b'\n'))})
        except FileNotFoundError:
            rows.append({'path': path, 'sha256': None, 'lf_sha256': None})
    return rows


def digest(rows, path):
    return next((row['sha256'] for row in rows if row['path'] == path), None)


def git(*args, env=None, data=None):
    result = subprocess.run(['git', *args], cwd=ROOT, env=env, input=data, capture_output=True)
    require(result.returncode == 0, 'git %s failed: %s' % (' '.join(args), result.stderr.decode('utf-8', 'replace').strip()[:300]))
    return result.stdout


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=1, ensure_ascii=False)
        stream.write('\n')


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def read_text(path):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None


def baseline_identity():
    # The harness paths are pure additions and the candidate Validate is the one replaced path: on this isolated branch
    # validate.yml carries the manual mutation workflow. In a private index, removing the harness paths and restoring the
    # pinned candidate Validate blob from its committed byte copy must give the candidate tree exactly, which proves every
    # other product, test and CI file is the frozen candidate's without fetching its history.
    replaced = MANIFEST['baseline']['replaced']
    copy = git('cat-file', 'blob', 'HEAD:' + replaced['copy'])
    require(blob_id(copy) == replaced['blob'] and sha256(copy) == replaced['sha256'], 'The committed candidate Validate copy is not the pinned blob')
    head_entry = git('ls-tree', 'HEAD', '--', replaced['path']).decode('utf-8').split()
    with tempfile.TemporaryDirectory() as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        git('read-tree', 'HEAD', env=env)
        harness = git('ls-files', '--', *MANIFEST['harness_paths'], env=env).decode('utf-8').split()
        git('rm', '-r', '--cached', '--quiet', '--', *MANIFEST['harness_paths'], env=env)
        # A shallow checkout lacks the candidate blob; writing it from the verified copy yields the same object ID.
        written = git('hash-object', '-w', '--no-filters', '--stdin', data=copy).decode('ascii').strip()
        require(written == replaced['blob'], 'git wrote a different candidate Validate blob')
        git('update-index', '--cacheinfo', '%s,%s,%s' % (replaced['mode'], written, replaced['path']), env=env)
        tree = git('write-tree', env=env).decode('ascii').strip()
    return {'head': git('rev-parse', 'HEAD').decode('ascii').strip(), 'head_tree': git('rev-parse', 'HEAD^{tree}').decode('ascii').strip(),
            'tree_without_harness': tree, 'harness_files': harness,
            'replaced': {'path': replaced['path'], 'head_entry': head_entry[:3], 'candidate_blob': written, 'candidate_copy': replaced['copy']}}


def baseline_problems(baseline):
    replaced, problems = MANIFEST['baseline']['replaced'], []
    if baseline['tree_without_harness'] != MANIFEST['baseline']['tree']:
        problems.append('HEAD without the harness paths and with the pinned candidate Validate is not the frozen candidate tree')
    if baseline['replaced']['head_entry'][:2] != [replaced['mode'], 'blob'] or baseline['replaced']['head_entry'][2:] == [replaced['blob']]:
        problems.append('HEAD validate.yml must be the mutation workflow with the candidate mode, not the candidate blob')
    if not all(path.startswith(tuple(p.rstrip('/') for p in MANIFEST['harness_paths'])) for path in baseline['harness_files']):
        problems.append('a harness file lies outside the harness paths')
    return problems


def patched(variant, before):
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        subprocess.run(['git', 'init', '-q', str(work)], check=True, capture_output=True)
        target = work / variant['file']
        target.parent.mkdir(parents=True)
        target.write_bytes(before)
        result = subprocess.run(['git', '-C', str(work), '-c', 'core.autocrlf=false', 'apply', str(ROOT / variant['patch'])], capture_output=True)
        require(result.returncode == 0, variant['patch'] + ' does not apply: ' + result.stderr.decode('utf-8', 'replace').strip()[:300])
        return target.read_bytes()


def measurement_ci():
    sys.path.insert(0, str(ROOT / 'tests'))
    import measurement_ci as ci
    require(Path(ci.__file__).resolve() == (ROOT / 'tests/measurement_ci.py').resolve(), 'Unexpected measurement_ci module')
    minutes = MANIFEST['budget']['profile_deadline_seconds'] // 60
    require('deadline = time.monotonic()+%d*60' % minutes in (ROOT / 'tests/measurement_ci.py').read_text(encoding='utf-8'),
            'The shared profile deadline changed')
    return ci


def derived_profile(ci):
    base, budget = ci.PROFILES[MANIFEST['profile']], MANIFEST['budget']
    require(base['suites'] == ((MANIFEST['candidate_suite'], None, MANIFEST['unit']),), 'The candidate volume-mip-voi suites changed')
    require(base['suite_timeout'] == budget['suite_cap_seconds'] and base['suite_budgets'] == {MANIFEST['unit']: budget['suite_cap_seconds']},
            'The candidate volume-mip-voi cap changed')
    require(base['out'] == OUT and base['project_prefix'] == MANIFEST['project_prefix'], 'The candidate volume-mip-voi output or project changed')
    # Only the module changes: the same stack, output, project prefix, unit, cap and shared deadline run one authored case.
    return {**base, 'suites': ((MANIFEST['suite'], None, MANIFEST['unit']),)}


def load_oracle(source):
    # Only the named pure definitions run; imports, fixtures and the browser test class are never executed.
    tree, body, seen = ast.parse(source), [], []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in ORACLE_FUNCTIONS:
            body.append(node)
            seen.append(node.name)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            names = [target.id] if isinstance(target, ast.Name) else [e.id for e in target.elts if isinstance(e, ast.Name)] if isinstance(target, ast.Tuple) else []
            if names and all(name in ORACLE_CONSTANTS for name in names):
                body.append(node)
                seen += names
    require(sorted(seen) == sorted(ORACLE_FUNCTIONS + ORACLE_CONSTANTS), 'The candidate VOI oracle definitions changed: ' + ','.join(sorted(seen)))
    namespace = {'math': math}
    exec(compile(ast.Module(body=body, type_ignores=[]), ORACLE, 'exec'), namespace)
    return namespace


def zero_fill_band(oracle, probe, intercept, voi, record, orientation, mode):
    # The candidate's own zero_fill expectation. A Raysum mean's full ray may end at voxel centres or voxel edges (the oracle's
    # unclipped expectation takes both), so its band spans both extents; MIP and MinIP do not depend on the extent.
    if mode != 'Raysum':
        return [probe['zero_fill'], probe['zero_fill']]
    axis = oracle['RAY'][orientation]
    interval, _ = oracle['kept_segment'](probe['world'], axis, record)
    values = [oracle['gray'](oracle['zero_fill_hu'](oracle['ray_segments'](probe['world'], axis, intercept, extend), interval, mode), voi)
              for extend in (0, oracle['SPACING'][axis] / 2)]
    require(round(values[0], 3) == probe['zero_fill'], 'The Raysum zero-fill band does not reproduce the probe expectation')
    return [min(values), max(values)]


def first_pixel_failure(oracle, behaviour, tolerance):
    # N1's own order (test_mip_04): studies, cases, orientations, modes, then each probe in voi_pixels. The planes, camera and
    # label checks of line 395 and of every earlier cell hold for these mutations, which keep the VOI planes.
    plan, delta = oracle['voi_plan'](), oracle['VOI_DELTA']
    for study, intercept, voi in oracle['VOI_STUDIES']:
        for case in oracle['VOI_CASES']:
            record = oracle['voi_record'](case)
            for orientation in oracle['ORIENTATIONS']:
                for mode in oracle['MODES']:
                    for index, probe in enumerate(plan[(study, case['name'], orientation, mode)]):
                        if behaviour[mode] == 'expected':
                            continue
                        band, wanted = zero_fill_band(oracle, probe, intercept, voi, record, orientation, mode), probe['expected']
                        near = 0 if band[0] <= wanted <= band[1] else min(abs(wanted - value) for value in band)
                        far = max(abs(wanted - value) for value in band)
                        if far + tolerance[mode] <= delta:
                            continue
                        require(near - tolerance[mode] > delta, 'Ambiguous pixel prediction at %s %s %s %s probe %d' % (study, case['name'], orientation, mode, index))
                        width = delta + tolerance[mode]
                        return {'cell': [study, case['name'], orientation, mode],
                                'label': '%s · %s · %s mm · %s · Final' % (mode, orientation, oracle['mm_text'](oracle['TOTAL']), oracle['voi_label'](record)),
                                'probe_index': index, 'probe': probe, 'delta': delta, 'tolerance': tolerance[mode],
                                'band': [round(band[0], 3), round(band[1], 3)], 'accept': [round(band[0] - width, 3), round(band[1] + width, 3)]}
    return None


def pixel_prediction(oracle, pixel):
    # Every combination of the declared alternative behaviours must fail first at the same probe.
    modes = oracle['MODES']
    found = [first_pixel_failure(oracle, dict(zip(modes, choice)), MANIFEST['pixel_tolerance'])
             for choice in itertools.product(*[pixel['behaviours'][mode] for mode in modes])]
    require(found[0] is not None and all(item == found[0] for item in found), 'The declared pixel behaviours do not share one first failing probe')
    return found[0]


def semantic_problems(test_source):
    oracle, problems = load_oracle(test_source), []
    for name, variant in sorted(MANIFEST['variants'].items()):
        if 'pixel' not in variant:
            continue
        predicted = pixel_prediction(oracle, variant['pixel'])
        semantic = [detector.get('semantic') for detector in variant['detectors']]
        if semantic != [predicted]:
            problems.append(name + ' semantic detector differs from the candidate oracle prediction: ' + json.dumps(predicted, ensure_ascii=False))
    return problems


def semantic_facts(semantic, message):
    match = PIXEL_MESSAGE.match(message or '')
    if not match:
        return False, {'failed': ['the voi_pixels assertion text']}
    try:
        label, kind, probe, actual = ast.literal_eval(match.group('detail'))
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return False, {'failed': ['a parsable voi_pixels detail']}
    facts = {'label': list(label) if isinstance(label, tuple) else label, 'expected_kind': kind, 'probe': probe, 'actual': actual}
    numeric = isinstance(actual, (int, float)) and not isinstance(actual, bool)
    checks = {'cell and displayed Final label': isinstance(label, tuple) and list(label) == semantic['cell'] + [semantic['label']],
              'expected oracle': kind == 'expected', 'same preregistered probe': probe == semantic['probe'],
              'same delta': int(match.group('delta')) == semantic['delta'], 'numeric canvas gray': numeric}
    if numeric and isinstance(probe, dict) and isinstance(probe.get('expected'), (int, float)):
        low, high = semantic['band']
        distance = 0 if low <= actual <= high else min(abs(actual - low), abs(actual - high))
        facts['band_distance'] = round(distance, 3)
        checks['within the preregistered mutant band'] = distance <= semantic['delta'] + semantic['tolerance']
        checks['nearer the mutant band than the expected value'] = distance < abs(actual - probe['expected'])
    facts['failed'] = [name for name, passed in checks.items() if not passed] + ([] if len(checks) == 7 else ['band comparison'])
    return not facts['failed'], facts


def detector_problems(test_source):
    lines, problems = test_source.splitlines(), []
    for name, variant in sorted(MANIFEST['variants'].items()):
        if variant['case'] not in MANIFEST['cases']:
            problems.append(name + ' names an unknown case')
        if variant['expected_first_detector'] not in [detector['id'] for detector in variant['detectors']]:
            problems.append(name + ' expects an undeclared detector')
        for detector in variant['detectors']:
            for function, number, anchor in detector['frames']:
                text = lines[number - 1] if 0 < number <= len(lines) else ''
                enclosing = next((match.group(1) for match in (re.match(r'^\s*def (\w+)\(', line) for line in reversed(lines[:number])) if match), None)
                if anchor not in text or enclosing != function:
                    problems.append('%s %s: line %d is not %s in %s' % (name, detector['id'], number, anchor[:40], function))
            if detector['frames'][0][0] != MANIFEST['cases'][variant['case']]:
                problems.append('%s %s does not start in its case' % (name, detector['id']))
    ids = [(name, detector['id']) for name, variant in MANIFEST['variants'].items() if variant.get('dispatchable') for detector in variant['detectors']]
    if len({detector for _, detector in ids}) != len(ids):
        problems.append('dispatchable variants share a detector id')
    return problems


def wrapper_problems(source):
    tree, problems = ast.parse(source), []
    cases = [ast.literal_eval(node.value) for node in tree.body
             if isinstance(node, ast.Assign) and [getattr(target, 'id', None) for target in node.targets] == ['CASES']]
    if cases != [MANIFEST['cases']]:
        problems.append('wrapper CASES differ from the manifest')
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef)]
    if [node.name for node in classes] != [WRAPPER_CLASS] or not all(isinstance(item, ast.Pass) for item in classes[0].body):
        problems.append('wrapper must declare exactly one empty subclass')
    if [node.name for node in tree.body if isinstance(node, ast.FunctionDef)] != ['load_tests']:
        problems.append('wrapper must define only load_tests')
    return problems


def workflow_problems(text, validate):
    parts = validate.split('\n  volume-mip-voi:\n')
    job = re.split(r'\n  [A-Za-z0-9_-]+:\n', parts[1])[0] if len(parts) == 2 else ''
    setup = [line.strip() for line in job.splitlines() if re.search(r'ci_browser_apt\.py|-m venv |-m pip install |-m playwright install ', line)]
    lines = [line.strip() for line in text.splitlines()]
    checks = {
        'manual trigger only': bool(re.search(r'^on:\n  workflow_dispatch:\n', text, re.M))
        and not re.search(r'^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):', text, re.M),
        'read-only token scope': '\npermissions:\n  contents: read\n' in text,
        'no secrets or tokens': not re.search(r'secrets\.|GITHUB_TOKEN|github\.token', text),
        'no persisted Git credentials': text.count('persist-credentials: false') == 1 and text.count('actions/checkout@') == 1,
        'only the volume-mip-voi pinned actions': re.findall(r'uses: (\S+ # \S+)', text) == re.findall(r'uses: (\S+ # \S+)', job) == list(PINS),
        'independent bounded matrix': 'fail-fast: false' in lines and 'max-parallel: 2' in lines,
        'same runner and limits': all(line in lines and line in [l.strip() for l in job.splitlines()]
                                      for line in ('runs-on: ubuntu-24.04', 'timeout-minutes: 40', 'timeout-minutes: 10', 'timeout-minutes: 28')),
        'same dependency setup': len(setup) == 4 and all(line in lines for line in setup),
        'evidence always uploaded per attempt': text.count('if: always()') == 2 and 'if-no-files-found: error' in lines
        and 'name: voi-mutation-${{ matrix.variant }}-attempt${{ github.run_attempt }}' in lines,
        'no continue-on-error or candidate profile command': 'continue-on-error' not in text and '--profile' not in text,
    }
    return ['workflow: ' + name for name, passed in checks.items() if not passed]


def dispatch_problems(text):
    sets, problems = MANIFEST['dispatch_sets'], []
    matrix = {name: json.loads(values) for name, values in re.findall(r"inputs\.variants == '([A-Za-z0-9-]+)' && '(\[[^']*\])'", text)}
    options = re.findall(r'^          - ([A-Za-z0-9-]+)$', text, re.M)
    if matrix != sets or options != list(sets) or ('default: ' + next(iter(sets))) not in [line.strip() for line in text.splitlines()]:
        problems.append('dispatch: workflow choices, default or matrix differ from the manifest dispatch sets')
    listed = [variant for values in sets.values() for variant in values]
    dispatchable = sorted(name for name, variant in MANIFEST['variants'].items() if variant.get('dispatchable') is True)
    if sorted(listed) != dispatchable or len(set(listed)) != len(listed):
        problems.append('dispatch: every dispatchable variant must be in exactly one set and no other variant in any')
    return problems


def check():
    baseline = baseline_identity()
    blob = lambda path: git('cat-file', 'blob', 'HEAD:' + path)
    require(not git('ls-tree', 'HEAD', '--', RETIRED_WORKFLOW), RETIRED_WORKFLOW + ' must not remain as a second entry')
    report = {'baseline': baseline, 'variants': {}}
    for name, variant in sorted(MANIFEST['variants'].items()):
        before = blob(variant['file'])
        row = {'case': variant['case'], 'dispatchable': variant.get('dispatchable'), 'patch_sha256': sha256(blob(variant['patch'])),
               'before_sha256': sha256(before), 'after_sha256': sha256(patched(variant, before))}
        require(all(row[key] == variant[key] for key in ('patch_sha256', 'before_sha256', 'after_sha256')), name + ' differs: ' + json.dumps(row))
        report['variants'][name] = row
    workflow, test_source = blob(MANIFEST['workflow']).decode('utf-8'), blob(ORACLE).decode('utf-8')
    problems = (baseline_problems(baseline) + detector_problems(test_source) + wrapper_problems(blob(WRAPPER).decode('utf-8'))
                + workflow_problems(workflow, blob(MANIFEST['baseline']['replaced']['copy']).decode('utf-8')) + dispatch_problems(workflow)
                + semantic_problems(test_source))
    require(not problems, '; '.join(problems))
    profile = derived_profile(measurement_ci())
    report['profile'] = {'name': MANIFEST['profile'], 'suites': profile['suites'], 'suite_timeout': profile['suite_timeout'],
                         'suite_budgets': profile['suite_budgets'], 'out': OUT.relative_to(ROOT).as_posix(), 'project_prefix': profile['project_prefix']}
    report['pixel_predictions'] = {name: pixel_prediction(load_oracle(test_source), variant['pixel'])
                                   for name, variant in sorted(MANIFEST['variants'].items()) if 'pixel' in variant}
    report['hashed_files_at_head'] = [{'path': path, 'sha256': sha256(blob(path))} for path in MANIFEST['hashed_files']]
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0


def predict():
    source = (ROOT / ORACLE).read_bytes().replace(b'\r\n', b'\n').decode('utf-8')
    oracle = load_oracle(source)
    print(json.dumps({name: pixel_prediction(oracle, variant['pixel']) for name, variant in sorted(MANIFEST['variants'].items()) if 'pixel' in variant},
                     indent=1, ensure_ascii=False))
    return 0


def guard(name):
    variant, directory = MANIFEST['variants'][name], EVIDENCE / name
    directory.mkdir(parents=True, exist_ok=False)
    environment = {key: os.environ.get(key) for key in ('GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_SHA',
                   'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'ImageOS', 'ImageVersion')}
    record = {'variant': name, 'case': variant['case'], 'meaning': variant['meaning'], 'status': 'refused', 'started_utc': utc_now(),
              'environment': environment}
    try:
        require(variant.get('dispatchable') is True, '%s is not dispatchable (%s)' % (name, variant.get('status')))
        require(environment['GITHUB_ACTIONS'] == 'true' and environment['RUNNER_ENVIRONMENT'] == 'github-hosted', 'Requires a disposable GitHub-hosted runner')
        require(environment['GITHUB_EVENT_NAME'] == 'workflow_dispatch', 'Manual dispatch only')
        require(environment['GITHUB_REF'] == MANIFEST['harness_ref'], 'Dispatch the prepared harness ref only')
        require((environment['GITHUB_WORKFLOW_REF'] or '').endswith('/%s@%s' % (MANIFEST['workflow'], MANIFEST['harness_ref'])), 'Dispatch the prepared workflow entry only')
        # A rerun would be a second attempt of an experiment that already has a result: refuse before anything changes.
        require(environment['GITHUB_RUN_ATTEMPT'] == '1', 'Run attempt %s refused: each variant has exactly one attempt' % environment['GITHUB_RUN_ATTEMPT'])
        record['baseline'] = baseline = baseline_identity()
        require(baseline['head'] == environment['GITHUB_SHA'], 'The checkout is not the dispatched commit')
        workflow = git('cat-file', 'blob', 'HEAD:' + MANIFEST['workflow']).decode('utf-8')
        problems = (baseline_problems(baseline) + workflow_problems(workflow, git('cat-file', 'blob', 'HEAD:' + MANIFEST['baseline']['replaced']['copy']).decode('utf-8'))
                    + dispatch_problems(workflow))
        require(not problems, '; '.join(problems))
        require(not git('status', '--porcelain', '--untracked-files=no'), 'Tracked files differ from the checkout before the mutation')
        patch = ROOT / variant['patch']
        record['patch'] = {'path': variant['patch'], 'sha256': sha256(patch.read_bytes())}
        require(record['patch']['sha256'] == variant['patch_sha256'], 'Patch bytes differ from the manifest')
        record['before'] = snapshot(MANIFEST['hashed_files'])
        require(digest(record['before'], variant['file']) == variant['before_sha256'], 'The target differs from the candidate before the mutation')
        git('apply', '--check', str(patch))
        git('apply', str(patch))
        record['changed'] = git('diff', '--name-only').decode('utf-8').split()
        require(record['changed'] == [variant['file']], 'The patch must change exactly its one target file')
        record['after'] = snapshot(MANIFEST['hashed_files'])
        require(digest(record['after'], variant['file']) == variant['after_sha256'], 'The mutated target differs from the manifest')
        require([row for row in record['before'] if row['path'] != variant['file']] == [row for row in record['after'] if row['path'] != variant['file']],
                'A file other than the target changed')
        record['status'] = 'applied'
    except Exception as error:
        record['refusal'] = type(error).__name__ + ': ' + str(error)
    finally:
        record['ended_utc'] = utc_now()
        write_new(directory / 'guard.json', record)
    print('VOI_MUTATION_GUARD ' + json.dumps({key: record.get(key) for key in ('variant', 'status', 'refusal')}, ensure_ascii=False), flush=True)
    return 0 if record['status'] == 'applied' else 3


def select(name):
    variant, directory = MANIFEST['variants'][name], EVIDENCE / name
    record = {'variant': name, 'case': variant['case'], 'status': 'refused', 'started_utc': utc_now()}
    try:
        require((read_json(directory / 'guard.json') or {}).get('status') == 'applied', 'No applied mutation for ' + name)
        os.environ['KIN_VOI_MUTATION_CASE'] = variant['case']
        spec = importlib.util.spec_from_file_location('kin_voi_mutation_run_tests', ROOT / 'scripts/run-tests.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        profile = derived_profile(measurement_ci())
        (suite, class_name, unit), = profile['suites']
        # run-tests.py's budgeted worker resolves --module with this same module_plan; freeze and compare it before any stack exists.
        record['plan'] = runner.module_plan('tests/' + suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        record['expected_tests'] = [{'file': WRAPPER, 'case': WRAPPER_CLASS + '.' + MANIFEST['cases'][variant['case']]}]
        require(record['plan']['tests'] == record['expected_tests'], 'The selection is not exactly the variant case')
        record['status'] = 'frozen'
    except Exception as error:
        record['refusal'] = type(error).__name__ + ': ' + str(error)
    finally:
        record['ended_utc'] = utc_now()
        write_new(directory / 'selection.json', record)
    print('VOI_MUTATION_SELECTION ' + json.dumps({key: record.get(key) for key in ('variant', 'status', 'refusal', 'expected_tests')}), flush=True)
    return 0 if record['status'] == 'frozen' else 3


def native(name):
    variant, directory = MANIFEST['variants'][name], EVIDENCE / name
    applied = read_json(directory / 'guard.json') or {}
    require(applied.get('status') == 'applied' and (read_json(directory / 'selection.json') or {}).get('status') == 'frozen',
            'A native run requires an applied mutation and a frozen selection')
    os.environ['KIN_VOI_MUTATION_CASE'] = variant['case']
    ci = measurement_ci()
    profile = derived_profile(ci)
    start = {'variant': name, 'case': variant['case'], 'profile': MANIFEST['profile'], 'suites': profile['suites'],
             'suite_timeout': profile['suite_timeout'], 'suite_budgets': profile['suite_budgets'], 'budget': MANIFEST['budget'],
             'out': OUT.relative_to(ROOT).as_posix(), 'project_prefix': profile['project_prefix'], 'started_utc': utc_now(),
             'before': snapshot(MANIFEST['hashed_files'])}
    require(start['before'] == applied['after'], 'Sources changed between the guard and the native run')
    write_new(directory / 'native-start.json', start)
    ci.PROFILES[MANIFEST['profile']] = profile
    outcome = {'exception': None, 'message': None}
    try:
        ci.main(MANIFEST['profile'])
    except BaseException as error:
        outcome = {'exception': type(error).__name__, 'message': str(error)[:500]}
        raise
    finally:
        write_new(directory / 'native-end.json', {'ended_utc': utc_now(), 'after': snapshot(MANIFEST['hashed_files']), **outcome})
    return 0


def parse_suite_log(text):
    lines = text.splitlines()
    parsed = {'exact': [], 'plans': [], 'refused': [], 'ran': [], 'summary': [], 'blocks': []}
    for index, line in enumerate(lines):
        for prefix, key in (('EXACT_TESTS ', 'exact'), ('PLAN_RESULT ', 'plans')):
            if line.startswith(prefix):
                try:
                    parsed[key].append(json.loads(line[len(prefix):]))
                except ValueError:
                    parsed[key].append({'unparsed': line[:300]})
        if line.startswith('TEST_RUN_REFUSED: '):
            parsed['refused'].append(line[len('TEST_RUN_REFUSED: '):])
        ran = re.match(r'^Ran (\d+) tests? in ', line)
        if ran:
            parsed['ran'].append(int(ran.group(1)))
        if SUMMARY.match(line):
            parsed['summary'].append(line)
        header = BLOCK.match(line)
        if not header:
            continue
        body = []
        for following in lines[index + 1:]:
            if BLOCK.match(following) or following.startswith('Ran '):
                break
            body.append(following)
        starts = [position for position, text_line in enumerate(body) if text_line.startswith('Traceback (most recent call last):')]
        segment = body[starts[-1] + 1:] if starts else []
        frame_positions = [position for position, text_line in enumerate(segment) if FRAME.match(text_line)]
        position = frame_positions[-1] + 1 if frame_positions else 0
        while position < len(segment) and segment[position].startswith('    '):
            position += 1
        exception = []
        for text_line in segment[position:]:
            if SEPARATOR.match(text_line):
                break
            exception.append(text_line)
        exception = '\n'.join(exception).strip()
        kind = re.match(r'^([A-Za-z_][\w.]*)(?::|$)', exception)
        frames = [FRAME.match(segment[p]) for p in frame_positions]
        parsed['blocks'].append({
            'kind': header.group('kind'), 'method': header.group('method'), 'exception_type': kind.group(1) if kind else None,
            'message': exception[len(kind.group(0)):].lstrip(' ') if kind else exception, 'exception_head': exception[:600],
            'frames': [[frame.group('function'), int(frame.group('line'))] for frame in frames
                       if frame.group('file').replace('\\', '/').endswith('/tests/e2e/test_volume_mip.py')]})
    return parsed


def observe(name, inputs):
    variant = MANIFEST['variants'][name]
    method = MANIFEST['cases'][variant['case']]
    facts = {'native_exit': inputs.get('native_exit')}

    def result(observation, detector=None, **extra):
        facts.update(extra)
        return {'observation': observation, 'detection_candidate': detector is not None, 'detector': detector,
                'expected_first_detector': variant['expected_first_detector'], 'facts': facts, 'rule': RULE}

    guarded, selection = inputs.get('guard') or {}, inputs.get('selection') or {}
    if guarded.get('status') != 'applied':
        return result('harness-refused-before-native', refusal=guarded.get('refusal'))
    if selection.get('status') != 'frozen':
        return result('selection-not-frozen', refusal=selection.get('refusal'))
    start, end = inputs.get('native_start'), inputs.get('native_end')
    if start is None:
        return result('native-not-started')
    if inputs.get('native_exit') is None:
        return result('native-exit-unknown-cancelled-or-step-deadline', native_end_recorded=end is not None)
    if end is None or end.get('after') != start.get('before'):
        return result('source-hashes-unproven-after-native', native_end_recorded=end is not None)
    facts.update(exception=end.get('exception'), message=end.get('message'))
    stages = inputs.get('stages')
    if not isinstance(stages, list):
        return result('infrastructure-no-stage-record')
    exits = {row.get('name'): row.get('exit') for row in stages if isinstance(row, dict)}
    facts['stages'] = exits
    setup_failures = [stage for stage in SETUP_STAGES if exits.get(stage) != 0]
    if setup_failures or SUITE not in exits:
        return result('infrastructure-before-suite', setup_failures=setup_failures)
    if exits[SUITE] == 124:
        return result('suite-deadline')
    log = parse_suite_log(inputs.get('suite_log') or '')
    facts.update(exact_tests=log['exact'], plan_results=log['plans'], ran=log['ran'], summary=log['summary'], refused=log['refused'],
                 blocks=[{key: block[key] for key in ('kind', 'method', 'exception_type', 'frames', 'exception_head')} for block in log['blocks']])
    if [reason for reason in log['refused'] if reason != UNFINISHED_PLAN]:
        return result('plan-refused')
    if log['exact'] != [['%s.%s.%s' % (SUITE, WRAPPER_CLASS, method)]]:
        return result('selection-mismatch')
    if [plan.get('status') for plan in log['plans']] == ['interrupted']:
        return result('suite-interrupted')
    if log['ran'] != [1] or len(log['plans']) != 1:
        return result('unclassified-run-record')
    if log['summary'] == ['OK'] and not log['blocks'] and exits[SUITE] == 0 and inputs['native_exit'] == 0:
        return result('mutation-survived-target-case-passed')
    if any('skipped=' in line for line in log['summary']):
        return result('skipped-capability-or-precondition')
    if [block for block in log['blocks'] if block['kind'] == 'ERROR']:
        return result('non-assertion-error')
    failures = [block for block in log['blocks'] if block['kind'] == 'FAIL']
    if (len(failures) != 1 or failures[0]['method'] != method or failures[0]['exception_type'] != 'AssertionError'
            or log['summary'] != ['FAILED (failures=1)'] or exits[SUITE] == 0 or inputs['native_exit'] == 0):
        return result('unclassified-failure')
    for detector in variant['detectors']:
        if failures[0]['frames'] == [[function, number] for function, number, _ in detector['frames']] and (
                detector['message'] is None or re.search(detector['message'], failures[0]['message'], re.M)):
            if detector.get('semantic'):
                # A pixel detector also needs the requested Final display, the same preregistered probe and a canvas value in
                # the mutant's predicted band; a rollback to a kept display or any other deviation is not this detection.
                matched, semantic = semantic_facts(detector['semantic'], failures[0]['message'])
                facts.setdefault('semantic', {})[detector['id']] = semantic
                if not matched:
                    continue
            return result('assertion-failure-at-preregistered-detector', {'id': detector['id'], 'proves': detector['proves']})
    return result('assertion-failure-outside-preregistered-detectors')


def detector_source(name):
    # The exact candidate test lines at every preregistered frame, from the checkout the native run used.
    path = ROOT / ORACLE
    try:
        data = path.read_bytes()
    except OSError as error:
        return {'error': type(error).__name__}
    lines = data.decode('utf-8', 'replace').splitlines()
    numbers = sorted({number for detector in MANIFEST['variants'][name]['detectors'] for _, number, _ in detector['frames']})
    return {'path': ORACLE, 'sha256': sha256(data), 'lines': {str(number): lines[number - 1] if number <= len(lines) else None for number in numbers}}


def copy_gate_state(target):
    try:
        sys.path.insert(0, str(ROOT / 'tests'))
        import live_test_gate
        source = live_test_gate.STATE
    except Exception as error:
        return {'error': type(error).__name__ + ': ' + str(error)}
    copied = []
    for path in sorted(source.glob(MANIFEST['unit'] + '*')) + [source / 'live-needs-inspection.json']:
        if path.is_file():
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target / path.name)
            copied.append({'name': path.name, 'sha256': sha256(path.read_bytes())})
    return copied


def classify(name):
    variant, directory = MANIFEST['variants'][name], EVIDENCE / name
    directory.mkdir(parents=True, exist_ok=True)
    exit_text = read_text(directory / 'native-exit.txt')
    suite_log = read_text(OUT / (SUITE + '.log'))
    inputs = {'guard': read_json(directory / 'guard.json'), 'selection': read_json(directory / 'selection.json'),
              'native_start': read_json(directory / 'native-start.json'), 'native_end': read_json(directory / 'native-end.json'),
              'native_exit': int(exit_text) if exit_text and exit_text.strip().isdigit() else None,
              'stages': read_json(OUT / 'results.json'), 'suite_log': suite_log}
    outcome = observe(name, inputs)
    outcome.update(variant=name, case=variant['case'], meaning=variant['meaning'], recorded_utc=utc_now(),
                   run={key: os.environ.get(key) for key in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_WORKFLOW_REF')},
                   patch={'path': variant['patch'], 'sha256': variant['patch_sha256'], 'after_sha256': variant['after_sha256']},
                   detector_source=detector_source(name), pinned_shader=MANIFEST['pinned_shader'] if 'pixel' in variant else None,
                   raw={'suite_log': (OUT / (SUITE + '.log')).relative_to(ROOT).as_posix(),
                        'suite_log_sha256': sha256((OUT / (SUITE + '.log')).read_bytes()) if suite_log is not None else None,
                        'results_sha256': sha256((OUT / 'results.json').read_bytes()) if (OUT / 'results.json').is_file() else None},
                   gate_state=copy_gate_state(directory / 'gate-state'))
    write_new(directory / 'classification.json', outcome)
    line = '| %s | %s | %s | native exit %s | suite exit %s |' % (name, outcome['observation'], (outcome['detector'] or {}).get('id'),
                                                                outcome['facts'].get('native_exit'), (outcome['facts'].get('stages') or {}).get(SUITE))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
            stream.write(line + '\n')
    print('VOI_MUTATION_OBSERVATION ' + line, flush=True)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', choices=('check', 'predict', 'guard', 'select', 'native', 'classify'))
    parser.add_argument('--variant', choices=sorted(MANIFEST['variants']))
    args = parser.parse_args(argv)
    if args.command == 'check':
        return check()
    if args.command == 'predict':
        return predict()
    if not args.variant:
        parser.error('--variant is required')
    return {'guard': guard, 'select': select, 'native': native, 'classify': classify}[args.command](args.variant)


if __name__ == '__main__':
    sys.exit(main())
