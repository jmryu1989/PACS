"""C2 custody for the disposable CI stack; never enables signing in a product build."""
import json
from pathlib import Path
import secrets
import tempfile


def configure(root, env):
    custody = tempfile.TemporaryDirectory(prefix='kin-d-signing-')
    directory = Path(custody.name)
    (directory / 'wrapping.key').write_bytes(secrets.token_bytes(32))
    override = directory / 'compose.json'
    override.write_text(json.dumps({'services': {'api': {
        'environment': {'KIN_EMR_WRAPPING_KEY_ID': 'synthetic',
                        'KIN_EMR_WRAPPING_KEY_FILES': json.dumps({'synthetic': '/run/kin-signing/wrapping.key'})},
        'volumes': [str(directory / 'wrapping.key') + ':/run/kin-signing/wrapping.key:ro'],
    }}}), encoding='utf-8')
    import os
    env['COMPOSE_FILE'] = os.pathsep.join([str(root / 'docker-compose.yml'), str(override)])
    env['KIN_D_SYNTHETIC_SIGNING'] = '1'
    return custody
