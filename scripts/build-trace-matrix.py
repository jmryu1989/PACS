#!/usr/bin/env python3
"""저장소의 REQ -> RISK -> TEST 표기, CI 명령과 CI 실행 기록을 추적표로 모은다.

REQ-CD14-TRACE-MATRIX -> RISK-CD14-OMITTED-GAP / RISK-CD14-FALSE-VV -> TEST-CD14-TRACE-MATRIX.
The matrix is an execution record of what the repository writes and what CI names
or ran; it is not a verification and validation completion statement. No network,
writes only below --out; the same inputs give the same bytes (sorted rows and keys,
no clock, LF, UTF-8 without BOM). Workflows are read with tests/ci_workflows.py
(PyYAML) and the CI runners' suite tables with ast, as the existing CI checks do.
The notation rules this parser accepts are in tests/README.md ("추적표 생성기").
"""
import argparse
import ast
from collections import Counter
import csv
import hashlib
import html
import importlib.util
import io
import json
import os
from pathlib import Path
import posixpath
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIPPED_DIRECTORIES = {'.git', 'node_modules', 'tmp', 'evidence'}
SOURCE_TREES = ('tests', 'api/src', 'scripts', 'worklist-v0/hpacs-lite')
# Fixtures are other tests' inputs, not notation; the bundle repeats its own sources.
SKIPPED_PREFIXES = ('tests/fixtures/',)
GENERATED = {'worklist-v0/hpacs-lite/main-split.bundle.js'}
# A carrier is a test or tool program of the repository, whatever its name (*_mutants.py runs as a test).
CARRIER = re.compile(r'(?:tests|scripts)/.*\.(?:py|cjs|mjs|js)$')
# Only for a file named in prose: the word must look like a test file before it is looked up.
TEST_NAME = re.compile(r'(?:^|/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|cjs|mjs|js)|[^/]*_live\.py)$')
TEST_STEM = re.compile(r'[A-Za-z0-9_]+_test$')
# The repository's CI runners. A workflow command names the runner; the runner's own
# suite table names the test files it executes, so that table is the CI test list.
MEASUREMENT_RUNNER = 'tests/measurement_ci.py'
CANDIDATE_RUNNER = 'tests/candidate_ci.py'
CANDIDATE_TABLES = ('BASE', 'FLOWS')
# Case-table rows: one JSON object carrying a TEST id with its REQ (and RISK) ids.
TABLE_KEYS = {'TEST': ('testId', 'test'), 'REQ': ('requirement', 'req'), 'RISK': ('risk',)}
CSV_COLUMNS = ('req', 'risk', 'test_id', 'test_file', 'source_file:line', 'in_ci', 'ci_job',
               'last_run_command', 'last_run_exit', 'last_run_inputs_sha256')
GAP_COLUMNS = ('test_id', 'test_file', 'in_ci', 'ci_job', 'reason')
STATEMENT = ('이 표는 저장소의 REQ/RISK/TEST 표기와 CI 명령·실행 기록을 모은 실행 기록이다. '
             '검증·유효성 확인(V&V) 완료를 뜻하지 않으며, 같은 CI를 다시 실행한 결과도 V&V 완료로 표시하지 않는다.')

WORD = r'[A-Za-z0-9][A-Za-z0-9-]*'
# A prefixed form such as U5S-REQ-04 is not this notation; it is reported, not guessed.
CONTINUATION = r'(?![A-Z0-9-]*(?:REQ|RISK|TEST)\b)[A-Z0-9]+(?:-[A-Z0-9]+)*\b'


def identifier(kind):
    return rf'(?<![A-Za-z0-9_-]){kind}-{WORD}(?:/{WORD})*'


def group_pattern(kind):
    one = identifier(kind)
    return re.compile(rf'{one}(?:(?:\s*/\s*|·)(?:{one}|{CONTINUATION})|\s*,\s*{one}|\s+and\s+{one})*')


GROUPS = {kind: group_pattern(kind) for kind in ('REQ', 'RISK', 'TEST')}
TOKENS = {kind: re.compile(rf'{identifier(kind)}|{CONTINUATION}') for kind in GROUPS}
ARROW = re.compile(r'\s*(?:→|->)\s*')
HEAD_END = re.compile(r':(?:\s|$)|\.(?:\s|$)|;|。')
TRAILING_ANNOTATION = re.compile(r'\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$')
QUOTED = re.compile(r'"([^"\n]*)"|\'([^\'\n]*)\'|`([^`\n]*)`')


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


matches = load_module(ROOT / 'scripts/ci_select.py', 'ci_select').matches
WorkflowCatalog = load_module(ROOT / 'tests/ci_workflows.py', 'ci_workflows').WorkflowCatalog


