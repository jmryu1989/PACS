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


def python_consumer(source):
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant):
                docstrings.add(id(node.body[0].value))
    values = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any('ci_workflows' in item.name.split('.') for item in node.names):
                return True
        if isinstance(node, ast.ImportFrom):
            if 'ci_workflows' in (node.module or '').split('.') or any(item.name == 'ci_workflows' for item in node.names):
                return True
        if isinstance(node, ast.Constant) and id(node) not in docstrings and isinstance(node.value, str):
            values.append(node.value.replace('\\', '/'))
    return (any('.github/workflows' in value or value == 'ci_workflows' for value in values)
            or ('.github' in values and 'workflows' in values))


def javascript_consumers(rows):
    return json.loads(subprocess.check_output(
        ['node', str(ROOT / 'tests/ci_workflow_consumers.cjs')],
        input=json.dumps(rows), text=True, encoding='utf-8'))


def consumers(root):
    found, javascript = set(), []
    for path in sorted((root / 'tests').rglob('*')):
        if not path.is_file() or path.suffix not in ('.py', '.js', '.cjs', '.mjs', '.ts'):
            continue
        source = path.read_text(encoding='utf-8-sig')
        name = path.relative_to(root).as_posix()
        if path.suffix == '.py':
            if python_consumer(source):
                found.add(name)
        else:
            javascript.append({'filename': name, 'source': source})
    found.update(row['filename'] for row, reads in zip(javascript, javascript_consumers(javascript)) if reads)
    return found


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
                   "// fs.readFileSync('.github/workflows/new.yaml')\nconst x = 1;"]
        self.assertEqual(javascript_consumers([{'filename': 'test.cjs', 'source': s} for s in sources]),
                         [True, True, False])


if __name__ == '__main__':
    unittest.main(verbosity=2)
