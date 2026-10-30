"""REQ-MG-WORKER-ASSET -> RISK-CODEC-CSP-DRIFT -> TEST-MG-WORKER-ASSET.

The served check consumes the actual pinned viewer, never the proxy test's stub.
The local directory check is also usable on an extracted viewer build.
"""
import argparse
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import urljoin

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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--viewer-root', type=Path)
    args, remaining = parser.parse_known_args()
    if args.viewer_root:
        assert_built_assets(args.viewer_root, (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8'))
    else:
        unittest.main(argv=[__file__, *remaining], verbosity=2)