def expand(token, kind, labels=None):
    """<kind>-A-07/15/19 is three ids, <kind>-A-01/17-B is A-01-B and A-17-B; a full id after / stands alone.

    A multi-part word that starts with the stem's own last part (REQ-A-DURABLE /
    A-PG-COMMIT) is a case label, not a substitution: REQ-A-A-PG-COMMIT is never
    written, so the word goes to labels and no id is made of it.
    """
    parts = [part.rstrip('-') for part in token.split('/')]
    parts = [part for part in parts if part]
    first, alternatives = parts[0], parts[1:]
    numbered = re.fullmatch(r'(.*-)(\d+)', first)
    if numbered and alternatives and all(re.fullmatch(r'\d+', part) for part in alternatives[:-1]):
        suffixed = re.fullmatch(r'(\d+)(-[A-Za-z0-9-]+)', alternatives[-1])
        if suffixed:
            numbers = [numbered.group(2), *alternatives[:-1], suffixed.group(1)]
            return [numbered.group(1) + number + suffixed.group(2) for number in numbers]
    ids, stem = [first], first.rsplit('-', 1)[0] + '-'
    for part in alternatives:
        if re.match(r'(?:REQ|RISK|TEST)-', part):
            if not part.startswith(kind + '-'):
                break
            ids.append(part)
            stem = part.rsplit('-', 1)[0] + '-'
        elif '-' in part and part.startswith(stem[:-1].rsplit('-', 1)[-1] + '-'):
            if labels is not None:
                labels.append(part)
        else:
            ids.append(stem + part)
    return ids


def group_ids(text, kind, labels=None):
    """Every id of one kind written in text, compound and continued forms expanded, in order."""
    found = []
    for group in GROUPS[kind].finditer(text):
        tokens = []
        for token in TOKENS[kind].finditer(group.group(0)):
            value = token.group(0)
            if value.startswith(kind + '-'):
                tokens.append(value)
            elif tokens:
                tokens[-1] += '/' + value
        for token in tokens:
            found.extend(expand(token, kind, labels))
    return list(dict.fromkeys(found))


def is_test_file(path):
    return bool(TEST_NAME.search(path))


def is_carrier(path):
    return bool(CARRIER.match(path))


def walk(root, top, skipped_prefixes=SKIPPED_PREFIXES):
    """Repository-relative POSIX paths below top, sorted, without skipped directories."""
    base = root / top if top else root
    if not base.is_dir():
        return []
    found = []

    def unreadable(error):
        # A skipped directory would silently drop notation from the record.
        raise error

    for directory, names, files in os.walk(base, onerror=unreadable):
        names[:] = sorted(name for name in names if name not in SKIPPED_DIRECTORIES)
        for name in files:
            relative = (Path(directory) / name).relative_to(root).as_posix()
            if not relative.startswith(skipped_prefixes) and relative not in GENERATED:
                found.append(relative)
    return sorted(found)


def read_lines(path):
    data = path.read_bytes()
    if b'\0' in data:
        return None
    return data.decode('utf-8', errors='replace').splitlines()


def chain_requirements(piece):
    """(REQ ids, start) when piece ends with a REQ group, else (None, None).

    The group may close a parenthesis, "(REQ-…) ->", or carry a trailing
    annotation, "REQ-… (D621) ->"; annotations are dropped one at a time.
    """
    text = piece
    while True:
        text = text.rstrip(' *`')
        last = None
        for last in GROUPS['REQ'].finditer(text):
            pass
        if last is not None and not text[last.end():].strip(' *`)'):
            return group_ids(last.group(0), 'REQ'), last.start()
        shorter = TRAILING_ANNOTATION.sub('', text)
        if shorter == text:
            return None, None
        text = shorter


