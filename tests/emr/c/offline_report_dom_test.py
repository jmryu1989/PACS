# coding: utf-8
"""EMR-C1 offline report DOM, C-D01..C-D06 (order §7): REQ-EMR-03/07/08/10/12/13/16 -> RISK-EMR-* -> TEST C-Dnn.

Loads the real, still unwired module worklist-v0/hpacs-lite/offline-report.js into Chromium inside an isolated harness
page (no main.html, no page boot, no network) and drives it through explicit synthetic ports: a view over real form
fields and a status region, a protected-store stand-in with a write fault, a signer stand-in that can be held, a server
transport whose answers can be held, lost or refused, and a context with owner, session epoch and current opening.
Assertions are about what the person sees and keeps (status region, field contents, report region), what crossed each
port, and the normal-path friction (one click, no dialog, no navigation, no extra window). The only visible texts
compared are the two labels the decisions prescribe: D594's disconnected-approval label and the order's §5.3
re-authentication label. The stand-ins prove the page logic, not native durability (C-NATIVE T1-T5).
"""
import json
import os
import sys
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "offline-report.js"
ORIGIN = "https://emr-c.test"
PAGE = "/harness/offline-report.html"
PENDING_LABEL = "승인 대기(단절)"  # D594: the required display for an approval stored while disconnected
REAUTH_LABEL = "재인증 후 전송"  # EMR-C order 5.3: a real session end holds the queue for re-authentication
HTML = """<!doctype html><html lang="ko"><meta charset="utf-8"><title>harness</title>
<label>Findings <textarea id="findings"></textarea></label>
<label>Conclusion <textarea id="conclusion"></textarea></label>
<label>Recommendation <textarea id="recommendation"></textarea></label>
<button id="approve" type="button">Approve</button>
<p id="status" role="status"></p>
<section id="report" aria-label="Report"></section>
<script src="offline-report.js"></script></html>"""

