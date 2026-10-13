"""REQ-EMR-07 -> RISK-EMR-ORIGINAL-FIXTURE: owned cleanup includes built images.

Pure Docker boundary model; no HTTP, containers, credentials or live fixture are started.
The resource model implements Compose removal semantics, then checks actual remaining
resources and restored environment. This makes the N09 omission a test-body assertion,
rather than relying only on unittest's class-cleanup error classification.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from owned_auth_http_stack import OwnedAuthStack, LABEL


class ResourceModel:
    def __init__(self, project, refuse_down=False):
        self.project = project
        self.refuse_down = refuse_down
        self.resources = {kind: {project: [kind + '-owned'], 'foreign': [kind + '-foreign']}
                          for kind in ('containers', 'volumes', 'networks', 'images')}

    def run(self, argv, **_kwargs):
        if argv[:2] == ['docker', 'compose']:
            project = os.environ['COMPOSE_PROJECT_NAME']
            if argv[2] == 'logs':
                return subprocess.CompletedProcess(argv, 0, b'synthetic service metadata\n', b'')
            if argv[2] == 'down':
                if self.refuse_down:
                    return subprocess.CompletedProcess(argv, 1, b'', b'synthetic engine refusal\n')
                self.resources['containers'][project] = []
                self.resources['networks'][project] = []
                if '--volumes' in argv or '-v' in argv:
                    self.resources['volumes'][project] = []
                removal = next((a.split('=', 1)[1] for a in argv if a.startswith('--rmi=')), None)
                if '--rmi' in argv:
                    removal = argv[argv.index('--rmi') + 1]
                if removal in ('local', 'all'):
                    self.resources['images'][project] = []
                return subprocess.CompletedProcess(argv, 0, b'', b'')
        kind = {'ps': 'containers', 'volume': 'volumes', 'network': 'networks', 'image': 'images'}.get(argv[1])
        if kind and '--filter' in argv:
            selector = argv[argv.index('--filter') + 1]
            if selector == 'label=' + LABEL + '=' + self.project or selector == 'reference=' + self.project + '-*':
                output = '\n'.join(self.resources[kind][self.project]).encode()
                return subprocess.CompletedProcess(argv, 0, output, b'')
        raise AssertionError('unmodelled external resource operation')


class OwnedFixtureCleanupTests(unittest.TestCase):
    def exercise(self, refuse_down=False):
        project = 'kin-emrb-auth-123456789abc'
        model = ResourceModel(project, refuse_down)
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'foreign'}):
            # Avoid start(): this pure test only owns the model's generated resources.
            fixture = object.__new__(OwnedAuthStack)
            fixture.project, fixture.out = project, Path(folder)
            fixture.values, fixture.previous, fixture.started = {}, {'COMPOSE_PROJECT_NAME': 'foreign'}, True
            os.environ['COMPOSE_PROJECT_NAME'] = project
            with patch('owned_auth_http_stack.subprocess.run', side_effect=model.run):
                if refuse_down:
                    with self.assertRaises(RuntimeError):
                        fixture.close()
                else:
                    try:
                        fixture.close()
                    except Exception as error:
                        self.fail('normal owned cleanup did not complete: ' + type(error).__name__)
            self.assertEqual(os.environ['COMPOSE_PROJECT_NAME'], 'foreign')
            for kind, owners in model.resources.items():
                self.assertEqual(owners['foreign'], [kind + '-foreign'], 'foreign resources remain untouched')
                self.assertEqual(owners[project], [kind + '-owned'] if refuse_down else [],
                                 'cleanup must remove every owned resource or propagate the refusal')

    def test_cleanup_removes_all_owned_resources_including_images(self):
        self.exercise()

    def test_engine_refusal_propagates_and_restores_selection(self):
        self.exercise(refuse_down=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