class Notation:
    def __init__(self, test_files):
        self.test_files = test_files
        self.edges = set()
        self.irregular = set()
        self.requirements = {}
        self.chain_tests = set()

    def requirement(self, req, source):
        self.requirements.setdefault(req, set()).add(source)

    def flag(self, source, reason, text):
        self.irregular.add((source, reason, text.strip()[:200]))

    def resolve(self, name):
        name = name[2:] if name.startswith('./') else name
        if '.' not in Path(name).name:
            candidates = [path for path in self.test_files if Path(path).stem == Path(name).name]
        else:
            candidates = [path for path in self.test_files if path == name or path.endswith('/' + name)]
        return candidates

    def test_element(self, head, carrier, source, text):
        """(test ids, test files, irregular reason or None) named by the third element."""
        ids = group_ids(head, 'TEST')
        if ids:
            return ids, [], None
        names = []
        for word in re.findall(r'[A-Za-z0-9_./-]+', head.replace('`', ' ')):
            if is_test_file(word) or TEST_STEM.fullmatch(word):
                names.append(word)
        if names:
            files, reason = [], 'test-by-file'
            for name in dict.fromkeys(names):
                candidates = self.resolve(name)
                if len(candidates) == 1:
                    files.append(candidates[0])
                else:
                    reason = 'ambiguous-test-file' if candidates else 'unresolved-test-file'
                    self.flag(source, reason, text)
            return [], files, 'test-by-file' if files else reason
        if is_carrier(carrier):
            return [], [carrier], 'test-not-id'
        return [], [], 'test-not-id'

    def scan_line(self, carrier, number, line):
        source = f'{carrier}:{number}'
        labels = []
        for kind in GROUPS:
            group_ids(line, kind, labels)
        if labels:
            self.flag(source, 'abbreviated-label', line)
        pieces = ARROW.split(line)
        chains = 0
        index = 0
        while index < len(pieces) - 1:
            reqs, _ = chain_requirements(pieces[index])
            if not reqs:
                index += 1
                continue
            chains += 1
            middle = pieces[index + 1]
            next_reqs, next_start = chain_requirements(middle)
            # A REQ group closing the middle piece starts the next chain on this line.
            starts_next = bool(next_reqs) and index + 2 < len(pieces)
            if starts_next:
                middle = middle[:next_start]
            risks = group_ids(middle, 'RISK')
            middle_tests = group_ids(HEAD_END.split(middle, 1)[0], 'TEST')
            tests, files, reason = [], [], None
            consumed = index + 1
            if not risks and middle_tests:
                tests, reason = middle_tests, 'missing-risk'
            elif starts_next or index + 2 >= len(pieces):
                reason = 'missing-test'
                if is_carrier(carrier):
                    files = [carrier]
            else:
                third = pieces[index + 2]
                follow_reqs, follow_start = chain_requirements(third)
                if follow_reqs and index + 3 < len(pieces):
                    third = third[:follow_start]
                tests, files, reason = self.test_element(HEAD_END.split(third, 1)[0], carrier, source, line)
                consumed = index + 2
                if not risks:
                    self.flag(source, 'missing-risk', line)
            if reason:
                self.flag(source, reason, line)
            for req in reqs:
                self.requirement(req, source)
                for risk in risks or ['']:
                    for test in tests:
                        self.edges.add((req, risk, test, None, source))
                        self.chain_tests.add(test)
                    for path in files:
                        self.edges.add((req, risk, '', path, source))
                    if not tests and not files:
                        self.edges.add((req, risk, '', '', source))
            index = consumed
        # Prefixed forms (U5S-REQ-04) count here: they are reported, never read as ids.
        if not chains and re.search(r'REQ-[A-Za-z0-9]', line) and re.search(r'RISK-[A-Za-z0-9]', line):
            if ARROW.search(line):
                self.flag(source, 'no-chain', line)
            elif re.search(r'TEST-[A-Za-z0-9]', line):
                self.flag(source, 'slash-triplet', line)


def row_ids(row, kind):
    # A table field holds one whole id, so its id may carry the _ and . that prose ids cannot (TOMO_SCOUT, IOD-13.1.4).
    values = []
    for key in TABLE_KEYS[kind]:
        value = row.get(key)
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str) and re.fullmatch(rf'{kind}-[A-Za-z0-9][A-Za-z0-9_.-]*', item):
                values.append(item)
    return values


def table_rows(document):
    """(row, declared suite file or None) for every object carrying a REQ id and a test field, in document order."""
    def visit(value, suite):
        if isinstance(value, dict):
            declared = value.get('file')
            suite = declared if isinstance(declared, str) else suite
            if row_ids(value, 'REQ') and any(isinstance(value.get(key), (str, list)) for key in TABLE_KEYS['TEST']):
                yield value, suite
            for child in value.values():
                yield from visit(child, suite)
        elif isinstance(value, list):
            for child in value:
                yield from visit(child, suite)
    return list(visit(document, None))


def table_consumers(root, table, test_files, unique_name):
    """Test files quoting a path that resolves to the table (from their directory, the root or as a
    path suffix), or quoting its bare file name when no other file under the source trees has it."""
    name = posixpath.basename(table)
    found = []
    for path in test_files:
        lines = read_lines(root / path) if path != table else None
        text = '\n'.join(lines or [])
        if name not in text:
            continue
        for quoted in QUOTED.finditer(text):
            value = next(group for group in quoted.groups() if group is not None)
            if not value.endswith(name):
                continue
            stripped = value[2:] if value.startswith('./') else value
            resolved = {posixpath.normpath(posixpath.join(posixpath.dirname(path), value)), posixpath.normpath(value)}
            if (table in resolved or ('/' in stripped and table.endswith('/' + stripped))
                    or (value == name and unique_name)):
                found.append(path)
                break
    return found


