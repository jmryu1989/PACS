"""REQ-W2C-05 -> RISK-CI-UNHASHED-INPUT -> AST audit plus omission mutation.

Conservatively include executable workflow-path literals (including declarations
passed through variables). Comments and docstrings are not dependency evidence.
JS/TS uses the repository's TypeScript parser, not a replacement syntax parser.
"""
import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recorder', ROOT / 'scripts/record-run.py')
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)


def python_scan(source):
    """(reads workflows itself, imported module names, file names named in code)."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant):
                docstrings.add(id(node.body[0].value))
    values, modules, reads = [], set(), False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(part for item in node.names for part in item.name.split('.'))
            if any('ci_workflows' in item.name.split('.') for item in node.names):
                reads = True
        if isinstance(node, ast.ImportFrom):
            modules.update((node.module or '').split('.'))
            modules.update(item.name for item in node.names)
            if 'ci_workflows' in (node.module or '').split('.') or any(item.name == 'ci_workflows' for item in node.names):
                reads = True
        if isinstance(node, ast.Constant) and id(node) not in docstrings and isinstance(node.value, str):
            values.append(node.value.replace('\\', '/'))
        if isinstance(node, ast.Call) and (
                isinstance(node.func, ast.Name) and node.func.id == '__import__'
                or isinstance(node.func, ast.Attribute) and node.func.attr == 'import_module'):
            if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                modules.update(node.args[0].value.split('.'))
            else:
                reads = True  # Unknown dynamic module: conservatively record the workflows.
    values = [value.rstrip('/') for value in values]
    reads = (reads or any('.github/workflows' in value or value == 'ci_workflows' for value in values)
            or ('.github' in values and 'workflows' in values))
    # importlib/runpy/subprocess name a module by string; plain names count like imports.
    modules.update(value for value in values if value.isidentifier())
    files = {part for value in values for part in value.replace('/', ' ').split() if '.' in part}
    return reads, modules, files


def python_consumer(source):
    return python_scan(source)[0]


def javascript_scan(rows):
    return json.loads(subprocess.check_output(
        ['node', str(ROOT / 'tests/ci_workflow_consumers.cjs')],
        input=json.dumps(rows), text=True, encoding='utf-8'))


def javascript_consumers(rows):
    return [row['reads'] for row in javascript_scan(rows)]


def consumers(root):
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
            scans[name] = python_scan(source)
        else:
            javascript.append({'filename': name, 'source': source})
    for row, result in zip(javascript, javascript_scan(javascript) if javascript else []):
        scans[row['filename']] = (result['reads'], set(result['modules']), set(result['files']))
    found = {name for name, (reads, _, _) in scans.items() if reads}
    while True:
        stems = {Path(name).stem for name in found}
        files = {Path(name).name for name in found}
        added = {name for name, (_, modules, named) in scans.items()
                 if name not in found and (modules & stems or named & files)}
        if not added:
            return found
        found |= added


def missing_consumers(found, expand=recorder.workflow_contract_inputs):
    return sorted(name for name in found if '.github/workflows' not in expand([name], [], ROOT)[1])


class WorkflowConsumerTests(unittest.TestCase):
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

    def test_missing_new_consumer_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'tests/new_workflow_reader.py'
            path.parent.mkdir()
            path.write_text('from tests.ci_workflows import WorkflowCatalog as Catalog\n', encoding='utf-8')
            found = consumers(root)
            self.assertEqual(found, {'tests/new_workflow_reader.py'})
            self.assertEqual(missing_consumers(found), ['tests/new_workflow_reader.py'])
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
                         ['tests/nested/loads_by_path.py', 'tests/uses_inventory.py'])

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
            py = python_scan('command = ' + repr(path))
            js = javascript_scan([{'filename': 'p.cjs', 'source': 'const command = ' + json.dumps(path)}])[0]
            self.assertIn('record-run.py', py[2], path)
            self.assertIn('record-run.py', js['files'], path)
            self.assertFalse(py[0])
            self.assertFalse(js['reads'])

    def test_scanning_guard_records_the_test_corpus(self):
        for name in ('tests/record_run_test.py', 'tests/ci_workflow_consumers_test.py'):
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
    unittest.main(verbosity=2)
