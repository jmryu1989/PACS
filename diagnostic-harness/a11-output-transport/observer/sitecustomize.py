"""Never-merged A11 output transport diagnostic harness: interpreter start hook for the one hosted diagnostic run only.

Python imports sitecustomize from PYTHONPATH at start. This file does nothing unless KIN_TRANSPORT_DIAG_DIR is set, which the
harness sets only on the NetLog preflight and on the profile's live step. It installs kin_transport_observer, which observes and
never changes a test's control flow, and then runs the next sitecustomize on sys.path, as the interpreter would have without this
directory in front (on the hosted runner, Ubuntu's own)."""
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

if os.environ.get('KIN_TRANSPORT_DIAG_DIR'):
    try:
        import kin_transport_observer
        kin_transport_observer.install()
    except Exception as error:  # observation never breaks the observed process
        try:
            sys.stderr.write('[kin-transport-observer] not installed: %s: %s\n' % (type(error).__name__, error))
        except Exception:
            pass


def _chain():
    for entry in list(sys.path):
        try:
            folder = os.path.abspath(entry or os.getcwd())
        except Exception:
            continue
        candidate = os.path.join(folder, 'sitecustomize.py')
        if folder == _HERE or not os.path.isfile(candidate):
            continue
        spec = importlib.util.spec_from_file_location('_kin_chained_sitecustomize', candidate)
        module = importlib.util.module_from_spec(spec)
        sys.modules['_kin_chained_sitecustomize'] = module
        spec.loader.exec_module(module)
        return candidate
    return None


try:
    CHAINED = _chain()
except Exception:
    CHAINED = None
