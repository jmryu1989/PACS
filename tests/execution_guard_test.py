"""Synthetic subprocess regressions; never start Docker, a browser or a live stack."""
import ast
from collections import namedtuple
from datetime import datetime, timedelta, timezone
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch
import live_test_gate as gate

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/run-tests.py'

# S7-TEST-DB-EXEC (D222): a live test reaches only the Compose project this process inherited
# (COMPOSE_PROJECT_NAME/COMPOSE_FILE/COMPOSE_ENV_FILES + cwd = repo root). A fixed container name reaches
# whatever stack owns that name, so one test could write to a stack it did not select or mix two stacks.
# The names are the docker-compose.yml container_name values; the guard reads test sources only (stdlib ast).
FIXED_CONTAINERS = frozenset({'kin-db', 'kin-api', 'kin-keycloak', 'kin-orthanc', 'kin-proxy'})
CONTAINER_VERBS = frozenset('exec logs inspect pause unpause start stop restart kill rm cp top port wait attach '
                            'stats update rename commit export diff'.split())
COMPOSE_CONTAINER_VERBS = frozenset('exec logs ps run up down stop start restart pause unpause kill rm cp top port '
                                    'events'.split())
COMPOSE_VALUE_FLAGS = frozenset('-p --project-name -f --file --project-directory --env-file --profile --ansi '
                                '--progress --parallel'.split())
COMPOSE_SELECT_FLAGS = frozenset('-p --project-name -f --file --project-directory --env-file'.split())
ROOT_MODULES = frozenset({'invariants_live', 'test_worklist'})
SUBPROCESS_CALLS = frozenset('run Popen check_output check_call call getoutput getstatusoutput'.split())
OS_CALLS = frozenset({'system', 'popen'})
ASYNCIO_CALLS = frozenset({'create_subprocess_exec', 'create_subprocess_shell'})
EXECUTION_ATTRIBUTES = frozenset({('subprocess', name) for name in SUBPROCESS_CALLS} | {('os', name) for name in OS_CALLS}
                                 | {('asyncio', name) for name in ASYNCIO_CALLS})
# Every entry keeps a fixed name for a recorded reason; an entry that no longer matches fails (V-08) so it
# cannot silently cover a new file.
TG01_EXCLUDED = {
    'tests/ops_backup_test.py': 'mock of the scripts/ops_*.py operations Compose contract',
    'tests/ops_deploy_preflight_test.py': 'mock of the scripts/ops_*.py operations Compose contract',
    'tests/ops_deploy_host_container_test.py': 'creates its own kin-api/kin-proxy for the ops contract (Linux CI)',
    'tests/migration_rehearsal.py': 'operator tool bound to the ops_backup backup source',
    'tests/gateway_pipeline_live.py': 'container-object operations only on the proven-empty hosted gateway-e2e daemon',
}
TG02_EXCLUDED = {
    'tests/audit_store_db_test.py': 'only its own labelled networkless containers, no Compose; its docker(*args) '
                                    'wrapper argv is opaque here and its call sites stay under TG-01',
    'tests/ops_deploy_host_container_test.py': 'its own disposable project (--project-directory, -f)',
    'tests/gateway_pipeline_live.py': 'its own gateway project (-p, --env-file, -f) with a scrubbed environment',
    'tests/measurement_ci.py': 'its own hosted project (-p project, env=env) on a proven-empty daemon',
}
Violation = namedtuple('Violation', 'rule file line detail')
OPAQUE = object()


def compose_target_sources(root=ROOT):
    return {path.relative_to(root).as_posix(): path.read_text(encoding='utf-8')
            for path in sorted((root / 'tests').rglob('*.py')) if '__pycache__' not in path.parts}


