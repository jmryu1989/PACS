"""D02C live bounded previews, real BFF/Orthanc/CDP and owned fixtures only.

Run separately: python tests/e2e/test_thumbnail_requests.py
"""
from __future__ import annotations
from pathlib import Path
import datetime, hashlib, io, json, re, subprocess, time, unittest, uuid
from urllib.parse import urlsplit
from pydicom import dcmread
from pydicom.uid import generate_uid, CTImageStorage, ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
from test_portrait_workspace import PortraitWorkspaceE2E


class ThumbnailRequestsE2E(PortraitWorkspaceE2E):
    def hashes(self):
        result={}
        for uid in self.stack.active:
            found=self.stack._orthanc_request('POST','/tools/lookup',uid.encode()).body
            orth=next(x['ID'] for x in found if x['Type']=='Study')
            for inst in self.stack._orthanc_request('GET',f'/studies/{orth}/instances').body:
                path='/instances/'+inst['ID']+'/file'
                result[path]=hashlib.sha256(self.stack.orthanc_bytes(path)).hexdigest()
        return result

    def many(self,series=32):
        fixture=self.fixture()
        path=next(iter(self.hashes()))
        data=dcmread(io.BytesIO(self.stack.orthanc_bytes(path)))
        ae=AE(ae_title='HALLYM_CT')
        ae.add_requested_context(CTImageStorage,ExplicitVRLittleEndian)
        assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
        self.assertTrue(assoc.is_established)
        try:
            for n in range(2,series+1):
                data.SOPInstanceUID=generate_uid()
                data.file_meta.MediaStorageSOPInstanceUID=data.SOPInstanceUID
                data.SeriesInstanceUID=generate_uid()
                data.SeriesNumber=n
                data.SeriesDescription='D02C synthetic series '+str(n)
                self.assertEqual(assoc.send_c_store(data).Status,0)
        finally:
            assoc.release()
        return fixture

    def observe(self, page, fixtures, hashes):
        self.started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.nonce = uuid.uuid4().hex
        self.events, self.active, self.live_urls = [], {}, set()
        def resource(kind, url):
            if kind == 'create': self.live_urls.add(url)
            else: self.live_urls.discard(url)
        page.expose_function('_d02cResource', resource)
        page.evaluate('''({uids, ids, nonce}) => {
          const raw = window.fetch, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
          const sources = new WeakMap();
          window._d02c = { sources: {}, created: 0, revoked: 0, pending: 0, peak: 0, lifecycle: [] };
          let seq = 0;
          window.fetch = async (input, init) => {
            let url = String(input);
            const owned = (url.includes('/dicom-web/studies/') && uids.some(u => url.includes(u))) ||
              (url.includes('/instances/') && url.includes('/preview') && ids.some(id => url.includes(id))) ||
              (url.endsWith('/api/dicom/lookup') && uids.some(u => String(init?.body).includes(u)));
            if (owned) url += (url.includes('?') ? '&' : '?') + 'd02c=' + nonce + (++seq);
            if (owned) {
              _d02c.pending++; _d02c.peak=Math.max(_d02c.peak,_d02c.pending);
              _d02c.lifecycle.push({kind:'start',url,at:performance.now()});
            }
            let done=false;
            const finish = () => {
              if (owned && !done) {
                done=true; _d02c.pending--;
                _d02c.lifecycle.push({kind:'settled',url,at:performance.now()});
              }
            };
            let res;
            try { res = await raw(url, init); }
            catch (e) { finish(); throw e; }
            if (owned) {
              for (const method of ['blob','json']) {
                const read=res[method].bind(res);
                res[method]=async () => {
                  try { const value=await read(); if (method==='blob') sources.set(value,url); return value; }
                  finally { finish(); }
                };
              }
              if (res.body) {
                const cancel=res.body.cancel.bind(res.body);
                res.body.cancel=async () => { try { return await cancel(); } finally { finish(); } };
              }
            }
            return res;
          };
          URL.createObjectURL = b => {
            const url = create.call(URL, b);
            _d02c.sources[url] = sources.get(b);
            _d02c.created++;
            window._d02cResource('create', url);
            return url;
          };
          URL.revokeObjectURL = url => {
            delete _d02c.sources[url]; _d02c.revoked++;
            window._d02cResource('revoke', url);
            return revoke.call(URL, url);
          };
        }''', {'uids':[f.uid for f in fixtures], 'ids':[p.split('/')[2] for p in hashes], 'nonce':self.nonce})
        cdp = page.context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Network.setCacheDisabled', {'cacheDisabled':True})
        def start(e):
            url = e['request']['url']
            if 'd02c='+self.nonce not in url: return
            self.active[e['requestId']] = url
            self.events.append({'kind':'start','id':e['requestId'],'url':url,'at':time.perf_counter()})
        def end(e, kind):
            if e['requestId'] not in self.active: return
            self.active.pop(e['requestId'])
            self.events.append({'kind':kind,'id':e['requestId'],'at':time.perf_counter(),
                                'canceled':e.get('canceled',False),'error':e.get('errorText')})
        cdp.on('Network.requestWillBeSent', start)
        cdp.on('Network.loadingFinished', lambda e:end(e,'finished'))
        cdp.on('Network.loadingFailed', lambda e:end(e,'failed'))
        return cdp

    def ready(self, page, count):
        page.wait_for_function('''n => {
          const cells = [...document.querySelectorAll('#thumbwrap .thumbs > div')];
          return cells.length === n && cells.every(c => {
            const i = c.querySelector('img'); return i && i.complete && i.naturalWidth > 0;
          });
        }''', arg=count, timeout=30000)
        self.settled(page)

    def settled(self, page):
        deadline = time.monotonic()+5
        while self.active and time.monotonic()<deadline: page.wait_for_timeout(50)
        self.assertEqual(self.active, {})

    def evidence(self, page, label):
        self.settled(page)
        # Capture Docker output in memory; persist only terminal rows carrying this test's nonce.
        result = subprocess.run(['docker','logs','--since',self.started,'kin-proxy'],capture_output=True)
        self.assertEqual(result.returncode,0)
        lines = (result.stdout+result.stderr).decode('utf-8',errors='replace').splitlines()
        rows = []
        for line in lines:
            if 'd02c='+self.nonce not in line: continue
            m = re.search(r'"(GET|POST) ([^ ]+) HTTP/[^\"]+" (\d+) (\d+)',line)
            if m: rows.append({'method':m[1],'path':m[2],'status':int(m[3]),'bytes':int(m[4])})
        starts = {e['id']:e['url'] for e in self.events if e['kind']=='start'}
        terminal = {e['id']:e for e in self.events if e['kind']!='start'}
        self.assertEqual(set(starts),set(terminal))
        known = {urlsplit(u).path+'?'+urlsplit(u).query for u in starts.values()}
        self.assertTrue(rows)
        self.assertTrue(all(row['path'] in known for row in rows))
        pending = peak = 0
        for e in self.events:
            pending += 1 if e['kind']=='start' else -1
            peak = max(peak,pending)
        lifecycle = page.evaluate('({peak:_d02c.peak,pending:_d02c.pending,events:_d02c.lifecycle})')
        self.assertEqual(lifecycle['pending'],0)
        self.assertLessEqual(lifecycle['peak'],4)
        if label != 'cancel': self.assertLessEqual(peak,4)
        folder = Path(__file__).parent/'artifacts'
        folder.mkdir(exist_ok=True)
        (folder/('D02C-'+label+'.json')).write_text(json.dumps({
            'startedUTC':self.started,'events':self.events,'nginxTerminals':rows,
            'peakCDP':peak,'fetchBodyLifecycle':lifecycle,'browserTerminalMissing':0,'liveBlobURLs':len(self.live_urls),
            'note':'Nginx status is gateway completion/disconnect, not proof that upstream computation aborted.'
        },indent=2)+'\n',encoding='utf-8')
        return rows

    def snapshot(self, page, label):
        page.screenshot(path=str(Path(__file__).parent/'artifacts'/('D02C-'+label+'.png')))

    def test_d02c_bound_pages_and_preservation(self):
        fixture = self.many()
        before = self.hashes()
        self.addCleanup(lambda:self.assertEqual(self.hashes(),before))
        self.seed_report(fixture)
        page = self.login()
        self.observe(page,[fixture],before)
        self.select(page,fixture)
        self.ready(page,24)
        expect(page.locator('#thumb-range')).to_have_text('시리즈 1–24 / 32')
        expect(page.locator('#thumb-prev')).to_be_disabled()
        starts = lambda:[e for e in self.events if e['kind']=='start']
        self.assertEqual(len(starts()),49)  # metadata + 24 authorized lookup/preview pairs
        self.assertEqual(len(self.live_urls),24)
        edited = fixture.secret+' private draft'
        page.locator('#findings').fill(edited)
        self.wait_state(page,fixture,lambda s:(s.get('draft') or {}).get('findings')==edited,timeout=30000)
        state, versions = self.state(fixture), self.versions(fixture)
        page.locator('#thumb-next').click()
        self.ready(page,8)
        self.assertEqual(len(starts()),65)
        self.assertEqual(len(self.live_urls),8)
        expect(page.locator('#thumb-range')).to_have_text('시리즈 25–32 / 32')
        expect(page.locator('#thumb-next')).to_be_disabled()
        self.snapshot(page,'last-page')
        page.locator('#thumb-prev').click()
        self.ready(page,24)
        self.assertEqual(len(starts()),113)
        self.assertEqual(len(self.live_urls),24)
        self.assertEqual(self.state(fixture),state)
        self.assertEqual(self.versions(fixture),versions)
        expect(page.locator('#findings')).to_have_value(edited)
        self.snapshot(page,'first-page')
        self.evidence(page,'pages')

    def test_d02c_cancel_and_aba(self):
        a,b = self.many(),self.fixture()
        before = self.hashes()
        self.addCleanup(lambda:self.assertEqual(self.hashes(),before))
        page = self.login()
        cdp = self.observe(page,[a,b],before)
        cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':500,
                  'downloadThroughput':1024*1024,'uploadThroughput':1024*1024})
        with page.expect_request(lambda r:f'/studies/{a.uid}/instances' in r.url): self.select(page,a)
        self.select(page,b)
        self.ready(page,1)
        with page.expect_request(lambda r:'/preview?d02c=' in r.url): self.select(page,a)
        self.select(page,b)
        self.select(page,a)
        self.ready(page,24)
        with page.expect_request(lambda r:'/api/dicom/lookup?' in r.url): page.locator('#thumb-next').click()
        page.locator('#thumb-prev').click()
        self.ready(page,24)
        expected_ids = {p.split('/')[2] for p in before}
        browsed = page.evaluate('Object.values(_d02c.sources)')
        self.assertEqual(len(browsed),24)
        for url in browsed:
            oid = urlsplit(url).path.split('/')[2]
            self.assertIn(oid,expected_ids)
            tags = self.stack._orthanc_request('GET','/instances/'+oid+'/simplified-tags').body
            self.assertEqual(tags['StudyInstanceUID'],a.uid)
        self.assertEqual(len(self.live_urls),24)
        canceled = [e for e in self.events if e.get('canceled')]
        self.assertGreaterEqual(len(canceled),3)
        expect(page.locator('#thumbwrap')).not_to_contain_text('실패')
        rows = self.evidence(page,'cancel')
        starts = {e['id']:e['url'] for e in self.events if e['kind']=='start'}
        canceled_paths = {urlsplit(starts[e['id']]).path+'?'+urlsplit(starts[e['id']]).query for e in canceled}
        self.assertTrue(any(row['path'] in canceled_paths for row in rows))

    def test_d02c_errors_and_pagehide(self):
        a,b = self.many(series=3),self.fixture()
        before = self.hashes()
        self.addCleanup(lambda:self.assertEqual(self.hashes(),before))
        page = self.login()
        self.observe(page,[a,b],before)
        faults = []
        def fail_one(route):
            if not faults:
                faults.append(route.request.url)
                route.fulfill(status=503,body='synthetic preview failure')
            else: route.continue_()
        page.route('**/instances/*/preview?d02c=*',fail_one)
        self.select(page,a)
        page.wait_for_function("() => document.querySelectorAll('#thumbwrap img').length === 2 && document.querySelector('#thumbwrap').textContent.includes('HTTP 503')")
        self.settled(page)
        self.assertEqual(len(self.live_urls),2)
        page.unroute('**/instances/*/preview?d02c=*',fail_one)
        def fail_metadata(route): route.fulfill(status=503,body='<img src=x onerror=alert(1)>')
        pattern = '**/studies/'+b.uid+'/instances?d02c=*'
        page.route(pattern,fail_metadata)
        self.select(page,b)
        expect(page.locator('#thumbwrap')).to_contain_text('썸네일 실패: HTTP 503')
        self.assertEqual(page.locator('#thumbwrap img').count(),0)
        self.assertEqual(len(self.live_urls),0)
        page.unroute(pattern,fail_metadata)
        self.select(page,a)
        self.ready(page,3)
        self.snapshot(page,'recovered')
        self.evidence(page,'errors')
        # A binding's asynchronous message can be lost when its document is destroyed.
        # Persist only counters after the product's earlier pagehide cleanup listener runs.
        page.evaluate('''key => addEventListener('pagehide', () => sessionStorage.setItem(key,
          JSON.stringify({created:_d02c.created, revoked:_d02c.revoked, live:Object.keys(_d02c.sources).length})))''',self.nonce)
        page.goto('about:blank')
        page.goto(self.stack.proxy+'/worklist/hpacs-lite/main.html')
        counters = page.evaluate('''key => {
          const value=JSON.parse(sessionStorage.getItem(key)); sessionStorage.removeItem(key); return value;
        }''',self.nonce)
        self.assertEqual(counters['live'],0)
        self.assertEqual(counters['created'],counters['revoked'])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ThumbnailRequestsE2E(name) for name in loader.getTestCaseNames(ThumbnailRequestsE2E)
                              if name.startswith('test_d02c_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)

