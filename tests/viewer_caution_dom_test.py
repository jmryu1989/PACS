# coding: utf-8
"""C09/M17: shipped extensions at their browser/service boundary on a synthetic HTTP origin."""
import functools
import http.server
import json
import os
import re
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
class ViewerCautionDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def setUp(self):
        self.page = self.browser.new_page(); self.page.goto(f'http://127.0.0.1:{self.server.server_port}/?StudyInstanceUIDs=1.2')
        self.page.evaluate("document.body.replaceChildren(); document.body.innerHTML='<p id=kin-viewer-layout-status></p>'")
    def tearDown(self): self.page.close()
    def script(self, name): self.page.add_script_tag(url=f'/config/ohif/{name}.js')
    def test_product_csp_allows_eval_only_in_the_decoder_worker(self):
        policies = re.findall(r'add_header Content-Security-Policy "([^"]+)" always;',
                              (ROOT / 'proxy/nginx.conf.template').read_text(encoding='utf-8'))
        page_policies = [p for p in policies if "'unsafe-eval'" not in p.replace(';', ' ').split()]
        self.assertEqual(len(page_policies), 1, 'one page policy without JavaScript eval')
        policy = page_policies[0]
        worker_policy = next(p for p in policies if "'unsafe-eval'" in p.replace(';', ' ').split())
        directives = {parts[0]: parts[1:] for directive in policy.split(';') if (parts := directive.split())}
        self.assertIn("'wasm-unsafe-eval'", directives['script-src'])
        for name, sources in directives.items():
            self.assertNotIn("'unsafe-eval'", sources)
            if name != 'script-src':
                self.assertNotIn("'wasm-unsafe-eval'", sources)
        # The real nginx response/path contract is covered by proxy_image_route_test.py. Here the browser
        # enforces those policies on served scripts; Playwright's evaluate bypasses CSP and cannot prove it.
        worker_path = '/ohif/1927.bundle.497fe7ce9f85fada0cc8.js'
        probe = """async function probe() {
          const result = {};
          try {
            const {instance} = await WebAssembly.instantiate(new Uint8Array([
              0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
              7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]));
            result.wasm = instance.exports.answer();
          } catch(error) { result.wasmError = error.message; }
          try { result.eval = eval('6 * 7'); } catch(error) { result.evalBlocked = error.name; }
          try { result.dynamic = new Function('return 42')(); } catch(error) { result.dynamicBlocked = error.name; }
          return result;
        }
        """
        worker_script = probe + 'probe().then(result => postMessage(result));'
        page_script = probe + 'const decoderPath = ' + json.dumps(worker_path) + ';' + """
          function runWorker(url) { return new Promise((resolve, reject) => {
            const worker = new Worker(url);
            worker.onmessage = e => {worker.terminate(); resolve(e.data)};
            worker.onerror = e => {worker.terminate(); reject(new Error(e.message))};
          }); }
          const blobURL = URL.createObjectURL(new Blob([""" + json.dumps(worker_script) + """], {type:'application/javascript'}));
          window.probeDone = Promise.all([
            probe(), runWorker(decoderPath), runWorker('/csp-worker.js'), runWorker(blobURL)
          ]).finally(() => URL.revokeObjectURL(blobURL));
        """
        fixtures = {
            '/csp-check.html': ('text/html', '<script src="/csp-page.js"></script>'),
            '/csp-page.js': ('application/javascript', page_script),
            '/csp-worker.js': ('application/javascript', worker_script),
            # Like the pinned codec chunk, this import keeps the default response policy; execution
            # belongs to the decoder worker's global, whose entry response grants new Function.
            '/csp-codec.js': ('application/javascript', probe),
            worker_path: ('application/javascript', "importScripts('/csp-codec.js');probe().then(result => postMessage(result));"),
        }
        for path, (mime, body) in fixtures.items():
            response_policy = worker_policy if path == worker_path else policy
            self.page.route('**' + path, lambda route, request, mime=mime, body=body, csp=response_policy: route.fulfill(
                content_type=mime, body=body, headers={'Content-Security-Policy': csp}))
        response = self.page.goto(f'http://127.0.0.1:{self.server.server_port}/csp-check.html')
        self.assertEqual(response.headers['content-security-policy'], policy)
        result = self.page.evaluate('probeDone')
        blocked = {'wasm': 42, 'evalBlocked': 'EvalError', 'dynamicBlocked': 'EvalError'}
        self.assertEqual(result, [blocked, {'wasm': 42, 'eval': 42, 'dynamic': 42}, blocked, blocked])

    def test_empty_decoder_result_is_a_failed_frame_before_cache_and_recovers(self):
        self.script('sof3-decode'); self.script('image-load-status')
        self.page.evaluate("""() => {
          const element = document.createElement('div'); document.body.append(element);
          window.currentImage = 'wadors:frame-a'; window.images = new Map(); window.messages = [];
          window.accepted = []; window.failedImages = []; window.pending = [];
          window.workerManager = {executeTask(...args) {
            if (this !== workerManager) throw Error('lost worker manager');
            window.taskArgs = args;
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
          }};
          window.originalTask = workerManager.executeTask;
          window.cornerstone = {getWebWorkerManager:()=>workerManager, cache:{getImage:id=>images.get(id)},
            Enums:{Events:{IMAGE_LOAD_FAILED:'failed',IMAGE_LOADED:'loaded',STACK_NEW_IMAGE:'stack',VIEWPORT_NEW_IMAGE_SET:'set'}},
            eventTarget:new EventTarget(),getRenderingEngines:()=>[{getViewports:()=>[{element,getCurrentImageId:()=>currentImage}]}]};
          window.ext = kinCreateImageLoadStatus();
          ext.preRegistration({servicesManager:{services:{uiNotificationService:{show:m=>messages.push(m)},
            viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},subscribe:(name,refresh)=>{
              window.refreshGrid=refresh;return {unsubscribe(){}};
            }}}}});
          ext.onModeEnter();
          // Consumer contract: only a fulfilled decode can become an image/cache entry. Rejections retain
          // the caller's image identity and flow through the loader's existing failure event.
          window.loadFrame = async imageId => {
            try {
              const frame = await workerManager.executeTask('dicomImageLoader','decodeTask',
                {imageFrame:{rows:2,columns:2},pixelData:new Uint8Array([1]),options:{}}, {priority:3});
              images.set(imageId,frame);accepted.push(imageId);
              cornerstone.eventTarget.dispatchEvent(new CustomEvent('loaded',{detail:{imageId}}));
              return {ok:true};
            } catch(error) {
              failedImages.push(imageId);
              cornerstone.eventTarget.dispatchEvent(new CustomEvent('failed',{detail:{imageId,error}}));
              window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',
                {reason:error,promise:Promise.resolve(),cancelable:true}));
              return {ok:false};
            }
          };
        }""")
        for frame in ['{rows:0,columns:0,pixelData:new Float32Array()}',
                      '{rows:0,columns:2,pixelData:new Uint16Array(4)}',
                      '{rows:2,columns:0,pixelData:new Uint16Array(4)}',
                      '{rows:2,columns:2,pixelData:new Uint16Array()}',
                      '{rows:2,columns:2}', 'null']:
            with self.subTest(frame=frame):
                result = self.page.evaluate(f"""async()=>{{const load=loadFrame(currentImage);
                  pending.shift().resolve({frame});return await load}}""")
                self.assertEqual(result, {'ok': False})
                self.assertEqual(self.page.evaluate('images.size + accepted.length'), 0)
                expect(self.page.get_by_role('alert')).to_contain_text('해독 결과가 비어 있거나 불완전')
        self.assertIn('해독 결과가 비어 있거나 불완전', self.page.evaluate('messages[0].message'))
        # Complete pixels, including all-zero images, pass by identity. No intensity-based corruption heuristic.
        for pixels in ['new Uint8Array(4)', 'new Int16Array([0,1,-1,2])',
                       'new Float32Array([0,.5,1,2])', 'new Uint8Array(12)', 'new Uint8Array(16)']:
            result = self.page.evaluate(f"""async()=>{{
              const frame={{rows:2,columns:2,pixelData:{pixels}}}; const load=loadFrame(currentImage);
              pending.shift().resolve(frame);const result=await load;
              return {{...result,unchanged:images.get(currentImage)===frame,priority:taskArgs[3].priority}};
            }}""")
            self.assertEqual(result, {'ok': True, 'unchanged': True, 'priority': 3})
            expect(self.page.get_by_role('alert')).to_have_count(0)
        # A bad prefetch does not cover another displayed image or an already successful retry of that image.
        self.page.evaluate("""async()=>{const load=loadFrame('wadors:frame-b');
          pending.shift().resolve({rows:0,columns:0,pixelData:new Float32Array()});await load}""")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("currentImage='wadors:frame-b';refreshGrid()")
        expect(self.page.get_by_role('alert')).to_contain_text('해독 결과가 비어 있거나 불완전')
        self.page.evaluate("""async()=>{currentImage='wadors:frame-a';refreshGrid();
          const load=loadFrame(currentImage);pending.shift().resolve({rows:0,columns:0,pixelData:new Float32Array()});await load}""")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        # Other worker methods/results are untouched; exit restores ownership even after repeated mode entry.
        self.assertTrue(self.page.evaluate("""async()=>{const value={};
          const result=workerManager.executeTask('otherWorker','decodeTask');pending.shift().resolve(value);
          return await result===value}"""))
        self.page.evaluate("ext.onModeExit();ext.onModeEnter();ext.onModeExit()")
        self.assertTrue(self.page.evaluate('workerManager.executeTask===originalTask'))
        self.page.evaluate("ext.onModeEnter();workerManager.executeTask=()=>Promise.resolve('later owner');ext.onModeExit()")
        self.assertEqual(self.page.evaluate('workerManager.executeTask()'), 'later owner')

    def test_jpeg_lossless_stream_cut_short_fails_before_the_decoder(self):
        # The pinned JS lossless decoder answers a stream cut short with a complete all-zero frame, so the
        # check is on the codestream: an all-zero frame from a complete stream still displays.
        self.script('sof3-decode'); self.script('image-load-status')
        self.page.evaluate("""() => {
          const element = document.createElement('div'); document.body.append(element);
          window.currentImage = 'wadors:frame-a'; window.decoded = []; window.messages = [];
          window.workerManager = {executeTask(name, method, task) {
            decoded.push(task.transferSyntax);
            return Promise.resolve({rows:2,columns:2,pixelData:new Uint16Array(4)});
          }};
          window.cornerstone = {getWebWorkerManager:()=>workerManager, cache:{getImage:()=>undefined},
            Enums:{Events:{IMAGE_LOAD_FAILED:'failed',IMAGE_LOADED:'loaded',STACK_NEW_IMAGE:'stack',VIEWPORT_NEW_IMAGE_SET:'set'}},
            eventTarget:new EventTarget(),getRenderingEngines:()=>[{getViewports:()=>[{element,getCurrentImageId:()=>currentImage}]}]};
          window.ext = kinCreateImageLoadStatus();
          ext.preRegistration({servicesManager:{services:{uiNotificationService:{show:m=>messages.push(m)},
            viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},subscribe:()=>({unsubscribe(){}})}}}});
          ext.onModeEnter();
          // 8-bit frames stay on the pinned decoder, as every frame does when the wasm decoder is unavailable.
          window.decode = async (transferSyntax, bytes) => {
            try {
              await workerManager.executeTask('dicomImageLoader','decodeTask',{transferSyntax,pixelData:new Uint8Array(bytes),
                imageFrame:{rows:2,columns:2,bitsAllocated:8,samplesPerPixel:1,pixelRepresentation:0}},{});
              return 'shown';
            } catch(error) {
              cornerstone.eventTarget.dispatchEvent(new CustomEvent('failed',{detail:{imageId:currentImage,error}}));
              return 'failed';
            }
          };
        }""")
        head = [0xff, 0xd8, 0xff, 0xc3, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda]
        cases = [('1.2.840.10008.1.2.4.70', head + [0x12, 0x34], 'failed'),
                 ('1.2.840.10008.1.2.4.57', head + [0xff, 0x00, 0x56], 'failed'),
                 ('1.2.840.10008.1.2.4.70', head + [0x12, 0xff, 0xd9], 'shown'),
                 ('1.2.840.10008.1.2.4.57', head + [0x12, 0xff, 0xd9, 0x00], 'shown'),
                 ('1.2.840.10008.1.2.1', [0x12, 0x34, 0x56, 0x78], 'shown')]
        for syntax, data, outcome in cases:
            with self.subTest(syntax=syntax, tail=data[-3:]):
                before = self.page.evaluate('decoded.length')
                self.assertEqual(self.page.evaluate('([s, b]) => decode(s, b)', [syntax, data]), outcome)
                self.assertEqual(self.page.evaluate('decoded.length') - before, 0 if outcome == 'failed' else 1,
                                 'a stream cut short never reaches the decoder')
                if outcome == 'failed':
                    expect(self.page.get_by_role('alert')).to_contain_text('해독 결과가 비어 있거나 불완전')
        self.page.evaluate('ext.onModeExit()')

    def test_pixel_failure_explanation_follows_the_displayed_image_and_mode(self):
        self.script('sof3-decode'); self.script('image-load-status')
        self.page.evaluate("""() => {
          const element = document.createElement('div'); document.body.append(element);
          window.currentImage = 'image-a';
          const events = {IMAGE_LOAD_FAILED:'failed', IMAGE_LOADED:'loaded', STACK_NEW_IMAGE:'stack', VIEWPORT_NEW_IMAGE_SET:'set'};
          window.loadedImages = new Set();
          window.cornerstone = {cache:{getImage:id => loadedImages.has(id) ? {imageId:id} : undefined},
            Enums:{Events:events}, eventTarget:new EventTarget(), getRenderingEngines:() => [{
            getViewports:() => [{element, getCurrentImageId:() => window.currentImage}]
          }]};
          window.extension = kinCreateImageLoadStatus();
          extension.preRegistration({servicesManager:{services:{viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},
            subscribe:(name, refresh) => {window.refreshGrid=refresh; return {unsubscribe(){}};}}}}});
          extension.onModeEnter();
          window.pixelEvent = (type, imageId, error) => cornerstone.eventTarget.dispatchEvent(new CustomEvent(type,{detail:{imageId,error}}));
        }""")
        self.page.evaluate("pixelEvent('failed','prefetched-image',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        # The served pinned loader reports the first-frame fetch failure as Error(message),
        # with no response/status fields. The served-page test proves the server-reason channel.
        self.page.evaluate("pixelEvent('failed','image-a',new Error(\"Couldn't retrieve image-a got status 404\"))")
        expect(self.page.get_by_role('alert')).to_contain_text('계속되면 관리자에게 문의하세요')
        self.page.evaluate("currentImage='image-b'; refreshGrid()")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("pixelEvent('failed','image-a',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("pixelEvent('failed','image-b',{status:503})")
        expect(self.page.get_by_role('alert')).to_contain_text('HTTP 503')
        self.page.evaluate("loadedImages.add('image-b'); pixelEvent('loaded','image-b'); pixelEvent('failed','image-b',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("currentImage='image-c'; pixelEvent('failed','image-c',{status:404})")
        expect(self.page.get_by_role('alert')).to_be_visible()
        self.page.evaluate("extension.onModeExit(); pixelEvent('failed','image-c',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("extension.onModeEnter(); refreshGrid()")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate('extension.onModeExit()')

    def test_failed_module_can_retry_without_reopening_study(self):
        self.script('tool-retry')
        for source, factory, asset, global_name, member in [
            ('context-loss','kinCreateContextLoss','viewer-context-loss','KinViewerContextLoss','create'),
            ('frame-coverage','kinCreateFrameCoverage','viewer-frame-coverage','KinFrameCoverage','mount'),
            ('images-only','kinCreateImagesOnly','viewer-images-only','KinViewerImagesOnly','create'),
            ('dicom-pdf','kinCreateDicomPdf','viewer-dicom-pdf','KinDicomPdf','create')]:
            self.page.evaluate("window.kinViewerSession={}; window.kinViewerOnEnd=()=>({close(){}}); window.connected=0")
            self.script(source)
            route = f'**/worklist/hpacs-lite/{asset}.js'
            self.page.route(route, lambda request: request.abort())
            self.page.evaluate("([factory])=>{window.ext=window[factory]();window.args={servicesManager:{services:{}}};ext.preRegistration?.(args);ext.onModeEnter(args)}",[factory])
            retry=self.page.get_by_role('button', name='Retry', exact=True); expect(retry).to_be_visible()
            self.page.unroute(route)
            module = f"window.{global_name}={{ {member}:()=>{{window.connected++;return {{start(){{}},mount(){{return true}},stop(){{}}}}}} }}"
            self.page.route(route, lambda request: request.fulfill(content_type='application/javascript',body=module))
            retry.click(); self.page.wait_for_function('window.connected === 1')
            expect(retry).to_have_count(0)
            self.page.evaluate('ext.onModeExit()'); self.page.unroute(route)

    def test_known_image_rejections_are_specific_and_do_not_reach_the_global_boundary(self):
        self.script('sof3-decode'); self.script('image-load-status')
        self.page.evaluate("""() => {
          window.currentImage='wadors:'+location.origin+'/dicom-web/studies/1/series/2/instances/3/frames/1';
          const element=document.createElement('div');document.body.append(element);
          window.cornerstone={cache:{getImage:()=>null},Enums:{Events:{IMAGE_LOAD_FAILED:'failed',IMAGE_LOAD_ERROR:'decode',IMAGE_LOADED:'loaded',STACK_NEW_IMAGE:'stack',VIEWPORT_NEW_IMAGE_SET:'set'}},
            eventTarget:new EventTarget(),getRenderingEngines:()=>[{getViewports:()=>[{element,getCurrentImageId:()=>currentImage}]}]};
          window.messages=[];window.boundaryErrors=[];window.sourceConfig={acceptHeader:['original']};
          window.config={acceptHeader:['multipart/related; type=image/jp2; transfer-syntax=*']};
          window.ext=kinCreateImageLoadStatus();
          ext.preRegistration({extensionManager:{getActiveDataSource:()=>[{getConfig:()=>sourceConfig}]},servicesManager:{services:{
            uiNotificationService:{show:message=>messages.push(message)},viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},subscribe:()=>({unsubscribe(){}})}
          }}});
          // The pinned ui-next boundary subscribes in bubble phase. Known image rejections must be handled before it.
          window.addEventListener('unhandledrejection',e=>boundaryErrors.push(e.reason));
          window.addEventListener('error',e=>boundaryErrors.push(e.error));
          ext.onModeEnter();
          window.fail=(error,type='failed')=>cornerstone.eventTarget.dispatchEvent(new CustomEvent(type,{detail:{imageId:currentImage,error}}));
          window.reject=error=>window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{reason:error,promise:Promise.resolve(),cancelable:true}));
          window.renderError=error=>window.dispatchEvent(new ErrorEvent('error',{error,cancelable:true}));
        }""")
        self.assertEqual(self.page.evaluate('sourceConfig.acceptHeader'), ['multipart/related; type=image/jp2; transfer-syntax=*'])
        for error, expected in [('{status:401}', '로그인'), ('{status:403}', '접근 권한'), ('{status:404}', '프레임이 없습니다'),
                                ("{status:503,response:{code:'IMAGE_DELIVERY_RECORD_UNAVAILABLE',message:'영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다.'}}", '열람 기록'),
                                ('{status:409}', '변경되었습니다'), ('{status:416}', '프레임 번호'), ('{status:503}', '영상 서버'),
                                ('{status:0}', '전송이 끊겼'), ("new Error('CACHE_SIZE_EXCEEDED')", '메모리'),
                                ("new TypeError('Failed to fetch')", '전송이 끊겼'),
                                ("new TypeError('NetworkError when attempting to fetch resource.')", '전송이 끊겼'),
                                ("new TypeError('Load failed')", '전송이 끊겼'),
                                ("new TypeError('Cannot read properties of undefined')", '계속되면 관리자에게 문의하세요'),
                                ("new Error('JPEG 2000 decoder failed')", '압축 영상'), ("'JPEG-LS decoder failed'", '압축 영상'),
                                ("'Empty decoded image frame'", '해독 결과가 비어 있거나 불완전'),
                                ("new EvalError(\"Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script\")", '뷰어 보안 정책'),
                                ("new WebAssembly.CompileError(\"WebAssembly.compile(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script\")", '뷰어 보안 정책'),
                                ("\"Refused to compile WebAssembly module under Content Security Policy\"", '뷰어 보안 정책'),
                                ("new DOMException('cancelled','AbortError')", '요청이 취소'), ("new DOMException('timeout','TimeoutError')", '시간이 초과')]:
            self.page.evaluate(f"()=>{{window.latest={error};fail(latest);reject(latest);renderError(latest)}}")
            expect(self.page.get_by_role('alert')).to_contain_text(expected)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 0)
        self.page.evaluate("reject(new Error('unrelated render failure'))")
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1, 'unknown errors retain upstream diagnostics')
        self.page.evaluate("cornerstone.eventTarget.dispatchEvent(new CustomEvent('loaded',{detail:{imageId:currentImage}}))")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("reject(new Error('Couldn\\'t retrieve '+currentImage.slice(7)+' got status 504'))")
        expect(self.page.get_by_role('alert')).to_contain_text('HTTP 504')
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1)
        self.page.evaluate("""()=>{const error={status:503,request:{}};
          window.dispatchEvent(new CustomEvent('kin-series-metadata-failed',{detail:{error,message:'영상 정보를 한 번 다시 요청했지만 불러오지 못했습니다(HTTP 503).'}}));
          reject(error)}""")
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1, 'metadata recovery already supplied the terminal reason')
        # An empty successful response would spin forever in the pinned streaming loader; truncated multipart
        # must reject, and complete bytes must pass unchanged. This exercises the real browser ReadableStream.
        route = '**/dicom-web/studies/1/series/2/instances/3/frames/1'
        for payload, complete in [('', False), ('--fixture\r\nContent-Type: image/jp2\r\n\r\nbytes', False),
                                  ('--fixture\r\nContent-Type: image/jp2\r\n\r\nbytes\r\n--fixture--\r\n', True)]:
            self.page.route(route, lambda r: r.fulfill(status=200, content_type='multipart/related; boundary=fixture', body=payload))
            result = self.page.evaluate("""async()=>{try{return {body:await (await fetch(currentImage.slice(7))).text()}}
              catch(error){fail(error);reject(error);return {error:error.message}}}""")
            if complete:
                self.assertEqual(result, {'body': payload})
            else:
                self.assertIn('error', result, 'incomplete transport must reject before decode')
                expect(self.page.get_by_role('alert')).to_contain_text('프레임이 완전하지 않습니다')
            self.page.unroute(route)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1)
        if os.environ.get('KIN_MG_ERROR_SCREENSHOT'):
            self.page.screenshot(path=os.environ['KIN_MG_ERROR_SCREENSHOT'])
        self.page.evaluate("ext.onModeExit();reject(latest)")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 2)
        self.assertEqual(self.page.evaluate('sourceConfig.acceptHeader'), ['original'])
    def test_mixed_modality_merged_layout_round_trips_all_cells(self):
        self.page.evaluate('document.body.replaceChildren()')
        self.script('layout-model'); self.script('layout')
        self.page.evaluate("""() => {
          window.kinViewerSession={ended:()=>false,readOnly:()=>false,onReadOnly:()=>()=>{},onChange:()=>()=>{},sameAccount:()=>true,note(){}};
          window.kinViewerOnEnd=()=>({close(){}}); window.KinSessionTransport={refusal:()=>false};
          window.KinHangingProtocolModel={}; window.KinViewerHangingProtocol={mount:()=>({end(){}})};
          const sets=['MG','MR','DX'].map((Modality,i)=>({displaySetInstanceUID:'d'+i,Modality,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.2.'+(i+1),SOPClassHandlerId:'stack',images:[{SOPInstanceUID:'1.3.'+(i+1)}]}));
          const rectangles=[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]];
          window.state={layout:{numRows:2,numCols:2,layoutType:'grid'},activeViewportId:'v2',viewports:new Map(rectangles.map(([x,y,width,height],i)=>['v'+i,{viewportId:'v'+i,x,y,width,height,displaySetInstanceUIDs:['d'+i],viewportOptions:{viewportType:'stack',toolGroupId:'default'},displaySetOptions:[{}]}]))};
          const grid={getState:()=>state,setLayout:async spec=>{window.restored={rectangles:spec.layoutOptions,cells:spec.layoutOptions.map((_,i)=>spec.findOrCreateViewport(i)),active:spec.activeViewportId}}};
          window.fetch=async path=>({ok:true,json:async()=>path==='/api/me'?{kind:'member',sub:'doctor',institution:'site'}:{studies:[{uid:'1.2'}]}});
          const services={viewportGridService:grid,cornerstoneViewportService:{},displaySetService:{getActiveDisplaySets:()=>sets,getDisplaySetByUID:id=>sets.find(s=>s.displaySetInstanceUID===id)}};
          window.ext=kinCreateViewerLayout();ext.preRegistration({servicesManager:{services}});ext.onModeEnter();
        }""")
        save=self.page.get_by_role('button',name='Save Recent Layout',exact=True); expect(save).to_be_enabled(); save.click()
        expect(self.page.locator('#kin-viewer-layout-status')).to_contain_text('저장했습니다')
        self.page.get_by_role('button',name='Restore Recent Layout',exact=True).click()
        self.page.wait_for_function('!!window.restored')
        actual=self.page.evaluate('restored'); self.assertEqual(3,len(actual['cells']))
        self.assertEqual([['d0'],['d1'],['d2']],[c['displaySetInstanceUIDs'] for c in actual['cells']])
        self.assertEqual([{'x':0,'y':0,'width':.5,'height':1},{'x':.5,'y':0,'width':.5,'height':.5},{'x':.5,'y':.5,'width':.5,'height':.5}],actual['rectangles'])
        self.assertEqual(actual['active'],actual['cells'][2]['viewportOptions']['viewportId'])
        if os.environ.get('KIN_CAUTION_SCREENSHOT'): self.page.screenshot(path=os.environ['KIN_CAUTION_SCREENSHOT'])
        self.page.evaluate('ext.onModeExit()')
if __name__=='__main__': unittest.main()
