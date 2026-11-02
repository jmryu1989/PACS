"""CD-02: fixed declarations -> inventory, originals, source notice, deterministic output.

Byte comparison is limited to the explicitly required reproducibility contract.
"""
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location('notices', Path(__file__).with_name('build-open-source-notices.py'))
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)


class Headings(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.values = []
        self.current = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in ('h1', 'h2', 'h3'):
            self.current = ''

    def handle_data(self, data):
        if self.current is not None:
            self.current += data

    def handle_endtag(self, tag):
        if tag in ('h1', 'h2', 'h3') and self.current is not None:
            self.values.append(self.current)
            self.current = None


class OpenSourceNoticesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = []
        self.write('api/package-lock.json', json.dumps({'packages': {
            '': {'name': 'app'}, 'node_modules/example': {'version': '1.2.3', 'license': 'MIT'},
            'node_modules/tool': {'version': '4.0.0', 'license': 'Apache-2.0', 'dev': True}}}))
        self.write('gateway/agent/requirements.txt', 'requests==2.32.5\n')
        self.write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16-alpine@sha256:abc\n')
        self.write('api/Dockerfile', 'FROM node:22-slim AS base\nFROM base AS production\n')

    def write(self, path, body):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body.encode('utf-8'))
        if path not in self.files:
            self.files.append(path)

    def collect(self, **kwargs):
        return notices.collect(self.root, files=self.files, **kwargs)

    def test_declarations_and_html_sections(self):
        result = self.collect()
        rows = result['components']
        self.assertEqual([(r['name'], r['version'], r['scope']) for r in rows if r['section'] == 'API'],
                         [('example', '1.2.3', 'Runtime'), ('tool', '4.0.0', 'Development')])
        self.assertEqual([(r['name'], r['version']) for r in rows if r['section'] == 'Gateway' and r['scope'] == 'Declared dependency'], [('requests', '2.32.5')])
        self.assertEqual({r['name'] for r in rows if r['section'] == 'Containers' and 'image_name' in r}, {'postgres:16-alpine@sha256:abc', 'node:22-slim'})
        self.assertEqual(next(r['digest'] for r in rows if r['name'].startswith('postgres:')), 'sha256:abc')
        html = notices.render(result).decode()
        for title in notices.SECTIONS:
            self.assertIn(title, Headings(html).values)
        self.assertIn('원문 미확보', html)
        self.assertFalse(result['complete'])

    def test_original_and_notice_are_linked_and_version_change_loses_them(self):
        text = 'Copyright Example\nPermission is hereby granted...\n'
        self.write('worklist-v0/legal/licenses/example-LICENSE.txt', text)
        self.write('worklist-v0/legal/licenses/example-NOTICE.txt', 'Example attribution\n')
        originals = [dict(name=name, path='example-' + name + '.txt', sha256=hashlib.sha256(body.encode()).hexdigest())
                     for name, body in [('LICENSE', text), ('NOTICE', 'Example attribution\n')]]
        self.write('worklist-v0/legal/licenses/catalog.json', json.dumps({'components': {'example@1.2.3': {'files': originals}}}))
        row = next(r for r in self.collect()['components'] if r['name'] == 'example')
        self.assertEqual(row['missing'], [])
        self.assertEqual({f['name'] for f in row['originals']}, {'LICENSE', 'NOTICE'})
        self.assertIn('licenses/example-NOTICE.txt', notices.render(self.collect()).decode())
        self.write('api/package-lock.json', json.dumps({'packages': {'node_modules/example': {'version': '2.0.0'}}}))
        self.assertTrue(next(r for r in self.collect()['components'] if r['name'] == 'example')['missing'])

    def test_missing_empty_or_changed_original_is_not_complete(self):
        self.write('worklist-v0/legal/licenses/catalog.json', json.dumps({'components': {
            'example@1.2.3': {'files': [dict(name='LICENSE',path='LICENSE.txt',sha256='wrong')]}}}))
        for body in (None, '', 'changed'):
            if body is not None:
                self.write('worklist-v0/legal/licenses/LICENSE.txt', body)
            row = next(r for r in self.collect()['components'] if r['name'] == 'example')
            self.assertTrue(row['missing'])
            self.assertEqual(row['originals'], [])

    def test_original_provenance_explanation_is_visible(self):
        note = 'SPDX license text, package ships no file; <example>'
        self.write('worklist-v0/legal/licenses/catalog.json', json.dumps({'components': {
            'example@1.2.3': {'files': [], 'notes': [note]}}}))
        row = next(r for r in self.collect()['components'] if r['name'] == 'example')
        self.assertEqual(row.get('notes'), [note])
        self.assertIn('SPDX license text, package ships no file; &lt;example&gt;',
                      notices.render(self.collect()).decode())

    def test_source_forms_and_local_patch_detection(self):
        self.assertEqual(self.collect()['source_offer'], 'link')
        self.assertEqual(self.collect()['modification']['statement'], 'Halo 수정 없음')
        written = self.collect(source_offer='written')
        self.assertIn('서면 제공 문안', notices.render(written).decode())
        self.assertFalse(written['complete'])
        self.write('vendor/fix.patch', '--- a/orthanc/Sources/Server.cpp\n+++ b/orthanc/Sources/Server.cpp\n')
        result = self.collect()
        self.assertIn('vendor/fix.patch', result['modification']['patches'])
        self.assertNotEqual(result['modification']['statement'], 'Halo 수정 없음')

    def test_pinned_ohif_metadata_and_upstream_tags(self):
        self.write('viewer/ohif/third-party-licenses.json', json.dumps({'components': [{'name':'@ohif/core', 'version':'3.9.0', 'license':'MIT'}]}))
        self.write('docker-compose.yml', 'services:\n  orthanc:\n    image: orthancteam/orthanc:24.12.0\n')
        self.write('worklist-v0/legal/licenses/orthanc-build-matrix-24.12.0.json', json.dumps({'components': [
            {'name':'Orthanc','tag':'Orthanc-1.12.5','source':'https://orthanc.uclouvain.be/hg/orthanc/rev/Orthanc-1.12.5'}]}))
        rows = self.collect()['components']
        self.assertEqual([(r['name'],r['version']) for r in rows if r['section']=='OHIF'], [('@ohif/core','3.9.0')])
        self.assertEqual(next(r['source_tag'] for r in rows if r['section']=='Orthanc'), 'Orthanc-1.12.5')
        self.write('docker-compose.yml', 'services:\n  orthanc:\n    image: orthancteam/orthanc:25.1.0\n')
        self.assertTrue(next(r['missing'] for r in self.collect()['components'] if r['section']=='Orthanc'))

    def test_asr_preserves_engine_commit_and_model_identity(self):
        pins = dict(engine_name='whisper.cpp', engine_tag='v1.9.4', engine_commit='engine-commit',
                    engine_tag_object='tag-object', model_file='ggml-small.bin',
                    model_revision='model-commit', model_repo='ggerganov/whisper.cpp', model_sha256='model-digest')
        self.write('scripts/asr_engine_attest.py', 'PINS = ' + repr(pins))
        rows = [r for r in self.collect()['components'] if r['section']=='ASR']
        self.assertEqual({r['name'] for r in rows}, {'whisper.cpp', 'ggml-small.bin'})
        self.assertEqual(next(r['commit'] for r in rows if r['name']=='whisper.cpp'), 'engine-commit')
        self.assertEqual(next(r['sha256'] for r in rows if r['name']=='ggml-small.bin'), 'model-digest')

    def test_reproducibility_and_input_changes(self):
        first = self.collect()
        second = self.collect()
        self.assertEqual(notices.json_bytes(first), notices.json_bytes(second))
        self.assertEqual(notices.render(first), notices.render(second))
        self.write('docker-compose.yml', 'services:\n  db:\n    image: postgres:17-alpine\n')
        self.assertNotEqual(first['inputs'], self.collect()['inputs'])
        self.assertIn('postgres:17-alpine', notices.render(self.collect()).decode())

    def test_compose_override_and_checkout_line_endings(self):
        self.write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    ports: !override []\n    environment: !reset {}\n')
        before = self.collect()
        for path in self.files:
            target = self.root / path
            target.write_bytes(target.read_bytes().replace(b'\n', b'\r\n'))
        self.assertEqual(notices.json_bytes(before), notices.json_bytes(self.collect()))

    def test_runtime_image_override_is_not_reported_as_a_literal_pin(self):
        reference = '${DATABASE_IMAGE:-postgres:16-alpine}'
        self.write('docker-compose.yml', 'services:\n  api:\n    image: ' + reference + '\n')
        row = next(r for r in self.collect()['components'] if r['name']==reference)
        self.assertTrue(row['unresolved_interpolation'])
        self.assertIsNone(row['image_name'])
        self.assertIsNone(row['image_tag'])

    def test_own_test_image_is_excluded_from_third_party_catalogue(self):
        self.write('docker-compose.yml', 'services:\n  api:\n    image: ${KIN_TEST_API_IMAGE:-kin-api:c1-candidate}\n  db:\n    image: postgres:16-alpine\n')
        rows = [r['name'] for r in self.collect()['components'] if r['section'] == 'Containers' and 'image_name' in r]
        self.assertEqual(rows, ['node:22-slim', 'postgres:16-alpine'])

    def test_generator_twice_and_check_rejects_changed_inputs(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True, timeout=30)
        args = ['--root', str(self.root)]
        self.assertEqual(notices.main(args), 0)
        outputs = [self.root / notices.LEGAL / 'open-source-notices.html',
                   self.root / notices.LEGAL / 'licenses/components.json']
        first = [p.read_bytes() for p in outputs]
        self.assertEqual(notices.main(args), 0)
        self.assertEqual(first, [p.read_bytes() for p in outputs])

        self.assertEqual(notices.main(args + ['--check']), 0)
        self.assertEqual(notices.main(args + ['--check', '--require-complete']), 1)
        self.write('docker-compose.yml', 'services:\n  db:\n    image: postgres:17-alpine\n')
        self.assertEqual(notices.main(args + ['--check']), 1)
        self.assertEqual(first, [p.read_bytes() for p in outputs])

    def test_nested_compose_image_is_hashed_and_tag_change_requires_regeneration(self):
        self.write('gateway/docker-compose.yml', 'services:\n  gateway:\n    image: orthancteam/orthanc:24.12.0\n')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True, timeout=30)
        result = self.collect()
        self.assertIn('gateway/docker-compose.yml', result['inputs'])
        row = next(r for r in result['components'] if r['name'] == 'orthancteam/orthanc:24.12.0')
        self.assertIn('gateway/docker-compose.yml:gateway', row['origin'])
        args = ['--root', str(self.root)]
        self.assertEqual(notices.main(args), 0)
        self.write('gateway/docker-compose.yml', 'services:\n  gateway:\n    image: orthancteam/orthanc:25.1.0\n')
        self.assertEqual(notices.main(args + ['--check']), 1)

    def test_scratch_files_do_not_change_the_inventory(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True, timeout=30)
        before = notices.collect(self.root)
        self.write('tmp/scratch/Dockerfile', 'FROM scratch-image:123\n')
        self.write('tmp/scratch/orthanc.patch', 'change orthanc\n')
        self.assertEqual(notices.json_bytes(before), notices.json_bytes(notices.collect(self.root)))

    def test_gateway_requires_matching_full_resolution_provenance(self):
        def unresolved():
            return [r for r in self.collect()['components'] if r.get('scope') == 'Unresolved transitive dependencies']
        self.assertTrue(unresolved()[0]['missing'])
        path = 'gateway/agent/requirements.txt'
        proof = '{"resolver": "fixture"}\n'
        self.write('worklist-v0/legal/licenses/resolution.json', proof)
        record = dict(sha256=hashlib.sha256((self.root / path).read_bytes()).hexdigest(),
                      packages=[['requests', '2.32.5']], provenance='resolution.json',
                      provenance_sha256=hashlib.sha256(proof.encode()).hexdigest())
        self.write('worklist-v0/legal/licenses/catalog.json', json.dumps({'requirement_resolutions': {path: record}}))
        self.assertEqual(unresolved(), [])
        self.write(path, 'requests==2.32.6\n')
        self.assertTrue(unresolved()[0]['missing'])

    def test_distribution_packages_remain_counted_until_inventoried(self):
        rows = self.collect()['components']
        images = [r for r in rows if 'image_name' in r]
        gaps = [r for r in rows if r.get('scope') == 'Unresolved image package inventory']
        self.assertEqual({r['version'] for r in images}, {r['version'] for r in gaps})
        self.assertTrue(all(r['missing'] for r in gaps))


if __name__ == '__main__':
    unittest.main()
