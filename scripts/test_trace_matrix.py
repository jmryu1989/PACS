#!/usr/bin/env python3
"""REQ-CD14-TRACE-MATRIX -> RISK-CD14-OMITTED-GAP / RISK-CD14-FALSE-VV -> TEST-CD14-TRACE-MATRIX.

The fixed fixture tree is tests/fixtures/trace: repo/ is the input repository
(READMEs, test files, a runner with a suite table, a case table with its consumer,
a workflow and ci-paths.json), ci-runs/ holds two record-run run.json files and
requirements.csv is the optional requirement list. expected/ pins the CSV rows and
the gap lists byte for byte, because those two files are the data the reviewer
reads and acceptance 4 requires the same bytes from the same inputs. The HTML
wording is not pinned; its stamps, its statement, its CI labels and the absence of
scripts are.
"""
import contextlib
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/trace'
spec = importlib.util.spec_from_file_location('build_trace_matrix', ROOT / 'scripts/build-trace-matrix.py')
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)
OUTPUTS = ('trace-matrix.csv', 'trace-matrix.html', 'trace-gaps.json')
FULL = {'run_id': 'fixture-run-7', 'ci_runs': FIXTURE / 'ci-runs', 'requirements': FIXTURE / 'requirements.csv'}
RUNNER_JOB = 'validate:fx-live(measurement_ci:fx-profile)'
MUTANTS = 'tests/fx_print_mutants.py'


def generate(out, root=FIXTURE / 'repo', **options):
    return trace.build(root, out, 'fixture-commit', **options)


def csv_rows(out):
    return list(csv.DictReader((Path(out) / 'trace-matrix.csv').read_text(encoding='utf-8').splitlines()))


def gap_lists(out):
    return json.loads((Path(out) / 'trace-gaps.json').read_text(encoding='utf-8'))


def tree_digest(directory):
    return {path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(Path(directory).rglob('*')) if path.is_file()}


class TraceMatrixTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)

    def full(self, name='out', **options):
        out = self.work / name
        generate(out, **FULL, **options)
        return out

    def copy(self):
        repo = self.work / 'repo'
        shutil.copytree(FIXTURE / 'repo', repo)
        return repo

    def test_rows_and_gap_lists_match_the_reviewed_fixture(self):
        out = self.full()
        for name in ('trace-matrix.csv', 'trace-gaps.json'):
            with self.subTest(output=name):
                self.assertEqual((out / name).read_bytes(), (FIXTURE / 'expected' / name).read_bytes())
        self.assertEqual(tuple(csv_rows(out)[0]), trace.CSV_COLUMNS)

    def test_gap_lists_agree_with_the_rows(self):
        out = self.full()
        rows, gaps = csv_rows(out), gap_lists(out)
        self.assertEqual(set(gaps), {'base_commit', 'run_id', 'statement', 'req_without_test', 'test_without_req',
                                     'test_not_in_ci', 'test_ci_unverified', 'irregular_notation'})
        tested = {row['req'] for row in rows if row['test_id'] or row['test_file']}
        untested = [item['req'] for item in gaps['req_without_test']]
        self.assertTrue(untested)
        self.assertFalse(tested.intersection(untested))
        # A requirement only in --requirements, ones only in prose and one with an irregular third element.
        self.assertEqual({source.split(':')[0] for item in gaps['req_without_test'] for source in item['sources']},
                         {'requirements.csv', 'README.md'})
        referenced = {row['test_id'] for row in rows if row['test_id']}
        unreferenced = gaps['test_without_req']
        self.assertTrue(unreferenced)
        self.assertFalse(referenced.intersection(item['test_id'] for item in unreferenced))
        self.assertIn(['tests/fx_unref_test.py'], [item['files'] for item in unreferenced])
        in_ci = {row['test_file'] for row in rows if row['in_ci'] == 'yes'}
        for item in gaps['test_not_in_ci'] + gaps['test_ci_unverified']:
            self.assertNotIn(item['test_file'], in_ci)
        self.assertEqual({(item['test_file'], item['reason']) for item in gaps['test_not_in_ci']},
                         {('tests/fx_unref_test.py', 'no'), ('tests/fx_idle_live.py', 'no'), ('', 'no-test-file')})
        self.assertEqual({(item['test_file'], item['reason']) for item in gaps['test_ci_unverified']},
                         {('tests/fx_beta_test.cjs', 'selection-only'), (MUTANTS, 'selection-only')})
        self.assertEqual({item['reason'] for item in gaps['irregular_notation']},
                         {'test-by-file', 'test-not-id', 'no-chain', 'missing-test', 'abbreviated-label',
                          'table-test-not-id'})

    def test_direct_runner_and_selection_only_are_distinguished_in_all_outputs(self):
        out = self.full()
        rows, gaps = csv_rows(out), gap_lists(out)
        jobs = {row['test_file']: (row['in_ci'], row['ci_job']) for row in rows}
        self.assertEqual(jobs['tests/fx_alpha_test.py'], ('yes', 'validate:pure'))
        # Named by no command; the runner's PROFILES['fx-profile']['suites'] (built from SUITES) names it.
        self.assertEqual(jobs['tests/fx_runner_test.py'], ('yes', RUNNER_JOB))
        # Declared by a profile no workflow invokes: not in CI.
        self.assertEqual(jobs['tests/fx_idle_live.py'], ('no', ''))
        self.assertEqual(jobs['tests/fx_beta_test.cjs'], ('selection-only', 'ci-paths:fx-select'))
        listed = {key: {item['test_file'] for item in gaps[key]} for key in ('test_not_in_ci', 'test_ci_unverified')}
        self.assertEqual(listed['test_ci_unverified'], {'tests/fx_beta_test.cjs', MUTANTS})
        self.assertNotIn('tests/fx_beta_test.cjs', listed['test_not_in_ci'])
        self.assertIn('tests/fx_idle_live.py', listed['test_not_in_ci'])
        for path in ('tests/fx_alpha_test.py', 'tests/fx_runner_test.py'):
            self.assertNotIn(path, listed['test_not_in_ci'] | listed['test_ci_unverified'])
        page = (out / 'trace-matrix.html').read_text(encoding='utf-8')
        for cell in ('<td>validate:pure</td>', f'<td>{RUNNER_JOB}</td>', '<td>ci-paths:fx-select</td>'):
            self.assertIn(cell, page)
        unverified = page.split('<h2>Tests With Unverified CI Execution</h2>', 1)[1].split('<h2>', 1)[0]
        self.assertIn('tests/fx_beta_test.cjs', unverified)
        self.assertNotIn('tests/fx_beta_test.cjs', page.split('<h2>Tests Not Run in CI</h2>', 1)[1].split('<h2>', 1)[0])

    def test_a_carrier_counts_whatever_its_file_name(self):
        # The mutation runner carries its id on line 2 under a name outside the test-file pattern.
        test_id = (FIXTURE / 'repo' / MUTANTS).read_text(encoding='utf-8').splitlines()[1].strip('"').split(':')[0]
        gaps = gap_lists(self.full())
        entries = {key: [item for item in gaps[key] if item['test_id'] == test_id]
                   for key in ('test_not_in_ci', 'test_ci_unverified')}
        self.assertEqual(entries['test_not_in_ci'], [])
        self.assertEqual(entries['test_ci_unverified'], [{'ci_job': 'ci-paths:fx-select', 'in_ci': 'selection-only',
                                                          'reason': 'selection-only', 'test_file': MUTANTS,
                                                          'test_id': test_id}])
        self.assertIn({'test_id': test_id, 'files': [MUTANTS]}, gaps['test_without_req'])
        # An id written only in a README has no carrier at all. It is read from the README:
        # written here, this file would carry it in the real repository's matrix.
        readme = (FIXTURE / 'repo/docs/README.md').read_text(encoding='utf-8')
        only = next(re.findall(r'TEST-[A-Z-]+', line)[0] for line in readme.splitlines()
                    if line.startswith('TEST-') and '->' not in line)
        self.assertIn({'ci_job': '', 'in_ci': 'no', 'reason': 'no-test-file', 'test_file': '',
                       'test_id': only}, gaps['test_not_in_ci'])

    def test_hashed_inputs_are_not_executions(self):
        unref = 'tests/fx_unref_test.py'
        listed = {item['test_file'] for item in gap_lists(self.full())['test_not_in_ci']}
        # Named only as record-run --file and by a ci-paths job no workflow defines.
        self.assertIn(unref, listed)
        repo = self.copy()
        workflow = repo / '.github/workflows/validate.yml'
        workflow.write_text(workflow.read_text(encoding='utf-8') +
                            '    - name: Now executed\n      run: python3 -B tests/fx_unref_test.py\n',
                            encoding='utf-8', newline='\n')
        out = self.work / 'executed'
        generate(out, root=repo)
        self.assertNotIn(unref, {item['test_file'] for item in gap_lists(out)['test_not_in_ci']})

    def test_case_table_rows_are_edges_carried_by_the_suite_that_runs_them(self):
        # The ids are read from the fixture table: written here, they would be TEST ids
        # carried by this file in the real repository's matrix.
        table = json.loads((FIXTURE / 'repo/tests/fx_cases.json').read_text(encoding='utf-8'))
        suite = table['suites'][0]
        # The consumer quotes the table's path and the workflow runs it; the suite declares its own file.
        linked = [case for case in table['cases'] if 'testId' in case]
        cases = [(case['requirement'], case['risk'], case['testId'], 'tests/fx_table_test.cjs') for case in linked]
        cases += [(case['req'], case['risk'], case['test'], suite['file']) for case in suite['cases']]
        out = self.full()
        rows, gaps = csv_rows(out), gap_lists(out)
        edges = {(row['req'], row['risk'], row['test_id'], row['test_file'], row['in_ci'], row['ci_job'])
                 for row in rows if row['source_file:line'].startswith('tests/fx_cases.json:')}
        self.assertEqual(edges, {case + ('yes', 'validate:pure') for case in cases})
        sources = {row['test_id']: row['source_file:line'] for row in rows if row['test_file'] == 'tests/fx_table_test.cjs'}
        self.assertEqual(sources, dict(zip((case['testId'] for case in linked),
                                           ('tests/fx_cases.json:8', 'tests/fx_cases.json:14'))))
        # A row whose test field is not a TEST id is reported at its line, never linked.
        self.assertEqual([item['source'] for item in gaps['irregular_notation'] if item['reason'] == 'table-test-not-id'],
                         ['tests/fx_cases.json:20'])
        gap_ids = {item['test_id'] for key in ('test_without_req', 'test_not_in_ci', 'test_ci_unverified')
                   for item in gaps[key]}
        self.assertFalse({case[2] for case in cases} & gap_ids)
        # A TEST id in any other JSON string is not an input.
        note = table['note'].split()[0]
        for name in OUTPUTS:
            self.assertNotIn(note, (out / name).read_text(encoding='utf-8'))

    def test_workflow_yaml_layout_does_not_change_the_result(self):
        repo = self.copy()
        workflow = repo / '.github/workflows/validate.yml'
        head, jobs = workflow.read_text(encoding='utf-8').split('jobs:\n', 1)
        deeper = ''.join('  ' + line if line.strip() else line for line in jobs.splitlines(keepends=True))
        workflow.write_text(head + 'jobs:\n' + deeper, encoding='utf-8', newline='\n')
        first, second = self.full('first'), self.full('second', root=repo)
        for name in OUTPUTS:
            with self.subTest(output=name):
                self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())

    def test_an_abbreviated_label_is_reported_and_never_made_an_id(self):
        out = self.full()
        gaps = gap_lists(out)
        self.assertIn('REQ-FX-SHORT', [item['req'] for item in gaps['req_without_test']])
        for name in OUTPUTS:
            self.assertNotIn('REQ-FX-FX-CASE-LABEL', (out / name).read_text(encoding='utf-8'))
        flagged = [item for item in gaps['irregular_notation'] if item['reason'] == 'abbreviated-label']
        self.assertEqual([item['source'] for item in flagged], ['README.md:14'])

    def test_last_run_is_the_latest_record_naming_the_test(self):
        rows = [row for row in csv_rows(self.full()) if row['test_file'] == 'tests/fx_alpha_test.py']
        self.assertTrue(rows)
        for row in rows:
            self.assertIn('scripts/run-tests.py', row['last_run_command'])
            self.assertEqual(row['last_run_exit'], '1')
            self.assertRegex(row['last_run_inputs_sha256'], r'^[0-9a-f]{64}$')
        runs = self.work / 'runs'
        shutil.copytree(FIXTURE / 'ci-runs/run-a', runs / 'run-a')
        out = self.work / 'older'
        generate(out, ci_runs=runs)
        older = [row for row in csv_rows(out) if row['test_file'] == 'tests/fx_alpha_test.py']
        self.assertEqual({row['last_run_exit'] for row in older}, {'0'})
        self.assertNotEqual(older[0]['last_run_inputs_sha256'], rows[0]['last_run_inputs_sha256'])
        out = self.work / 'none'
        generate(out)
        self.assertEqual({row['last_run_command'] for row in csv_rows(out)}, {''})

    def test_same_inputs_give_the_same_bytes(self):
        first, second = self.full('first'), self.full('second')
        for name in OUTPUTS:
            with self.subTest(output=name):
                data = (first / name).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(),
                                 hashlib.sha256((second / name).read_bytes()).hexdigest())
                self.assertNotIn(b'\r', data)
                self.assertFalse(data.startswith(b'\xef\xbb\xbf'))
                data.decode('utf-8')
        gaps = gap_lists(first)
        self.assertEqual((first / 'trace-gaps.json').read_text(encoding='utf-8'),
                         json.dumps(gaps, sort_keys=True, indent=2, ensure_ascii=False) + '\n')

    def test_header_stamps_commit_and_run_as_an_execution_record(self):
        out = self.full()
        page = (out / 'trace-matrix.html').read_text(encoding='utf-8')
        gaps = gap_lists(out)
        self.assertIn('fixture-commit', page)
        self.assertIn('fixture-run-7', page)
        self.assertIn('실행 기록이다', page)
        self.assertIn('V&amp;V) 완료를 뜻하지 않으며', page)
        self.assertNotIn('<script', page.lower())
        self.assertEqual((gaps['base_commit'], gaps['run_id']), ('fixture-commit', 'fixture-run-7'))
        self.assertIn('V&V) 완료를 뜻하지 않으며', gaps['statement'])
        bare = self.work / 'bare'
        generate(bare)
        self.assertIsNone(gap_lists(bare)['run_id'])
        self.assertNotIn('fixture-run-7', (bare / 'trace-matrix.html').read_text(encoding='utf-8'))

    def test_writes_only_the_three_outputs(self):
        before = tree_digest(FIXTURE)
        out = self.full()
        self.assertEqual(sorted(path.name for path in out.iterdir()), sorted(OUTPUTS))
        self.assertEqual(tree_digest(FIXTURE), before)
        self.assertEqual(sorted(path.name for path in self.work.iterdir()), ['out'])

    def test_command_line_refuses_a_requirements_list_without_req_ids(self):
        listing = self.work / 'bad.csv'
        listing.write_text('req\nnot-an-id\n', encoding='utf-8', newline='\n')
        out = self.work / 'out'
        with contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(trace.main(['--out', str(out), '--base-commit', 'fixture-commit',
                                         '--requirements', str(listing)]), 1)
        self.assertIn("'not-an-id'", error.getvalue())
        self.assertFalse(out.exists())

    def test_command_line_help_and_argument_errors_are_korean(self):
        # §4: option names stay English; the sentences a user reads are Korean.
        hangul = '[가-힣]'
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit) as stop:
            trace.main(['--help'])
        self.assertEqual(stop.exception.code, 0)
        page = output.getvalue()
        # One block per option: its line and the wrapped help below it.
        blocks = re.split(r'\n(?=\s+-)', page)
        for option in ('-h, --help', '--out', '--base-commit', '--run-id', '--ci-runs', '--requirements'):
            block = next(block for block in blocks if block.lstrip().startswith(option + ' '))
            self.assertRegex(block, hangul, option)
        self.assertRegex(page.splitlines()[0], hangul)
        out = self.work / 'out'
        for argv in (['--out'], ['--root', '.']):
            with self.subTest(argv=argv):
                with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit) as stop:
                    trace.main(argv)
                self.assertEqual(stop.exception.code, 2)
                message = error.getvalue().strip().splitlines()[-1]
                self.assertIn(argv[0], message)
                self.assertRegex(message, hangul)
                self.assertRegex(error.getvalue().splitlines()[0], hangul)
        self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