def read_table(root, path, test_files, unique_name, notation, carriers):
    """REQ x RISK x TEST edges of a JSON case table; other JSON strings are not read."""
    data = (root / path).read_bytes()
    try:
        document = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return
    found = table_rows(document)
    if not found:
        return
    text = data.decode('utf-8').splitlines()
    positions = {}
    for number, line in enumerate(text, 1):
        for key, value in re.findall(r'"(testId|test)"\s*:\s*"([^"]*)"', line):
            positions.setdefault((key, value), []).append(number)
    rows = [(row, suite) for row, suite in found if row_ids(row, 'TEST')]
    # A test field that is not a TEST id (XA01) is a table this reader cannot link: reported once, not guessed.
    for row, _ in [item for item in found if not row_ids(item[0], 'TEST')][:1]:
        key = next(key for key in TABLE_KEYS['TEST'] if isinstance(row.get(key), (str, list)))
        value = row[key] if isinstance(row[key], str) else ''
        number = (positions.get((key, value)) or [0])[0]
        notation.flag(f'{path}:{number}', 'table-test-not-id', text[number - 1] if number else json.dumps(row)[:200])
    consumers = None
    for row, suite in rows:
        key = next(key for key in TABLE_KEYS['TEST'] if row_ids({key: row.get(key)}, 'TEST'))
        tests = row_ids(row, 'TEST')
        lines = positions.get((key, tests[0])) or [0]
        source = f'{path}:{lines.pop(0) if len(lines) > 1 else lines[0]}'
        if isinstance(suite, str) and suite in test_files:
            files = [suite]
        else:
            if consumers is None:
                consumers = table_consumers(root, path, test_files, unique_name)
            files = consumers or ['']
        for req in row_ids(row, 'REQ'):
            notation.requirement(req, source)
            for risk in row_ids(row, 'RISK') or ['']:
                for test in tests:
                    notation.chain_tests.add(test)
                    for file in files:
                        notation.edges.add((req, risk, test, file, source))
                        if file:
                            carriers.setdefault(test, set()).add(file)


def module_tables(root, path):
    """Module-level assignments of a runner, as ast nodes; the runner is parsed, never executed."""
    file = root / path
    if not file.is_file():
        return None
    tree = ast.parse(file.read_text(encoding='utf-8'), filename=path)
    return {target.id: node.value for node in tree.body if isinstance(node, ast.Assign)
            for target in node.targets if isinstance(target, ast.Name)}


def declared_files(root, node, tables, seen=()):
    """Existing files below tests/ named by a string of node or of a module-level table node uses."""
    found = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            relative = posixpath.normpath('tests/' + child.value) if child.value else ''
            if relative.startswith('tests/') and (root / relative).is_file():
                found.add(relative)
        elif isinstance(child, ast.Name) and child.id in tables and child.id not in seen:
            found |= declared_files(root, tables[child.id], tables, seen + (child.id,))
    return found


def runner_suites(root):
    """({profile: files} of measurement_ci.PROFILES[*]['suites'], files of candidate_ci's tables)."""
    profiles = {}
    tables = module_tables(root, MEASUREMENT_RUNNER)
    if tables is not None:
        table = tables.get('PROFILES')
        if not isinstance(table, ast.Dict):
            raise ValueError(f'{MEASUREMENT_RUNNER}의 PROFILES가 dict 표가 아니다')
        for key, value in zip(table.keys, table.values):
            if isinstance(key, ast.Constant) and isinstance(value, ast.Dict):
                for field, suites in zip(value.keys, value.values):
                    if isinstance(field, ast.Constant) and field.value == 'suites':
                        profiles[key.value] = declared_files(root, suites, tables)
    candidate = set()
    tables = module_tables(root, CANDIDATE_RUNNER)
    for name in CANDIDATE_TABLES if tables is not None else ():
        if name in tables:
            candidate |= declared_files(root, tables[name], tables)
    return profiles, candidate


def executed_text(command):
    """Drop record-run's own options: its --file/--tree values are hashed inputs, not executions."""
    kept = []
    for line in command.replace('\\\n', ' ').splitlines():
        at = line.find('record-run.py')
        if at >= 0:
            separator = line.find(' -- ', at)
            line = line[:at] + (line[separator + 4:] if separator >= 0 else '')
        kept.append(line)
    return '\n'.join(kept)


def named_paths(tokens, candidates):
    """Candidates named by any token, exactly, as a path suffix, or through a glob."""
    exact, globs = set(), []
    for token in tokens:
        token = token[2:] if token.startswith('./') else token
        if any(char in token for char in '*?['):
            globs.append(token)
        parts = token.split('/')
        for start in range(len(parts)):
            exact.add('/'.join(parts[start:]))
    return {path for path in candidates if path in exact or any(
        matches(path, glob) or any(matches(path, glob.split('/', cut)[-1]) for cut in range(1, glob.count('/') + 1))
        for glob in globs)}


def runs_candidate(text):
    """A command line executing candidate_ci.py with a --target (the --check-sha form runs no suite)."""
    for line in text.splitlines():
        try:
            words = shlex.split(line, comments=True)
        except ValueError:
            words = line.split()
        if '--target' in words and any(word == CANDIDATE_RUNNER or word.endswith('/' + CANDIDATE_RUNNER)
                                       for word in words):
            return True
    return False


