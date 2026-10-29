"""Minhoon 7: real served OHIF presence, synthetic users and disconnects.

No replacement DOM, identity model, API controller or timer. Network failure and
Chromium page crash exercise the real heartbeat lease. Only this class is loaded.
"""
import json
import os
from pathlib import Path
import time
import unittest
import uuid

from playwright.sync_api import expect
from document_session import document_request
from test_s9_viewer_output_scope import ServedViewerFlow
from test_viewer_ux_priors import ViewerUXPriorsE2E
from test_prior_selection import canvas_ready


class ViewingPresenceE2E(ServedViewerFlow, ViewerUXPriorsE2E):
    def presence(self, fixtures, actor='jmryu'):
        response = self.stack.request('GET', '/presence?uids=' + ','.join(f.uid for f in fixtures), actor)
        self.assertEqual(response.status, 200, response.text)
        return response.body

    def names(self, fixture):
        return sorted(v['name'] for v in self.presence([fixture])['studies'][fixture.uid])

    def viewing_cell(self, page, fixture):
        headers = page.locator('#heads th').all_text_contents()
        return page.locator(f'#rows tr[data-uid="{fixture.uid}"]').get_by_role('cell').nth(headers.index('Viewing'))

    def until(self, observer, read, expected, timeout=20000):
        end = time.monotonic() + timeout / 1000
        while time.monotonic() < end:
            actual = read()
            if actual == expected:
                return
            observer.wait_for_timeout(100)
        self.assertEqual(read(), expected)

    def open_as(self, fixture, actor):
        work = self.login(actor)
        self.open_toolbar_group(work, '#image-opening-open')
        work.locator('#image-opening-open').click()
        work.get_by_label('Include Latest Prior', exact=True).uncheck()
        work.get_by_role('button', name='Done', exact=True).click()
        self.select(work, fixture)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        page.on('dialog', lambda dialog: dialog.accept())
        canvas_ready(page, 1)
        page.wait_for_function('''() => window.KinViewerUX &&
          !kinViewerHistoryWorkspaceState().busy && !kinViewerJobWorkspaceState().busy''')
        return work, page

    def test_presence_01_open_compare_switch_close_logout_and_scope(self):
        patient = 'PRESENCE-' + uuid.uuid4().hex[:12]
        current = self.ct(patient, 'presence current', '20260801')
        prior = self.ct(patient, 'presence prior', '20260701')
        self.seed_report(current)
        before = self.stack.request('GET', '/studies', 'doctor').body
        state = next(s for s in before['studies'] if s['uid'] == current.uid)
        reports = self.report_rows(current)
        work, viewer = self.open_as(current, 'doctor')
        second, other = self.open_as(current, 'doctor2')
        names = sorted(document_request(p, 'GET', self.stack.api + '/me').json()['displayName'] for p in [work, second])
        self.until(work, lambda: self.names(current), names)
        own_name = document_request(work, 'GET', self.stack.api + '/me').json()['displayName']
        other_name = document_request(second, 'GET', self.stack.api + '/me').json()['displayName']
        expect(self.viewing_cell(work, current)).to_have_text('Viewing: ' + other_name, timeout=15000)
        expect(self.viewing_cell(second, current)).to_have_text('Viewing: ' + own_name, timeout=15000)
        self.assertEqual(self.presence([current], 'kdoctor')['studies'], {})
        self.studies(viewer).get_by_role('button', name='D03A presence prior', exact=True).click()
        canvas_ready(viewer, 2)
        self.until(work, lambda: self.names(prior), [document_request(work, 'GET', self.stack.api + '/me').json()['displayName']])
        self.until(work, lambda: self.names(current), names)
        expect(self.viewing_cell(second, prior)).to_have_text('Viewing: ' + own_name, timeout=15000)
        expect(self.viewing_cell(work, prior)).to_have_text('')
        self.evidence(viewer, 'presence-two-displayed-studies')
        # A fresh worklist action replaces the named viewer with the selected study.
        self.select(work, prior)
        work.locator('#m-filmbox').click()
        canvas_ready(viewer, 1)
        self.until(work, lambda: self.names(current), [document_request(second, 'GET', self.stack.api + '/me').json()['displayName']])
        viewer.close()
        self.until(second, lambda: self.names(prior), [])
        expect(self.viewing_cell(second, prior)).to_have_text('', timeout=15000)
        response = document_request(second, 'POST', self.stack.api + '/auth/logout')
        self.assertIn(response.status, (200, 201, 204))
        self.until(work, lambda: self.names(current), [])
        after = next(s for s in self.stack.request('GET', '/studies', 'doctor').body['studies'] if s['uid'] == current.uid)
        self.assertEqual({k: after.get(k) for k in ['holder','rs','repDoc','confirm']},
                         {k: state.get(k) for k in ['holder','rs','repDoc','confirm']})
        self.assertEqual(self.report_rows(current), reports)

    def test_presence_02_real_cadence_network_reconnect_and_page_crash(self):
        study = self.ct('PRESENCE-' + uuid.uuid4().hex[:12], 'presence drop', '20260801')
        observer = self.login('doctor2')
        work, viewer = self.open_as(study, 'doctor')
        name = document_request(work, 'GET', self.stack.api + '/me').json()['displayName']
        self.until(observer, lambda: self.names(study), [name])
        expect(self.viewing_cell(observer, study)).to_have_text('Viewing: ' + name, timeout=15000)
        beats = []
        viewer.on('request', lambda request: beats.append(time.monotonic())
                  if request.method == 'POST' and request.url.endswith('/api/presence') and request.post_data_json.get('uids') else None)
        policy = self.presence([study])
        self.until(observer, lambda: len(beats) >= 3, True, timeout=4 * policy['heartbeatMs'])
        intervals = [round((b-a)*1000, 2) for a,b in zip(beats, beats[1:])]
        work.context.set_offline(True)
        lost = time.monotonic()
        self.until(observer, lambda: self.names(study), [], timeout=policy['expiresMs'] + 20000)
        network_drop = round((time.monotonic()-lost)*1000, 2)
        expect(self.viewing_cell(observer, study)).to_have_text('', timeout=15000)
        work.context.set_offline(False)
        self.until(observer, lambda: self.names(study), [name])
        expect(self.viewing_cell(observer, study)).to_have_text('Viewing: ' + name, timeout=15000)
        self.evidence(viewer, 'presence-network-reconnected')
        crashes = []
        viewer.once('crash', lambda _: crashes.append(time.monotonic()))
        try:
            # Page.crash never acknowledges its CDP command after the renderer
            # dies. Navigation observes the same real crash through Playwright's
            # page lifecycle and has the ordinary action timeout.
            viewer.goto('chrome://crash')
        except Exception as error:
            self.assertTrue(any(text in str(error).lower() for text in ['crash', 'closed', 'err_aborted']), str(error))
        self.until(observer, lambda: bool(crashes), True)
        self.until(observer, lambda: self.names(study), [], timeout=policy['expiresMs'] + 20000)
        crash_drop = round((time.monotonic()-crashes[0])*1000, 2)
        expect(self.viewing_cell(observer, study)).to_have_text('', timeout=15000)
        measured = {'heartbeat_ms': policy['heartbeatMs'], 'expiry_ms': policy['expiresMs'],
                    'observed_intervals_ms': intervals, 'network_drop_ms': network_drop,
                    'crash_drop_ms': crash_drop}
        folder = Path(os.environ['KIN_EVIDENCE_DIR'])
        (folder/'presence-timing.json').write_text(json.dumps(measured, indent=2), encoding='utf-8')
        print('PRESENCE_TIMING', json.dumps(measured), flush=True)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewingPresenceE2E(name) for name in loader.getTestCaseNames(ViewingPresenceE2E)
                              if name.startswith('test_presence_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
