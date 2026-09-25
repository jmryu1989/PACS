"""S4-EG1 pure contract: judge adequacy and static pins (stdlib and AST only; no Docker, stack or network).

The offline judge must pass the clean vector, fail every violating vector on exactly its own ID and fail closed on
missing evidence. The live harness is read as source and never imported here: its import chain belongs to the
run-tests live permission. Pinned: the harness shape (A1 timing, scoped Compose, no reads while kin-orthanc is paused,
teardown order, the A3 handoff), the gateway-e2e finally path in measurement_ci, the dispatch-only workflow (A2) and
the one D-7 pure step in validate.yml.
"""
import ast
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import gateway_pipeline_judge as judge  # noqa: E402

LIVE = (ROOT / 'tests' / 'gateway_pipeline_live.py').read_text(encoding='utf-8')
LIVE_TREE = ast.parse(LIVE)
CI = (ROOT / 'tests' / 'measurement_ci.py').read_text(encoding='utf-8')
CI_TREE = ast.parse(CI)
WORKFLOW = (ROOT / '.github' / 'workflows' / 'gateway-e2e.yml').read_text(encoding='utf-8')
VALIDATE = (ROOT / '.github' / 'workflows' / 'validate.yml').read_text(encoding='utf-8')
VECTORS = json.loads((ROOT / 'tests' / 'gateway_pipeline_vectors.json').read_text(encoding='utf-8'))
METHODS = ['test_eg1_1_normal_transfer_and_late_delta', 'test_eg1_2_multibatch_outage_restart_resume',
           'test_eg1_3_storage_stall_crash_restart_now_retry', 'test_eg1_4_oversized_f01_boundary_bounded_repeat',
           'test_eg1_5_cross_study_convergence_and_negative_controls']
BLOCKS = ['N', 'B', 'R', 'F', 'X']
# The live step binds every source the run depends on (contract section 7, Binding).
BOUND = ['gateway/agent/agent.py', 'gateway/agent/Dockerfile', 'gateway/agent/requirements.txt',
         'gateway/docker-compose.yml', 'gateway/orthanc.json', 'scripts/send_cstore.py', 'scripts/run-tests.py',
         'tests/live_test_gate.py', 'tests/invariants_live.py', 'tests/measurement_ci.py',
         'tests/gateway_pipeline_live.py', 'tests/gateway_pipeline_judge.py', 'proxy/nginx.conf.template',
         'docker-compose.yml', 'config/orthanc.json', 'api/src/pacs.service.ts', 'api/src/pacs.controller.ts',
         'api/src/gateway-receipt.ts', 'api/src/gateway-retry.ts', 'api/src/auth.guard.ts',
         '.github/workflows/gateway-e2e.yml']


def apply(clean, patch):
    value = copy.deepcopy(clean)
    for operation in patch:
        *parents, last = operation['path']
        target = value
        for key in parents:
            target = target[key]
        if operation['op'] == 'set':
            target[last] = operation['value']
        elif operation['op'] == 'append':
            target[last].append(operation['value'])
        else:
            raise ValueError(operation['op'])
    return value


def position(node):
    return node.lineno, node.col_offset


def calls(node):
    return sorted((item for item in ast.walk(node) if isinstance(item, ast.Call)), key=position)


def callee(call):
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return call.func.id if isinstance(call.func, ast.Name) else None


def function(owner, name):
    found = [node for node in ast.walk(owner) if isinstance(node, ast.FunctionDef) and node.name == name]
    assert len(found) == 1, name
    return found[0]


def harness():
    return next(node for node in LIVE_TREE.body if isinstance(node, ast.ClassDef) and node.name == 'GatewayPipelineLive')


def assigned(tree, name):
    for node in tree.body:
        if isinstance(node, ast.Assign) and [ast.unparse(target) for target in node.targets] == [name]:
            return ast.literal_eval(node.value)
    raise AssertionError('no module constant ' + name)


def step_text(anchor):
    # The workflow step (from its "- " line) that contains the anchor.
    return WORKFLOW.split(anchor)[0].rsplit('\n      - ', 1)[1]