def ci_inventory(root, test_files, profiles, candidate):
    """test file -> (in_ci, jobs): workflow commands and the runner tables they invoke, then ci-paths.json globs."""
    catalog = WorkflowCatalog(root)
    named = {}
    for name, doc in sorted(catalog.documents.items()):
        stem = Path(name).stem
        for job_id, job in doc['jobs'].items():
            for step in job.get('steps') or []:
                run = step.get('run')
                if not isinstance(run, str):
                    continue
                text = executed_text(run)
                tokens = re.findall(r'[A-Za-z0-9_.*?\[\]/-]+', text)
                for path in named_paths(tokens, test_files):
                    named.setdefault(path, set()).add(f'{stem}:{job_id}')
                if runs_candidate(text):
                    runner = Path(CANDIDATE_RUNNER).stem
                    for path in candidate:
                        named.setdefault(path, set()).add(f'{stem}:{job_id}({runner})')
    if profiles:
        runner = Path(MEASUREMENT_RUNNER).stem
        for profile, places in sorted(catalog.profile_bindings().items()):
            for place in places:
                label = (f"{Path(place['workflow']).stem}:{place['job']}({runner}:{profile}"
                         f"{',dispatch' if place['dispatch'] else ''})")
                for path in profiles.get(profile, ()):
                    named.setdefault(path, set()).add(label)
    jobs_present = {job_id for doc in catalog.documents.values() for job_id in doc['jobs']}
    paths_file = root / 'scripts/ci-paths.json'
    selection = json.loads(paths_file.read_text(encoding='utf-8')).get('jobs', {}) if paths_file.is_file() else {}
    literal = {job: {pattern for pattern in patterns if not any(char in pattern for char in '*?[')}
               for job, patterns in selection.items() if job in jobs_present}
    wildcard = {job: [pattern for pattern in selection[job] if pattern not in literal[job]] for job in literal}
    result = {}
    for path in test_files:
        if path in named:
            result[path] = ('yes', sorted(named[path]))
            continue
        selected = sorted(f'ci-paths:{job}' for job in literal if path in literal[job] or
                          any(matches(path, pattern) for pattern in wildcard[job]))
        result[path] = ('selection-only', selected) if selected else ('no', [])
    return result


def run_records(ci_runs, test_files):
    """test file -> (command, exit, inputs sha256) of the latest run.json whose command names it."""
    if not ci_runs:
        return {}
    latest = {}
    for path in sorted(Path(ci_runs).rglob('run.json')):
        record = json.loads(path.read_text(encoding='utf-8'))
        command = record.get('command') or []
        if not isinstance(command, list):
            continue
        key = (record.get('ended_at_utc') or '', record.get('started_at_utc') or '',
               path.relative_to(ci_runs).as_posix())
        exit_code = record.get('exit_code')
        inputs = sorted([item.get('requested') or '', item.get('status') or '', item.get('sha256') or '']
                        for item in record.get('files_before') or [])
        digest = hashlib.sha256(json.dumps(inputs, separators=(',', ':'), ensure_ascii=False)
                                .encode('utf-8')).hexdigest() if inputs else ''
        value = (shlex.join(str(part) for part in command),
                 str(exit_code) if exit_code is not None else str(record.get('status') or ''), digest)
        for test in named_paths([str(part) for part in command], test_files):
            if test not in latest or key > latest[test][0]:
                latest[test] = (key, value)
    return {test: value for test, (_, value) in latest.items()}


def read_requirements(requirements_csv):
    """[(REQ id, source)] of the optional --requirements CSV, checked before any scanning."""
    if not requirements_csv:
        return []
    found = []
    with open(requirements_csv, encoding='utf-8', newline='') as stream:
        reader = csv.DictReader(stream)
        if 'req' not in (reader.fieldnames or []):
            raise ValueError('--requirements CSV에 req 열이 없다')
        for row in reader:
            value = (row['req'] or '').strip()
            if value:
                if not re.fullmatch(rf'REQ-{WORD}', value):
                    raise ValueError(f'--requirements {reader.line_num}행의 값이 REQ id가 아니다: {value!r}')
                found.append((value, f'{Path(requirements_csv).name}:{reader.line_num}'))
    return found


