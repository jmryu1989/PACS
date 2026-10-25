"""C2 custody for the disposable CI stack; never enables signing in a product build."""
import json
from pathlib import Path
import secrets
import tempfile


def configure(root, env):
    """Write the wrapping key and the api override; mark the suites' environment.

    The override is handed to the stack owner's own Compose commands through
    compose_arguments(), not through COMPOSE_FILE: the suites address the running
    stack by COMPOSE_PROJECT_NAME alone, and the e2e local-target guard admits
    only the repository's docker-compose.yml when COMPOSE_FILE is set.
    """
    custody = tempfile.TemporaryDirectory(prefix='kin-d-signing-')
    directory = Path(custody.name)
    (directory / 'wrapping.key').write_bytes(secrets.token_bytes(32))
    (directory / 'compose.json').write_text(json.dumps({'services': {'api': {
        'environment': {'KIN_EMR_WRAPPING_KEY_ID': 'synthetic',
                        'KIN_EMR_WRAPPING_KEY_FILES': json.dumps({'synthetic': '/run/kin-signing/wrapping.key'})},
        'volumes': [str(directory / 'wrapping.key') + ':/run/kin-signing/wrapping.key:ro'],
    }}}), encoding='utf-8')
    env['KIN_D_SYNTHETIC_SIGNING'] = '1'
    return custody


def compose_arguments(root, custody):
    """The owner's -f list: the repository file first (it fixes the project directory), then the override."""
    return ['-f', str(root / 'docker-compose.yml'), '-f', str(Path(custody.name) / 'compose.json')]
