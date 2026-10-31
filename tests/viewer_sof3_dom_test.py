# coding: utf-8
"""REQ-MG-SOF3-DECODE -> RISK-MG-SOF3-PIXEL, RISK-MG-SOF3-FALLBACK -> TEST-MG-SOF3-EQUALITY, TEST-MG-SOF3-FALLBACK.

The shipped image-load-status extension, the SOF3 pool, the classic decode worker and kin-sof3.wasm run in Chromium
from a synthetic same-origin server. Only the pinned loader's worker manager is a stand-in: it records what it is asked
to decode and returns a frame, so the test sees exactly what the pinned worker would receive. Expected samples are the
encoder input of tests/fixtures/sof3_cases.json (seed formula below; every codestream was decoded equal by GDCM when
the fixture was generated). No timing is asserted.
"""
import base64
import functools
import http.server
import json
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / 'tests/fixtures/sof3_cases.json').read_text(encoding='utf-8'))['cases']
LE = '1.2.840.10008.1.2.1'


def expected(case, seed):
    """The generator's seed formula (scripts/sof3/make_test_cases.py), without numpy."""
    mask, state, out = (1 << case['precision']) - 1, seed, []
    for i in range(case['rows'] * case['columns'] * case['components']):
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        pixel = i // case['components']
        x, y = pixel % case['columns'], pixel // case['columns']
        out.append(((x * 37 + y * 101) * (mask // 512 + 1) + (state >> 26)) & mask)
    out[0], out[1] = mask, 0
    return out


class Quiet(http.server.SimpleHTTPRequestHandler):
    # Worker scripts need a JavaScript MIME type; Python's default map can come from the Windows registry.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def translate_path(self, path):
        # docker-compose mounts worklist-v0 at /worklist, which Orthanc ServeFolders publishes as /worklist/.
        if path.startswith('/worklist/'):
            path = '/worklist-v0/' + path[len('/worklist/'):]
        return super().translate_path(path)

    def log_message(self, *_): pass


class ViewerSof3DecodeDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/?StudyInstanceUIDs=1.2')
        self.page.evaluate("document.body.replaceChildren()")

    def tearDown(self): self.page.close()

    def mount(self):
        for name in ('sof3-decode', 'image-load-status'):
            self.page.add_script_tag(url=f'/config/ohif/{name}.js')
        self.page.evaluate("""() => {
          const element = document.createElement('div'); document.body.append(element);
          window.currentImage = 'wadors:frame-a'; window.images = new Map(); window.calls = [];
          // Stand-in for the pinned worker manager: records the task and answers like decodeLittleEndian would.
          window.workerManager = {executeTask(name, method, task, options) {
            if (this !== workerManager) throw Error('lost worker manager');
            calls.push({name, method, task, options});
            const pixels = task.transferSyntax === '1.2.840.10008.1.2.1'
              ? new Uint16Array(task.pixelData.buffer, task.pixelData.byteOffset, task.pixelData.length / 2) : new Uint16Array(4);
            return Promise.resolve({rows: task.imageFrame.rows, columns: task.imageFrame.columns, pixelData: pixels});
          }};
          window.originalTask = workerManager.executeTask;
          window.cornerstone = {getWebWorkerManager:()=>workerManager, cache:{getImage:id=>images.get(id)},
            Enums:{Events:{IMAGE_LOAD_FAILED:'failed',IMAGE_LOADED:'loaded',STACK_NEW_IMAGE:'stack',VIEWPORT_NEW_IMAGE_SET:'set'}},
            eventTarget:new EventTarget(),getRenderingEngines:()=>[{getViewports:()=>[{element,getCurrentImageId:()=>currentImage}]}]};
          window.messages = [];
          window.ext = kinCreateImageLoadStatus();
          ext.preRegistration({servicesManager:{services:{uiNotificationService:{show:m=>messages.push(m)},
            viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},subscribe:()=>({unsubscribe(){}})}}}});
          ext.onModeEnter();
          const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
          // The pinned loader's consumer contract: a fulfilled decode becomes the image, a rejection is a failed load.
          window.loadFrame = async (imageId, spec) => {
            const task = {transferSyntax: spec.syntax, pixelData: bytes(spec.codestream), decodeConfig: {},
              options: {preScale: {enabled: true}, transferPixelData: true},
              imageFrame: {rows: spec.rows, columns: spec.columns, bitsAllocated: 16, samplesPerPixel: 1, pixelRepresentation: 0}};
            try {
              const frame = await workerManager.executeTask('dicomImageLoader', 'decodeTask', task, {priority: 5});
              images.set(imageId, frame);
              cornerstone.eventTarget.dispatchEvent(new CustomEvent('loaded', {detail: {imageId}}));
              return {ok: true, samples: Array.from(frame.pixelData)};
            } catch (error) {
              cornerstone.eventTarget.dispatchEvent(new CustomEvent('failed', {detail: {imageId, error}}));
              return {ok: false, message: String(error.message)};
            }
          };
        }""")

    def spec(self, case, frame, codestream=None):
        return {'syntax': case['transferSyntax'], 'rows': case['rows'], 'columns': case['columns'],
                'codestream': codestream or frame['codestream']}

    def test_lossless_frames_decode_in_wasm_and_reach_the_pinned_worker_as_little_endian(self):
        self.mount()
        self.assertEqual(self.page.evaluate('kinSof3DecodeState().workers'), 1, 'a decoder is started before the first frame')
        decoded = 0
        for case in [c for c in CASES if c['components'] == 1]:
            for index, frame in enumerate(case['frames']):
                with self.subTest(case=case['name'], frame=index):
                    image = f"wadors:{case['name']}-{index}"
                    result = self.page.evaluate('([image, spec]) => loadFrame(image, spec)', [image, self.spec(case, frame)])
                    self.assertTrue(result['ok'], result)
                    self.assertEqual(result['samples'], expected(case, frame['seed']))
                    call = self.page.evaluate('(() => { const c = calls.at(-1); return {name: c.name, method: c.method, '
                                              'syntax: c.task.transferSyntax, priority: c.options.priority, '
                                              'preScale: c.task.options.preScale.enabled} })()')
                    self.assertEqual(call, {'name': 'dicomImageLoader', 'method': 'decodeTask', 'syntax': LE,
                                            'priority': 5, 'preScale': True})
                    decoded += 1
        self.assertEqual(self.page.evaluate('calls.length'), decoded, 'the pinned worker saw each frame once')
        state = self.page.evaluate('kinSof3DecodeState()')
        self.assertEqual((state['unavailable'], state['routed'], state['fallbacks'], state['rejected']), (None, decoded, 0, 0))
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate('ext.onModeExit()')
        self.assertTrue(self.page.evaluate('workerManager.executeTask === originalTask'))

    def test_truncated_lossless_frame_shows_the_decode_failure_and_never_reaches_the_pinned_decoder(self):
        self.mount()
        case = next(c for c in CASES if c['name'] == 'p16-sv1-2d')
        truncated = base64.b64encode(base64.b64decode(case['frames'][0]['codestream'])[:2000]).decode('ascii')
        result = self.page.evaluate('([spec]) => loadFrame(currentImage, spec)', [self.spec(case, case['frames'][0], truncated)])
        self.assertFalse(result['ok'])
        self.assertIn('decoder rejected the codestream', result['message'])
        self.assertEqual(self.page.evaluate('calls.length + images.size'), 0)
        expect(self.page.get_by_role('alert')).to_have_text(
            '압축 영상 프레임을 해독하지 못했습니다. 원본의 압축 형식과 파일 손상을 관리자에게 확인해 주세요.')
        # The next complete frame of the same image replaces the explanation.
        result = self.page.evaluate('([spec]) => loadFrame(currentImage, spec)', [self.spec(case, case['frames'][0])])
        self.assertTrue(result['ok'])
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate('ext.onModeExit()')

    def test_decoder_that_cannot_load_keeps_the_pinned_path_with_the_original_task(self):
        self.page.route('**/worklist/hpacs-lite/kin-sof3.wasm', lambda route: route.abort())
        self.mount()
        case = next(c for c in CASES if c['name'] == 'p16-sv1-multiframe')
        for index, frame in enumerate(case['frames']):
            result = self.page.evaluate('([image, spec]) => loadFrame(image, spec)', [f'wadors:f{index}', self.spec(case, frame)])
            self.assertTrue(result['ok'], result)
        calls = self.page.evaluate('calls.map(c => ({syntax: c.task.transferSyntax, bytes: btoa(String.fromCharCode(...c.task.pixelData))}))')
        self.assertEqual(calls, [{'syntax': case['transferSyntax'], 'bytes': frame['codestream']} for frame in case['frames']])
        state = self.page.evaluate('kinSof3DecodeState()')
        self.assertTrue(state['unavailable'])
        self.assertEqual((state['routed'], state['rejected'], state['workers']), (0, 0, 0))
        expect(self.page.get_by_role('alert')).to_have_count(0)
        # On this path a scan cut short behind an APP segment carrying FF D9 is refused before the pinned decoder,
        # which would show it as a full frame of wrong samples.
        full = base64.b64decode(case['frames'][0]['codestream'])
        sos = full.index(b'\xff\xda')
        scan = sos + 2 + int.from_bytes(full[sos + 2:sos + 4], 'big')
        app = bytes([0xff, 0xe1, 0x00, 0x04, 0xff, 0xd9])
        cut = base64.b64encode((full[:sos] + app + full[sos:])[:scan + len(app) + 8]).decode('ascii')
        result = self.page.evaluate('([spec]) => loadFrame(currentImage, spec)', [self.spec(case, case['frames'][0], cut)])
        self.assertFalse(result['ok'])
        self.assertEqual(self.page.evaluate('calls.length'), len(case['frames']))
        expect(self.page.get_by_role('alert')).to_contain_text('해독 결과가 비어 있거나 불완전')
        self.page.evaluate('ext.onModeExit()')


if __name__ == '__main__':
    unittest.main()