def _bindings(function):
    """Names bound directly in one function body (parameters, stores, imports, nested def/class names)."""
    found = {}
    arguments = function.args
    for argument in arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [arguments.vararg, arguments.kwarg]:
        if argument is not None:
            found.setdefault(argument.arg, []).append(argument)
    stack = list(function.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.setdefault(node.name, []).append(node)
            continue
        if isinstance(node, ast.Lambda):
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            found.setdefault(node.id, []).append(node)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                found.setdefault(name, []).append(node)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            found.setdefault(node.name, []).append(node)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                found.setdefault((alias.asname or alias.name).split('.')[0], []).append(node)
        stack.extend(ast.iter_child_nodes(node))
    return found


class _Source:
    """One parsed test file with the bounded argv resolution R of the S7-TEST-DB-EXEC test plan: list literal,
    `+`, and a name with exactly one plain assignment (local before the call, else module level and never rebound
    by a function) that is read only as a `+` operand or as an execution argv. Everything else is unresolved; the
    guard closes on it instead of passing it."""

    def __init__(self, rel, tree):
        self.rel, self.tree = rel, tree
        self.depth = len(Path(rel).parts) - 1
        self.parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        self.subprocess_names, self.root_imports, self.root_module_aliases = set(), set(), set()
        self.module_binds = {}
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    if node.module == 'subprocess' and alias.name in SUBPROCESS_CALLS:
                        self.subprocess_names.add(alias.asname or alias.name)
                    if node.module.split('.')[-1] in ROOT_MODULES and alias.name == 'ROOT':
                        self.root_imports.add(alias.asname or alias.name)
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split('.')[-1] in ROOT_MODULES:
                        self.root_module_aliases.add(alias.asname or alias.name)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.module_binds.setdefault(node.name, []).append(node)
                continue
            for sub in ast.walk(node):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
                    self.module_binds.setdefault(sub.id, []).append(sub)
                elif isinstance(sub, (ast.Import, ast.ImportFrom)):
                    for alias in sub.names:
                        self.module_binds.setdefault((alias.asname or alias.name).split('.')[0], []).append(alias)
        self.global_names = {name for node in ast.walk(tree) if isinstance(node, ast.Global) for name in node.names}
        self.function_bindings, self._rebound, self._docstrings, self._copied_only = {}, None, None, {}

    def bindings_of(self, function):
        if function not in self.function_bindings:
            self.function_bindings[function] = _bindings(function)
        return self.function_bindings[function]

    def rebound(self, name):
        """True when some function binds `name`, so the module-level value cannot be trusted at a use."""
        if self._rebound is None:
            self._rebound = set()
            for node in ast.walk(self.tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self._rebound |= set(self.bindings_of(node))
        return name in self._rebound

    def is_docstring(self, constant):
        if self._docstrings is None:
            self._docstrings = set()
            for node in ast.walk(self.tree):
                if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
                    first = node.body[0]
                    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                            and isinstance(first.value.value, str):
                        self._docstrings.add(first.value)
        return constant in self._docstrings

    def function_of(self, node):
        while node in self.parents:
            node = self.parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return node
        return None

    def is_execution(self, call):
        function = call.func
        if isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name):
            return (function.value.id, function.attr) in EXECUTION_ATTRIBUTES
        return isinstance(function, ast.Name) and function.id in self.subprocess_names

    @staticmethod
    def argv(call):
        if call.args:
            return call.args[0]
        return next((keyword.value for keyword in call.keywords
                     if keyword.arg in ('args', 'cmd', 'command', 'program')), None)

    @staticmethod
    def _single(name, binds, parents):
        nodes = binds.get(name, [])
        if len(nodes) != 1:
            return None
        parent = parents.get(nodes[0])
        if isinstance(parent, ast.Assign) and len(parent.targets) == 1 and parent.targets[0] is nodes[0]:
            return parent
        return None

    def binding(self, name, at):
        """The one plain assignment R follows for `name` used at node `at`, or None."""
        function = self.function_of(at)
        if function is not None:
            binds = self.bindings_of(function)
            if name in binds:
                assign = self._single(name, binds, self.parents)
                if assign is None or (assign.lineno, assign.col_offset) >= (at.lineno, at.col_offset):
                    return None
                return assign
        assign = self._single(name, self.module_binds, self.parents)
        return None if assign is None or self.rebound(name) else assign

    def resolve(self, expression, at, depth=0):
        """-> (tokens or None, assignments followed). Followed assignments are returned even when a later
        part fails, so the literals they hold count as reaching this call (U1) and are searched by U3."""
        if depth > 8:
            return None, []
        if isinstance(expression, ast.List):
            return [self.element(item) for item in expression.elts], []
        if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Add):
            left, used_left = self.resolve(expression.left, at, depth + 1)
            right, used_right = self.resolve(expression.right, at, depth + 1)
            if left is None or right is None:
                return None, used_left + used_right
            return left + right, used_left + used_right
        if isinstance(expression, ast.Name):
            assign = self.binding(expression.id, at)
            if assign is None:
                return None, []
            tokens, used = self.resolve(assign.value, assign, depth + 1)
            if not self.copied_only(expression.id, assign):
                tokens = None
            return tokens, used + [assign]
        return None, []

    def copied_only(self, name, assign):
        """True when every read of `name` in the scope of `assign` is a `+` operand or an execution argv. Any other
        read (insert/append, a slice or item store, an alias, an argument to other code) may change the list in place,
        so the assigned value is no longer the argv a call receives."""
        function = self.function_of(assign)
        key = (name, function)
        if key not in self._copied_only:
            self._copied_only[key] = all(
                self._copy_read(node) for node in ast.walk(function or self.tree)
                if isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Load))
        return self._copied_only[key]

    def _copy_read(self, node):
        parent = self.parents.get(node)
        if isinstance(parent, ast.BinOp) and isinstance(parent.op, ast.Add):
            return True
        call = self.parents.get(parent) if isinstance(parent, ast.keyword) else parent
        return isinstance(call, ast.Call) and self.is_execution(call) and self.argv(call) is node

    def element(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            assign = self._single(node.id, self.module_binds, self.parents)
            if assign is not None and isinstance(assign.value, ast.Constant) and isinstance(assign.value.value, str) \
                    and not self.rebound(node.id):
                return assign.value.value
        return OPAQUE

    def imported_only(self, name, at):
        """`name` still holds its import at `at`: the module binds it only by that import, no function declares it
        global, and no enclosing function binds it. A reassignment or del leaves the value's origin unknown."""
        if len(self.module_binds.get(name, [])) != 1 or name in self.global_names:
            return False
        node = at
        while node in self.parents:
            node = self.parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and name in self.bindings_of(node):
                return False
        return True

    def is_root(self, expression, at, depth=0):
        """cwd is the repository root: ROOT from invariants_live/test_worklist, a module-level
        Path(__file__).resolve().parents[<depth of this file>], an alias of either, or str() of one."""
        if depth > 8:
            return False
        if isinstance(expression, ast.Call) and ast.unparse(expression.func) == 'str' and len(expression.args) == 1 \
                and not expression.keywords:
            return self.is_root(expression.args[0], at, depth + 1)
        if isinstance(expression, ast.Attribute) and isinstance(expression.value, ast.Name):
            alias = expression.value.id
            return expression.attr == 'ROOT' and alias in self.root_module_aliases and self.imported_only(alias, at) \
                and not any(isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del))
                            and node.attr == 'ROOT' and isinstance(node.value, ast.Name) and node.value.id == alias
                            or isinstance(node, ast.Call) and ast.unparse(node.func) in ('setattr', 'delattr')
                            and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == alias
                            for node in ast.walk(self.tree))
        if not isinstance(expression, ast.Name):
            return False
        if expression.id in self.root_imports:
            function = self.function_of(at)
            if function is None or expression.id not in self.bindings_of(function):
                return self.imported_only(expression.id, at)
        assign = self.binding(expression.id, at)
        if assign is None:
            return False
        if self.function_of(assign) is None \
                and ast.unparse(assign.value) == f'Path(__file__).resolve().parents[{self.depth}]':
            return True
        return self.is_root(assign.value, assign, depth + 1)


@functools.lru_cache(maxsize=None)
def _source(rel, text):
    return _Source(rel, ast.parse(text, filename=rel))


def _parse(sources, rule_scope):
    parsed, violations = {}, []
    for rel in sorted(sources):
        try:
            parsed[rel] = _source(rel, sources[rel])
        except SyntaxError as error:
            violations.append(Violation('TG-SYNTAX', rel, error.lineno or 0, rule_scope))
    return parsed, violations


def _fixed_name_sites(source):
    sites = []
    for node in ast.walk(source.tree):
        if isinstance(node, ast.List) and node.elts and source.element(node.elts[0]) == 'docker':
            values = [source.element(item) for item in node.elts]
            start = 2 if len(values) > 2 and values[1] == 'container' else 1
            verb = values[start] if len(values) > start else None
            operands = []
            if verb == 'network' and len(values) > start + 1 and values[start + 1] in ('connect', 'disconnect'):
                operands = node.elts[start + 2:]
            elif verb in CONTAINER_VERBS:
                operands = node.elts[start + 1:]
            elif verb == 'run':
                for index in range(start + 1, len(values)):
                    if values[index] == '--name' and index + 1 < len(node.elts):
                        operands.append(node.elts[index + 1])
                    elif isinstance(values[index], str) and values[index].startswith('--name='):
                        if values[index][len('--name='):] in FIXED_CONTAINERS:
                            sites.append(Violation('TG01-FIXED-NAME', source.rel, node.elts[index].lineno, values[index]))
            for operand in operands:
                value = source.element(operand)
                if value in FIXED_CONTAINERS:
                    sites.append(Violation('TG01-FIXED-NAME', source.rel, operand.lineno, value))
                elif value is OPAQUE and _kin_prefixed(operand):
                    sites.append(Violation('TG01-UNRESOLVED-NAME', source.rel, operand.lineno, ast.unparse(operand)))
        elif isinstance(node, ast.Call):
            for argument in node.args:
                value = source.element(argument)
                if value in FIXED_CONTAINERS:
                    sites.append(Violation('TG01-FIXED-NAME', source.rel, argument.lineno, value))
    return sites


