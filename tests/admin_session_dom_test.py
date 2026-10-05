# coding: utf-8
"""U5S-REQ-04/06/08/10/12/24 -> U5S-RISK-SESSION/APPLY/WAIT -> U5S-TEST-PAGES.

Real auth, gate, transport and pages. Synthetic fetch responses can stop before headers,
inside a JSON body, or before rejection. Navigation is held at the destination while
an in-document observer reports DOM/storage and attempted requests to the harness.
No server or LiveStack. Legacy generic-401/end-pulse cases move here with named signals.
"""
import json
import os
from pathlib import Path
import time
import unittest
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from clinician_home_dom_test import ROWS, REPORTS
from admin_gateway_status_dom_test import MEMBERS, ACCESS, FIVE
from admin_metrics_dom_test import answer as metrics_answer, ROWS as METRICS_ROWS
from admin_audit_dom_test import answer as audit_answer, PAGE1

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(os.environ.get('KIN_PAGES_ASSETS', ROOT / 'worklist-v0/hpacs-lite'))
ORIGIN = 'https://session-pages.test'
BASE = '/worklist/hpacs-lite/'
SESSION = 'SYN-PAGES-S1'
SUB = 'SYN-CLIN-SUB'
OWNER = ['SYN-INST-A', SUB]

INIT = r"""(() => {
  const native = fetch.bind(window);
  let armed = null;
  window.synSeen = [];
  window.synArm = options => { armed = options; };
  window.synRelease = null;
  window.fetch = (url, init = {}) => {
    const path = new URL(url, location.href).pathname;
    window.synSeen.push({path, method: init.method || 'GET', session: new Headers(init.headers).get('X-KIN-Session')});
    if (!armed || path !== armed.path) return native(url, init);
    const hold = armed; armed = null;
    if (hold.receipt) {
      const sent = JSON.parse(init.body), question = hold.receipt === 'question';
      hold.body = {owner:sent.expectedOwner,replayed:false,applied:{requestId:sent.requestId,id:sent.requestId,
        studyUid:hold.uid,action:'create',from:null,to:question?'Open':'Requested',revision:1,
        at:'2026-10-04T00:00:00.000Z',...(question?{entry:{id:sent.requestId,seq:1,kind:'question'}}:{kind:sent.kind})}};
    }
    const bytes = new TextEncoder().encode(JSON.stringify(hold.body));
    const options = {status: hold.status || 200, headers: {'Content-Type': 'application/json', ...(hold.code ? {'X-KIN-Auth-Code':hold.code} : {})}};
    // Intentionally ignore AbortSignal: abort alone cannot prove late-result safety.
    if (hold.cut === 'headers') return new Promise((resolve, reject) => {
      window.synRelease = () => resolve(new Response(bytes, options));
      if (hold.respectAbort) init.signal.addEventListener('abort', () => reject(new DOMException('SYN cancelled','AbortError')));
    });
    if (hold.cut === 'error') return new Promise((resolve, reject) => {
      window.synRelease = () => reject(new TypeError('SYN late network failure'));
    });
    const stream = new ReadableStream({start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      window.synRelease = () => { controller.enqueue(bytes.slice(2)); controller.close(); };
    }});
    return Promise.resolve(new Response(stream, options));
  };
  const snapshot = () => ({html: document.body.innerHTML, protectedRows:document.querySelectorAll('#users tr,#studies tr,#metrics-rows tr,#audit-rows tr,#gateway-rows > li,#study-access-dialog,dialog[open]').length, values:[...document.querySelectorAll('input,textarea')].map(el=>el.value),
    storage: [JSON.stringify({...localStorage}), JSON.stringify({...sessionStorage})],
    work: window.KinWorkContext?.state(), seen: window.synSeen});
  window.synWatch = () => {
    setInterval(() => native('/probe', {method:'POST', body:JSON.stringify(snapshot())}), 25);
  };
  window.synEnd = mode => {
    window.synWatch();
    setTimeout(() => window.synRelease?.(), 100);
    if (mode === 'logout') document.querySelector('#logout').click();
    else if (mode === 'replace') KinAuth.replaced({session: KinAuth.sessionId()});
    else if (mode !== 'server-ended') {
      const c = new BroadcastChannel('kin-session');
      c.postMessage({type:'session-ended',session:KinAuth.sessionId(),operation:55,status:'ending'}); c.close();
    }
  };
})();"""


class PageSessionDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = None
        self.fresh('admin')

    def tearDown(self):
        self.close_context()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.unexpected)

    def complete_move(self, route):
        route.fulfill(status=204)
        self.completed_moves.add(route)

    def close_context(self):
        if not self.context:
            return
        # Release the deliberately held destination before destroying its route handler.
        for route in self.moves:
            if route not in self.completed_moves:
                self.complete_move(route)
        self.context.close()
        self.context = None

    def fresh(self, kind, session=SESSION, init=''):
        self.close_context()
        self.kind, self.session = kind, session
        self.calls, self.errors, self.unexpected, self.probes, self.moves = [], [], [], [], []
        self.me_status, self.me_code = 200, None
        self.me_extra = {}
        self.cancel_moves = False
        self.completed_moves = set()
        self.me_owner = SUB
        self.responses = {}
        self.context = self.browser.new_context()
        self.context.add_init_script(INIT + init)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.context.route('**/*', self.route)

    def route(self, route):
        req = route.request
        path = urlparse(req.url).path
        self.calls.append((req.method, path, req.headers.get('x-kin-session')))
        if path == '/probe':
            self.probes.append(json.loads(req.post_data))
            route.fulfill(status=204)
        elif path == BASE + 'index.html':
            self.moves.append(route)  # Hold the destination, not just the old request.
            if self.cancel_moves: self.complete_move(route)
        elif path.startswith(BASE):
            file = ASSETS / path[len(BASE):]
            if file.is_file():
                route.fulfill(body=file.read_bytes(), content_type='text/html' if file.suffix=='.html' else 'application/javascript')
            else:
                self.unexpected.append(path); route.abort()
        elif path == '/api/me':
            body = {'kind':'member','sub':self.me_owner,'institution':OWNER[0], 'user':'syn-user',
                    'displayName':'SYN Actor','roles':['admin'] if self.kind=='admin' else ['clinician'], 'sessionId':self.session}
            if self.me_status != 200: body = {'message':'SYN failed', 'code':self.me_code, **self.me_extra}
            route.fulfill(status=self.me_status, json=body)
        elif path == '/api/auth/logout':
            route.fulfill(status=204)
        elif path == '/api/auth/login':
            route.fulfill(status=204)
        elif path == '/api/auth/entry':
            route.fulfill(json={'sessionId':self.session})
        elif path in self.responses:
            route.fulfill(json=self.responses[path])
        elif path == '/api/admin/users':
            route.fulfill(json=MEMBERS if req.method=='GET' else {'temporaryPassword':'SYN late secret'})
        elif path.endswith('/study-access'):
            route.fulfill(json={**ACCESS,'owner':OWNER})
        elif path.startswith('/api/admin/users/'):
            route.fulfill(json={'temporaryPassword':'SYN late secret'})
        elif path == '/api/admin/metrics':
            route.fulfill(json=metrics_answer(rows=METRICS_ROWS))
        elif path == '/api/admin/audit':
            route.fulfill(json=PAGE1)
        elif path == '/api/studies':
            route.fulfill(json=FIVE)
        elif path == '/api/clinician/studies':
            rows = sorted(ROWS,key=lambda x:x['uid'])
            route.fulfill(json={'studies':rows,'pagination':{'limit':100,'offset':0,'total':len(rows),'next':None}})
        elif path.endswith('/report'):
            uid = path.split('/')[-2]; route.fulfill(json=REPORTS[uid])
        elif path.endswith('/questions') or path.endswith('/image-requests'):
            route.fulfill(json={'owner':OWNER,'items':[]})
        elif path == '/api/critical-results':
            route.fulfill(json={'owner':OWNER,'view':'received','items':[],'nextCursor':None,'pending':0})
        elif path == '/favicon.ico' or path.startswith('/kin-brand/'):
            route.fulfill(status=404)
        else:
            self.unexpected.append(path); route.abort()

    def pump(self, predicate, timeout=5):
        end = time.monotonic()+timeout
        while not predicate():
            if time.monotonic()>end: self.fail('expected observation did not arrive')
            self.page.wait_for_timeout(15)

    def open(self):
        self.page.goto(ORIGIN+BASE+self.kind+'.html')
        expect(self.page.locator('#users tr' if self.kind=='admin' else '#studies tr')).not_to_have_count(0)

    def hold(self, path, cut, body=None, status=200, code=None):
        self.page.evaluate('x => synArm(x)',dict(path=path,cut=cut,body=body or {'late':'SYN'},status=status,code=code))

    def close_and_check(self, mode):
        self.page.evaluate('mode => synEnd(mode)', mode)
        self.pump(lambda: self.moves and len(self.probes)>=12)
        closed = [p for p in self.probes if p['work'] in ['ending','confirmed','unconfirmed']]
        self.assertGreaterEqual(len(closed),8)
        first, last = closed[0], closed[-1]
        self.assertEqual(first['html'],last['html'],'late completion repainted the closed document')
        before, after = [list(map(json.loads, p['storage'])) for p in [first,last]]
        if mode == 'logout':
            # The logout receipt may confirm its own end record while ordinary work is already closed.
            started, confirmed = before[0].pop('kin-session-end'), after[0].pop('kin-session-end')
            started, confirmed = json.loads(started), json.loads(confirmed)
            self.assertIn(started['status'],['ending','confirmed'])
            self.assertEqual({**started,'status':'confirmed'},confirmed)
        self.assertEqual(before,after,'late completion changed work storage')
        self.assertEqual(first['seen'],last['seen'],'new work started after end')
        self.assertNotIn('SYN late', last['html'])
        self.assertNotIn('SYN Actor',last['html'])
        self.assertNotIn('SYN ALPHA',last['html'])
        self.assertNotIn('SYN Member',last['html'])
        self.assertEqual(first['values'],last['values'])
        self.assertEqual(0,last['protectedRows'],'all session data and open dialogs are removed')
        self.assertEqual(1,len(self.moves),'one navigation')
        self.assertEqual(1 if mode=='logout' else 0,sum(m=='POST' and p=='/api/auth/logout' for m,p,_ in self.calls))
        # Cancel the navigation and actively try the surviving controls: no post-end work even then.
        self.complete_move(self.moves[0])
        count = len([c for c in self.calls if c[1].startswith('/api/')])
        self.page.evaluate("() => { for (const el of document.querySelectorAll('button')) { el.disabled=false; el.click(); } }")
        self.page.wait_for_timeout(50)
        self.assertEqual(count,len([c for c in self.calls if c[1].startswith('/api/')]))
        self.assertEqual([],self.errors)

    def test_admin_end_cuts_across_all_panels(self):
        operations = [('members','/api/admin/users','#refresh',MEMBERS),
                      ('metrics','/api/admin/metrics','#metrics-refresh',metrics_answer(rows=METRICS_ROWS)),
                      ('audit','/api/admin/audit','#audit-refresh',PAGE1),
                      ('gateway','/api/studies','#gateway-refresh',FIVE)]
        for label,path,button,body in operations:
            for cut in ['headers','body','error']:
                for mode in ['logout','notice','replace','server-ended']:
                    with self.subTest(panel=label,cut=cut,end=mode):
                        self.fresh('admin'); self.open()
                        if label != 'members':
                            self.page.locator(button).click()
                            self.page.wait_for_timeout(60)
                        if mode == 'server-ended':
                            # The refusal arrives through the bound transport. A
                            # late body/error is tested by the three other modes.
                            if cut != 'headers': continue
                            self.hold(path,cut,{'code':'AUTH_SESSION_ENDED'},401,'AUTH_SESSION_ENDED')
                        else:
                            self.hold(path,cut,body)
                        self.page.locator(button).click()
                        self.page.wait_for_function('synRelease !== null')
                        self.close_and_check(mode)

    def assert_work_stays(self):
        self.assertEqual('active', self.page.evaluate('KinWorkContext.state()'))
        self.assertEqual(ORIGIN + BASE + self.kind + '.html', self.page.url)
        self.assertEqual([], self.moves)
        self.assertFalse(any(p == '/api/auth/logout' for _, p, _ in self.calls))

    def test_read_403_clears_admin_panels_and_later_read_recovers(self):
        # U5PG-F01: denial withdraws the protected panel, not the session.
        panels = [('members', '/api/admin/users', '#refresh', '#users', '#message'),
                  ('metrics', '/api/admin/metrics', '#metrics-refresh', '#metrics-rows', '#metrics-message'),
                  ('audit', '/api/admin/audit', '#audit-refresh', '#audit-rows', '#audit-message'),
                  ('audit-more', '/api/admin/audit', '#audit-more', '#audit-rows', '#audit-message'),
                  ('gateway', '/api/studies', '#gateway-refresh', '#gateway-rows', '#gateway-message')]
        for label, path, button, rows, message in panels:
            with self.subTest(panel=label):
                self.fresh('admin'); self.open()
                refresh = '#audit-refresh' if label == 'audit-more' else button
                if label != 'members':
                    self.page.locator(refresh).click()
                expect(self.page.locator(rows + ' > *')).not_to_have_count(0)
                self.hold(path, 'headers', {'message': 'SYN read refused'}, 403)
                self.page.locator(button).click()
                self.page.wait_for_function('synRelease !== null')
                if label == 'members':
                    self.page.get_by_role('button', name='Change Membership', exact=True).click()
                    self.page.locator('#membership-form input[name=institution]').fill('SYN private edit')
                self.page.evaluate('synRelease()')
                expect(self.page.locator(rows + ' > *')).to_have_count(0)
                expect(self.page.locator(rows + ' button')).to_have_count(0)
                expect(self.page.locator(refresh)).to_be_disabled()
                expect(self.page.locator(message)).to_be_visible()
                self.assertTrue(self.page.locator(message).inner_text())
                if label == 'members':
                    expect(self.page.locator('dialog[open]')).to_have_count(0)
                    self.assertEqual('', self.page.locator('#membership-form input[name=institution]').input_value())
                    for control in ['#search', '#institution-filter', '#open-create', '#previous', '#next']:
                        expect(self.page.locator(control)).to_be_disabled()
                self.assert_work_stays()
                # Controls stay disabled until the panel is opened again in a freshly read document.
                self.page.reload()
                expect(self.page.locator('#users tr')).not_to_have_count(0)
                if label != 'members': self.page.locator(refresh).click()
                expect(self.page.locator(rows + ' > *')).not_to_have_count(0)
                expect(self.page.locator(refresh)).to_be_enabled()
                self.assert_work_stays()

    def test_read_403_closes_study_access_but_write_403_keeps_edits(self):
        self.open()
        button = self.page.get_by_role('button', name='Study Access', exact=True)
        button.click()
        expect(self.page.locator('[data-save]')).to_be_enabled()
        self.page.locator('#study-access-form input[name=reason]').fill('SYN retained reason')
        path = '/api/admin/users/SYN-U-1/study-access'
        self.hold(path, 'headers', {'message': 'SYN write refused'}, 403)
        self.page.locator('[data-save]').click()
        self.page.evaluate('synRelease()')
        expect(self.page.locator('[data-status]')).to_contain_text('SYN write refused')
        self.assertEqual('SYN retained reason', self.page.locator('#study-access-form input[name=reason]').input_value())
        expect(self.page.locator('[data-save]')).to_be_enabled()
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.hold(path, 'headers', {'message': 'SYN read refused'}, 403)
        self.page.locator('[data-reload]').click()
        self.page.evaluate('synRelease()')
        expect(self.page.locator('#study-access-dialog')).to_have_count(0)
        expect(self.page.locator('#message')).to_have_text('SYN read refused')
        self.assert_work_stays()
        button.click()
        expect(self.page.locator('[data-save]')).to_be_enabled()
        self.assertEqual('', self.page.locator('#study-access-form input[name=reason]').input_value())

    def test_member_read_denial_drops_an_older_password_answer(self):
        self.open()
        self.hold('/api/admin/users/SYN-U-1/reset-password', 'headers', {'temporaryPassword': 'SYN late secret'})
        self.page.get_by_role('button', name='Temp Password', exact=True).click()
        self.page.wait_for_function('synRelease !== null')
        self.page.evaluate('window.releasePassword = synRelease; synRelease = null')
        self.hold('/api/admin/users', 'headers', {'message': 'SYN read refused'}, 403)
        self.page.locator('#refresh').click()
        self.page.wait_for_function('synRelease !== null')
        self.page.evaluate('synRelease()')
        expect(self.page.locator('#message')).to_have_text('SYN read refused')
        self.page.evaluate('releasePassword()')
        self.page.wait_for_timeout(80)
        expect(self.page.locator('dialog[open]')).to_have_count(0)
        expect(self.page.locator('#users tr')).to_have_count(0)
        expect(self.page.locator('#temporary-password')).to_be_empty()
        expect(self.page.locator('#message')).to_have_text('SYN read refused')
        self.assert_work_stays()

    def test_write_403_keeps_members_and_gateway_rows(self):
        for label, path, button, rows, message in [
            ('members', '/api/admin/users/SYN-U-1', 'Revoke Approval', '#users', '#message'),
            ('gateway', None, None, '#gateway-rows', '.gw-note')]:
            with self.subTest(panel=label):
                self.fresh('admin'); self.open()
                if label == 'gateway':
                    self.page.locator('#gateway-refresh').click()
                    expect(self.page.locator('#gateway-rows > li')).not_to_have_count(0)
                    action = self.page.locator('#gateway-rows button:visible').first
                    uid = action.locator('xpath=ancestor::li').get_attribute('data-uid')
                    path = '/api/studies/' + uid + '/gateway-retry'
                else:
                    action = self.page.get_by_role('button', name=button, exact=True)
                before = self.page.locator(rows + ' > *').count()
                self.hold(path, 'headers', {'message': 'SYN write refused'}, 403)
                action.click()
                self.page.wait_for_function('synRelease !== null')
                self.page.evaluate('synRelease()')
                self.page.wait_for_timeout(80)
                expect(self.page.locator(rows + ' > *')).to_have_count(before)
                self.assertTrue(any(self.page.locator(message).all_text_contents()))
                self.assert_work_stays()

    def test_read_403_clears_clinician_panels_and_later_read_recovers(self):
        uid = ROWS[0]['uid']
        for label, path, target, controls in [
            ('studies', '/api/clinician/studies', '#studies', '#refresh, #list-retry'),
            ('report', f'/api/clinician/studies/{uid}/report', '#report-body', '#report-retry'),
            ('timeline', f'/api/clinician/studies/{uid}/timeline', '#timeline-list', '#timeline-toggle, #timeline-retry'),
            ('questions', f'/api/studies/{uid}/questions', '#questions-body', '#questions-body button'),
            ('images', f'/api/studies/{uid}/image-requests', '#image-requests-body', '#image-requests-body button')]:
            with self.subTest(panel=label):
                self.fresh('clinician')
                rows = [{**r} for r in ROWS]
                rows[1]['sourcePatientKey'] = rows[0]['sourcePatientKey']
                rows.sort(key=lambda r: r['uid'])
                self.responses['/api/clinician/studies'] = {'studies': rows,
                    'pagination': {'limit': 100, 'offset': 0, 'total': len(rows), 'next': None}}
                if label == 'timeline':
                    self.responses[path] = {'uid': uid, 'patientKey': rows[0]['sourcePatientKey'],
                        'identity': {'birth': 'match', 'sex': 'match', 'conflict': False},
                        'studies': [{**r, 'identity': {'birth': 'match', 'sex': 'match'}} for r in rows[:2]],
                        'pagination': {'limit': 100, 'offset': 0, 'total': 2, 'next': None}}
                if label == 'questions':
                    self.responses[path] = {'owner': OWNER, 'items': [{'id': '00000000-0000-4000-8000-000000000001',
                        'studyUid': uid, 'state': 'Open', 'revision': 1, 'entryCount': 1,
                        'author': {'actor': 'syn-author', 'name': 'SYN prior author'}}]}
                if label == 'images':
                    self.responses[path] = {'owner': OWNER, 'items': [{'id': '00000000-0000-4000-8000-000000000001',
                        'studyUid': uid, 'kind': 'external-image', 'state': 'Closed', 'revision': 1,
                        'requester': {'actor': 'syn-author', 'name': 'SYN prior author'},
                        'counterparty': {'text': 'SYN destination', 'institutionId': None},
                        'reason': 'SYN prior reason', 'handler': None, 'note': 'SYN prior note'}]}
                self.open()
                pick = self.page.locator(f'#studies tr[data-uid="{uid}"] button')
                pick.click()
                expect(self.page.locator('#report-state')).to_have_attribute('data-state', 'final')
                if label == 'timeline':
                    self.page.locator('#timeline-toggle').click()
                    expect(self.page.locator('#timeline-list > li')).to_have_count(2)
                if label in ['questions', 'images']:
                    summary = '#questions-summary' if label == 'questions' else '#image-requests-summary'
                    self.page.locator(summary).click()
                    rows_selector = '#question-list > li' if label == 'questions' else '#image-request-list > li'
                    expect(self.page.locator(rows_selector)).to_have_count(1)
                self.hold(path, 'headers', {'message': 'SYN read refused'}, 403)
                if label == 'studies': self.page.locator('#refresh').click()
                elif label == 'report': pick.click()
                elif label == 'timeline':
                    self.page.locator('#timeline-toggle').click()
                    self.page.locator('#timeline-toggle').click()
                else:
                    self.page.locator(summary).click()
                    self.page.locator(summary).click()
                self.page.wait_for_function('synRelease !== null')
                self.page.evaluate('synRelease()')
                state = {'studies': '#list-state', 'report': '#report-state', 'timeline': '#timeline-state',
                         'questions': '#questions-state', 'images': '#image-requests-state'}[label]
                expect(self.page.locator(state)).to_contain_text('SYN read refused')
                for control in self.page.locator(controls).all(): expect(control).to_be_disabled()
                if label in ['questions', 'images']:
                    expect(self.page.locator(rows_selector)).to_have_count(0)
                    expect(self.page.locator(target + ' button')).to_have_count(0)
                    self.assertNotIn('SYN prior', self.page.locator(target).inner_text())
                else:
                    expect(self.page.locator(target + ' > *')).to_have_count(0)
                self.assert_work_stays()
                self.page.reload()
                expect(self.page.locator('#studies tr')).not_to_have_count(0)
                self.page.locator(f'#studies tr[data-uid="{uid}"] button').click()
                expect(self.page.locator('#report-state')).to_have_attribute('data-state', 'final')
                if label == 'timeline':
                    self.page.locator('#timeline-toggle').click()
                    expect(self.page.locator('#timeline-list > li')).to_have_count(2)
                elif label in ['questions', 'images']:
                    self.page.locator(summary).click()
                    expect(self.page.locator(rows_selector)).to_have_count(1)
                self.assert_work_stays()

    def test_write_403_keeps_clinician_editors_and_report(self):
        for operation in ['question', 'image']:
            with self.subTest(panel=operation):
                self.fresh('clinician'); self.open(); uid = self.pick()
                suffix = 'questions' if operation == 'question' else 'image-requests'
                self.page.locator('#' + suffix + ' summary').click()
                field = '#question-ask-text' if operation == 'question' else '#image-request-reason-new'
                expect(self.page.locator(field)).to_be_visible()
                self.page.locator(field).fill('SYN retained edit')
                if operation == 'image': self.page.locator('#image-request-counterparty-new').fill('SYN ward')
                before = self.page.locator('#report-body').inner_html()
                self.hold('/api/studies/' + uid + '/' + suffix, 'headers', {'message': 'SYN write refused'}, 403)
                self.page.locator('.question-compose[data-action=ask] [data-send]' if operation == 'question'
                                  else '#image-request-new [data-send]').click()
                self.page.wait_for_function('synRelease !== null')
                self.page.evaluate('synRelease()')
                expect(self.page.locator('#' + suffix)).to_contain_text('SYN write refused')
                expect(self.page.locator(field)).to_be_enabled()
                self.assertEqual('SYN retained edit', self.page.locator(field).input_value())
                self.assertEqual(before, self.page.locator('#report-body').inner_html())
                self.assert_work_stays()

    def test_admin_permission_and_study_access_writes(self):
        for operation in ['permission','access','create','password']:
            for cut in ['headers','body','error']:
                with self.subTest(operation=operation,cut=cut):
                    self.fresh('admin'); self.open()
                    member = MEMBERS['users'][0]
                    path='/api/admin/users/'+member['id']
                    if operation=='permission':
                        self.page.get_by_role('button',name='Change Membership',exact=True).click()
                        self.page.locator('#membership-form input[name=institution]').fill('SYN-CHANGED')
                        self.hold(path,cut)
                        self.page.locator('#membership-form button[type=submit]').click()
                    elif operation=='access':
                        self.page.get_by_role('button',name='Study Access',exact=True).click()
                        expect(self.page.locator('#study-access-dialog [data-editor]')).to_be_enabled()
                        self.page.locator('#study-access-dialog [name=reason]').fill('SYN reason')
                        self.hold(path+'/study-access',cut,{**ACCESS,'owner':OWNER,'revision':2})
                        self.page.get_by_role('button',name='Save Access').click()
                    elif operation=='create':
                        self.page.locator('#open-create').click()
                        for name,value in {'username':'syn-new','email':'syn@local.test','firstName':'SYN','lastName':'New'}.items():
                            self.page.locator('#create-form [name='+name+']').fill(value)
                        self.hold('/api/admin/users',cut,{'temporaryPassword':'SYN late secret'})
                        self.page.locator('#create-form button[type=submit]').click()
                    else:
                        self.hold(path+'/reset-password',cut,{'temporaryPassword':'SYN late secret'})
                        self.page.get_by_role('button',name='Temp Password',exact=True).click()
                    self.page.wait_for_function('synRelease !== null')
                    self.close_and_check('notice')

    def pick(self):
        uid=ROWS[0]['uid']
        self.page.locator('#studies tr[data-uid="'+uid+'"]').click()
        return uid

    def test_clinician_report_question_request_and_inbox_end_cuts(self):
        for operation in ['report','question','image','critical']:
            for cut in ['headers','body','error']:
                for mode in ['logout','notice','replace']:
                    with self.subTest(operation=operation,cut=cut,end=mode):
                        self.fresh('clinician'); self.open()
                        uid=ROWS[0]['uid']
                        if operation=='report':
                            self.hold('/api/clinician/studies/'+uid+'/report',cut,REPORTS[uid]); self.pick()
                        elif operation in ['question','image']:
                            self.pick()
                            suffix='questions' if operation=='question' else 'image-requests'
                            self.hold('/api/studies/'+uid+'/'+suffix,cut,{'owner':OWNER,'items':[]})
                            self.page.locator('#'+suffix+' summary').click()
                        else:
                            self.hold('/api/critical-results',cut,{'owner':OWNER,'view':'received','items':[],'nextCursor':None,'pending':0})
                            self.page.locator('#critical-results').get_by_role('button',name='Refresh',exact=True).click()
                        self.page.wait_for_function('synRelease !== null'); self.close_and_check(mode)

    def test_clinician_writes_end_before_late_receipts_or_errors(self):
        for operation in ['question','image']:
            for cut in ['headers','body','error']:
                with self.subTest(operation=operation,cut=cut):
                    self.fresh('clinician'); self.open(); uid=self.pick()
                    suffix='questions' if operation=='question' else 'image-requests'
                    self.page.locator('#'+suffix+' summary').click()
                    field = '#question-ask-text' if operation=='question' else '#image-request-reason-new'
                    expect(self.page.locator(field)).to_be_visible()
                    self.page.locator(field).fill('SYN pending edit')
                    if operation=='image':
                        self.page.locator('#image-request-counterparty-new').fill('SYN ward')
                    self.page.evaluate('x => synArm(x)',dict(path='/api/studies/'+uid+'/'+suffix,cut=cut,
                                                             receipt=operation,uid=uid,status=201))
                    self.page.locator('.question-compose[data-action=ask] [data-send]' if operation=='question'
                                      else '#image-request-new [data-send]').click()
                    self.page.wait_for_function('synRelease !== null')
                    self.close_and_check('notice')

    def test_s1_late_answer_and_notice_leave_s2_document_unchanged(self):
        for kind in ['admin','clinician']:
            with self.subTest(page=kind):
                self.fresh(kind); self.open()
                path='/api/admin/users' if kind=='admin' else '/api/clinician/studies'
                self.hold(path,'headers',{'code':'AUTH_SESSION_ENDED'},401,'AUTH_SESSION_ENDED')
                self.page.locator('#refresh').click()
                old=self.page
                self.session='SYN-PAGES-S2'
                self.page=self.context.new_page()
                self.page.on('pageerror',lambda e:self.errors.append(str(e)))
                self.open()
                before=self.page.locator('body').inner_html()
                old.evaluate('synRelease()')
                self.pump(lambda:bool(self.moves))
                self.page.wait_for_timeout(100)
                self.assertEqual('active',self.page.evaluate('KinWorkContext.state()'))
                self.assertEqual('SYN-PAGES-S2',self.page.evaluate('KinAuth.sessionId()'))
                self.assertEqual(before,self.page.locator('body').inner_html())
                self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))

    def test_plain_failures_and_foreign_notices_keep_both_documents(self):
        for kind in ['admin','clinician']:
            for status in [401,403,409,428,500,503]:
                with self.subTest(page=kind,status=status):
                    self.fresh(kind,'SYN-PAGES-S2'); self.open(); self.cancel_moves=True
                    path='/api/admin/users' if kind=='admin' else '/api/clinician/studies'
                    self.hold(path,'headers',{'message':'SYN refused'},status)
                    self.page.locator('#refresh').click()
                    self.page.evaluate("() => { const c=new BroadcastChannel('kin-session'); c.postMessage({type:'session-ended',session:'SYN-PAGES-S1'}); c.postMessage({type:'session-ended'}); c.close(); localStorage.setItem('kin-session-ended','legacy'); synRelease(); }")
                    self.page.wait_for_timeout(80)
                    self.assertEqual('active',self.page.evaluate('KinWorkContext.state()'))
                    self.assertEqual(0,len(self.moves))
                    self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))
                    text=self.page.locator('#message' if kind=='admin' else '#list-state').inner_text()
                    self.assertIn('SYN refused',text)

    def test_missed_notice_first_request_and_bound_headers(self):
        for kind in ['admin','clinician']:
            for status,code in [(401,'AUTH_SESSION_ENDED'),(409,'AUTH_SESSION_MISMATCH')]:
                with self.subTest(page=kind,code=code):
                    self.fresh(kind); self.open()
                    path='/api/admin/users' if kind=='admin' else '/api/clinician/studies'
                    self.hold(path,'headers',{'code':code},status,code)
                    self.page.locator('#refresh').click()
                    self.page.evaluate('() => { synWatch(); synRelease(); }')
                    self.pump(lambda:self.moves and len(self.probes)>5)
                    self.assertNotEqual('active',self.probes[-1]['work'])
                    self.assertEqual(self.probes[-1]['protectedRows'],0)
                    self.assertEqual(len(self.moves),1)
                    record=json.loads(self.probes[-1]['storage'][0]).get('kin-session-end')
                    if code=='AUTH_SESSION_ENDED':
                        self.assertEqual(json.loads(record)['status'],'confirmed')
                        self.assertEqual(json.loads(record)['session'],SESSION)
                    else:
                        self.assertIsNone(record)
                    self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))
                    issued=[r for r in self.probes[-1]['seen'] if r['path']==path]
                    self.assertTrue(issued)
                    self.assertTrue(all(r['session']==SESSION for r in issued))

    def test_two_server_ends_without_channel_leave_once(self):
        for kind in ['admin','clinician']:
            with self.subTest(page=kind):
                self.fresh(kind,init='window.BroadcastChannel = undefined;'); self.open()
                path='/api/admin/users' if kind=='admin' else '/api/clinician/studies'
                for first in [True,False]:
                    self.hold(path,'headers',{'code':'AUTH_SESSION_ENDED'},401,'AUTH_SESSION_ENDED')
                    self.page.locator('#refresh').click()
                    self.page.wait_for_function('typeof synRelease === "function"')
                    if first: self.page.evaluate('() => { window.synFirstRelease=synRelease; synRelease=null; }')
                issued=self.page.evaluate('path => synSeen.filter(r=>r.path===path)',path)
                self.assertEqual(len(issued),3,'initial list plus two real pending refreshes')
                self.assertTrue(all(r['session']==SESSION for r in issued))
                self.page.evaluate('() => { synWatch(); synFirstRelease(); synRelease(); }')
                self.pump(lambda:self.moves and len(self.probes)>8)
                self.assertEqual(len(self.moves),1,'two ended responses must leave only once without BroadcastChannel')
                self.assertEqual(self.probes[-1]['protectedRows'],0)
                record=json.loads(json.loads(self.probes[-1]['storage'][0])['kin-session-end'])
                self.assertEqual((record['session'],record['status']),(SESSION,'confirmed'))
                self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))

    def test_pending_admin_bootstrap_never_reads_protected_panels(self):
        self.fresh('admin')
        self.me_status,self.me_code=403,'INSTITUTION_PENDING'
        self.me_extra={'kind':'member','sub':SUB,'user':'syn-user','institution':OWNER[0],
                       'roles':['admin'],'sessionId':SESSION}
        self.page.goto(ORIGIN+BASE+'admin.html')
        self.pump(lambda:bool(self.moves))
        for route in self.moves: self.complete_move(route)
        self.assertEqual([p for _,p,_ in self.calls if p.startswith('/api/')],['/api/me'])
        self.assertEqual(self.page.evaluate('KinAuth.session().state'),'pending')
        self.assertEqual(self.page.locator('#users tr,#gateway-rows > li,#metrics-rows tr,#audit-rows tr').count(),0)
        self.assertIsNone(self.page.evaluate("localStorage.getItem('kin-session-end')"))

    def test_notice_during_bootstrap_never_starts_protected_work(self):
        for kind in ['admin','clinician']:
            for cut in ['headers','body']:
                with self.subTest(page=kind,cut=cut):
                    me = {'kind':'member','sub':SUB,'institution':OWNER[0],'roles':[kind if kind=='admin' else 'clinician'],
                          'user':'syn-user','sessionId':SESSION}
                    init = 'synArm('+json.dumps(dict(path='/api/me',cut=cut,body=me))+');'
                    self.fresh(kind,init=init)
                    self.page.goto(ORIGIN+BASE+kind+'.html')
                    self.page.wait_for_function('synRelease !== null')
                    self.assertEqual(['/api/me'],self.page.evaluate("synSeen.map(r=>r.path).filter(p=>p.startsWith('/api/'))"))
                    self.page.evaluate("() => { synWatch(); const c=new BroadcastChannel('kin-session'); c.postMessage({type:'session-ended',session:'SYN-PAGES-S1',operation:88,status:'ending'}); c.close(); setTimeout(()=>synRelease(),80); }")
                    self.pump(lambda:self.moves and len(self.probes)>5)
                    self.assertFalse(any(p.startswith('/api/') and p!='/api/me' for _,p,_ in self.calls))
                    self.assertNotEqual('active',self.probes[-1]['work'])

    def test_timeout_keeps_document_and_back_checks_end_record(self):
        for kind in ['admin','clinician']:
            with self.subTest(page=kind,case='timeout'):
                # The transport keeps the timer functions it was created with (a viewer may later pause its own), so the
                # controlled clock has to be in place before the page builds its transport.
                self.fresh(kind); self.page.clock.install(); self.open()
                path='/api/admin/users' if kind=='admin' else '/api/clinician/studies'
                self.page.evaluate('synArm',dict(path=path,cut='headers',body={},respectAbort=True))
                self.page.locator('#refresh').click()
                self.page.wait_for_function('synRelease !== null')
                self.page.clock.run_for(61000)
                self.assertEqual('active',self.page.evaluate('KinWorkContext.state()'))
                self.assertEqual([],self.moves)
                text=self.page.locator('#message' if kind=='admin' else '#list-state').inner_text()
                self.assertIn('제한 시간' if kind=='admin' else '응답이 없어',text)
                self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))

            with self.subTest(page=kind,case='back'):
                self.fresh(kind); self.open()
                self.page.route(ORIGIN+'/outside', lambda r:r.fulfill(body='<title>Outside</title>'))
                self.page.goto(ORIGIN+'/outside')
                self.page.evaluate("localStorage.setItem('kin-session-end',JSON.stringify({session:'SYN-PAGES-S1',operation:77,status:'confirmed'}))")
                before=len(self.calls)
                # Real history navigation. Persisted pageshow is exercised separately because routing can disable BFCache.
                self.page.go_back(wait_until='commit')
                self.pump(lambda:self.moves)
                self.assertFalse(any(p.startswith('/api/admin/') or p.startswith('/api/clinician/')
                                     for _,p,_ in self.calls[before:]))

    def test_shared_inbox_uses_clinician_page_session_binding(self):
        self.fresh('clinician'); self.open()
        self.pump(lambda:any(p=='/api/critical-results' for _,p,_ in self.calls))
        requests=[session for _,path,session in self.calls if path=='/api/critical-results']
        self.assertTrue(requests)
        self.assertTrue(all(session==SESSION for session in requests),'shared inbox must use the page transport')

    def test_entry_no_session_storage_proof_and_bfcache_record(self):
        for kind in ['admin','clinician']:
            with self.subTest(page=kind,entry='absent'):
                self.fresh(kind); self.me_status=401
                self.page.goto(ORIGIN+BASE+kind+'.html')
                self.pump(lambda:any(p=='/api/auth/login' for _,p,_ in self.calls))
                self.assertFalse(any(p=='/api/auth/logout' for _,p,_ in self.calls))
            with self.subTest(page=kind,entry='unreadable'):
                denied="Object.defineProperty(window,'localStorage',{get(){throw Error('SYN denied')}});"
                self.fresh(kind,init=denied)
                self.page.goto(ORIGIN+BASE+kind+'.html',wait_until='commit')
                self.pump(lambda:self.moves)
                self.assertFalse(any(p.startswith('/api/') for _,p,_ in self.calls))
            with self.subTest(page=kind,entry='proof-final-document'):
                self.fresh(kind,init=denied)
                self.page.goto(ORIGIN+BASE+kind+'.html#kin-entry=SYN-once')
                expect(self.page.locator('#users tr' if kind=='admin' else '#studies tr')).not_to_have_count(0)
                self.assertEqual('',self.page.evaluate('location.hash'))
                self.assertEqual(1,sum(p=='/api/auth/entry' for _,p,_ in self.calls))
            with self.subTest(page=kind,entry='bfcache-record'):
                self.fresh(kind); self.open()
                self.page.evaluate("() => { synWatch(); localStorage.setItem('kin-session-end',JSON.stringify({session:KinAuth.sessionId(),operation:77,status:'confirmed'})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); }")
                self.pump(lambda:self.moves)


if __name__ == '__main__':
    unittest.main(verbosity=2)
