"""MH-1: the shipped worklist consumes synthetic presence through its real polling and column UI.

Assertions concern visible cells and HTTP requests. The server unit suite separately
checks subject exclusion and institution/study access; these responses are already scoped.
No LiveStack or original patient data is used.
"""
import json
import unittest
from urllib.parse import parse_qs

from playwright.sync_api import expect
from multi_institution_worklist_dom_test import (
    MultiInstitutionWorklist, Server, SESSION_A, DEFAULT_ORDER, ORIGIN, layout_key, row, until,
)


class PresenceServer(Server):
    def __init__(self):
        super().__init__(rows=[row('2.25.101', 'SYN-CURRENT'), row('2.25.102', 'SYN-PRIOR', rs='A')])
        # A writing lock alone must never be displayed as viewing.
        self.rows[0]['state']['holder'] = 'writer-without-viewer'
        self.people = {'2.25.101': ['SYN Colleague'], '2.25.102': ['SYN Colleague', '<img src=x onerror=window.synXss=1>']}
        self.presence_reads = []
        self.fail = False
        self.hold = False
        self.pending = []

    def static(self, route, path, entry, strict):
        # The worker uses the canonical production path even at the harness origin.
        if path == '/worklist/hpacs-lite/preload-worker.js':
            path = '/preload-worker.js'
        return super().static(route, path, entry, strict)

    def api(self, route, method, path, query, body, entry, answer):
        if method == 'GET' and path == '/api/presence':
            uids = parse_qs(query).get('uids', [''])[0].split(',')
            self.presence_reads.append(uids)
            payload = {'studies': {uid: [{'name': name, 'since': '2026-10-29T00:00:00Z'}
                                       for name in self.people.get(uid, [])] for uid in uids},
                       'heartbeatMs': 5000, 'expiresMs': 10000}
            if self.hold:
                self.pending.append((answer, payload))
                return
            return answer(503 if self.fail else 200, {} if self.fail else payload)
        return super().api(route, method, path, query, body, entry, answer)


class ViewingCellDOM(MultiInstitutionWorklist):
    def cell(self, screen, pid):
        return screen.data_row(pid).get_by_role('cell').nth(screen.heads().index('Viewing'))

    def test_viewing_all_rows_poll_clear_recover_and_escape(self):
        server = PresenceServer()
        screen = self.boot(server)
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('Viewing: SYN Colleague')
        expect(self.cell(screen, 'SYN-PRIOR')).to_have_text(
            'Viewing: SYN Colleague, <img src=x onerror=window.synXss=1>')
        self.assertEqual({'2.25.101', '2.25.102'}, set(server.presence_reads[-1]))
        self.assertEqual(0, self.cell(screen, 'SYN-PRIOR').locator('img').count())
        server.people = {'2.25.102': ['SYN New Reader']}
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('', timeout=12000)
        expect(self.cell(screen, 'SYN-PRIOR')).to_have_text('Viewing: SYN New Reader')
        server.fail = True
        expect(self.cell(screen, 'SYN-PRIOR')).to_have_text('', timeout=12000)
        server.fail = False
        expect(self.cell(screen, 'SYN-PRIOR')).to_have_text('Viewing: SYN New Reader', timeout=12000)
        screen.finish()

    def test_viewing_column_preferences_and_late_response_after_filter_aba(self):
        server = PresenceServer()
        prefs = {'version': 1, 'modes': {'Radiology': {'order': ['viewing'] + [k for k in DEFAULT_ORDER if k != 'viewing'], 'hidden': []},
                                        'Technician': {'order': [], 'hidden': []}}}
        screen = self.boot(server, storage={layout_key(SESSION_A): json.dumps(prefs)})
        self.assertEqual('Viewing', screen.heads()[0])
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('Viewing: SYN Colleague')
        server.hold = True
        until(lambda: len(server.pending) > 0, 10, 'pending presence poll')
        old_answer, old_payload = server.pending.pop(0)
        screen.page.get_by_role('textbox', name='ID Filter', exact=True).fill('SYN-PRIOR')
        screen.wait_rows(['SYN-PRIOR'])
        screen.page.get_by_role('textbox', name='ID Filter', exact=True).fill('')
        until(lambda: len(screen.column('ID')) == 2, 5, 'both rows restored')
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('')
        server.people = {}
        server.hold = False
        old_answer(200, old_payload)
        screen.page.wait_for_timeout(200)
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('')
        for answer, payload in server.pending:
            answer(200, {**payload, 'studies': {}})
        server.pending.clear()
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('')
        screen.page.wait_for_timeout(5500)
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('')
        screen.finish()

        prefs['modes']['Radiology']['hidden'] = ['viewing']
        hidden_server = PresenceServer()
        hidden = self.boot(hidden_server, storage={layout_key(SESSION_A): json.dumps(prefs)})
        self.assertNotIn('Viewing', hidden.heads())
        self.assertEqual([], hidden_server.presence_reads)
        hidden.finish()

    def test_viewing_stalled_read_expires_and_session_end_discards_response(self):
        server = PresenceServer()
        screen = self.boot(server)
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('Viewing: SYN Colleague')
        server.hold = True
        until(lambda: len(server.pending) > 0, 10, 'stalled poll')
        expect(self.cell(screen, 'SYN-CURRENT')).to_have_text('', timeout=10000)
        server.hold_landing = True
        peer = screen.page.context.new_page()
        peer.goto(ORIGIN + '/kin-emblem-j1.svg')
        peer.evaluate("""session => { const c = new BroadcastChannel('kin-session');
          c.postMessage({type:'session-ended', session, operation:Date.now(), status:'ending'}); c.close(); }""",
                      'SYN-SESSION-' + SESSION_A['sub'])
        expect(screen.page.locator('#rows')).to_be_empty()
        for answer, payload in server.pending:
            answer(200, payload)
        server.pending.clear()
        screen.page.wait_for_timeout(200)
        expect(screen.page.locator('#rows')).to_be_empty()
        screen.finish()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewingCellDOM(name) for name in loader.getTestCaseNames(ViewingCellDOM)
                              if name.startswith('test_viewing_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