def _kin_prefixed(node):
    if isinstance(node, ast.JoinedStr) and node.values:
        head = node.values[0]
        return isinstance(head, ast.Constant) and isinstance(head.value, str) and head.value.startswith('kin-')
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        head = node.left
        return isinstance(head, ast.Constant) and isinstance(head.value, str) and head.value.startswith('kin-') \
            or _kin_prefixed(head)
    return False


def fixed_name_violations(sources, excluded=TG01_EXCLUDED):
    """TG-01: no product container name addressed by a docker container operation or passed as a call argument."""
    parsed, violations = _parse(sources, 'TG-01')
    for rel, source in parsed.items():
        sites = _fixed_name_sites(source)
        if rel not in excluded:
            violations += sites
        elif not sites:
            violations.append(Violation('TG01-STALE-EXCLUSION', rel, 0, excluded[rel]))
    violations += [Violation('TG01-STALE-EXCLUSION', rel, 0, excluded[rel])
                   for rel in sorted(excluded) if rel not in sources]
    return sorted(violations, key=lambda item: (item.file, item.line, item.rule))


def _compose_verb(tokens):
    """tokens after 'docker', 'compose' -> (verb or None, selection flags before it, opaque token met)."""
    selections, index = [], 0
    while index < len(tokens):
        token = tokens[index]
        if token is OPAQUE:
            return None, selections, True
        if token.startswith('-'):
            flag = token.split('=', 1)[0]
            if flag in COMPOSE_SELECT_FLAGS:
                selections.append(flag)
            index += 2 if flag in COMPOSE_VALUE_FLAGS and '=' not in token else 1
            continue
        return token, selections, False
    return None, selections, False


