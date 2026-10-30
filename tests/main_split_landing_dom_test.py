"""C3-LIVE: current unsplit and delivered bundle have the same event behavior.

Historical original/approved/parent equality remains in main_split_historical.py.
This comparison includes every current listener; no W2 events are filtered out.
"""
import unittest
import main_early_input_dom_test as pre


def setUpModule():
    pre.Pages.open()


def tearDownModule():
    pre.Pages.close()


class CurrentLanding(pre.PreCase):
    both = pre.Registration.both

    def test_worker_uses_the_same_api_answers_and_session_checks_as_the_page(self):
        run = pre.Run(self, pre.Pages.current.layout('actual'), filters=(pre.SAVED,))
        run.booted()
        # The shipped worker's startup read must reach the existing synthetic server, including its 404 fallback.
        run.wait(lambda: any(r['path'] == '/api/preload/cache-key' and r['answered']
                             for r in run.worker_requests), 'preload session API answered')
        self.assertEqual([], run.errors)
        run.page.evaluate("""() => {
          const source = `onconnect = event => {
            const port = event.ports[0];
            port.onmessage = async event => {
              const {url, options} = event.data;
              try {
                const response = await fetch(url, options);
                port.postMessage({status: response.status, code: response.headers.get('X-KIN-Auth-Code'),
                                  body: await response.json()});
              } catch (_) { port.postMessage({aborted: true}); }
            };
            port.start();
          };`;
          window.workerProbe = new SharedWorker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
          window.workerAnswers = [];
          workerProbe.port.onmessage = event => workerAnswers.push(event.data);
          workerProbe.port.start();
        }""")

        def ask(path, session, method='GET', body=None):
            options = {'method': method, 'headers': {'X-KIN-Session': session}}
            if body is not None:
                options['headers']['Content-Type'] = 'application/json'
                options['body'] = pre.json.dumps(body)
            run.page.evaluate('request => workerProbe.port.postMessage(request)',
                              {'url': pre.h.ORIGIN + path, 'options': options})

        def answer(number):
            run.wait(lambda: run.page.evaluate('workerAnswers.length') == number, 'worker API reply')
            return run.page.evaluate('workerAnswers[workerAnswers.length - 1]')

        # An ordinary synthetic API hold remains pending for a worker until the same answer path runs.
        held = run.site.held_gets['/api/syn-held'] = []
        ask('/api/syn-held?source=worker', run.site.cookie)
        run.wait(lambda: bool(held), 'worker API held by the origin')
        self.assertEqual([], run.page.evaluate('workerAnswers'))
        run.site.answer(held.pop(), 503, {'message': 'SYN held response'})
        self.assertEqual({'status': 503, 'code': None, 'body': {'message': 'SYN held response'}}, answer(1))
        ask('/api/prefs?source=worker', run.site.cookie)
        self.assertEqual({'status': 200, 'code': None, 'body': {'filters': [pre.SAVED], 'templates': []}}, answer(2))
        ask('/api/prefs', 'SYN-WRONG-SESSION')
        refused = answer(3)
        self.assertEqual((409, 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_MISMATCH'),
                         (refused['status'], refused['code'], refused['body']['code']))
        ask('/api/syn-absent', run.site.cookie)
        missing = answer(4)
        self.assertEqual((404, 'SYN_NOT_STUBBED'), (missing['status'], missing['body']['code']))
        template = {'name': 'SYN Worker Template', 'findings': 'SYN worker text'}
        ask('/api/templates', run.site.cookie, 'POST', template)
        saved = answer(5)
        self.assertEqual(200, saved['status'])
        self.assertEqual([template], run.site.template_posts)
        self.assertEqual([saved['body']], run.site.templates)
        self.assertEqual([], run.errors)

    def test_hosted_request_contract_retains_multiplicity(self):
        from main_load_hosted import assert_script_requests, assert_account_requests
        baseline = [('GET', '/worklist/hpacs-lite/auth.js', '')]
        candidate = baseline + [('GET', '/worklist/hpacs-lite/'+name, '')
                                for name in ('main-split.bundle.js', 'worklist-folder-tree.js', 'study-panel.js', 'report-editor-frame.js',
                                             'study-transfer-local.js', 'related-report-mode.js', 'report-view-observation.js',
                                             'multi-study-view.js')]
        assert_script_requests(baseline, candidate, landing=True)
        for bad in (candidate[:-1], candidate+[candidate[-1]], candidate+[('GET','/extra.js','')]):
            with self.assertRaises(AssertionError):
                assert_script_requests(baseline, bad, landing=True)
        account = [('GET', '/api/me', '')]
        reads = account + [('GET', path, '') for path in ('/api/filter-folders', '/api/shared-filters')]
        assert_account_requests(account, reads)
        for bad in (reads[:-1], reads+[reads[-1]], reads+[('GET','/api/unknown','')]):
            with self.assertRaises(AssertionError):
                assert_account_requests(account, bad)

    def test_current_registration_dispatch_and_retry_schedule(self):
        for outcome in pre.Registration.OUTCOMES:
            for schedule in pre.SCHEDULES if outcome == pre.Registration.OUTCOMES[-1] else ('default',):
                with self.subTest(outcome=outcome, schedule=schedule):
                    base, (before, _, old_errors), (after, _, errors) = self.both(
                        'landing-C3', outcome, schedule=schedule, reference='current')
                    self.assertEqual([], old_errors)
                    self.assertEqual([], errors)
                    self.compare_phases(base, before, after, 'current unsplit to current bundle', dispatches=True)
                    for phase in before:
                        self.assertEqual(before[phase]['screen'], after[phase]['screen'])

    def test_current_held_input_and_leave(self):
        unsplit, bundled = pre.Pages.current.layout(0), pre.Pages.current.layout('actual')
        for hazard in pre.HAZARDS:
            with self.subTest(hazard=hazard):
                before = self.early(hazard, unsplit, hold=unsplit[1]['scripts'][-1])
                after = self.early(hazard, bundled, hold=bundled[1]['bundle'])
                self.assertEqual(before.errors, after.errors)
                self.assertEqual(before.early_screen, after.early_screen)
                self.assertEqual(before.final_screen, after.final_screen)
                self.assertEqual(before.dialogs, after.dialogs)
        self.assertEqual([], self.leaving(bundled, hold=bundled[1]['bundle']))

    test_delivered_asset_hash_is_bound_to_the_actual_body = pre.ActualLayout.test_delivered_asset_hash_is_bound_to_the_actual_body


if __name__ == '__main__':
    unittest.main(verbosity=2)