def collect(root, requirements_csv=None, ci_runs=None):
    root = Path(root)
    listed = read_requirements(requirements_csv)
    every = [path for top in SOURCE_TREES for path in walk(root, top, ())]
    names = Counter(posixpath.basename(path) for path in every)
    sources = [path for top in SOURCE_TREES for path in walk(root, top) if not path.endswith('.md')]
    profiles, candidate = runner_suites(root)
    runners = {path for suites in profiles.values() for path in suites} | candidate | {
        path for path in (MEASUREMENT_RUNNER, CANDIDATE_RUNNER) if (root / path).is_file()}
    test_files = sorted(path for path in sources if is_carrier(path) or path in runners)
    notation = Notation(test_files)
    carriers, bare_tests = {}, set()
    for path in sources:
        if path.endswith('.json'):
            read_table(root, path, test_files, names[posixpath.basename(path)] == 1, notation, carriers)
            continue
        lines = read_lines(root / path)
        for number, line in enumerate(lines or [], 1):
            if 'TEST-' in line:
                for test in group_ids(line, 'TEST'):
                    carriers.setdefault(test, set()).add(path)
            if 'REQ-' in line:
                notation.scan_line(path, number, line)
    for path in (path for path in walk(root, '') if path.endswith('.md')):
        for number, line in enumerate(read_lines(root / path) or [], 1):
            if 'TEST-' in line:
                bare_tests.update(group_ids(line, 'TEST'))
            if 'REQ-' in line:
                for req in group_ids(line, 'REQ'):
                    notation.requirement(req, f'{path}:{number}')
                notation.scan_line(path, number, line)
    for req, source in listed:
        notation.requirement(req, source)

    ci = ci_inventory(root, test_files, profiles, candidate)
    runs = run_records(ci_runs, test_files)
    test_carriers = {test: sorted(path for path in paths if path in ci) for test, paths in carriers.items()}

    rows = set()
    for req, risk, test, path, source in notation.edges:
        files = [path] if path is not None else (test_carriers.get(test) or [''])
        for file in files:
            status, jobs = ci.get(file, ('', [])) if file else ('', [])
            command, exit_code, digest = runs.get(file, ('', '', ''))
            rows.add((req, risk, test, file, source, status, ' '.join(jobs), command, exit_code, digest))

    tested = {row[0] for row in rows if row[2] or row[3]}
    req_without_test = [{'req': req, 'sources': sorted(sources_)}
                        for req, sources_ in sorted(notation.requirements.items()) if req not in tested]
    all_tests = set(carriers) | bare_tests | notation.chain_tests
    test_without_req = [{'test_id': test, 'files': sorted(carriers.get(test, ()))}
                        for test in sorted(all_tests - notation.chain_tests)]
    # A path-selected job may run the file through a runner this reader does not know:
    # that is unverified, never "not in CI".
    not_in_ci, unverified = set(), set()
    lists = {'no': not_in_ci, 'selection-only': unverified}
    for test in all_tests:
        files = test_carriers.get(test) or []
        if not files:
            not_in_ci.add((test, '', 'no', '', 'no-test-file'))
        for file in files:
            status, jobs = ci[file]
            if status in lists:
                lists[status].add((test, file, status, ' '.join(jobs), status))
    for row in rows:
        if not row[2] and row[3] and row[5] in lists:
            lists[row[5]].add(('', row[3], row[5], row[6], row[5]))
    irregular = [dict(zip(('source', 'reason', 'text'), entry))
                 for entry in sorted(notation.irregular, key=lambda item: (source_key(item[0]), item[1]))]
    return sorted(rows, key=row_key), {
        'req_without_test': req_without_test, 'test_without_req': test_without_req,
        'test_not_in_ci': [dict(zip(GAP_COLUMNS, entry)) for entry in sorted(not_in_ci)],
        'test_ci_unverified': [dict(zip(GAP_COLUMNS, entry)) for entry in sorted(unverified)],
        'irregular_notation': irregular}


def source_key(source):
    path, _, line = source.rpartition(':')
    return path, int(line) if line.isdigit() else 0


def row_key(row):
    return row[:4] + (source_key(row[4]),) + row[5:]


def render_csv(rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator='\n')
    writer.writerow(CSV_COLUMNS)
    writer.writerows(rows)
    return buffer.getvalue().encode('utf-8')


def render_json(gaps, base_commit, run_id):
    document = dict(gaps, base_commit=base_commit, run_id=run_id, statement=STATEMENT)
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


