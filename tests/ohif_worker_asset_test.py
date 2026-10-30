"""REQ-MG-WORKER-ASSET -> RISK-CODEC-CSP-DRIFT -> TEST-MG-WORKER-ASSET.

The served check consumes the actual pinned viewer, never the proxy test's stub.
The local directory check is also usable on an extracted viewer build.
"""
import argparse
import gzip
import json
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import urljoin
import zlib

ROOT = Path(__file__).resolve().parents[1]


def decoder_worker_paths(config):
    paths = []
    for path, body in re.findall(r'location\s+=\s+(/ohif/[^\s{}]+\.js)\s*\{([^{}]*)\}', config):
        policies = re.findall(r'add_header\s+Content-Security-Policy\s+"([^"]+)"', body)
        if any("'unsafe-eval'" in policy.replace(';', ' ').split() for policy in policies):
            paths.append(path)
    if len(paths) != 1:
        raise AssertionError('expected exactly one decoder worker with the eval exception: ' + repr(paths))
    return paths


def assert_built_assets(viewer_root, config):
    for path in decoder_worker_paths(config):
        asset = viewer_root / path.removeprefix('/ohif/')
        if not asset.is_file() or not asset.stat().st_size:
            raise AssertionError('nginx names a decoder worker absent from the built viewer: ' + str(asset))


LOADER_INIT = 'dicom-image-loader/dist/esm/init.js'


def library_decoder_worker(library):
    """File name of the decode worker the pinned viewer creates, read from libOrthancOHIF.so.

    The plugin embeds the viewer build as gzip members plus a resource name table. The app bundle's
    dicom-image-loader init creates the worker from a webpack chunk id; the bundle's own chunk file map
    names that chunk, and the name must be one of the embedded resources.
    """
    app = None
    for hit in re.finditer(rb'\x1f\x8b\x08', library):
        try:
            text = zlib.decompressobj(31).decompress(library[hit.start():])
        except zlib.error:
            continue
        if LOADER_INIT.encode() in text and b'__webpack_require__.u = ' in text:
            app = text.decode('utf-8')
            break
    if app is None:
        raise AssertionError('pinned viewer app bundle with the dicom-image-loader init is absent')
    init = app[app.index(LOADER_INIT):][:2000]
    created = re.search(r'new Worker\(new URL\(/\* worker import \*/ __webpack_require__\.p \+ __webpack_require__\.u\((\d+)\)', init)
    files = re.search(r'__webpack_require__\.u = \(chunkId\) => \{.*?return "" \+ \((\{[^{}]*\})\[chunkId\] \|\| chunkId\) \+ '
                      r'"\.bundle\." \+ (\{[^{}]*\})\[chunkId\] \+ "\.js";', app, re.S)
    if not created or not files:
        raise AssertionError('pinned viewer no longer creates the decode worker from a named webpack chunk')
    chunk = created.group(1)
    names, hashes = json.loads(files.group(1)), json.loads(files.group(2))
    if chunk not in hashes:
        raise AssertionError('decode worker chunk is missing from the chunk file map: ' + chunk)
    name = names.get(chunk, chunk) + '.bundle.' + hashes[chunk] + '.js'
    if b'\0' + name.encode() + b'\0' not in library:
        raise AssertionError('decode worker is not an embedded viewer resource: ' + name)
    return name


def assert_library_assets(library, config):
    worker = '/ohif/' + library_decoder_worker(library)
    paths = decoder_worker_paths(config)
    if paths != [worker]:
        raise AssertionError('nginx eval exception ' + repr(paths) + ' is not the pinned viewer decode worker ' + worker)
    return worker


def assert_served_assets(test, page):
    config = (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8')
    for path in decoder_worker_paths(config):
        response = page.request.get(urljoin(page.url, path))
        test.assertEqual(response.status, 200, 'worker missing from pinned viewer: ' + path)
        test.assertIn('javascript', response.headers.get('content-type', '').lower(),
                      'a viewer SPA fallback is not a worker asset: ' + path)
        body = response.body().lstrip()
        test.assertTrue(body and not body.startswith(b'<'), 'worker asset is empty or HTML')


class WorkerAssetTest(unittest.TestCase):
    def test_worker_comes_from_the_eval_location_and_must_exist_in_the_build(self):
        config = (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8')
        paths = decoder_worker_paths(config)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(AssertionError, 'absent'):
                assert_built_assets(root, config)
            asset = root / paths[0].removeprefix('/ohif/')
            asset.write_bytes(b'self.onmessage = () => {};')
            assert_built_assets(root, config)
            # A new viewer build's differently named chunk must fail the old nginx policy.
            asset.rename(root / 'different-worker.js')
            with self.assertRaisesRegex(AssertionError, 'absent'):
                assert_built_assets(root, config)

    def test_library_check_follows_the_worker_the_viewer_creates(self):
        config = (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8')
        chunk, digest = re.fullmatch(r'/ohif/(\d+)\.bundle\.([0-9a-f]+)\.js', decoder_worker_paths(config)[0]).groups()

        def library(worker_chunk, file_hash, resource):
            app = ('/* ../node_modules/@cornerstonejs/' + LOADER_INIT + ' */ const workerFn = () => new Worker(new URL('
                   '/* worker import */ __webpack_require__.p + __webpack_require__.u(' + worker_chunk + '), __webpack_require__.b));\n'
                   '__webpack_require__.u = (chunkId) => {\n// return url\nreturn "" + ({"572":"polySeg"}[chunkId] || chunkId) + '
                   '".bundle." + {"' + chunk + '":"' + file_hash + '","572":"abc"}[chunkId] + ".js";\n}')
            return b'ELF\0' + resource.encode() + b'\0\0' + gzip.compress(app.encode())

        name = chunk + '.bundle.' + digest + '.js'
        self.assertEqual(assert_library_assets(library(chunk, digest, name), config), '/ohif/' + name)
        # A viewer pin with another worker chunk or file hash must fail the old nginx exception.
        with self.assertRaisesRegex(AssertionError, 'not the pinned viewer decode worker'):
            assert_library_assets(library(chunk, 'f' * 20, chunk + '.bundle.' + 'f' * 20 + '.js'), config)
        with self.assertRaisesRegex(AssertionError, 'missing from the chunk file map'):
            assert_library_assets(library('9999', digest, name), config)
        with self.assertRaisesRegex(AssertionError, 'not an embedded viewer resource'):
            assert_library_assets(library(chunk, digest, 'other.js'), config)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--viewer-root', type=Path)
    parser.add_argument('--ohif-library', type=Path, help='libOrthancOHIF.so copied from the pinned Orthanc image')
    args, remaining = parser.parse_known_args()
    if args.ohif_library:
        config = (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8')
        print('pinned viewer decode worker', assert_library_assets(args.ohif_library.read_bytes(), config), 'matches nginx')
    elif args.viewer_root:
        assert_built_assets(args.viewer_root, (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8'))
    else:
        unittest.main(argv=[__file__, *remaining], verbosity=2)
