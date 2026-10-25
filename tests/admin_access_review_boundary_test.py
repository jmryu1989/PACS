"""REQ-EMR-15/19 -> RISK-F-05 -> TEST-ACCESS-REVIEW-BOUNDARY.

Reuse B2's owned, synthetic PostgreSQL install and its normal runtime reader.
Never connects to a configured application database or production fixture.
"""
import json
import os
import subprocess
import time
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


class AccessReviewBoundary(PgLedgerFixture):
    def test_real_nest_and_pg_review(self):
        source = ROOT / 'tests/admin_access_review_boundary_test.cjs'
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(ROOT / 'tmp/access-review/spool'),
               'NODE_PATH': str(ROOT / 'api/node_modules'), 'KIN_ACCESS_REVIEW_BUILD': str(ROOT / 'api/dist')}
        evidence = ROOT / 'tmp/access-review' / self.token
        evidence.mkdir(parents=True)
        ready = evidence / 'ready.json'
        env.update(KIN_ACCESS_REVIEW_READY=str(ready), KIN_ACCESS_REVIEW_WEB=str(ROOT / 'worklist-v0/hpacs-lite'))
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network, '-p', '127.0.0.1::3000',
                       '--mount', 'type=bind,source=' + str(evidence) + ',target=/evidence',
                       '--mount', 'type=bind,source=' + str(ROOT / 'worklist-v0/hpacs-lite') + ',target=/worklist,readonly',
                       '-e', 'KIN_ACCESS_REVIEW_READY=/evidence/ready.json', '-e', 'KIN_ACCESS_REVIEW_WEB=/worklist', '--mount', 'type=bind,source=' + str(source) + ',target=/app/access-review.cjs,readonly',
                       '-e', 'DATABASE_URL=' + self.runtime_url, '-e', 'KIN_B2R_WITNESS_URL=' + self.witness_url,
                       '-e', 'KIN_ACCESS_REVIEW_BUILD=/app/dist', '-e', 'KIN_B2R_SPOOL=/tmp/access-review-spool',
                       self.image, 'node', '/app/access-review.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], str(source)]
        with (evidence / 'node.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 120
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.1)
                self.assertTrue(ready.exists(), (evidence / 'node.log').read_text())
                port = self.command(['docker', 'port', self.container + '-node', '3000/tcp']).stdout.strip().rsplit(':', 1)[1] if self.image else '3000'
                self.check_served_page('http://127.0.0.1:' + port, json.loads(ready.read_text()), evidence)
            finally:
                ready.with_suffix('.json.done').write_text('browser finished')
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.terminate(); process.wait(timeout=15)
        print((evidence / 'node.log').read_text())
        self.assertEqual(process.returncode, 0)

    def check_served_page(self, base, facts, evidence):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + '/worklist/admin.html')
                page.get_by_label('From (UTC)', exact=True).fill(facts['from'][:16])
                page.get_by_label('Until (UTC, exclusive)', exact=True).fill(facts['until'][:16])
                with page.expect_response(lambda r: 'report=access' in r.url) as response:
                    page.get_by_role('button', name='Load Review', exact=True).click()
                self.assertEqual(response.value.status, 200)
                body = response.value.json()
                self.assertEqual(body['institutionId'], 'SYN-A')
                self.assertTrue(any(row['eventId'] == facts['selfEventId'] for row in body['rows']))
                page.wait_for_function("document.getElementById('access-review-state').textContent === 'Partial'")
                self.assertIn('GET admin/audit', page.locator('#access-review-rows').inner_text())
                page.locator('#access-review').screenshot(path=str(evidence / 'served-review.png'))
                page.get_by_label('Events', exact=False).select_option('files')
                with page.expect_response(lambda r: 'report=access' in r.url) as response:
                    page.get_by_role('button', name='Load Review', exact=True).click()
                files = response.value.json()
                self.assertEqual(response.value.status, 200)
                self.assertEqual([row['result'] for row in files['rows']], ['aborted', 'prepared'])
                page.wait_for_function("document.getElementById('access-review-state').textContent === 'Loaded'")
                text = page.locator('#access-review-rows').inner_text()
                self.assertIn('prepared', text); self.assertIn('aborted', text)
                page.locator('#access-review').screenshot(path=str(evidence / 'served-candidates.png'))
                (evidence / 'served-responses.json').write_text(json.dumps({'review': body, 'files': files}, indent=2))
                self.assertEqual(errors, [])
            finally: browser.close()



if __name__ == '__main__': unittest.main()