LEGEND = (
    ('in_ci = yes, ci_job = <workflow>:<job>', 'workflow의 run 명령(record-run.py의 -- 뒤 명령 포함)이 이 시험 파일을 경로·경로 끝·glob으로 이름 짓는다.'),
    ('in_ci = yes, ci_job = <workflow>:<job>(measurement_ci:<profile>)', 'run 명령이 tests/measurement_ci.py --profile <profile>을 실행하고, 그 실행기의 PROFILES[<profile>][\'suites\'] 표가 이 파일을 이름 짓는다.'),
    ('in_ci = yes, ci_job = <workflow>:<job>(candidate_ci)', 'run 명령이 tests/candidate_ci.py --target …을 실행하고, 그 실행기의 BASE·FLOWS 표가 이 파일을 이름 짓는다.'),
    ('in_ci = selection-only', '명령도 실행기 표도 이 파일을 이름 짓지 않고, workflow에 있는 job의 ci-paths.json 경로 선택 glob만 이 파일을 포함한다. 실행 여부를 확인하지 못했으므로 미실행이 아니라 미확인(test_ci_unverified)으로 따로 둔다.'),
    ('in_ci = no', '명령·실행기 표·경로 선택 어느 것도 이 파일을 가리키지 않는다.'),
    ('no-test-file', 'TEST id를 지닌 carrier(이름과 상관없이 tests/·scripts/ 아래의 .py·.cjs·.mjs·.js 파일)도 사례 표를 실행하는 carrier도 없다(제품 소스나 문서에만 있다).'),
)
IRREGULAR_LEGEND = (
    ('no-chain', 'REQ·RISK와 화살표가 있으나 REQ → RISK 연결로 읽히지 않는다(접두 표기 U5S-REQ 등).'),
    ('slash-triplet', 'REQ·RISK·TEST가 화살표 없이 한 줄에 있다.'),
    ('abbreviated-label', 'id 뒤 / 다음에 그 id의 마지막 마디로 시작하는 여러 마디 이름이 있다(<id>-A / A-<사례 이름>). 사례 이름으로 보고 id를 만들지 않는다(마디가 겹친 id를 만들지 않는다).'),
    ('table-test-not-id', '사례 표의 행이 REQ id와 함께 TEST id가 아닌 시험 이름(XA01 등)을 지닌다. 그 표의 첫 행만 보고하고 연결하지 않는다.'),
    ('missing-test', '세 번째 요소가 없다. carrier 안의 줄이면 그 파일에 연결했다.'),
    ('missing-risk', '두 번째 요소에 RISK id가 없다.'),
    ('test-by-file', '세 번째 요소가 TEST id 대신 시험 파일 이름이다. 파일에 연결했다.'),
    ('test-not-id', '세 번째 요소가 TEST id도 시험 파일도 아니다. carrier 안의 줄이면 그 파일에 연결했다.'),
    ('unresolved-test-file', '세 번째 요소의 파일 이름에 맞는 시험 파일이 없다.'),
    ('ambiguous-test-file', '세 번째 요소의 파일 이름에 맞는 시험 파일이 둘 이상이다.'),
)


def table(headers, rows):
    head = ''.join(f'<th>{html.escape(header)}</th>' for header in headers)
    body = ''.join('<tr>' + ''.join(f'<td>{html.escape(str(cell))}</td>' for cell in row) + '</tr>\n' for row in rows)
    return f'<table>\n<thead><tr>{head}</tr></thead>\n<tbody>\n{body}</tbody>\n</table>\n'


def gap_table(items):
    return table(GAP_COLUMNS, [tuple(item[key] for key in GAP_COLUMNS) for item in items])


def render_html(rows, gaps, base_commit, run_id):
    run_label = run_id if run_id is not None else 'none'
    summary = [('Edges', len(rows)), ('Requirements without tests', len(gaps['req_without_test'])),
               ('Tests without requirements', len(gaps['test_without_req'])),
               ('Tests not run in CI', len(gaps['test_not_in_ci'])),
               ('Tests with unverified CI execution', len(gaps['test_ci_unverified'])),
               ('Irregular notation', len(gaps['irregular_notation']))]
    parts = [
        '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<title>Trace Matrix</title>\n',
        '<style>body{font:13px sans-serif}table{border-collapse:collapse;margin-bottom:1.5em}'
        'th,td{border:1px solid #999;padding:2px 4px;vertical-align:top;text-align:left}'
        'td{font:12px monospace}</style>\n</head>\n<body>\n<h1>Trace Matrix</h1>\n',
        f'<p>Base commit: <code>{html.escape(base_commit)}</code> · Run ID: <code>{html.escape(run_label)}</code></p>\n',
        f'<p>{html.escape(STATEMENT)}</p>\n',
        '<h2>Summary</h2>\n', table(('Item', 'Count'), summary),
        '<h2>Trace Matrix</h2>\n<p>한 행은 표기 한 곳(문서·주석 줄 또는 사례 표의 한 사례)의 REQ×RISK×TEST 연결 하나와 그 시험 파일 하나다. '
        'last_run_* 열은 --ci-runs로 받은 run.json 가운데 그 파일을 실행한 마지막 기록이다.</p>\n',
        table(('Label', 'Description'), LEGEND),
        table(CSV_COLUMNS, rows),
        '<h2>Requirements Without Tests</h2>\n<p>TEST id나 시험 파일에 연결되지 않은 REQ id다.</p>\n',
        table(('req', 'sources'), [(item['req'], ' '.join(item['sources'])) for item in gaps['req_without_test']]),
        '<h2>Tests Without Requirements</h2>\n<p>어떤 REQ → RISK → TEST 연결이나 사례 표 행의 TEST 요소로도 쓰이지 않은 TEST id다.</p>\n',
        table(('test_id', 'files'), [(item['test_id'], ' '.join(item['files'])) for item in gaps['test_without_req']]),
        '<h2>Tests Not Run in CI</h2>\n<p>CI 명령도 그 명령이 실행하는 실행기 표도 경로 선택도 가리키지 않는 carrier와, carrier가 없는 TEST id다.</p>\n',
        gap_table(gaps['test_not_in_ci']),
        '<h2>Tests With Unverified CI Execution</h2>\n<p>경로 선택(ci-paths.json)으로만 job에 묶인 시험이다. '
        '이 생성기가 실행 여부를 확인하지 못했다는 뜻이며 미실행으로 세지 않는다.</p>\n',
        gap_table(gaps['test_ci_unverified']),
        '<h2>Irregular Notation</h2>\n<p>표기 규칙에 맞지 않아 그대로 보고하는 줄이다. 생성기는 이 줄을 고치거나 추측하지 않는다.</p>\n',
        table(('Label', 'Description'), IRREGULAR_LEGEND),
        table(('source', 'reason', 'text'),
              [(item['source'], item['reason'], item['text']) for item in gaps['irregular_notation']]),
        '</body>\n</html>\n',
    ]
    return ''.join(parts).encode('utf-8')


