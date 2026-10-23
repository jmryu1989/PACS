"""REQ-W2C-05 -> RISK-CI-UNHASHED-INPUT -> AST audit plus omission mutation.

Conservatively include executable workflow-path literals (including declarations
passed through variables). Comments and docstrings are not dependency evidence.
JS/TS uses the repository's TypeScript parser, not a replacement syntax parser.
"""
import ast
import importlib.util
import json
import posixpath
import re
import shlex
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recorder', ROOT / 'scripts/record-run.py')
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)


def python_scan(source, filename='tests/probe.py'):
    """(reads workflows itself, imported module names, file names named in code)."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant):
                docstrings.add(id(node.body[0].value))
    values, modules, files, reads = [], set(), set(), False
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases.update((item.asname, item.name) for item in node.names if item.asname)
        elif isinstance(node, ast.ImportFrom) and node.module:
            aliases.update((item.asname or item.name, node.module + '.' + item.name) for item in node.names)

    def call_name(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return call_name(node.value) + '.' + node.attr
        return ''

    def argument(node, index=0):
        value = node.args[index] if len(node.args) > index else None
        return value.value if isinstance(value, ast.Constant) and isinstance(value.value, str) else None

    # Union assignments and local call arguments; uncertainty must add inputs,
    # never discard a possible loader. This is bounded AST evaluation, not execution.
    bindings = {}
    functions = {}
    uncertain_names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.setdefault(node.name, []).append(node)
            uncertain_names.update(param.arg for param in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs])
        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            uncertain_names.add(node.target.id)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.attr in ('append', 'extend', 'insert', 'pop', 'remove', 'clear')):
            uncertain_names.add(node.func.value.id)
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(target, ast.Name) and node.value is not None:
                    bindings.setdefault(target.id, []).append(node.value)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for function in functions.get(call_name(node.func), []):
                for param, value in zip(function.args.args, node.args):
                    bindings.setdefault(param.arg, []).append(value)
                for keyword in node.keywords:
                    if keyword.arg:
                        bindings.setdefault(keyword.arg, []).append(keyword.value)

    resolved_cache = {}

    def resolved(node, seen=frozenset()):
        if node is None or id(node) in seen or len(seen) > 40:
            return {None}
        if id(node) not in resolved_cache:
            resolved_cache[id(node)] = resolve_node(node, seen)
        return resolved_cache[id(node)]

    def resolve_node(node, seen):
        if node is None or id(node) in seen or len(seen) > 40:
            return {None}
        seen = seen | {id(node)}
        resolve = lambda item: resolved(item, seen)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return {node.value.replace('\\', '/')}
        if isinstance(node, ast.Name):
            if node.id == '__file__':
                return {filename}
            values = set().union(*(resolve(value) for value in bindings.get(node.id, []))) or {None}
            # A parameter may also arrive from another module; a mutable argv
            # cannot be proved complete from its initial assignment alone.
            return values | {None} if node.id in uncertain_names else values
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return set().union(*(resolve(item) for item in node.elts))
        if isinstance(node, ast.Starred):
            return resolve(node.value)
        if isinstance(node, ast.IfExp):
            return resolve(node.body) | resolve(node.orelse)
        if isinstance(node, ast.Attribute) and node.attr == 'parent':
            return {posixpath.dirname(value) if value is not None else None for value in resolve(node.value)}
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                and node.value.attr == 'parents' and isinstance(node.slice, ast.Constant)
                and type(node.slice.value) is int and 0 <= node.slice.value < 10):
            values = resolve(node.value.value)
            for _ in range(node.slice.value + 1):
                values = {posixpath.dirname(value) if value is not None else None for value in values}
            return values
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
            left, right = resolve(node.left), resolve(node.right)
            def sequence(value):
                if isinstance(value, (ast.List, ast.Tuple)):
                    return True
                if isinstance(value, ast.Name):
                    return any(isinstance(item, (ast.List, ast.Tuple)) for item in bindings.get(value.id, []))
                return False
            if isinstance(node.op, ast.Add) and (sequence(node.left) or sequence(node.right)):
                return left | right
            if len(left) * len(right) > 256:
                return left | right | {None}
            return {None if a is None or b is None else
                    posixpath.join(a, b) if isinstance(node.op, ast.Div) else a + b
                    for a in left for b in right}
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name in ('str', 'Path', 'pathlib.Path') and node.args:
                return resolve(node.args[0])
            if isinstance(node.func, ast.Attribute):
                if node.func.attr in ('resolve', 'absolute', 'as_posix'):
                    return resolve(node.func.value)
                if node.func.attr == 'with_name' and node.args:
                    return {posixpath.join(posixpath.dirname(base), value)
                            if base is not None and value is not None else None
                            for base in resolve(node.func.value) for value in resolve(node.args[0])}
        return {None}

    def loader_files(args):
        # Container bind mounts retain their repository source identity.
        mounts = []
        for value in args:
            if value and ':' in value:
                source, destination, *_ = value.split(':')
                if (source == 'tests' or source.startswith('tests/')) and destination.startswith('/'):
                    mounts.append((source, destination))
        for value in args:
            if not value or not value.endswith(('.py', '.cjs', '.js', '.mjs', '.ts')):
                continue
            for source, destination in mounts:
                if value.startswith(destination + '/'):
                    value = source + value[len(destination):]
                    break
            if '/tests/' in value:
                value = 'tests/' + value.split('/tests/', 1)[1]
            files.add(value)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(item.name for item in node.names)
            if any('ci_workflows' in item.name.split('.') for item in node.names):
                reads = True
        if isinstance(node, ast.ImportFrom):
            prefix = '.' * node.level + (node.module or '')
            modules.add(prefix)
            modules.update(prefix + ('.' if node.module else '') + item.name for item in node.names)
            if 'ci_workflows' in (node.module or '').split('.') or any(item.name == 'ci_workflows' for item in node.names):
                reads = True
        if isinstance(node, ast.Constant) and id(node) not in docstrings and isinstance(node.value, str):
            values.append(node.value.replace('\\', '/'))
        if isinstance(node, ast.Call):
            loader = call_name(node.func)
            if loader in ('importlib.import_module', '__import__', 'runpy.run_module'):
                value = argument(node)
                if loader == 'importlib.import_module' and value and value.startswith('.'):
                    package = argument(node, 1)
                    for keyword in node.keywords:
                        if keyword.arg == 'package' and isinstance(keyword.value, ast.Constant):
                            package = keyword.value.value
                    if isinstance(package, str):
                        level = len(value) - len(value.lstrip('.'))
                        pieces = package.split('.')
                        value = '.'.join(pieces[:len(pieces) - level + 1] + [value.lstrip('.')])
                    else:
                        # Without a known package this call cannot be attributed to the importer.
                        value = None
                if value is not None:
                    modules.add(value)
                else:
                    reads = True  # Unknown dynamic module: conservatively record the workflows.
            elif loader in ('runpy.run_path', 'importlib.util.spec_from_file_location'):
                index = 1 if loader.endswith('spec_from_file_location') else 0
                args = resolved(node.args[index] if len(node.args) > index else None)
                loader_files(args)
                if None in args:
                    reads = True
            elif loader in ('subprocess.run', 'subprocess.Popen', 'subprocess.call',
                            'subprocess.check_call', 'subprocess.check_output'):
                argv = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == 'args'), None)
                resolved_args = resolved(argv)
                loader_files(resolved_args)
                if resolved_args & {'-e', '--eval', '-r', '--require'}:
                    reads = True  # Inline/preloaded code needs runtime attribution.
                if None in resolved_args or not isinstance(argv, (ast.List, ast.Tuple, ast.Name, ast.IfExp, ast.BinOp)):
                    reads = True
                if isinstance(argv, (ast.List, ast.Tuple)):
                    args = [item.value if isinstance(item, ast.Constant) and isinstance(item.value, str)
                            else None for item in argv.elts]
                    if len(args) >= 3 and args[1] == '-m':
                        # sys.executable is also an explicit Python command in this AST.
                        executable = argv.elts[0]
                        if (args[0] and Path(args[0]).name.startswith('python') or
                                call_name(executable) == 'sys.executable') and args[2]:
                            modules.add(args[2])
                            if args[2] in ('unittest', 'pytest'):
                                modules.update(value for value in args[3:] if value and not value.startswith('-'))
            elif loader in ('os.system', 'os.popen', 'asyncio.create_subprocess_shell',
                            'asyncio.create_subprocess_exec'):
                reads = True  # Shell/async launch is explicitly unresolved, never silently ignored.
    values = [value.rstrip('/') for value in values]
    # Several pure suites add tests/e2e before importing its modules. Resolve that
    # explicit local search root; a bare module still never matches global stems.
    search_roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and call_name(node.func) in ('sys.path.insert', 'sys.path.append', 'sys.path.extend'):
            index = 1 if call_name(node.func) == 'sys.path.insert' else 0
            if len(node.args) > index:
                search_roots.update(value for value in resolved(node.args[index]) if value is not None)
    modules.update(posixpath.join(base, module.replace('.', '/')).replace('/', '.')
                   for base in search_roots for module in list(modules) if not module.startswith('.'))
    reads = (reads or any('.github/workflows' in value for value in values)
            or ('.github' in values and 'workflows' in values))
    return reads, modules, files


def python_consumer(source):
    return python_scan(source)[0]


def javascript_scan(rows):
    return json.loads(subprocess.check_output(
        ['node', str(ROOT / 'tests/ci_workflow_consumers.cjs')],
        input=json.dumps(rows), text=True, encoding='utf-8'))


def javascript_consumers(rows):
    return [row['reads'] for row in javascript_scan(rows)]


def consumers(root, *, audit=None):
    """Direct workflow readers, then every file that imports, requires, loads or runs one.

    A helper such as ci_artifacts.inventory() reads the catalogue for its caller, so
    the caller consumes workflows too. Conservative over-inclusion is the policy.
    """
    scans, javascript = {}, []
    for path in sorted((root / 'tests').rglob('*')):
        if not path.is_file() or path.suffix not in ('.py', '.js', '.cjs', '.mjs', '.ts'):
            continue
        source = path.read_text(encoding='utf-8-sig')
        name = path.relative_to(root).as_posix()
        if path.suffix == '.py':
            scans[name] = python_scan(source, name)
        else:
            javascript.append({'filename': name, 'source': source})
    for row, result in zip(javascript, javascript_scan(javascript) if javascript else []):
        scans[row['filename']] = (result['reads'], set(result['modules']), set(result['files']))
    def targets(importer, modules, files):
        parent = posixpath.dirname(importer)
        candidates = set()
        for module in modules:
            if importer.endswith('.py'):
                level = len(module) - len(module.lstrip('.'))
                suffix = module.lstrip('.').replace('.', '/')
                if level:
                    base = parent
                    for _ in range(level - 1):
                        base = posixpath.dirname(base)
                    bases = [posixpath.join(base, suffix)]
                else:
                    bases = [posixpath.join(parent, suffix), suffix, 'tests/' + suffix]
                extensions = ('.py', '/__init__.py')
            else:
                if not module.startswith('.'):
                    continue  # Bare JS specifiers are packages, not same-named test files.
                bases = [posixpath.normpath(posixpath.join(parent, module))]
                extensions = ('', '.js', '.cjs', '.mjs', '.ts', '/index.js', '/index.cjs')
            for base in bases:
                matches = {posixpath.normpath(base + ext) for ext in extensions} & scans.keys()
                if matches:
                    candidates.update(matches)
                    break
        for file in files:
            bases = [file] if file.startswith(('tests/', 'scripts/')) else [posixpath.join(parent, file)]
            candidates.update(posixpath.normpath(base) for base in bases if posixpath.normpath(base) in scans)
        return candidates

    edges = {name: targets(name, modules, files) for name, (_, modules, files) in scans.items()}
    # A resolved filename outside the scanned test graph is still an unknown
    # dependency (for example a scripts/ helper or a container-only path).
    direct = {name for name, (reads, _, files) in scans.items()
              if reads or any(not targets(name, set(), {file}) for file in files)}
    found = set(direct)
    while True:
        added = {name for name in scans if name not in found and edges[name] & found}
        if not added:
            if audit is not None:
                audit.update(direct=sorted(direct),
                             edges={name: sorted(targets) for name, targets in edges.items()},
                             consumers=sorted(found))
            return found
        found |= added


def missing_consumers(found, expand=recorder.workflow_contract_inputs):
    return sorted(name for name in found if '.github/workflows' not in expand([name], [], ROOT)[1])


def workflow_step_audit(root):
    """Diagnostic only: attribute missing recorder inputs to workflow/job/step.

    shlex handles the literal command subset used by current workflows. Dynamic
    shell expressions are reported as unresolved, never a completeness verdict.
    """
    from ci_workflows import WorkflowCatalog
    graph = {}
    readers = consumers(root, audit=graph)
    rows = []
    for workflow, doc in WorkflowCatalog(root).documents.items():
        for job_id, job in doc['jobs'].items():
            for index, step in enumerate(job.get('steps', [])):
                run = str(step.get('run', '')).replace('\\\n', ' ').replace('`\n', ' ')
                for line_number, line in enumerate(run.splitlines(), 1):
                    line = line.replace('\\', '/')
                    if 'scripts/record-run.py' not in line:
                        continue
                    line = re.sub(r'\$\{\{\s*github.workspace\s*\}\}/', '', line)
                    row = dict(workflow=workflow, job=job_id, step=index, name=step.get('name'),
                               line=line_number, missing=[], unresolved=[])
                    rows.append(row)
                    try:
                        words = shlex.split(line, comments=True)
                        pos = next(i for i, word in enumerate(words) if word.lstrip('./') == 'scripts/record-run.py')
                        divider = words.index('--', pos)
                    except (ValueError, StopIteration) as error:
                        row['unresolved'].append('recorder command: ' + str(error))
                        continue
                    options, command = words[pos + 1:divider], words[divider + 1:]
                    declared, trees = [], []
                    for i, word in enumerate(options):
                        for option, values in (('--file', declared), ('--tree', trees)):
                            if word == option and i + 1 < len(options):
                                values.append(options[i + 1].removeprefix('./'))
                            elif word.startswith(option + '='):
                                values.append(word.split('=', 1)[1].removeprefix('./'))
                    extra_files, extra_trees = recorder.workflow_contract_inputs(declared, trees, root)
                    declared += extra_files
                    trees += extra_trees
                    invoked = {word.removeprefix('./') for word in command if word.removeprefix('./') in graph['edges']}
                    if '-m' in command:
                        invoked.update(word.replace('.', '/') + '.py' for word in command
                                       if word.replace('.', '/') + '.py' in graph['edges'])
                    if any('$' in word for word in command + options):
                        row['unresolved'].append('shell/matrix variable requires expanded command inspection')
                    required = set(invoked)
                    pending = list(invoked)
                    while pending:
                        for target in graph['edges'][pending.pop()]:
                            if target not in required:
                                required.add(target)
                                pending.append(target)
                    if invoked & readers:
                        required.update(('.github/workflows', 'tests/ci_workflows.py', 'scripts/record-run.py'))
                    def covered(name):
                        return name in declared or any(name == tree or name.startswith(tree.rstrip('/') + '/') for tree in trees)
                    row.update(invoked=sorted(invoked), missing=sorted(name for name in required if not covered(name)))
    return dict(contract='W2C-05 step input diagnostic; no per-file registration', steps=rows,
                gaps=sum(bool(row['missing']) for row in rows), unresolved=sum(bool(row['unresolved']) for row in rows))


class WorkflowConsumerTests(unittest.TestCase):
    def test_restore_required_check_names_are_unique_and_workflow_qualified(self):
        # REQ-RESTORE-JOB-NAMES -> RISK-RESTORE-FAILURE-MASKED:
        # These are external branch-protection contexts, not implementation pins.
        from ci_workflows import WorkflowCatalog
        catalogue = WorkflowCatalog(ROOT)
        contexts = {}
        for workflow, document in catalogue.documents.items():
            for job_id, job in document['jobs'].items():
                contexts.setdefault(job.get('name', job_id), []).append((workflow, job_id))
        for job_id in ('produce', 'consume'):
            self.assertEqual(contexts.get(f'restore-product / {job_id}'),
                             [(catalogue.owner(job_id)[0], job_id)])
            self.assertNotIn(job_id, contexts)
            for kind in ('combined', 'database', 'image', 'orthanc'):
                self.assertNotIn(f'restore-{kind} / {job_id}', contexts)

    def test_audit_entry_points_report_gaps_without_failing_and_parse_errors_fail(self):
        # R5-DIAG-01: both public CLIs preserve diagnostics and exit semantics.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tests').mkdir()
            (root / '.github/workflows').mkdir(parents=True)
            (root / 'tests/new.py').write_text('import leaf\n', encoding='utf-8')
            (root / 'tests/leaf.py').write_text("p = '.github/workflows'\n", encoding='utf-8')
            workflow = root / '.github/workflows/probe.yml'
            workflow.write_text('''jobs:
  probe:
    steps:
      - name: missing transitive input
        run: python scripts/record-run.py --file tests/new.py -- python tests/new.py
      - name: complete inputs
        run: python scripts/record-run.py --tree tests -- python tests/new.py
      - name: unresolved argv
        run: python scripts/record-run.py --file tests/new.py -- python $ENTRY
''', encoding='utf-8')
            commands = ([sys.executable, '-B', str(Path(__file__).resolve())],
                        ['node', str(ROOT / 'tests/ci_workflow_consumers.cjs')])
            for command in commands:
                with self.subTest(command=command):
                    result = subprocess.run([*command, '--audit', str(root)], capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    report = json.loads(result.stdout)
                    self.assertEqual(report['gaps'], 1)
                    self.assertEqual(report['unresolved'], 1)
                    self.assertEqual(len(report['steps']), 3)
                    for index, row in enumerate(report['steps']):
                        self.assertEqual((row['workflow'], row['job'], row['step']), ('.github/workflows/probe.yml', 'probe', index))
                    self.assertEqual(report['steps'][0]['missing'], ['tests/leaf.py'])
                    self.assertEqual(report['steps'][1]['missing'], [])
                    self.assertTrue(report['steps'][2]['unresolved'])
            workflow.write_text('jobs: [unclosed', encoding='utf-8')
            for command in commands:
                with self.subTest(invalid=command):
                    result = subprocess.run([*command, '--audit', str(root)], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue(result.stderr)

    def test_parent_index_keeps_resolved_external_target(self):
        scan = python_scan("subprocess.run(['python', str(Path('sandbox/a/probe.py').parents[1] / 'leaf.py')])")
        self.assertEqual(scan[2], {'sandbox/leaf.py'})

    def test_loader_boundaries_and_external_targets(self):
        cases = {
            'from_alias.py': "from subprocess import run as launch\nlaunch(['node', 'leaf.js'])",
            'module_alias.py': "import subprocess as sp\nsp.run(['node', 'leaf.mjs'])",
            'typescript.py': "subprocess.run(['node', 'leaf.ts'])",
            'run_unittest.py': "subprocess.run(['python', '-m', 'unittest', 'tests.leaf'])",
            'run_pytest.py': "subprocess.run(['python', '-m', 'pytest', 'tests/leaf.py'])",
            'inline.py': "subprocess.run(['node', '-e', code])",
            'preload.py': "subprocess.run(['node', '--require', module])",
            'shell.py': "import os\nos.system(command)",
            'popen.py': "import os\nos.popen(command)",
            'async.py': "import asyncio\nasyncio.create_subprocess_exec(*args)",
            'async_shell.py': "import asyncio\nasyncio.create_subprocess_shell(command)",
            'outside.py': "subprocess.run(['python', 'scripts/helper.py'])",
            'exec.cjs': "require('child_process').exec('node leaf.js');",
            'execsync.cjs': "require('child_process').execSync('node leaf.mjs');",
            'fork.cjs': "require('child_process').fork('./leaf.js');",
            'alias.cjs': "const {spawnSync: launch} = require('node:child_process'); launch('node', ['./leaf.js']);",
            'execfile.cjs': "require('child_process').execFile('node', ['./leaf.js']);",
            'execfilesync.cjs': "require('child_process').execFileSync('node', ['./leaf.js']);",
            'inline.cjs': "require('child_process').spawnSync('node', ['-e', 'require(module)']);",
        }
        negatives = {
            'from_plain.py': "from subprocess import run as launch\nlaunch(['node', 'plain.js'])",
            'module_plain.py': "import subprocess as sp\nsp.run(['node', 'plain.mjs'])",
            'typescript_plain.py': "subprocess.run(['node', 'plain.ts'])",
            'unittest_plain.py': "subprocess.run(['python', '-m', 'unittest', 'tests.plain'])",
            'pytest_plain.py': "subprocess.run(['python', '-m', 'pytest', 'tests/plain.py'])",
            'aliases_plain.cjs': "const {spawnSync: launch} = require('node:child_process'); launch('node', ['./plain.js']);",
            'fork_plain.cjs': "require('child_process').fork('./plain.js');",
            'execfile_plain.cjs': "require('child_process').execFile('node', ['./plain.js']);",
            'execfilesync_plain.cjs': "require('child_process').execFileSync('node', ['./plain.js']);",
            'shell_prose.py': "# os.system(command)\ntext = 'asyncio.create_subprocess_exec(args)'",
            'exec_prose.cjs': "// execSync('node leaf.js')\nconst text = 'exec(command)';",
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tests').mkdir()
            for ext in ('py', 'js', 'mjs', 'ts'):
                (root / ('tests/leaf.' + ext)).write_text("p = '.github/workflows'", encoding='utf-8')
                (root / ('tests/plain.' + ext)).write_text('p = 1', encoding='utf-8')
            for name, source in {**cases, **negatives}.items():
                (root / 'tests' / name).write_text(source, encoding='utf-8')
            found = consumers(root)
        self.assertTrue({'tests/' + name for name in cases} <= found, sorted(found))
        self.assertFalse({'tests/' + name for name in negatives} & found, sorted(found))

    def test_step_audit_reports_inputs_not_unregistered_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tests').mkdir()
            (root / '.github/workflows').mkdir(parents=True)
            (root / 'tests/new.py').write_text('import leaf', encoding='utf-8')
            (root / 'tests/leaf.py').write_text("p = '.github/workflows'", encoding='utf-8')
            (root / '.github/workflows/probe.yml').write_text('''jobs:
  probe:
    steps:
      - run: python scripts/record-run.py --file tests/new.py -- python tests/new.py
      - run: python scripts/record-run.py --tree tests -- python tests/new.py
''', encoding='utf-8')
            report = workflow_step_audit(root)
        self.assertEqual(report['steps'][0]['missing'], ['tests/leaf.py'])
        self.assertEqual(report['steps'][1]['missing'], [])
        self.assertEqual(report['steps'][0]['job'], 'probe')
        self.assertEqual(report['steps'][0]['step'], 0)
    def test_constructed_paths_variable_argv_and_local_wrappers(self):
        cases = {
            'clinician.py': "ROOT = Path(__file__).resolve().parents[1]\nsubprocess.run(['node', str(ROOT / 'tests' / 'leaf.cjs')])",
            'main_split.py': "_HELPER = Path(__file__).with_name('leaf.cjs')\nsubprocess.check_output(['node', str(_HELPER)])",
            'pacs.py': "ROOT = Path(__file__).resolve().parents[1]\ncmd = ['node', str(ROOT / 'tests/leaf.cjs')]\nsubprocess.run(cmd)",
            'conditional.py': "cmd = ['node', 'leaf.cjs' if flag else 'plain.cjs']\nsubprocess.run(args=cmd)",
            'concat.py': "cmd = ['node'] + ['leaf.cjs']\nsubprocess.run(cmd)",
            'wrapper.py': "def run(harness, values):\n command = ['node', str(Path(__file__).parent / harness), *values]\n subprocess.run(command)\nrun('leaf.cjs' if flag else 'plain.cjs', ['--test'])",
            'container.py': "subprocess.Popen(['docker', 'run', '-v', str(Path(__file__).parent.resolve()) + ':/emr:ro', 'image', '/emr/leaf.cjs'])",
            'variable.cjs': "const {spawnSync} = require('node:child_process'); const cmd = ['./leaf.cjs']; spawnSync('node', cmd);",
            'conditional.cjs': "const {spawnSync} = require('node:child_process'); spawnSync('node', flag ? ['./leaf.cjs'] : ['./plain.cjs']);",
        }
        sources = {'leaf.cjs': "const workflows = '.github/workflows';", 'plain.cjs': 'module.exports = 1;', **cases,
                   'unknown.py': 'subprocess.run(build_argv())',
                   'unknown.cjs': "require('node:child_process').spawnSync('node', buildArgv());",
                   'mutated.py': "cmd = ['node', 'plain.cjs']\ncmd.append(runtime_path)\nsubprocess.run(cmd)",
                   'parameter.py': "cmd = ['node', 'plain.cjs']\ndef launch(cmd):\n subprocess.run(cmd)",
                   'mutated.cjs': "const cmd = ['./plain.cjs']; cmd.push(runtimePath); require('node:child_process').spawnSync('node', cmd);",
                   'metadata.py': "data = {'leaf.cjs': 1}; argv = ['node', 'leaf.cjs']; print(argv)",
                   'not_execute.py': "subprocess.run(['echo', 'plain text'])",
                   'other/plain.py': "subprocess.run(['node', 'plain.cjs'])",
                   'other/plain.cjs': 'module.exports = 1;'}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, source in sources.items():
                path = root / 'tests' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            audit = {}
            found = consumers(root, audit=audit)
        self.assertEqual(found, {'tests/' + name for name in [*cases, 'leaf.cjs', 'unknown.py', 'unknown.cjs', 'mutated.py', 'parameter.py', 'mutated.cjs']})
        for name in cases:
            self.assertIn('tests/leaf.cjs', audit['edges']['tests/' + name], name)
        self.assertNotIn('tests/leaf.cjs', audit['edges']['tests/metadata.py'])

    def test_explicit_python_search_root_is_not_global_stem_matching(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, source in {
                'e2e/leaf.py': "p = '.github/workflows'",
                'plain/leaf.py': 'x = 1',
                'precision.py': "sys.path.insert(0, str(Path(__file__).parent / 'e2e'))\nimport leaf",
                'unrelated.py': "sys.path.insert(0, str(Path(__file__).parent / 'plain'))\nimport leaf",
            }.items():
                path = root / 'tests' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            self.assertEqual(consumers(root), {'tests/e2e/leaf.py', 'tests/precision.py'})

    def test_loader_arguments_and_importer_relative_paths_only(self):
        sources = {
            'pkg/leaf.py': "p = '.github/workflows'",
            'pkg/leaf.cjs': "const p = '.github/workflows';",
            'pkg/live.py': "p = '.github/workflows'",
            'pkg/contract_test.cjs': "const p = '.github/workflows';",
            'pkg/static.py': 'from . import leaf',
            'pkg/dynamic.py': "import importlib; importlib.import_module('leaf')",
            'pkg/builtin.py': "__import__('leaf')",
            'pkg/run_module.py': "import runpy; runpy.run_module('leaf')",
            'pkg/run_path.py': "import runpy; runpy.run_path('leaf.py')",
            'pkg/subprocess.py': "import subprocess; subprocess.run(['python', '-m', 'tests.pkg.leaf'])",
            'pkg/spawn.cjs': "const {spawnSync} = require('node:child_process'); spawnSync('node', ['./contract_test.cjs']);",
            'pkg/spawn_module.cjs': "const {spawnSync} = require('node:child_process'); spawnSync('python', ['-m', 'tests.pkg.leaf']);",
            'pkg/export.cjs': "export * from './leaf';",
            'pkg/resolve.cjs': "require.resolve('./leaf');",
            'pkg/key.py': "counters = {'live': 0}; label = 'leaf'; filename = 'contract_test.cjs'",
            'pkg/not_loader.py': "obj.import_module('leaf'); obj.run_module('leaf')",
            'pkg/other_package.py': "import importlib; importlib.import_module('.leaf', package='tests.other')",
            'other/leaf.py': 'x = 1', 'other/leaf.cjs': 'module.exports = 1;',
            'other/contract_test.cjs': 'module.exports = 1;',
            'other/static.py': 'from . import leaf',
            'other/dynamic.py': "import importlib; importlib.import_module('leaf')",
            'other/explicit_package.py': "import importlib; importlib.import_module('.leaf', package='tests.pkg')",
            'other/positional_package.py': "import importlib; importlib.import_module('.leaf', 'tests.pkg')",
            'other/unknown_package.py': "import importlib; importlib.import_module('.leaf', package=package_name)",
            'other/require.cjs': "require('./leaf');",
            'other/bare.cjs': "require('leaf');",
            'other/spawn.cjs': "const {spawnSync} = require('node:child_process'); spawnSync('node', ['./contract_test.cjs']);",
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, source in sources.items():
                path = root / 'tests' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            found = consumers(root)
        expected = {name for name in sources if name.startswith('pkg/') and name not in (
            'pkg/key.py', 'pkg/not_loader.py', 'pkg/other_package.py')}
        expected.update(('other/explicit_package.py', 'other/positional_package.py', 'other/unknown_package.py'))
        self.assertEqual(found, {'tests/' + name for name in expected})

    def test_every_ast_consumer_gets_workflow_inputs(self):
        found = consumers(ROOT)
        print(json.dumps({'consumers': sorted(found), 'missing': missing_consumers(found)}, indent=2))
        self.assertIn('tests/candidate_ci_test.py', found)
        self.assertIn('tests/pacs_split_test.cjs', found)
        self.assertEqual(missing_consumers(found), [])
        for name in found:
            files, trees = recorder.workflow_contract_inputs([str(ROOT / name)], [], ROOT)
            self.assertIn('.github/workflows', trees, name)
            files, trees = recorder.workflow_contract_inputs([], ['tests'], ROOT)
            self.assertIn('.github/workflows', trees, name)

    def test_new_reader_needs_no_registration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'tests/new_workflow_reader.py'
            path.parent.mkdir()
            path.write_text('from tests.ci_workflows import WorkflowCatalog as Catalog\n', encoding='utf-8')
            found = consumers(root)
            self.assertEqual(found, {'tests/new_workflow_reader.py'})
            self.assertEqual(missing_consumers(found), [])
        self.assertEqual(missing_consumers({'tests/candidate_ci_test.py'}, lambda *args: ([], [])),
                         ['tests/candidate_ci_test.py'])

    def test_readers_through_helpers_and_template_paths_are_consumers(self):
        sources = {
            'ci_workflows.py': "WORKFLOWS = '.github/workflows'\n",
            'ci_artifacts.py': 'from ci_workflows import WorkflowCatalog\n\ndef inventory(root):\n    return root\n',
            'measurement_ci.py': 'import ci_artifacts\n\ndef workflow_report():\n    return ci_artifacts\n',
            'uses_inventory.py': 'from ci_artifacts import inventory\nrows = inventory(".")\n',
            'uses_report.py': 'import measurement_ci\nreport = measurement_ci.workflow_report()\n',
            'nested/loads_by_path.py': ("import importlib.util\n"
                                        "spec = importlib.util.spec_from_file_location('m', 'tests/ci_artifacts.py')\n"),
            'imports_by_name.py': "import importlib\nreport = importlib.import_module('measurement_ci')\n",
            'template_reader.cjs': ("const fs = require('node:fs');\nconst root = process.cwd();\n"
                                    "module.exports = () => fs.readdirSync(`${root}/.github/workflows`);\n"),
            'requires_reader.cjs': "const read = require('./template_reader');\nread();\n",
            # Negative: importing a helper that reads nothing, or naming a reader only in prose.
            'plain_helper.py': 'def add(a, b):\n    return a + b\n',
            'uses_plain_helper.py': 'from plain_helper import add\nprint(add(1, 2))\n',
            'prose_only.py': '"""Unlike measurement_ci.py, this reads nothing."""\n# from ci_artifacts import inventory\nx = 1\n',
            'plain_template.cjs': 'const name = "x";\nconsole.log(`${name}/docs`);\n',
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, source in sources.items():
                path = root / 'tests' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding='utf-8')
            found = consumers(root)
        readers = {'ci_workflows.py', 'ci_artifacts.py', 'measurement_ci.py', 'uses_inventory.py', 'uses_report.py',
                   'nested/loads_by_path.py', 'imports_by_name.py', 'template_reader.cjs', 'requires_reader.cjs'}
        self.assertEqual(found, {'tests/' + name for name in readers})
        # A reader found only through the import graph still has to be declared to the recorder.
        self.assertEqual(missing_consumers({'tests/uses_inventory.py', 'tests/nested/loads_by_path.py'}),
                         [])

    def test_reading_propagates_through_any_depth_of_imports(self):
        # A twelve-hop chain whose names do not sort in chain order, crossing Python and JS
        # (a JS file runs a Python file by name and a Python file runs that JS file), with
        # branches and a cycle hanging off it; every importer consumes workflows.
        chain = ['q_hop', 'b_hop', 'x_hop', 'd_hop', 'k_hop', 'a_hop', 'w_hop', 'f_hop']
        sources = {'zz_reader.py': "WORKFLOWS = '.github/workflows'\n"}
        previous = 'zz_reader'
        for name in chain:
            sources[name + '.py'] = f'import {previous}\n'
            previous = name
        sources.update({
            'm_runner.cjs': "const { spawnSync } = require('node:child_process');\n"
                            "spawnSync('python', ['tests/f_hop.py']);\n",
            'c_last.py': "import subprocess\nsubprocess.run(['node', 'tests/m_runner.cjs'])\n",
            'branch_one.py': 'import d_hop\n',
            'branch_two.py': 'from k_hop import *\n',
            'cycle_a.py': 'import cycle_b\nimport c_last\n',
            'cycle_b.py': 'import cycle_a\n',
            # Negatives: a deep chain and a cycle that never reach a reader.
            'plain_0.py': 'x = 1\n',
            'plain_1.py': 'import plain_0\n', 'plain_2.py': 'import plain_1\n', 'plain_3.py': 'import plain_2\n',
            'plain_4.py': 'import plain_3\n', 'plain_5.py': 'import plain_4\n',
            'loop_a.py': 'import loop_b\n', 'loop_b.py': 'import loop_a\nimport plain_5\n',
        })
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tests').mkdir()
            for name, source in sources.items():
                (root / 'tests' / name).write_text(source, encoding='utf-8')
            found = consumers(root)
        readers = ['zz_reader.py', *(name + '.py' for name in chain), 'm_runner.cjs', 'c_last.py',
                   'branch_one.py', 'branch_two.py', 'cycle_a.py', 'cycle_b.py']
        self.assertEqual(found, {'tests/' + name for name in readers})

    def test_dotted_dynamic_imports_ts_import_equals_and_constant_require(self):
        sources = {
            'leaf.py': "p = '.github/workflows'",
            'leaf.cjs': "const p = '.github/workflows';",
            'dynamic.py': "import importlib; m = importlib.import_module('tests.leaf')",
            'builtin.py': "m = __import__('tests.leaf', fromlist=['x'])",
            'equals.ts': "import x = require('./leaf');",
            'indirect.cjs': "const n = './leaf'; require(n);",
            'alias.cjs': "const n = './leaf'; const a = n; require(a);",
            'scoped.cjs': "const n = './plain'; function f() { const n = './leaf'; require(n); }",
            'plain.py': "x = 1",
            'plain.cjs': "module.exports = 1;",
            'negative.py': "import importlib; m = importlib.import_module('tests.plain')",
            'negative.ts': "import x = require('./plain');",
            'negative.cjs': "const n = './plain'; require(n); // require('./leaf')",
            'shadowed.cjs': "const n = './leaf'; function f() { const n = './plain'; require(n); }",
            'unresolved.py': "import importlib; importlib.import_module(name)",
            'unresolved.cjs': "require(process.env.MODULE);",
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'tests').mkdir()
            for name, source in sources.items():
                (root / 'tests' / name).write_text(source, encoding='utf-8')
            found = consumers(root)
        expected = {'leaf.py', 'leaf.cjs', 'dynamic.py', 'builtin.py', 'equals.ts', 'indirect.cjs',
                    'alias.cjs', 'scoped.cjs', 'unresolved.py', 'unresolved.cjs'}
        self.assertEqual(found, {'tests/' + name for name in expected})

    def test_joined_paths_and_recorder_command_spellings(self):
        for source in ("p = Path('.') / '.github/' / 'workflows' / 'candidate.yml'",
                       "p = Path('.') / '.github\\\\' / 'workflows' / 'candidate.yml'"):
            self.assertTrue(python_consumer(source))
        sources = ["const p = path.join('.', '.github/', 'workflows');",
                   "const p = path.join('.', '.github\\\\', 'workflows');",
                   "const p = path.join('.', '.githubish/', 'workflows');",
                   "// path.join('.', '.github/', 'workflows')\nconst p = 'docs';"]
        self.assertEqual(javascript_consumers([{'filename': 'p.cjs', 'source': s} for s in sources]),
                         [True, True, False, False])
        for path in ('${{ github.workspace }}/scripts/record-run.py', './scripts/record-run.py',
                     'python scripts\\record-run.py'):
            py = python_scan("import subprocess; subprocess.run(['python', " + repr(path) + '])')
            js = javascript_scan([{'filename': 'p.cjs', 'source': "spawnSync('python', [" + json.dumps(path) + ']);'}])[0]
            self.assertTrue(any(value.endswith('scripts/record-run.py') for value in py[2]), path)
            self.assertTrue(any(value.endswith('scripts/record-run.py') for value in js['files']), path)
            self.assertFalse(py[0])
            self.assertFalse(js['reads'])

    def test_scanning_guard_records_the_test_corpus(self):
        for name in ('tests/ci_workflow_consumers.cjs', 'tests/ci_workflow_consumers_test.py'):
            with self.subTest(name=name):
                files, trees = recorder.workflow_contract_inputs([name], [], ROOT)
                self.assertIn('tests', trees)
                self.assertIn('.github/workflows', trees)
                self.assertIn('api/package-lock.json', files)
                files, trees = recorder.workflow_contract_inputs([name], ['tests'], ROOT)
                self.assertNotIn('tests', trees)

    def test_python_ast_handles_imports_paths_and_ignores_documentation(self):
        for source in ('import ci_workflows as ci', 'from tests import ci_workflows',
                       "p = ROOT / '.github' / 'workflows'; p.glob('*.yml')",
                       "p = Path('.github/workflows/renamed.yaml'); p.read_bytes()"):
            self.assertTrue(python_consumer(source), source)
        self.assertFalse(python_consumer('# import ci_workflows\n""".github/workflows/example.yml"""\nx = 1'))

    def test_javascript_ast_handles_paths_and_ignores_comments(self):
        sources = ["const p = path.join(root, '.github', 'workflows'); fs.readdirSync(p);",
                   "fs.readFileSync('.github/workflows/new.yaml')",
                   "fs.readdirSync(`${root}/.github/workflows`);",
                   "// fs.readFileSync('.github/workflows/new.yaml')\nconst x = 1;",
                   "console.log(`${root}/docs`);"]
        self.assertEqual(javascript_consumers([{'filename': 'test.cjs', 'source': s} for s in sources]),
                         [True, True, True, False, False])


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--audit':
        print(json.dumps(workflow_step_audit(Path(sys.argv[2]).resolve()), indent=2))
    else:
        unittest.main(verbosity=2)
