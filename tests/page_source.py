"""Python adapter for the single page-source implementation in page_source.cjs.

The legacy page view retains markup and reconstructs only the moved inline block.
Historical git blobs are deliberately not routed through this helper.
"""
import json
from pathlib import Path
import subprocess

_HELPER = Path(__file__).with_suffix('.cjs')


def read_page_bytes(path):
    return subprocess.check_output(['node', str(_HELPER), 'source', str(path)])


def read_page_source(path):
    return read_page_bytes(path).decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')


def read_source(path):
    path = Path(path)
    return read_page_source(path) if path.suffix.lower() == '.html' else path.read_text(encoding='utf-8')


def moved_files(path):
    return tuple(Path(p) for p in json.loads(subprocess.check_output(
        ['node', str(_HELPER), 'files', str(path)], text=True, encoding='utf-8')))


def include_moved_files(files, root):
    """Extend an existing served-input allowlist; keep every existing entry and its order."""
    root = Path(root).resolve()
    added = [p.relative_to(root).as_posix() for p in moved_files(root/'worklist-v0/hpacs-lite/main.html')]
    return tuple(dict.fromkeys([*files, *added]))