def head_commit(root):
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=str(root), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode != 0:
        raise ValueError('git rev-parse HEAD가 실패했다. --base-commit으로 기준 커밋을 주어라')
    return result.stdout.decode('ascii').strip()


def build(root, out, base_commit, run_id=None, ci_runs=None, requirements=None):
    rows, gaps = collect(root, requirements, ci_runs)
    outputs = {'trace-matrix.csv': render_csv(rows),
               'trace-matrix.html': render_html(rows, gaps, base_commit, run_id),
               'trace-gaps.json': render_json(gaps, base_commit, run_id)}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (out / name).write_bytes(data)
    return rows, gaps, {name: hashlib.sha256(data).hexdigest() for name, data in outputs.items()}


class KoreanFormatter(argparse.HelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        super().add_usage(usage, actions, groups, '사용법: ' if prefix is None else prefix)


# argparse's own sentences are English (§4); its message forms are stable, the option names stay as written.
ARGUMENT_ERRORS = (
    (re.compile(r'argument (\S+): expected one argument'), '{0} 옵션에 값이 하나 있어야 한다'),
    (re.compile(r'unrecognized arguments: (.*)'), '알 수 없는 인자다: {0}'),
    (re.compile(r'ambiguous option: (\S+) could match (.*)'), '{0} 옵션이 여러 옵션과 맞는다: {1}'),
)


class KoreanParser(argparse.ArgumentParser):
    def error(self, message):
        for pattern, sentence in ARGUMENT_ERRORS:
            found = pattern.fullmatch(message)
            if found:
                message = sentence.format(*found.groups())
                break
        else:
            message = f'인자를 해석할 수 없다: {message}'
        self.print_usage(sys.stderr)
        self.exit(2, f'{self.prog}: 인자 오류: {message}\n')


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = KoreanParser(description=__doc__.split('\n', 1)[0], add_help=False, formatter_class=KoreanFormatter)
    options = parser.add_argument_group('옵션')
    options.add_argument('-h', '--help', action='help', help='이 도움말을 보이고 끝낸다')
    options.add_argument('--out', type=Path, help='출력 디렉터리(기본 tmp/trace-matrix)')
    options.add_argument('--base-commit', help='머리글에 박는 기준 커밋(기본 git rev-parse HEAD)')
    options.add_argument('--run-id', help='머리글에 박는 CI 실행 ID(선택)')
    options.add_argument('--ci-runs', type=Path, help='내려받은 record-run run.json 기록 디렉터리(선택)')
    options.add_argument('--requirements', type=Path, help='REQ id를 담은 req 열이 있는 CSV(선택)')
    args = parser.parse_args(argv)
    try:
        base_commit = args.base_commit or head_commit(ROOT)
        rows, gaps, digests = build(ROOT, args.out or ROOT / 'tmp/trace-matrix', base_commit, args.run_id,
                                    args.ci_runs, args.requirements)
    except (OSError, ValueError, SyntaxError, subprocess.SubprocessError) as error:
        print(f'추적표를 만들 수 없다: {error}', file=sys.stderr)
        return 1
    print(f'edges={len(rows)} req_without_test={len(gaps["req_without_test"])} '
          f'test_without_req={len(gaps["test_without_req"])} test_not_in_ci={len(gaps["test_not_in_ci"])} '
          f'test_ci_unverified={len(gaps["test_ci_unverified"])} '
          f'irregular_notation={len(gaps["irregular_notation"])}')
    for name, digest in sorted(digests.items()):
        print(f'{digest}  {name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