def compose_selection_violations(sources, excluded=TG02_EXCLUDED):
    """TG-02: every execution call whose resolved argv is a container Compose command runs with cwd = repo root,
    without env= and without -p/-f/--project-directory/--env-file, so Compose uses the inherited selection.
    Forms the bounded resolution cannot judge fail closed (U1 UNLINKED, U2 STRING, U3 UNRESOLVED, U4 OPAQUE)."""
    parsed, violations = _parse(sources, 'TG-02')
    for rel, source in parsed.items():
        docker_lists = [node for node in ast.walk(source.tree) if isinstance(node, ast.List) and node.elts
                        and source.element(node.elts[0]) == 'docker']
        if rel in excluded:
            if not docker_lists:
                violations.append(Violation('TG02-STALE-EXCLUSION', rel, 0, excluded[rel]))
            continue
        reached = set()
        for call in ast.walk(source.tree):
            if not isinstance(call, ast.Call) or not source.is_execution(call):
                continue
            expression = source.argv(call)
            if expression is None:
                continue
            tokens, used = source.resolve(expression, call)
            searched = [expression] + [assign.value for assign in used]
            reached |= {node for part in searched for node in ast.walk(part) if isinstance(node, ast.List)}
            if tokens is None:
                if any(isinstance(node, ast.Constant) and isinstance(node.value, str)
                       and (node.value == 'docker' or node.value.startswith('docker '))
                       for part in searched for node in ast.walk(part)):
                    violations.append(Violation('TG02-UNRESOLVED', rel, call.lineno, ast.unparse(expression)))
                continue
            if tuple(tokens[:2]) != ('docker', 'compose'):
                continue
            literal_lines = sorted({node.lineno for part in searched for node in ast.walk(part)
                                    if isinstance(node, ast.List)})
            detail = 'argv literal lines ' + ','.join(map(str, literal_lines))
            verb, selections, opaque = _compose_verb(tokens[2:])
            if opaque:
                violations.append(Violation('TG02-OPAQUE', rel, call.lineno, detail))
                continue
            if verb not in COMPOSE_CONTAINER_VERBS:
                continue
            keywords = {keyword.arg: keyword.value for keyword in call.keywords if keyword.arg}
            if 'cwd' not in keywords or not source.is_root(keywords['cwd'], call):
                violations.append(Violation('TG02-CWD', rel, call.lineno, detail))
            if 'env' in keywords:
                violations.append(Violation('TG02-ENV', rel, call.lineno, detail))
            if selections:
                violations.append(Violation('TG02-SELECT-FLAG', rel, call.lineno, detail + ' ' + ','.join(selections)))
        for node in docker_lists:
            second = source.element(node.elts[1]) if len(node.elts) > 1 else None
            if second is OPAQUE:
                violations.append(Violation('TG02-OPAQUE', rel, node.lineno, ast.unparse(node)[:80]))
            elif second == 'compose' and node not in reached:
                violations.append(Violation('TG02-UNLINKED', rel, node.lineno, ast.unparse(node)[:80]))
        for node in ast.walk(source.tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                words = node.value.split()
                if tuple(words[:2]) == ('docker', 'compose') and _compose_verb(words[2:])[0] in COMPOSE_CONTAINER_VERBS \
                        and not source.is_docstring(node):
                    violations.append(Violation('TG02-STRING', rel, node.lineno, node.value[:80]))
    violations += [Violation('TG02-STALE-EXCLUSION', rel, 0, excluded[rel])
                   for rel in sorted(excluded) if rel not in sources]
    return sorted(violations, key=lambda item: (item.file, item.line, item.rule))


class InspectionReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pacs-inspection-test-')
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        state = patch.object(gate, 'STATE', self.state)
        state.start()
        self.addCleanup(state.stop)
        self.marker = self.state / 'live-needs-inspection.json'
        self.ledger = self.state / 'inspections.jsonl'
        self.record = self.state / 'inspection.json'
        self.identity = dict(unit='owned-probe', module='tests/probe.py', plan_sha256='a' * 64, attempt=1)

    def write_record(self, value=None):
        self.record.write_text(json.dumps(value if value is not None else self.inspection), encoding='utf-8')
        # Ensure distinct mtimes even on a filesystem with coarse write timestamps.
        stamp = max(time.time_ns(), self.marker.stat().st_mtime_ns + 1_000_000)
        os.utime(self.record, ns=(stamp, stamp))

    def assert_closed(self, action, exception=gate.Refused):
        marker = self.marker.read_bytes()
        ledger = self.ledger.read_bytes() if self.ledger.is_file() else None
        with self.assertRaises(exception):
            action()
        self.assertEqual(self.marker.read_bytes(), marker)
        self.assertEqual(self.ledger.read_bytes() if self.ledger.is_file() else None, ledger)
        with self.assertRaises(gate.Refused):
            with gate.live_run(**self.identity):
                self.fail('Uninspected gate admitted a run')

    def fail_live_run(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
            with gate.live_run(**self.identity):
                raise RuntimeError('synthetic failure')
        self.assertTrue(self.marker.is_file())
        self.inspection = {**json.loads(self.marker.read_bytes()), 'exit': 125,
                           'artifacts': ['probe.log'], 'stack': {'containers': []},
                           'inspected_at': datetime.now(timezone.utc).isoformat(), 'inspector': 'fixture-owner'}
        self.write_record()

    def test_inspection_requires_a_marker(self):
        with self.assertRaises(gate.Refused):
            gate.release_after_inspection(self.record)
        self.assertFalse(self.ledger.exists())

    def test_missing_and_malformed_records_keep_gate_closed(self):
        self.fail_live_run()
        self.record.unlink()
        invalid = [None, '{', '[]']
        invalid += [json.dumps({k: v for k, v in self.inspection.items() if k != key})
                    for key in self.inspection]
        invalid += [json.dumps({**self.inspection, key: value}) for key, value in (
            ('unit', ''), ('module', []), ('attempt', True), ('pid', 0), ('plan_sha256', 'bad'),
            ('exit', True), ('artifacts', 'probe.log'),
            ('artifacts', [None]), ('stack', []), ('inspected_at', None), ('inspector', ''))]
        for value in invalid:
            with self.subTest(record=value):
                if value is not None:
                    self.record.write_text(value, encoding='utf-8')
                self.assert_closed(lambda: gate.release_after_inspection(self.record))

    def test_single_field_mismatches_and_bad_times_keep_gate_closed(self):
        self.fail_live_run()
        self.ledger.write_text(json.dumps({'record_sha256': '0' * 64}) + '\n', encoding='utf-8')
        for key, value in (
                ('unit', 'another-unit'), ('module', 'tests/another.py'), ('attempt', 2),
                ('plan_sha256', 'b' * 64), ('pid', self.inspection['pid'] + 1),
                ('started_at', (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()),
                ('inspected_at', 'not-a-time'), ('inspected_at', '2026-02-30T00:00:00+00:00'),
                ('inspected_at', '2026-01-01T00:00:00'),
                ('inspected_at', self.inspection['started_at']),
                ('inspected_at', (datetime.now(timezone.utc) + timedelta(days=1)).isoformat())):
            with self.subTest(field=key, value=value):
                self.write_record({**self.inspection, key: value})
                self.assert_closed(lambda: gate.release_after_inspection(self.record))

    def test_stale_record_mtime_is_refused_independently_of_its_valid_time(self):
        self.fail_live_run()
        stamp = self.marker.stat().st_mtime_ns
        os.utime(self.record, ns=(stamp, stamp))
        self.assert_closed(lambda: gate.release_after_inspection(self.record))

    def test_fresh_matching_record_hash_cannot_be_reused_under_another_path(self):
        self.fail_live_run()
        raw = self.record.read_bytes()
        self.ledger.write_text(json.dumps({'record_sha256': hashlib.sha256(raw).hexdigest(),
                                          'record_path': 'previous-name.json'}) + '\n', encoding='utf-8')
        copied = self.state / 'copied.json'
        copied.write_bytes(raw)
        stamp = self.record.stat().st_mtime_ns
        os.utime(copied, ns=(stamp, stamp))
        for path in (self.record, copied):
            self.assert_closed(lambda: gate.release_after_inspection(path))

    def test_legacy_pid_only_marker_is_not_accepted(self):
        self.fail_live_run()
        self.marker.write_text(json.dumps({'pid': os.getpid()}), encoding='utf-8')
        self.write_record()
        self.assert_closed(lambda: gate.release_after_inspection(self.record))

    def test_inspection_appends_evidence_then_admits_following_live_run(self):
        previous = b''
        hashes = set()
        for index in range(2):
            self.identity['attempt'] = index + 1
            self.fail_live_run()
            marker = json.loads(self.marker.read_bytes())
            digest = hashlib.sha256(self.record.read_bytes()).hexdigest()
            self.assertNotIn(digest, hashes)
            hashes.add(digest)
            gate.release_after_inspection(self.record)
            self.assertFalse(self.marker.exists())
            current = self.ledger.read_bytes()
            self.assertTrue(current.startswith(previous))
            rows = [json.loads(line) for line in current.splitlines()]
            self.assertEqual(len(rows), index + 1)
            self.assertEqual(rows[-1]['marker'], marker)
            self.assertEqual(Path(rows[-1]['record_path']), self.record.resolve())
            self.assertEqual(rows[-1]['record_sha256'], hashlib.sha256(self.record.read_bytes()).hexdigest())
            self.assertTrue(rows[-1]['released_at'])
            with gate.live_run(**self.identity):
                gate.require_live_run()
            self.assertEqual(self.ledger.read_bytes(), current)
            previous = current

    def test_active_lease_prevents_inspection_release(self):
        with gate.live_run(**self.identity):
            with self.assertRaises(gate.Refused):
                gate.release_after_inspection(self.record)
            self.assertTrue(self.marker.exists())
            self.assertFalse(self.ledger.exists())

    def test_ledger_write_failure_keeps_marker(self):
        self.fail_live_run()
        self.ledger.mkdir()
        self.assert_closed(lambda: gate.release_after_inspection(self.record), OSError)

    def test_ledger_append_or_fsync_failure_keeps_marker(self):
        for target in ('write', 'fsync'):
            with self.subTest(target=target):
                if not self.marker.exists():
                    self.fail_live_run()
                original = self.marker.read_bytes()
                if target == 'write':
                    real_open = Path.open
                    def fail_append(path, *args, **kwargs):
                        if path == self.ledger and args and args[0] == 'a':
                            raise OSError('synthetic append failure')
                        return real_open(path, *args, **kwargs)
                    with patch.object(Path, 'open', fail_append):
                        self.assert_closed(lambda: gate.release_after_inspection(self.record), OSError)
                else:
                    with patch.object(gate.os, 'fsync', side_effect=OSError('synthetic fsync failure')):
                        with self.assertRaises(OSError):
                            gate.release_after_inspection(self.record)
                    self.assertEqual(self.marker.read_bytes(), original)
                    with self.assertRaises(gate.Refused):
                        gate.preflight_live()

    def test_unreadable_ledger_keeps_marker(self):
        self.fail_live_run()
        self.ledger.write_text('not json\n', encoding='utf-8')
        self.assert_closed(lambda: gate.release_after_inspection(self.record))


class ExecutionGuardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pacs-gate-test-')
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name)
        self.tests = self.path / 'repo/tests'
        self.tests.mkdir(parents=True)
        self.state = self.path / 'state'
        self.bootstrap = self.path / 'bootstrap.py'
        self.bootstrap.write_text(
            'import importlib.util\nfrom pathlib import Path\n'
            'spec=importlib.util.spec_from_file_location("runner", '+repr(str(RUNNER))+')\n'
            'runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)\n'
            'runner.ROOT=Path('+repr(str(self.tests.parent))+')\n'
            'runner.gate.STATE=Path('+repr(str(self.state))+')\n'
            'runner.__file__=__file__\nraise SystemExit(runner.main())\n', encoding='utf-8')
        (self.tests/'probe.py').write_text('''import subprocess, sys, time, unittest
from pathlib import Path
from live_test_gate import require_live_run
BASE=Path(__file__).parent
class Probe(unittest.TestCase):
 def test_pass(self): (BASE/'passed').write_text('yes')
 def test_fail(self): self.fail('intentional synthetic failure')
 def test_live(self): require_live_run(); (BASE/'live').write_text('yes')
 def test_hold(self): require_live_run(); (BASE/'holding').write_text('yes'); time.sleep(2)
 def test_timeout(self):
  subprocess.Popen([sys.executable,'-c',"import time;from pathlib import Path;time.sleep(3);Path("+repr(str(BASE/'escaped'))+").write_text('bad')"])
  time.sleep(8)
''', encoding='utf-8')

    def plan(self, unit='probe', case='test_pass', mode='pure', timeout=10, attempts=3):
        value = dict(unit=unit, mode=mode, tests=[dict(file='tests/probe.py', case='Probe.'+case)],
                     max_attempts=attempts, timeout_seconds=timeout)
        path = self.path/(unit+'-input.json')
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def run_plan(self, plan):
        return subprocess.run([sys.executable, '-B', str(self.bootstrap), '--plan', str(plan)],
                              capture_output=True, timeout=20)

    def test_live_stack_denies_before_configuration_or_network(self):
        import invariants_live as live
        with patch.object(live.LiveStack, '_load_local_configuration') as configuration:
            with self.assertRaisesRegex(RuntimeError, 'explicit live test plan'):
                live.LiveStack()
            configuration.assert_not_called()

    def test_shell_temp_and_home_variables_do_not_split_gate_state(self):
        command=[sys.executable,'-B','-c',
                 'import sys;sys.path.insert(0,'+repr(str(ROOT/'tests'))+');import live_test_gate;print(live_test_gate.STATE)']
        original=subprocess.check_output(command)
        altered=dict(os.environ, TMP=str(self.path), TEMP=str(self.path), TMPDIR=str(self.path), HOME=str(self.path))
        self.assertEqual(subprocess.check_output(command,env=altered),original)

    def test_pure_mode_cannot_grant_live_permission(self):
        result = self.run_plan(self.plan(case='test_live'))
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertFalse((self.tests/'live').exists())
        self.assertFalse((self.state/'live-needs-inspection.json').exists())

    def test_imported_testcase_refused_before_any_test_runs(self):
        (self.tests/'accidental.py').write_text('from probe import Probe\nimport unittest\nclass Pure(unittest.TestCase):\n def test_ok(self): pass\n')
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--module', 'tests/accidental.py',
                                 '--unit', 'accidental'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertIn(b'imported TestCase', result.stderr)
        self.assertFalse((self.tests/'passed').exists())

    def test_duplicate_unknown_and_imported_selection_refused(self):
        for kind in ['duplicate', 'unknown', 'imported']:
            path = self.plan(unit=kind)
            value = json.loads(path.read_text())
            if kind == 'duplicate': value['tests'] *= 2
            if kind == 'unknown': value['tests'][0]['case'] = 'Probe.test_missing'
            if kind == 'imported':
                (self.tests/'accidental.py').write_text('from probe import Probe\n')
                value['tests'][0]['file'] = 'tests/accidental.py'
            path.write_text(json.dumps(value))
            self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertFalse((self.tests/'passed').exists())

    def test_pass_cannot_repeat_even_with_new_evidence_or_changed_plan(self):
        path = self.plan()
        self.assertEqual(self.run_plan(path).returncode, 0)
        path = self.plan(case='test_fail')
        result = self.run_plan(path)
        self.assertEqual(result.returncode, 125)
        self.assertIn(b'already passed', result.stderr)
        self.assertEqual(len(json.loads((self.state/'probe.json').read_text())['attempts']), 1)

    def test_attempt_budget_survives_fixes_and_cannot_be_raised(self):
        path = self.plan(case='test_fail', attempts=2)
        self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertEqual(self.run_plan(path).returncode, 125)
        path = self.plan(case='test_pass', attempts=3)
        self.assertIn(b'Cannot change', self.run_plan(path).stderr)
        path = self.plan(case='test_pass', attempts=2)
        self.assertIn(b'budget exhausted', self.run_plan(path).stderr)
        self.assertFalse((self.tests/'passed').exists())

    def test_worker_entry_cannot_bypass_parent_budget(self):
        path = self.plan()
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--worker', str(path)],
                                input=b'', capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 125)
        self.assertFalse((self.tests/'passed').exists())

    def test_import_is_inside_deadline_and_attempt_budget(self):
        (self.tests/'slow_import.py').write_text('import time\ntime.sleep(8)\n')
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--module', 'tests/slow_import.py',
                                 '--unit', 'slow-import', '--timeout', '1'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 124, result.stderr)
        ledger = json.loads((self.state/'slow-import.json').read_text())
        self.assertEqual(ledger['attempts'][0]['status'], 'interrupted')

    def test_live_process_lease_and_release(self):
        first = subprocess.Popen([sys.executable, '-B', str(self.bootstrap), '--plan',
                                  str(self.plan(unit='first', case='test_hold', mode='live'))],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic()+8
        while not (self.tests/'holding').exists() and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertTrue((self.tests/'holding').exists())
        second = self.run_plan(self.plan(unit='second', case='test_live', mode='live'))
        self.assertEqual(second.returncode, 125)
        self.assertIn(b'Another run owns', second.stderr)
        self.assertFalse((self.state/'second.json').exists())
        self.assertFalse((self.tests/'live').exists())
        self.assertEqual(first.wait(timeout=10), 0)
        self.assertEqual(self.run_plan(self.plan(unit='third', case='test_live', mode='live')).returncode, 0)

    def test_failed_live_run_stays_closed_for_other_units(self):
        self.assertEqual(self.run_plan(self.plan(case='test_fail', mode='live')).returncode, 125)
        result = self.run_plan(self.plan(unit='next', case='test_live', mode='live'))
        self.assertEqual(result.returncode, 125)
        self.assertIn(b'fixture inspection', result.stderr)
        self.assertFalse((self.state/'next.json').exists())
        self.assertFalse((self.tests/'live').exists())

    def test_real_module_and_single_or_multi_file_plan_bind_marker_and_attempt(self):
        for filename in ('failure.py', 'other.py'):
            (self.tests / filename).write_text(
                'import unittest\nfrom live_test_gate import require_live_run\n'
                'class Failure(unittest.TestCase):\n'
                ' def test_body(self):\n  require_live_run()\n  self.fail("synthetic failure")\n', encoding='utf-8')
        for attempt, selection in enumerate(('module', 'single-plan', 'multi-plan'), 1):
            with self.subTest(selection=selection):
                command = [sys.executable, '-B', str(self.bootstrap)]
                if selection == 'module':
                    command += ['--module', 'tests/../tests/failure.py', '--mode', 'live', '--unit', 'bound-probe']
                else:
                    plan = json.loads(self.plan(unit='bound-probe', mode='live').read_text())
                    plan['tests'] = [dict(file='tests/../tests/failure.py', case='Failure.test_body')]
                    if selection == 'multi-plan':
                        plan['tests'].append(dict(file='tests/other.py', case='Failure.test_body'))
                    path = self.path / 'bound-input.json'
                    path.write_text(json.dumps(plan), encoding='utf-8')
                    command += ['--plan', str(path)]
                completed = subprocess.run(command, capture_output=True, timeout=20)
                self.assertEqual(completed.returncode, 125, completed.stderr)
                row = json.loads(next(line[len('PLAN_RESULT '):] for line in completed.stdout.decode().splitlines()
                                      if line.startswith('PLAN_RESULT ')))
                marker_path = self.state / 'live-needs-inspection.json'
                marker = json.loads(marker_path.read_bytes())
                self.assertEqual(set(marker), {'unit', 'module', 'attempt', 'plan_sha256', 'pid', 'started_at'})
                self.assertEqual(marker['unit'], 'bound-probe')
                self.assertEqual(marker['attempt'], attempt)
                self.assertEqual(row['attempt'], attempt)
                frozen = self.state / ('bound-probe-attempt-' + str(attempt) + '.json')
                self.assertEqual(marker['plan_sha256'], hashlib.sha256(frozen.read_bytes()).hexdigest())
                self.assertEqual(marker['plan_sha256'], row['plan_sha256'])
                self.assertEqual(marker['module'], 'plan:' + row['plan_sha256'] if selection == 'multi-plan'
                                 else 'tests/failure.py')
                self.assertEqual(datetime.fromisoformat(marker['started_at']).utcoffset(), timedelta(0))
                self.assertIs(type(marker['pid']), int)
                # The parent test is a separate commander, not the worker that failed.
                self.assertNotEqual(marker['pid'], os.getpid())
                record = self.path / ('inspection-' + str(attempt) + '.json')
                record.write_text(json.dumps({**marker, 'exit': completed.returncode,
                    'artifacts': ['inspection.md', 'run.log', 'stack.log'], 'stack': {'containers': []},
                    'inspected_at': datetime.now(timezone.utc).isoformat(), 'inspector': 'commander'}), encoding='utf-8')
                stamp = max(time.time_ns(), marker_path.stat().st_mtime_ns + 1_000_000)
                os.utime(record, ns=(stamp, stamp))
                ledger_path = self.state / 'bound-probe.json'
                unit_before = ledger_path.read_bytes()
                with patch.object(gate, 'STATE', self.state):
                    gate.release_after_inspection(record)
                self.assertEqual(ledger_path.read_bytes(), unit_before)
                self.assertFalse(marker_path.exists())
                entries = [json.loads(line) for line in (self.state / 'inspections.jsonl').read_text().splitlines()]
                self.assertEqual(len(entries), attempt)
                self.assertEqual(entries[-1]['marker'], marker)
                self.assertEqual(entries[-1]['record_sha256'], hashlib.sha256(record.read_bytes()).hexdigest())
        self.assertEqual(self.run_plan(self.plan(unit='admitted', case='test_live', mode='live')).returncode, 0)

    def test_timeout_kills_owned_descendants_and_blocks_retry(self):
        path = self.plan(case='test_timeout', mode='live', timeout=1)
        result = self.run_plan(path)
        self.assertEqual(result.returncode, 124, result.stderr)
        time.sleep(3)
        self.assertFalse((self.tests/'escaped').exists())
        self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertTrue((self.state/'live-needs-inspection.json').exists())


# CH08 form: one local prefix reaches two execution calls (login and general branch).
KCADM_SHARED = '''\
import os
import subprocess
from invariants_live import ROOT


def kcadm(config, *arguments, login=False):
    base = ['docker', 'compose', 'exec', '-T', 'keycloak']  # prefix
    if login:
        command = 'kcadm.sh config credentials --config ' + config
        return subprocess.run(base + ['sh', '-lc', command], cwd=ROOT,  # login
                              capture_output=True, text=True, timeout=30)
    return subprocess.run(base + ['/opt/keycloak/bin/kcadm.sh', *arguments, '--config', config], cwd=ROOT,  # general
                          capture_output=True, text=True, timeout=30)
'''
KCADM_DIRECT = KCADM_SHARED.replace(
    "    base = ['docker', 'compose', 'exec', '-T', 'keycloak']  # prefix\n", '').replace(
    "base + ['sh', '-lc', command]", "['docker', 'compose', 'exec', '-T', 'keycloak', 'sh', '-lc', command]").replace(
    "base + ['/opt/keycloak/bin/kcadm.sh',", "['docker', 'compose', 'exec', '-T', 'keycloak', '/opt/keycloak/bin/kcadm.sh',")
LOGIN_CWD, GENERAL_CWD = "], cwd=ROOT,  # login", "], cwd=ROOT,  # general"
OVERRIDE = " env={**os.environ, 'COMPOSE_PROJECT_NAME': 'kin'},"


class ComposeTargetGuard(unittest.TestCase):
    """TG-01..TG-03: live tests address containers only through the inherited Compose selection.
    Assertions are rule id, file and line of the judged call; the judged code is test tooling, not product."""

    def judge(self, source, rel='tests/case_test.py', tg01=(), tg02=()):
        sources = {rel: textwrap.dedent(source)}
        found = fixed_name_violations(sources, dict(tg01)) + compose_selection_violations(sources, dict(tg02))
        return sorted((item.rule, item.file, item.line) for item in found)

    @staticmethod
    def marked(source, *expected, rel='tests/case_test.py'):
        lines = textwrap.dedent(source).splitlines()
        found = []
        for rule, marker in expected:
            hits = [number for number, line in enumerate(lines, 1) if marker in line]
            assert len(hits) == 1, (marker, hits)
            found.append((rule, rel, hits[0]))
        return sorted(found)

    def assertVerdict(self, source, *expected, rel='tests/case_test.py'):
        self.assertEqual(self.judge(source, rel), self.marked(source, *expected, rel=rel))

    def test_tg01_no_fixed_product_container_name_in_scope(self):
        self.assertEqual(fixed_name_violations(compose_target_sources()), [])

    def test_tg02_compose_calls_follow_the_inherited_selection(self):
        self.assertEqual(compose_selection_violations(compose_target_sources()), [])

    def test_tg03_preserving_variants_pass(self):
        cases = {
            'P-01': '''\
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-XqAt', '-c', query],
                                          cwd=ROOT, capture_output=True, text=True, timeout=30)
                ''',
            'P-02': '''\
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    return subprocess.run(['docker', 'compose', 'exec', '-T', '-e', 'PGTZ=UTC', 'db', 'psql', '-XqAt'],
                                          cwd=ROOT, input=query, capture_output=True, text=True, timeout=30)
                ''',
            'P-03': '''\
                import subprocess
                from invariants_live import ROOT
                root = ROOT
                def text(sql):
                    return subprocess.check_output(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-c', sql],
                                                   cwd=str(ROOT))
                def alias(sql):
                    return subprocess.check_output(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-c', sql],
                                                   cwd=root)
                ''',
            'P-04': '''\
                import subprocess
                from test_worklist import ROOT
                def proxy_lines(started):
                    return subprocess.run(['docker', 'compose', 'logs', '--no-log-prefix', '--no-color', '--since',
                                           started, 'proxy'], cwd=ROOT, capture_output=True)
                ''',
            'P-05': '''\
                MAPPER = {"name": "kin-api-audience", "config": {"included.custom.audience": "kin-api"}}
                CLIENT = {"clientId": "kin-api"}
                def exact(clients):
                    return [client for client in clients if client.get("clientId") == "kin-api"]
                ''',
            'P-06': '''\
                import subprocess
                def server_test():
                    subprocess.run(['docker', 'build', '-t', 'kin-proxy:ci', 'proxy'], check=True)
                    return subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'node', 'kin-api:ci', '--test',
                                           '/tests/x.cjs'], check=True)
                ''',
            'P-07': '''\
                class Gateway:
                    @classmethod
                    def stall(cls):
                        cls.docker('exec', cls.agent, 'true')
                ''',
            'P-08': KCADM_SHARED,
            'P-09': KCADM_DIRECT,
            'P-10': '''\
                import subprocess
                from invariants_live import ROOT
                KEYCLOAK_EXEC = ['docker', 'compose', 'exec', '-T', 'keycloak']
                def remove(config):
                    return subprocess.run(KEYCLOAK_EXEC + ['rm', '-f', config], cwd=ROOT, capture_output=True)
                ''',
            'P-11': '''\
                import subprocess
                from invariants_live import ROOT
                def command(args):
                    return subprocess.run(args, cwd=ROOT, capture_output=True)
                class Source:
                    def test_no_compose(self, source):
                        self.assertNotIn("docker compose", source.lower())
                        command(['git', 'status'])
                ''',
            'P-12 module alias': '''\
                import subprocess
                import invariants_live as live
                def ps():
                    return subprocess.check_output(['docker', 'compose', 'ps', '--format', 'json'], cwd=live.ROOT)
                def logs():
                    return subprocess.check_output(['docker', 'compose', 'logs', 'api'], cwd=str(live.ROOT))
                ''',
            'P-13 unchanged shared prefix': '''\
                import subprocess
                from invariants_live import ROOT
                PS = ['docker', 'compose', 'ps', '--format', 'json']
                def ps():
                    return subprocess.check_output(PS, cwd=ROOT)
                def every():
                    return subprocess.check_output(PS + ['--all'], cwd=str(ROOT))
                def named():
                    return subprocess.run(args=PS, cwd=ROOT, capture_output=True)
                ''',
            'P-14 local name elsewhere': '''\
                import subprocess
                from pathlib import Path
                from invariants_live import ROOT
                def describe():
                    ROOT = Path('elsewhere')
                    return str(ROOT)
                def ps():
                    return subprocess.check_output(['docker', 'compose', 'ps'], cwd=ROOT)
                ''',
        }
        for name, source in cases.items():
            with self.subTest(name):
                self.assertEqual(self.judge(source), [])
        with self.subTest('P-03 e2e depth'):
            self.assertEqual(self.judge('''\
                import subprocess
                from pathlib import Path
                here = Path(__file__).resolve().parents[2]
                def ps():
                    return subprocess.check_output(['docker', 'compose', 'ps', '--format', 'json'], cwd=str(here))
                ''', rel='tests/e2e/case_test.py'), [])

    def test_tg03_violating_variants_fail_with_their_own_rule_only(self):
        cases = {
            'V-01': ('''\
                import subprocess
                def sql(query):
                    return subprocess.run(['docker', 'exec', '-i', 'kin-db', 'psql'], input=query)  # V
                ''', [('TG01-FIXED-NAME', '# V')]),
            'V-02': ('''\
                import subprocess
                PROXY = 'kin-proxy'
                def lines():
                    return subprocess.run(['docker', 'logs', PROXY], capture_output=True)  # V
                ''', [('TG01-FIXED-NAME', '# V')]),
            'V-03': ('''\
                import subprocess
                def pages(script):
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'api', 'node', '-e', script])  # V
                ''', [('TG02-CWD', '# V')]),
            'V-04': ('''\
                import os
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    clean = {key: value for key, value in os.environ.items() if not key.startswith('COMPOSE_')}
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-c', query],  # V
                                          cwd=ROOT, env=clean)
                ''', [('TG02-ENV', '# V')]),
            'V-05': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    return subprocess.run(['docker', 'compose', '-p', 'kin', 'exec', 'db', 'psql', '-c', query],  # V
                                          cwd=ROOT)
                ''', [('TG02-SELECT-FLAG', '# V')]),
            'V-06': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    return subprocess.run(['docker', 'compose', '-f', 'docker-compose.yml', 'exec', 'db', 'psql',  # V
                                           '-c', query], cwd=ROOT)
                ''', [('TG02-SELECT-FLAG', '# V')]),
            'V-07': ('''\
                import subprocess
                def touch(service):
                    return subprocess.run(['docker', 'exec', f'kin-{service}', 'true'])  # V
                ''', [('TG01-UNRESOLVED-NAME', '# V')]),
            'V-09': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql(query):
                    result = subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-c', query], cwd=ROOT)
                    if result.returncode:
                        result = subprocess.run(['docker', 'exec', 'kin-db', 'psql', '-c', query])  # V
                    return result
                ''', [('TG01-FIXED-NAME', '# V')]),
            'V-10': ('''\
                def broken(:  # V
                    pass
                ''', [('TG-SYNTAX', '# V'), ('TG-SYNTAX', '# V')]),
            'V-11': (KCADM_SHARED.replace(LOGIN_CWD, '],  # login'), [('TG02-CWD', '# login')]),
            'V-12': (KCADM_SHARED.replace(GENERAL_CWD, '],  # general'), [('TG02-CWD', '# general')]),
            'V-13': (KCADM_SHARED.replace(LOGIN_CWD, '], cwd=ROOT,' + OVERRIDE + '  # login'),
                     [('TG02-ENV', '# login')]),
            'V-14': (KCADM_SHARED.replace(GENERAL_CWD, '], cwd=ROOT,' + OVERRIDE + '  # general'),
                     [('TG02-ENV', '# general')]),
            'V-15 augmented': (KCADM_SHARED.replace(
                '  # prefix\n', '  # prefix\n    base += [\'-e\', \'X=1\']\n'), [('TG02-UNLINKED', '# prefix')]),
            'V-15 twice': (KCADM_SHARED.replace(
                '  # prefix\n', "  # prefix\n    base = ['docker', 'compose', 'exec', 'keycloak']  # again\n"),
                [('TG02-UNLINKED', '# prefix'), ('TG02-UNLINKED', '# again')]),
            'V-16 handed on': ('''\
                def kcadm(helper, command):
                    base = ['docker', 'compose', 'exec', '-T', 'keycloak']  # V
                    return helper(base + ['sh', '-lc', command])
                ''', [('TG02-UNLINKED', '# V')]),
            'V-16 returned': ('''\
                import subprocess
                from invariants_live import ROOT
                def prefix():
                    return ['docker', 'compose', 'exec', '-T', 'keycloak']  # V
                def kcadm(command):
                    return subprocess.run(prefix() + ['sh', '-lc', command], cwd=ROOT)
                ''', [('TG02-UNLINKED', '# V')]),
            'V-17': ('''\
                import subprocess
                from invariants_live import ROOT
                def proxy_lines():
                    command = 'docker compose logs proxy'  # V
                    return subprocess.run(command.split(), cwd=ROOT, capture_output=True)
                ''', [('TG02-STRING', '# V')]),
            'V-18': ('''\
                import subprocess
                from invariants_live import ROOT
                def docker(extra):
                    return subprocess.run(['docker'] + extra, cwd=ROOT, capture_output=True)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-19 tool': ('''\
                import subprocess
                from invariants_live import ROOT
                def run(tool):
                    return subprocess.run(['docker', tool, 'exec', 'db', 'true'], cwd=ROOT)  # V
                ''', [('TG02-OPAQUE', '# V')]),
            'V-19 sub-command': ('''\
                import subprocess
                from invariants_live import ROOT
                def run(sub):
                    return subprocess.run(['docker', 'compose', sub, 'db'], cwd=ROOT)  # V
                ''', [('TG02-OPAQUE', '# V')]),
            'V-20': (KCADM_SHARED.replace("['docker', 'compose', 'exec',", "['docker', 'compose', '-p', 'kin', 'exec',"),
                     [('TG02-SELECT-FLAG', '# login'), ('TG02-SELECT-FLAG', '# general')]),
            # A list changed in place is not the list first assigned: these calls run with -p kin or opaque argv.
            'V-21 insert': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql():
                    base = ['docker', 'compose', 'exec', '-T', 'db']
                    base.insert(2, '-p')
                    base.insert(3, 'kin')
                    return subprocess.run(base + ['psql'], cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-21 shared insert': (KCADM_SHARED.replace(
                '  # prefix\n', "  # prefix\n    base.insert(2, '-p'); base.insert(3, 'kin')\n"),
                [('TG02-UNRESOLVED', '# login'), ('TG02-UNRESOLVED', '# general')]),
            'V-21 module extend': ('''\
                import subprocess
                from invariants_live import ROOT
                BASE = ['docker', 'compose']
                BASE.extend(['-p', 'kin', 'exec', '-T', 'db'])
                def sql():
                    return subprocess.run(BASE + ['psql'], cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-21 changed by a function': ('''\
                import subprocess
                from invariants_live import ROOT
                KEYCLOAK_EXEC = ['docker', 'compose', 'exec', '-T', 'keycloak']
                def select():
                    KEYCLOAK_EXEC.insert(2, '--project-name=kin')
                def remove(config):
                    return subprocess.run(KEYCLOAK_EXEC + ['rm', '-f', config], cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-21 slice store': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql():
                    base = ['docker', 'compose', 'exec', '-T', 'db']
                    base[2:2] = ['-p', 'kin']
                    return subprocess.run(base + ['psql'], cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-21 handed on': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql(select):
                    base = ['docker', 'compose', 'exec', '-T', 'db']
                    select(base)
                    return subprocess.run(base + ['psql'], cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            'V-21 alias': ('''\
                import subprocess
                from invariants_live import ROOT
                def sql():
                    base = ['docker', 'compose', 'exec', '-T', 'db']
                    other = base
                    other[1:1] = ['compose', '-p', 'kin']
                    return subprocess.run(base, cwd=ROOT)  # V
                ''', [('TG02-UNRESOLVED', '# V')]),
            # cwd=ROOT counts only while ROOT still holds its import; another checkout's path selects another project.
            'V-22 reassigned': ('''\
                import subprocess
                from invariants_live import ROOT
                ROOT = '/another-checkout'
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=ROOT)  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 re-imported': ('''\
                import subprocess
                from invariants_live import ROOT
                from other_checkout import ROOT
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=str(ROOT))  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 deleted': ('''\
                import subprocess
                from invariants_live import ROOT
                del ROOT
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=ROOT)  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 global': ('''\
                import subprocess
                from invariants_live import ROOT
                def move():
                    global ROOT
                    ROOT = '/another-checkout'
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=ROOT)  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 module attribute': ('''\
                import subprocess
                import invariants_live as live
                live.ROOT = '/another-checkout'
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=live.ROOT)  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 setattr': ('''\
                import subprocess
                import invariants_live as live
                setattr(live, 'ROOT', '/another-checkout')
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=str(live.ROOT))  # V
                ''', [('TG02-CWD', '# V')]),
            'V-22 alias rebound': ('''\
                import subprocess
                import invariants_live as live
                import other_checkout as live
                def sql():
                    return subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql'], cwd=live.ROOT)  # V
                ''', [('TG02-CWD', '# V')]),
        }
        for name, (source, expected) in cases.items():
            with self.subTest(name):
                self.assertVerdict(source, *expected)

    def test_tg03_stale_exclusions_fail(self):
        sources = {'tests/clean_test.py': 'import subprocess\n',
                   'tests/kept_test.py': "import subprocess\nsubprocess.run(['docker', 'start', 'kin-api'])\n"}
        tg01 = {'tests/gone_test.py': 'reason', 'tests/clean_test.py': 'reason', 'tests/kept_test.py': 'reason'}
        self.assertEqual([(item.rule, item.file, item.line) for item in fixed_name_violations(sources, tg01)],
                         [('TG01-STALE-EXCLUSION', 'tests/clean_test.py', 0),
                          ('TG01-STALE-EXCLUSION', 'tests/gone_test.py', 0)])
        self.assertEqual([(item.rule, item.file, item.line) for item in fixed_name_violations(sources, {})],
                         [('TG01-FIXED-NAME', 'tests/kept_test.py', 2)])
        tg02 = {'tests/gone_test.py': 'reason', 'tests/clean_test.py': 'reason', 'tests/kept_test.py': 'reason'}
        self.assertEqual([(item.rule, item.file, item.line) for item in compose_selection_violations(sources, tg02)],
                         [('TG02-STALE-EXCLUSION', 'tests/clean_test.py', 0),
                          ('TG02-STALE-EXCLUSION', 'tests/gone_test.py', 0)])

    def test_tg03_shared_prefix_and_direct_list_are_judged_alike(self):
        def by_call(source):
            calls = sorted(node.lineno for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
                           and ast.unparse(node.func) == 'subprocess.run')
            return [(rule, calls.index(line)) for rule, _, line in self.judge(source)]
        self.assertEqual(self.judge(KCADM_SHARED), self.judge(KCADM_DIRECT))
        for cut, other in ((LOGIN_CWD, '],  # login'), (GENERAL_CWD, '],  # general')):
            with self.subTest(cut):
                shared, direct = KCADM_SHARED.replace(cut, other), KCADM_DIRECT.replace(cut, other)
                self.assertEqual(by_call(shared), by_call(direct))
                self.assertEqual(len(by_call(shared)), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