BOOT = r"""() => {
  const owner = id => ({ issuer: 'https://identity.example.test', subject: 'sub-' + id, institutionId: 'inst-a', deviceId: 'dev-' + id, osUserId: 'os-' + id });
  const b64 = value => { let s = ''; new TextEncoder().encode(JSON.stringify(value)).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = text => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), c => c.charCodeAt(0))));
  const syn = window.syn = { makeOwner: owner, owner: owner('r1'), online: false, epoch: 1, opening: { uid: '1.2.840.1', generation: 1 }, entries: new Map(),
    observations: [], calls: [], signRequests: [], holdSign: false, signHolds: [], putFault: false, leak: false, submitMode: 'commit', holdSubmit: false,
    submitHolds: [], holdRead: false, readHolds: [], cache: {}, printMode: 'return', seq: 0 };
  const field = id => document.querySelector('#' + id).value;
  const view = {
    readText: () => ({ findings: field('findings'), conclusion: field('conclusion'), recommendation: field('recommendation') }),
    status: document.querySelector('#status'),
    showReport: body => { document.querySelector('#report').textContent = body.text; },
    print: version => { syn.calls.push(['print', version.versionId]); return syn.printMode === 'return' ? Promise.resolve() : Promise.reject(new Error('cancelled')); },
  };
  // Stand-in for the native signer: it signs the request it was given, at the moment it runs.
  const build = req => {
    const n = ++syn.seq;
    return { formatVersion: 'emr-offline-queue/1', eventId: 'event-' + n, owner: { ...req.owner }, deviceSequence: n, predecessorEventId: null,
      envelope: { protected: 'header', payload: b64({ text: { kind: 'report', findings: req.text.findings, conclusion: req.text.conclusion, recommendation: req.text.recommendation } }), signature: 'signature' },
      access: { target: { studyId: req.uid, recordId: req.recordId, versionId: 'v-' + n } }, baseVersionId: null };
  };
  const signer = { sign(req) {
    syn.signRequests.push(req);
    if (!syn.holdSign) return Promise.resolve({ entry: build(req) });
    return new Promise(resolve => syn.signHolds.push(() => resolve({ entry: build(req) })));
  } };
  const store = {
    async enqueue(entry) { syn.calls.push(['enqueue', entry.eventId]); if (syn.putFault) throw new Error('disk full'); syn.entries.set(entry.eventId, entry);
      return { eventId: entry.eventId, entryId: 'row-' + entry.eventId, digest: 'd', durableAt: '2026-10-05T01:00:00.000Z' }; },
    async list(o) { syn.calls.push(['list', o.subject]); return [...syn.entries.values()].filter(e => syn.leak || e.owner.subject === o.subject); },
    async observe(o) { syn.observations.push(JSON.parse(JSON.stringify(o))); return { ok: true }; },
    async cached(uid) { syn.calls.push(['cached', uid]); return syn.cache[uid] ?? null; },
  };
  const answer = (entry, status, extra) => ({ eventId: entry.eventId, status, reason: null, recoveryRef: null, currentVersion: null,
    times: { signedAt: null, receivedAt: '2026-10-05T02:00:00.000Z', committedAt: null, publishedAt: null }, ...extra });
  const transport = {
    submit(entry) {
      syn.calls.push(['submit', entry.eventId, syn.epoch]);
      const respond = () => {
        if (syn.submitMode === 'ended') return Promise.reject({ status: 401, code: 'AUTH_SESSION_ENDED' });
        if (syn.submitMode === 'network') return Promise.reject({ kind: 'network' });
        if (syn.submitMode === 'conflict') return Promise.resolve(answer(entry, 'conflict', { reason: 'other-approved',
          currentVersion: { recordId: 'report-x', versionId: 'server-v', sha256: 'ab'.repeat(32) } }));
        return Promise.resolve(answer(entry, 'committed', {}));
      };
      if (!syn.holdSubmit) return respond();
      return new Promise((resolve, reject) => syn.submitHolds.push(() => respond().then(resolve, reject)));
    },
    read(uid) {
      syn.calls.push(['read', uid]);
      const body = { recordId: 'report-' + uid, versionId: 'v-read-' + syn.calls.length, text: 'SYN 판독 본문 ' + syn.calls.length };
      if (!syn.holdRead) return Promise.resolve(body);
      return new Promise(resolve => syn.readHolds.push(() => resolve(body)));
    },
  };
  const context = { owner: () => syn.owner, online: () => syn.online, session: () => ({ epoch: syn.epoch }), opening: () => syn.opening };
  syn.controller = KinOfflineReport.create({ view, store, signer, transport, context });
  syn.approve = () => syn.controller.approve({ uid: syn.opening.uid, recordId: 'report-' + syn.opening.uid, baseVersionId: null });
  document.querySelector('#approve').addEventListener('click', () => { syn.lastApproval = syn.approve(); });
  syn.signedText = eventId => unb64(syn.entries.get(eventId).envelope.payload).text;
  syn.submits = () => syn.calls.filter(c => c[0] === 'submit');
} """


class OfflineReportDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.outside = []
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.errors, self.dialogs, self.navigations = [], [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.page.goto(ORIGIN + PAGE)
        self.page.on("framenavigated", lambda frame: self.navigations.append(frame.url))
        self.page.evaluate(BOOT)

    def route(self, route):
        path = urlparse(route.request.url).path
        if route.request.url.startswith(ORIGIN) and path == PAGE:
            return route.fulfill(body=HTML, content_type="text/html; charset=utf-8")
        if route.request.url.startswith(ORIGIN) and path == "/harness/offline-report.js":
            return route.fulfill(body=MODULE.read_bytes(), content_type="application/javascript; charset=utf-8")
        self.outside.append(route.request.url)  # the module has no fetch of its own; anything else is a leak
        return route.abort()

    def tearDown(self):
        # Normal-path friction and isolation: no dialog, no navigation, one page, no request beyond the harness.
        self.assertEqual([], self.errors)
        self.assertEqual([], self.dialogs)
        self.assertEqual([], self.navigations)
        self.assertEqual(1, len(self.context.pages))
        self.assertEqual([], self.outside)
        self.context.close()

    def js(self, script, arg=None):
        return self.page.evaluate(script, arg)

    def status(self):
        return self.page.text_content("#status")

    def approve_click(self):
        self.page.click("#approve")
        return self.js("() => syn.lastApproval.then(state => ({ ...state }))")

    def test_d01_pending_is_not_published(self):
        self.page.fill("#findings", "SYN 소견")
        self.page.fill("#conclusion", "SYN 결론")
        state = self.approve_click()
        self.assertEqual(PENDING_LABEL, self.status())
        self.assertEqual([], self.js("() => syn.submits()"))
        self.assertEqual([state["eventId"]], self.js("() => [...syn.entries.keys()]"))
        self.assertEqual({"kind": "report", "findings": "SYN 소견", "conclusion": "SYN 결론", "recommendation": ""}, self.js("eventId => syn.signedText(eventId)", state["eventId"]))
        self.assertEqual(1, len(self.js("() => syn.signRequests")))
        # A failed durable write is not an approval: no pending label, nothing queued, the typed text stays.
        self.js("() => { syn.putFault = true; syn.opening = { uid: '1.2.840.2', generation: 2 }; }")
        self.page.fill("#findings", "SYN 두번째 소견")
        self.approve_click()
        self.assertNotEqual(PENDING_LABEL, self.status())
        self.assertEqual(1, self.js("() => syn.entries.size"))
        self.assertEqual("SYN 두번째 소견", self.page.input_value("#findings"))
        self.assertEqual([], self.js("() => syn.submits()"))

    def test_d02_later_text_survives(self):
        self.js("() => { syn.holdSign = true; }")
        self.page.fill("#findings", "SYN 승인 순간")
        self.page.click("#approve")
        self.page.wait_for_function("() => syn.signHolds.length === 1")
        self.page.fill("#findings", "SYN 승인 순간 그리고 이후 입력")
        self.js("() => syn.signHolds.shift()()")
        state = self.js("() => syn.lastApproval.then(state => ({ ...state }))")
        self.assertEqual("SYN 승인 순간", self.js("eventId => syn.signedText(eventId).findings", state["eventId"]))
        self.assertEqual("SYN 승인 순간 그리고 이후 입력", self.page.input_value("#findings"))
        self.assertEqual(PENDING_LABEL, self.status())
        self.js("() => { syn.online = true; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual([state["eventId"]], [c[1] for c in self.js("() => syn.submits()")])
        self.assertNotEqual(PENDING_LABEL, self.status())
        self.assertEqual("SYN 승인 순간 그리고 이후 입력", self.page.input_value("#findings"))

    def test_d03_aba_and_old_session_reply(self):
        self.js("""() => { syn.online = true; syn.holdRead = true; syn.opening = { uid: 'A', generation: 1 }; syn.first = syn.controller.open('A');
          syn.opening = { uid: 'B', generation: 2 }; syn.opening = { uid: 'A', generation: 3 }; syn.second = syn.controller.open('A'); }""")
        self.js("() => syn.readHolds.shift()()")
        self.assertIs(False, self.js("() => syn.first"))
        self.assertEqual("", self.page.text_content("#report"))
        self.assertEqual([], self.js("() => syn.observations"))
        self.js("() => syn.readHolds.shift()()")
        self.assertIs(True, self.js("() => syn.second"))
        shown = self.js("() => syn.observations")
        self.assertEqual(1, len(shown))
        self.assertEqual(self.page.text_content("#report").startswith("SYN 판독 본문"), True)
        # A reply addressed to the previous session must not mark the approval as applied.
        self.js("() => { syn.holdSubmit = true; }")
        self.page.fill("#findings", "SYN 이전 세션 승인")
        self.page.click("#approve")
        self.page.wait_for_function("() => syn.submitHolds.length === 1")
        self.js("() => { syn.epoch = 2; }")
        self.js("() => syn.submitHolds.shift()()")
        state = self.js("() => syn.lastApproval.then(state => ({ ...state }))")
        self.assertEqual(PENDING_LABEL, self.status())
        self.js("() => { syn.holdSubmit = false; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual([state["eventId"], state["eventId"]], [c[1] for c in self.js("() => syn.submits()")])
        self.assertNotEqual(PENDING_LABEL, self.status())

    def test_d04_end_reauth_and_other_account(self):
        self.js("() => { syn.online = true; syn.submitMode = 'network'; }")
        self.page.fill("#findings", "SYN 단절 중 승인")
        state = self.approve_click()
        self.assertEqual(PENDING_LABEL, self.status())  # a lost connection is not the end of the session
        self.js("() => { syn.submitMode = 'ended'; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual(REAUTH_LABEL, self.status())
        self.assertEqual([state["eventId"]], self.js("() => [...syn.entries.keys()]"))
        sent = len(self.js("() => syn.submits()"))
        # Another account on the same device neither sees nor sends the first clinician's queue.
        self.js("() => { syn.owner = syn.makeOwner('r2'); syn.epoch = 2; syn.submitMode = 'commit'; }")
        self.js("() => syn.controller.render()")
        self.assertEqual("", self.status())
        self.js("() => syn.controller.sync()")
        self.js("() => { syn.leak = true; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual(sent, len(self.js("() => syn.submits()")))
        # The same clinician's new session resumes with the original event.
        self.js("() => { syn.leak = false; syn.owner = syn.makeOwner('r1'); syn.epoch = 3; }")
        self.js("() => syn.controller.sync()")
        submits = self.js("() => syn.submits()")
        self.assertEqual([state["eventId"], 3], submits[-1][1:])
        self.assertNotIn(self.status(), (PENDING_LABEL, REAUTH_LABEL))
        self.assertEqual("SYN 단절 중 승인", self.page.input_value("#findings"))

    def test_d05_conflict_keeps_both_versions(self):
        self.js("() => { syn.online = true; syn.submitMode = 'conflict'; }")
        self.page.fill("#findings", "SYN 내 승인 원문")
        state = self.approve_click()
        self.assertEqual("conflict", state["status"])
        self.assertEqual("server-v", state["currentVersion"]["versionId"])
        self.assertEqual([state["eventId"]], self.js("() => [...syn.entries.keys()]"))
        self.assertEqual("SYN 내 승인 원문", self.js("eventId => syn.signedText(eventId).findings", state["eventId"]))
        self.assertEqual("SYN 내 승인 원문", self.page.input_value("#findings"))
        self.assertNotIn(self.status(), (PENDING_LABEL, REAUTH_LABEL, ""))
        self.js("() => { syn.submitMode = 'commit'; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual(1, len(self.js("() => syn.submits()")))  # no automatic resend or overwrite
        self.assertEqual("conflict", self.js("uid => syn.controller.state(uid).status", "1.2.840.1"))

    def test_d06_read_and_print_observations(self):
        self.js("() => { syn.online = true; syn.opening = { uid: 'S1', generation: 1 }; }")
        self.assertIs(True, self.js("() => syn.controller.open('S1')"))
        self.assertEqual([["read", "S1"]], [c for c in self.js("() => syn.calls") if c[0] == "read"])
        online = self.js("() => syn.observations")
        self.assertEqual(1, len(online))
        self.assertEqual(("client-shown", "online"), (online[0]["action"], online[0]["network"]))
        # Offline re-display from the device cache is a new access event each time, with no invented address.
        self.js("""() => { syn.online = false; syn.cache.S1 = { recordId: 'report-S1', versionId: 'v-cached', text: 'SYN 캐시 본문' };
          syn.opening = { uid: 'S1', generation: 2 }; }""")
        self.js("() => syn.controller.open('S1')")
        self.js("() => { syn.opening = { uid: 'S1', generation: 3 }; }")
        self.js("() => syn.controller.open('S1')")
        cached = self.js("() => syn.observations.slice(1)")
        self.assertEqual(2, len(cached))
        self.assertNotEqual(cached[0]["eventId"], cached[1]["eventId"])
        for row in cached:
            self.assertEqual(("client-shown", "offline", "not-observed", "v-cached"), (row["action"], row["network"], row["ip"], row["versionId"]))
        # Print is pinned to one version; a returned dialog is reported, never claimed as paper output.
        version = {"uid": "S1", "recordId": "report-S1", "versionId": "v-cached"}
        self.assertEqual("dialog-returned", self.js("v => syn.controller.print(v)", version))
        printed = self.js("() => syn.observations.slice(3)")
        self.assertEqual(["print-opened", "print-done"], [row["action"] for row in printed])
        self.assertEqual(["v-cached", "v-cached"], [row["versionId"] for row in printed])
        self.assertEqual(printed[0]["eventId"], printed[1]["relatedEventId"])
        self.assertEqual("not-observed", printed[1]["physicalOutput"])
        self.js("() => { syn.printMode = 'cancel'; }")
        self.assertEqual("cancelled", self.js("v => syn.controller.print(v)", version))
        after = self.js("() => syn.observations.slice(5)")
        self.assertEqual(["print-opened"], [row["action"] for row in after])


if __name__ == "__main__":
    unittest.main()