class JudgeAdequacy(unittest.TestCase):
    def test_ids_are_exact_and_partitioned(self):
        self.assertEqual(len(judge.IDS), 41)
        self.assertEqual(len(set(judge.IDS)), 41)
        self.assertEqual(set(judge.CHECKS), set(judge.IDS))
        self.assertEqual(judge.SCENARIO_IDS, tuple(name for name in judge.IDS if not name.startswith('T-')))
        asked = [name for group in judge.BLOCK_IDS.values() for name in group]
        self.assertEqual(len(asked), len(set(asked)))
        self.assertEqual(sorted(asked + ['X-5'] + [name for name in judge.IDS if name.startswith('T-')]),
                         sorted(judge.IDS))

    def test_clean_vector_passes_every_id(self):
        self.assertEqual(judge.judge(VECTORS['clean']), [])

    def test_each_violation_fails_exactly_its_own_id(self):
        named = [item['id'] for item in VECTORS['violations']]
        self.assertEqual(sorted(named), sorted(judge.IDS))
        self.assertEqual(len(named), len(set(named)))
        for item in VECTORS['violations']:
            with self.subTest(id=item['id']):
                self.assertEqual(judge.judge(apply(VECTORS['clean'], item['patch'])), [item['id']])

    def test_tolerated_variants_stay_clean(self):
        # A4 (a receipt on the Not Observed item) and the two outcomes the contract accepts either way.
        self.assertEqual(len(VECTORS['tolerated']), 3)
        for item in VECTORS['tolerated']:
            with self.subTest(why=item['why']):
                self.assertEqual(judge.judge(apply(VECTORS['clean'], item['patch'])), [])

    def test_missing_evidence_fails_closed(self):
        self.assertEqual(judge.judge({}), list(judge.IDS))
        self.assertEqual(judge.judge(None), list(judge.IDS))
        before_teardown = apply(VECTORS['clean'], [{'op': 'set', 'path': ['teardown'], 'value': None},
                                                   {'op': 'set', 'path': ['daemon'], 'value': None}])
        self.assertEqual(judge.judge(before_teardown), [name for name in judge.IDS if name.startswith('T-')])
        # The harness asks per block with the scenario only; that is exactly what it gets.
        self.assertEqual(judge.judge({'scenario': VECTORS['clean']['scenario']}, ids=judge.SCENARIO_IDS), [])

    def test_cli_rejudges_the_three_files_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            for name, key in (('scenario-evidence.json', 'scenario'), ('teardown-evidence.json', 'teardown'),
                              ('daemon-empty.json', 'daemon')):
                (base / name).write_text(json.dumps(VECTORS['clean'][key], ensure_ascii=False), encoding='utf-8')
            evidence = str(base / 'scenario-evidence.json')
            self.assertEqual(judge.main(['--evidence', evidence, '--out', str(base / 'judge.json')]), 0)
            written = json.loads((base / 'judge.json').read_text(encoding='utf-8'))
            self.assertEqual((written['findings'], written['ids']), ([], 41))
            self.assertEqual(sorted(written['inputs']), ['daemon-empty.json', 'scenario-evidence.json',
                                                         'teardown-evidence.json'])
            with self.assertRaises(FileExistsError):
                judge.main(['--evidence', evidence, '--out', str(base / 'judge.json')])
            (base / 'daemon-empty.json').unlink()
            self.assertEqual(judge.main(['--evidence', evidence, '--out', str(base / 'second.json')]), 1)
            self.assertEqual(json.loads((base / 'second.json').read_text(encoding='utf-8'))['findings'], ['T-4'])


