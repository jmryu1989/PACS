# coding: utf-8
"""FC-071 (A1 unit 15, walk C-R01-033 #12-#13): the worklist PF cell shows the Preload queue on the shipped page.

The shipped worklist (main.html and its scripts, preload-queue.js included) boots against the in-test server of
multi_institution_worklist_dom_test.py. Playwright cannot answer a SharedWorker's own requests, so the preload worker is
the one thing replaced: an init script puts a SharedWorker double in its place that records what the page posts and lets
the case send the worker's 'state' messages (the shape preload-worker.js broadcast() sends; the worker's real progress
counts are checked in preload_worker_test.cjs). The reader selects a row, presses the existing Preload button and turns
the PF column on; the PF cell then follows the queue: Queued, 'Downloading NN%' from done/total, Ready, and back to '·'
when the queue no longer holds the study, while another row keeps '·'. Cells are found by their visible header.
Synthetic data only.
"""
import unittest

from playwright.sync_api import expect
import multi_institution_worklist_dom_test as mi
from multi_institution_worklist_dom_test import Server, row, until

STUDY, OTHER = '2.25.601', '2.25.602'
WORKER_DOUBLE = """(() => {
  const posted = [], ports = [];
  Object.defineProperty(window, '__synPreload', { value: {
    posted, state(studies, session) { for (const port of ports) port.onmessage?.({ data: { type: 'state', session, unavailable: null,
      budget: 1024 ** 3, used: 0, studies } }); } } });
  window.SharedWorker = function () {
    const port = { onmessage: null, start() {}, postMessage(message) { posted.push(JSON.parse(JSON.stringify(message))); } };
    ports.push(port); this.port = port;
  };
})();"""


def entry(status, done=0, total=0, reason=None):
    return {'uid': STUDY, 'label': 'SYN-PF-01', 'status': status, 'reason': reason, 'waiting': False, 'done': done,
            'total': total, 'bytes': 0, 'open': False, 'expiresAt': None}


class PreloadPfCellDOM(unittest.TestCase):
    # The harness's browser and boot, without inheriting its own cases.
    setUpClass = mi.MultiInstitutionWorklist.__dict__['setUpClass']
    tearDownClass = mi.MultiInstitutionWorklist.__dict__['tearDownClass']
    boot = mi.MultiInstitutionWorklist.boot

    def pf(self, screen, pid):
        return screen.data_row(pid).get_by_role('cell').nth(screen.heads().index('PF'))

    def test_pf_cell_follows_the_preload_queue(self):
        server = Server(rows=[row(STUDY, 'SYN-PF-01'), row(OTHER, 'SYN-PF-02')])
        original = mi.STORAGE_RECORDER
        mi.STORAGE_RECORDER = original + '\n' + WORKER_DOUBLE
        try:
            screen = self.boot(server)
        finally:
            mi.STORAGE_RECORDER = original
        page = screen.page
        screen.show_column('PF')
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')

        screen.data_row('SYN-PF-01').get_by_role('cell', name='SYN-PF-01', exact=True).click(modifiers=['Control'])
        page.get_by_role('button', name='Preload', exact=True).click()
        added = until(lambda: [m for m in page.evaluate('() => window.__synPreload.posted') if m['type'] == 'add'], 5, 'add')
        self.assertEqual([STUDY], [s['uid'] for s in added[0]['studies']])

        session = added[0]['session']
        self.assertTrue(session)
        send = lambda *studies, to=session: page.evaluate('([studies, to]) => window.__synPreload.state(studies, to)', [list(studies), to])
        send(entry('Queued'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Queued')
        send(entry('Downloading'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 0%')
        send(entry('Downloading', 1, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 33%')
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('·')
        send(entry('Downloading', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 100%')
        send(entry('Ready', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('·')
        # The panel the Preload button already had says the same.
        expect(page.get_by_text('Preload: 1 Ready', exact=True)).to_be_attached()

        # A redraw of the list (a filter) keeps the queue state; a failure shows its reason on the cell.
        screen.page.get_by_role('textbox', name='ID Filter', exact=True).fill('SYN-PF-01')
        screen.wait_rows(['SYN-PF-01'])
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        send(entry('Failed', reason='서버에 연결하지 못했습니다. 다시 시도하세요.'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Failed')
        expect(self.pf(screen, 'SYN-PF-01').get_by_title('서버에 연결하지 못했습니다. 다시 시도하세요.')).to_have_count(1)
        # The worker's queue of another session (another login in this browser) is not this reader's: '·'.
        send(entry('Ready', 3, 3), to='SYN-OTHER-SESSION')
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')
        send(entry('Ready', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        # A study the queue no longer holds (Clear All of another session, logout) shows '·' again.
        send()
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')
        screen.finish()


if __name__ == '__main__':
    unittest.main()
