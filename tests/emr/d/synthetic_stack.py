"""C2 custody for the disposable CI stack; never enables signing in a product build.

The stack uses the deployment's own custody overlay (emr/deploy/docker-compose.signing.yml: the #218 wrapping ID
c2-wrap-v1 at /run/secrets/emr-signing-wrap-v1) with a fresh synthetic 32-byte file, so CI exercises the setting a
site installs rather than a private copy of it.
"""
from pathlib import Path
import secrets
import tempfile

OVERLAY = Path('emr/deploy/docker-compose.signing.yml')


def configure(root, env):
    """Write the wrapping key and point the deployment overlay at it; mark the suites' environment.

    The overlay is handed to the stack owner's own Compose commands through compose_arguments(), not through
    COMPOSE_FILE: the suites address the running stack by COMPOSE_PROJECT_NAME alone, and the e2e local-target
    guard admits only the repository's docker-compose.yml when COMPOSE_FILE is set.
    """
    custody = tempfile.TemporaryDirectory(prefix='kin-d-signing-')
    secret = Path(custody.name) / 'emr-signing-wrap-v1'
    secret.write_bytes(secrets.token_bytes(32))
    env['KIN_EMR_WRAPPING_SECRET_FILE'] = str(secret)
    env['KIN_D_SYNTHETIC_SIGNING'] = '1'
    return custody


def compose_arguments(root, custody):
    """The owner's -f list: the repository file first (it fixes the project directory), then the overlay."""
    return ['-f', str(root / 'docker-compose.yml'), '-f', str(root / OVERLAY)]