class HarnessPins(unittest.TestCase):
    def test_module_imports_are_stdlib_plus_the_live_stack_and_the_judge(self):
        top = []
        for node in LIVE_TREE.body:
            if isinstance(node, ast.Import):
                top += [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                top += ['%s:%s' % (node.module, alias.name) for alias in node.names]
        self.assertEqual(sorted(top), sorted([
            'base64', 'hashlib', 'json', 'os', 're', 'secrets', 'shutil', 'subprocess', 'sys', 'time', 'unittest',
            'uuid', 'contextlib:contextmanager', 'datetime:datetime', 'datetime:timezone', 'pathlib:Path',
            'urllib.parse:quote', 'urllib.request:Request', 'urllib.request:urlopen', 'gateway_pipeline_judge',
            'invariants_live:Fixture', 'invariants_live:LiveStack', 'invariants_live:psql']))

    def test_fixture_and_agent_imports_stay_method_local(self):
        local = {}
        for node in ast.walk(harness()):
            if isinstance(node, ast.FunctionDef):
                for item in node.body:
                    for inner in ast.walk(item):
                        if isinstance(inner, ast.Import):
                            for alias in inner.names:
                                local.setdefault(alias.name, set()).add(node.name)
                        elif isinstance(inner, ast.ImportFrom):
                            local.setdefault(inner.module, set()).add(node.name)
        self.assertEqual(local, {'numpy': {'write_fixtures'}, 'pydicom.dataset': {'write_fixtures'},
                                 'pydicom.uid': {'write_fixtures'}, 'importlib.util': {'plan'}})

    def test_one_class_five_fixed_methods_each_one_block(self):
        cls = harness()
        self.assertEqual([node.name for node in LIVE_TREE.body if isinstance(node, ast.ClassDef)],
                         ['GatewayPipelineLive'])
        self.assertEqual([ast.unparse(base) for base in cls.bases], ['unittest.TestCase'])
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test')]
        self.assertEqual(declared, METHODS)
        self.assertEqual(sorted(METHODS), METHODS, 'run-tests orders by name; the declared order is the run order')
        for name, letter in zip(METHODS, BLOCKS):
            method = function(cls, name)
            self.assertIsInstance(method.body[0], ast.With, name)
            self.assertEqual(ast.unparse(method.body[0].items[0].context_expr), 'self.block(%r)' % letter)
        block = ast.get_source_segment(LIVE, function(cls, 'block'))
        for needle in ("self.fail('blocked by ' + cls.blocked)", 'cls.blocked = self._testMethodName',
                       "judge.judge({'scenario': self.ev}, ids=judge.BLOCK_IDS[name])"):
            self.assertIn(needle, block)
        # Never a skip: a blocked or failed method fails.
        self.assertFalse([node for node in ast.walk(LIVE_TREE) if isinstance(node, ast.Attribute)
                          and node.attr in ('skipTest', 'skip', 'skipIf', 'skipUnless', 'expectedFailure')])
        last = ast.get_source_segment(LIVE, function(cls, METHODS[-1]))
        self.assertIn("judge.judge({'scenario': self.ev}, ids=judge.SCENARIO_IDS), [], 'X-5')", last)

    def test_forbidden_paths_names_and_prints_are_absent(self):
        # D-2 and F-EG1-2: no C-6 script and no host-port path; the container environment is never read; nothing is
        # printed (measurement_ci captures this output into the uploaded log, so a mask command would leak the secret).
        for token in ('verify_c6', 'host.docker.internal', 'extra_hosts', 'host-gateway', 'add-mask', 'Config'):
            self.assertNotIn(token, LIVE, token)
        self.assertEqual([call for call in calls(LIVE_TREE) if callee(call) == 'print'], [])

    def test_accepted_timing_values_a1(self):
        env = assigned(LIVE_TREE, 'AGENT_ENV')
        self.assertEqual(env, {'GW_STABLE_AGE': '5', 'GW_POLL_SECONDS': '1', 'GW_HTTP_TIMEOUT_SECONDS': '10',
                               'GW_STOW_TIMEOUT_SECONDS': '30', 'GW_BACKOFF_BASE_SECONDS': '90',
                               'GW_BACKOFF_MAX_SECONDS': '90', 'GW_BYTE_BUDGET_MIB': '24'})
        deadlines = assigned(LIVE_TREE, 'DEADLINES')
        self.assertEqual(deadlines, {'setup': 240, 'fixtures': 60, 'N': 90, 'B': 320, 'R': 235, 'F': 90, 'X': 180})
        self.assertEqual(sum(deadlines.values()) + 45, 1260)
        self.assertEqual((judge.BACKOFF, judge.RECEIPT_LAG, judge.RETRY_NOW_WITHIN, judge.QUIET), (90, 100, 45, 18))
        self.assertEqual(int(env['GW_BACKOFF_BASE_SECONDS']), judge.BACKOFF)
        self.assertEqual(int(env['GW_BACKOFF_MAX_SECONDS']), judge.BACKOFF)
        self.assertEqual(3 * (int(env['GW_STABLE_AGE']) + int(env['GW_POLL_SECONDS'])), judge.QUIET)
        self.assertEqual(judge.BUDGET, int(env['GW_BYTE_BUDGET_MIB']) * 1024 * 1024)
        self.assertEqual(assigned(LIVE_TREE, 'KIN_BASE_URL'), 'https://kin-cloud')
        self.assertEqual((assigned(LIVE_TREE, 'DICOM_PORT'), assigned(LIVE_TREE, 'ORTHANC_HTTP_PORT')), (14243, 18043))
        writer = ast.get_source_segment(LIVE, function(harness(), 'write_env_file'))
        for needle in ("'KIN_BASE_URL': KIN_BASE_URL", "'KIN_TLS_VERIFY': 'false'", "'GW_DICOM_BIND': '127.0.0.1'",
                       '**AGENT_ENV', 'os.O_EXCL', '0o600'):
            self.assertIn(needle, writer)

    def test_every_gateway_compose_call_is_scoped_and_scrubbed(self):
        lists = [node for node in ast.walk(LIVE_TREE) if isinstance(node, ast.List) and node.elts
                 and isinstance(node.elts[0], ast.Constant) and node.elts[0].value == 'docker']
        self.assertEqual(len(lists), 2)
        compose = [node for node in lists if len(node.elts) > 1 and isinstance(node.elts[1], ast.Constant)
                   and node.elts[1].value == 'compose']
        self.assertEqual(len(compose), 1)
        self.assertEqual([ast.unparse(item) for item in compose[0].elts],
                         ["'docker'", "'compose'", "'-p'", 'cls.project', "'--env-file'", 'str(cls.env_file)', "'-f'",
                          'str(GATEWAY_COMPOSE)', '*args'])
        helper = function(harness(), 'compose')
        self.assertTrue(any(node is compose[0] for node in ast.walk(helper)))
        runs = [call for call in calls(helper) if ast.unparse(call.func) == 'subprocess.run']
        self.assertEqual(len(runs), 1)
        self.assertEqual([ast.unparse(item.value) for item in runs[0].keywords if item.arg == 'env'],
                         ['scrubbed_environment()'])
        self.assertIn("not key.startswith('COMPOSE_')",
                      ast.get_source_segment(LIVE, function(LIVE_TREE, 'scrubbed_environment')))
        orphans = [call for call in calls(LIVE_TREE)
                   if any(isinstance(arg, ast.Constant) and arg.value == '--remove-orphans' for arg in call.args)]
        self.assertEqual([ast.unparse(call.func) for call in orphans], ['cls.compose'])
        self.assertEqual(LIVE.count('--remove-orphans'), 1)

    def test_nothing_reads_the_worklist_or_cloud_orthanc_while_kin_orthanc_is_paused(self):
        method = function(harness(), METHODS[2])

        def docker_at(verb):
            found = [call for call in calls(method) if callee(call) == 'docker' and call.args
                     and isinstance(call.args[0], ast.Constant) and call.args[0].value == verb]
            self.assertEqual(len(found), 1, verb)
            self.assertEqual(ast.unparse(found[0].args[1]), 'CLOUD_ORTHANC')
            return position(found[0])

        paused, resumed = docker_at('pause'), docker_at('unpause')
        self.assertLess(paused, resumed)
        reads = [ast.unparse(call) for call in calls(method) if paused < position(call) < resumed
                 and callee(call) in ('row', 'row_with', 'observed', 'cloud_sops', 'request', 'bearer_request')]
        self.assertEqual(reads, [])
        # The restarts are the accepted ones: A5 graceful -t 30 in Block B, crash -t 0 in Block R.
        grace = {name: [ast.unparse(call.args[0]) for call in calls(function(harness(), name)) if callee(call) == 'restart']
                 for name in METHODS}
        self.assertEqual((grace[METHODS[1]], grace[METHODS[2]]), (['30'], ['0']))
        self.assertEqual(sum(len(value) for value in grace.values()), 2)

    def test_teardown_is_registered_first_and_runs_producer_before_consumer(self):
        setup = [ast.unparse(call.func) for call in calls(function(harness(), 'setUpClass'))]
        first = setup.index('cls.addClassCleanup')
        for later in ('cls.preflight', 'LiveStack', 'cls.compose', 'cls.docker', 'cls.write_artifact'):
            self.assertLess(first, setup.index(later), later)
        registered = next(call for call in calls(function(harness(), 'setUpClass'))
                          if ast.unparse(call.func) == 'cls.addClassCleanup')
        self.assertEqual(ast.unparse(registered.args[0]), 'cls.teardown')
        text = ast.get_source_segment(LIVE, function(harness(), 'teardown'))
        order = ["'scenario evidence'", "'proxy detach'", "'gateway down'", "'owned cleanup'", "'identities'",
                 "'fixtures'", "'teardown evidence'"]
        at = [text.index(name) for name in order]
        self.assertEqual(at, sorted(at))
        self.assertLess(text.index("'unpause'"), text.index("'gateway down'"))
        for needle in ("cls.compose('down', '-v', '--remove-orphans'", 'cls.stack.cleanup_all',
                       'cls.stack.cleanup_test_identities', "'scenario-evidence.json'", "'teardown-evidence.json'",
                       "kc_admin('GET', '/clients/'"):
            self.assertIn(needle, text)

    def test_handoff_is_exclusive_and_written_before_the_first_gateway_compose_call(self):
        self.assertEqual(assigned(LIVE_TREE, 'HANDOFF'), 'gateway-project.json')
        self.assertEqual(assigned(CI_TREE, 'GATEWAY_HANDOFF'), 'gateway-project.json')
        setup = function(harness(), 'setUpClass')
        writes = [call for call in calls(setup) if ast.unparse(call.func) == 'cls.write_artifact'
                  and ast.unparse(call.args[0]) == 'HANDOFF']
        self.assertEqual(len(writes), 1)
        self.assertEqual(sorted(key.value for key in writes[0].args[1].keys),
                         ['agent', 'cloud_network', 'orthanc', 'project'])
        composes = [call for call in calls(setup) if ast.unparse(call.func) == 'cls.compose']
        self.assertTrue(composes)
        self.assertLess(position(writes[0]), min(position(call) for call in composes))
        writer = ast.get_source_segment(LIVE, function(harness(), 'write_artifact'))
        self.assertIn(".open('x', encoding='utf-8')", writer)
        self.assertIn('cls.redact(', writer)
        # The same owned project pattern on both sides.
        self.assertIn("cls.project = 'kin-eg1-gw-' + secrets.token_hex(6)", LIVE)
        self.assertIn("GATEWAY_PROJECT = re.compile(r'kin-eg1-gw-[0-9a-f]{12}')", CI)


class MeasurementFinallyPins(unittest.TestCase):
    def test_gateway_finally_unpauses_before_logs_and_removes_after_the_main_down(self):
        main = ast.get_source_segment(CI, function(CI_TREE, 'main'))
        marks = [main.index(token) for token in ('gateway_unpause(run, out)', "run('services'", "run('cleanup'",
                                                 'gateway_remove(run, out)')]
        self.assertEqual(marks, sorted(marks))
        self.assertEqual(main.count("if profile_name == 'gateway-e2e':"), 2)
        self.assertEqual(main.count('gateway_unpause('), 1)
        self.assertEqual(main.count('gateway_remove('), 1)
        unpause = ast.get_source_segment(CI, function(CI_TREE, 'gateway_unpause'))
        self.assertIn("['docker', 'ps', '-q', '--filter', 'status=paused']", unpause)
        self.assertIn("['docker', 'unpause', *paused]", unpause)
        remove = ast.get_source_segment(CI, function(CI_TREE, 'gateway_remove'))
        kinds = [remove.index(token) for token in ("('containers', ['docker', 'ps', '-aq', '--filter', label]",
                                                   "('networks', ['docker', 'network', 'ls', '-q', '--filter', label]",
                                                   "('volumes', ['docker', 'volume', 'ls', '-q', '--filter', label]")]
        self.assertEqual(kinds, sorted(kinds))
        for needle in ("'label=com.docker.compose.project='+project", 'GATEWAY_PROJECT.fullmatch(project)',
                       "('networks', ['docker', 'network', 'ls', '-q', '--filter', 'type=custom'])",
                       "out/'daemon-empty.json'"):
            self.assertIn(needle, remove)


class WorkflowPins(unittest.TestCase):
    def test_dispatch_only_exact_commit_first_attempt(self):
        for needle in ('on:\n  workflow_dispatch:\n    inputs:\n      expected_sha:\n', 'required: true',
                       'permissions:\n  contents: read\n', 'concurrency:\n  group: gateway-e2e\n  cancel-in-progress: false\n',
                       'runs-on: ubuntu-24.04', 'timeout-minutes: 40', 'ref: ${{ github.sha }}',
                       'persist-credentials: false', 'EXPECTED_SHA: ${{ inputs.expected_sha }}',
                       'ACTUAL_SHA: ${{ github.sha }}', 'RUN_ATTEMPT: ${{ github.run_attempt }}',
                       "grep -Eqx '[0-9a-f]{40}'", '[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ]', '[ "$RUN_ATTEMPT" = "1" ]'):
            self.assertIn(needle, WORKFLOW)
        for absent in ('push:', 'pull_request:', 'schedule:', 'workflow_run:', 'playwright', 'tests/e2e/requirements.txt'):
            self.assertNotIn(absent, WORKFLOW)
        # The input reaches the guard only through the environment, never a run script.
        self.assertEqual(WORKFLOW.count('${{ inputs.'), 1)

    def test_steps_run_in_the_contract_order(self):
        order = ['Exact commit and first attempt only', '-- python3 -B tests/measurement_ci_test.py',
                 '-- python3 -B tests/gateway_pipeline_contract_test.py', '-m venv',
                 'ExecutionSelectionTests.test_gateway_e2e_profile_selects_five_declared_cases',
                 '--run-dir tmp/gateway-e2e-ci/environment', '--profile gateway-e2e',
                 'tests/gateway_pipeline_judge.py --evidence', 'actions/upload-artifact@']
        at = [WORKFLOW.index(needle) for needle in order]
        self.assertEqual(at, sorted(at))
        for needle in order[1:]:
            self.assertEqual(WORKFLOW.count(needle), 1, needle)
        self.assertIn('-m pip install -r gateway/agent/requirements.txt numpy==2.0.2 pydicom==2.4.4 pynetdicom==2.0.2\n',
                      WORKFLOW)

    def test_live_step_binds_every_source_and_keeps_its_bound(self):
        live = next(line for line in WORKFLOW.splitlines() if '--profile gateway-e2e' in line)
        self.assertIn('--run-dir tmp/gateway-e2e-ci/live --cwd . ', live)
        for path in BOUND:
            self.assertIn(' --file ' + path + ' ', live, path)
        self.assertTrue(live.endswith('"$RUNNER_TEMP/gateway-e2e-python/bin/python" tests/measurement_ci.py --profile gateway-e2e'))
        self.assertIn('timeout-minutes: 28', step_text('--profile gateway-e2e'))

    def test_judge_and_upload_always_run_and_keep_the_evidence(self):
        judged = step_text('tests/gateway_pipeline_judge.py --evidence')
        self.assertIn('if: always()', judged)
        self.assertIn('--out tmp/gateway-e2e-ci/judge/judge.json', WORKFLOW)
        upload = WORKFLOW.split('actions/upload-artifact@')[1]
        self.assertIn('if: always()', step_text('actions/upload-artifact@'))
        for needle in ('tests/e2e/artifacts/gateway-e2e-ci/', 'tmp/gateway-e2e-ci/', 'if-no-files-found: error',
                       'retention-days: 7'):
            self.assertIn(needle, upload)

    def test_validate_runs_only_the_pure_contract_in_the_measurements_job(self):
        # D-7: one pure step on push and PR; the live profile stays dispatch only.
        self.assertEqual(VALIDATE.count('-- python3 -B tests/gateway_pipeline_contract_test.py'), 1)
        job = VALIDATE.split('\n  measurements:\n')[1].split('\n  volume-rendering:\n')[0]
        self.assertIn('--run-dir tmp/workspace-ui-ci/gateway-pipeline-contract ', job)
        self.assertIn('-- python3 -B tests/gateway_pipeline_contract_test.py', job)
        self.assertNotIn('--profile gateway-e2e', VALIDATE)
        for runner in ('-B tests/gateway_pipeline_live.py', '--module tests/gateway_pipeline_live.py'):
            self.assertNotIn(runner, VALIDATE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
