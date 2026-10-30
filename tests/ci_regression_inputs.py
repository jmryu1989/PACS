"""Derive PR regression inputs from recorder declarations, pages and test imports.

The selector stays stdlib-only on a fresh runner. Its checked-in path manifest is
verified against this derivation using the existing Python/TypeScript AST audit.
"""
from html.parser import HTMLParser
import json
import posixpath
from pathlib import PurePosixPath
import re
import shlex
from urllib.parse import urlsplit


def local_script(importer, src):
    url = urlsplit(src)
    if url.scheme or url.netloc:
        return None
    if url.path.startswith('/worklist/'):
        return 'worklist-v0/' + url.path.removeprefix('/worklist/')
    if url.path.startswith('/'):
        return None
    return posixpath.normpath(str(PurePosixPath(importer).parent / url.path))


def page_scripts(root, page):
    scripts = set()

    class Scripts(HTMLParser):
        def handle_starttag(self, tag, attrs):
            src = dict(attrs).get('src') if tag == 'script' else None
            if not src:
                return
            path = local_script(page, src)
            if path:
                scripts.add(path)

    Scripts().feed((root / page).read_text(encoding='utf-8'))
    manifest_path = 'scripts/main-split-order.json'
    manifest = json.loads((root / manifest_path).read_text(encoding='utf-8'))
    if manifest['artifact'] in scripts:
        scripts.update((manifest_path, 'scripts/build-main-split-bundle.py'))
        scripts.update((PurePosixPath(page).parent / row['file']).as_posix() for row in manifest['sources'])
    return scripts


def expand_scripts(root, scripts, graph):
    from ci_workflow_consumers_test import javascript_scan

    required, pending = set(scripts), set(scripts)
    while pending:
        rows = [{'filename': name, 'source': (root / name).read_text(encoding='utf-8')}
                for name in sorted(pending) if name.endswith(('.js', '.cjs', '.mjs'))
                and name not in graph and (root / name).is_file()]
        for row, scanned in zip(rows, javascript_scan(rows) if rows else []):
            graph[row['filename']] = {path for src in scanned['scriptPaths']
                                      if (path := local_script(row['filename'], src)) and (root / path).is_file()}
        following = set().union(*(graph.get(name, set()) for name in pending)) - required
        required.update(following)
        pending = following
    return required


def regression_inputs(root, catalog, suites):
    from ci_workflow_consumers_test import consumers

    graph = {}
    consumers(root, audit=graph)
    config = json.loads((root / 'scripts/ci-paths.json').read_text(encoding='utf-8'))
    script_graph = {}
    pages = {page.relative_to(root).as_posix(): expand_scripts(root, page_scripts(root, page.relative_to(root).as_posix()), script_graph)
             for page in (root / 'worklist-v0/hpacs-lite').glob('*.html')}
    result = {}
    for owner, commands in suites.items():
        required = set(commands)
        for step in catalog.job(owner)['steps']:
            words = shlex.split(re.sub(r'\$\{\{[^}]+\}\}', 'EXPRESSION', step.get('run', '')), comments=True)
            required.update(words[i + 1] for i, word in enumerate(words[:-1]) if word == '--file'
                            and '$' not in words[i + 1] and 'node_modules/' not in words[i + 1])
        pending = list(required)
        while pending:
            for dependency in graph['edges'].get(pending.pop(), []):
                if dependency not in required:
                    required.add(dependency)
                    pending.append(dependency)
        for page, scripts in pages.items():
            if page in required or page in config['jobs'][owner]:
                required.update(scripts)
        result[owner] = required
    return result
