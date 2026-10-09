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
  if (window.syn?.controller) window.syn.controller.dispose();
  document.querySelector('#report').textContent='';document.querySelector('#status').textContent='';
  const owner = id => ({ issuer: 'https://identity.example.test', subject: 'sub-' + id, institutionId: 'inst-a', deviceId: 'dev-' + id, osUserId: 'os-' + id });
  const b64 = value => { let s = ''; new TextEncoder().encode(JSON.stringify(value)).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = text => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), c => c.charCodeAt(0))));
  const syn = window.syn = { accountGeneration: 1, subscribers: [], timers: [], holdPut: false, putHolds: [], holdPrint: false, printHolds: [], session: { epoch: 1 }, makeOwner: owner, owner: owner('r1'), online: false, epoch: 1, opening: { uid: '1.2.840.1', generation: 1 }, entries: new Map(),
    observations: [], calls: [], signRequests: [], holdSign: false, signHolds: [], putFault: false, leak: false, submitMode: 'commit', holdSubmit: false,
    submitHolds: [], holdRead: false, readHolds: [], cache: {}, printMode: 'return', seq: 0, holdObserve: false, observeHolds: [], holdList: false, listHolds: [], holdCached: false, cachedHolds: [] };
  const field = id => document.querySelector('#' + id).value;
  const view = {
    readText: () => ({ findings: field('findings'), conclusion: field('conclusion'), recommendation: field('recommendation') }),
    status: document.querySelector('#status'),
    clearReport: () => { document.querySelector('#report').textContent = ''; },
    showReport: body => { document.querySelector('#report').textContent = body.text; },
    print: version => { syn.calls.push(['print', version.versionId]); const result = () => syn.printMode === 'return' ? Promise.resolve() : Promise.reject(new Error('cancelled')); if (syn.holdPrint) return new Promise((resolve,reject) => syn.printHolds.push(() => result().then(resolve,reject))); return result(); },
  };
  // Stand-in for the native signer: it signs the request it was given, at the moment it runs.
  const build = req => {
    const n = ++syn.seq;
    return { formatVersion: 'emr-offline-queue/1', eventId: 'event-' + n, owner: { ...req.owner }, deviceSequence: n, predecessorEventId: null,
      envelope: { protected: 'header', payload: b64({ eventId: 'event-' + n, studyId: req.uid, recordId: req.recordId, versionId: 'v-' + n, managingInstitutionId: req.owner.institutionId, deviceId: req.owner.deviceId, deviceSequence: n, predecessorEventId: null, signedAt: '2026-10-05T01:00:00.000Z', text: { kind: 'report', findings: req.text.findings, conclusion: req.text.conclusion, recommendation: req.text.recommendation } }), signature: 'signature' },
      access: { managingInstitutionId: req.owner.institutionId, target: { studyId: req.uid, recordId: req.recordId, versionId: 'v-' + n } }, baseVersionId: null };
  };
  const signer = { sign(req) {
    syn.signRequests.push(req);
    if (!syn.holdSign) return Promise.resolve({ entry: build(req) });
    return new Promise((resolve,reject) => syn.signHolds.push(mode => mode === 'throw' ? reject(new Error('sign failed')) : resolve({ entry: mode === 'mismatch' ? build({ ...req, text: { ...req.text, findings: 'other' } }) : build(req) })));
  } };
  const queueStates = new Map();
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const hashText = text => hash(new TextEncoder().encode(text));
  const digest = e => hashText(JSON.stringify(e));
  const store = {
    async enqueue(entry) { syn.calls.push(['enqueue', entry.eventId]); if (syn.putFault) throw new Error('disk full'); syn.entries.set(entry.eventId, entry);
      const receipt = { eventId: entry.eventId, entryId: 'row-' + entry.eventId, digest: await digest(entry), durableAt: '2026-10-05T01:00:00.000Z' };
      if (syn.holdPut) return new Promise((resolve,reject) => syn.putHolds.push(mode => mode === 'throw' ? reject(new Error('put failed')) : resolve(mode === 'mismatch' ? { ...receipt, eventId: 'wrong' } : receipt))); return receipt; },
    async list(o) {
      syn.calls.push(['list', o.subject]);
      const pick = () => [...syn.entries.values()].filter(e => syn.leak || e.owner.subject === o.subject);
      if (syn.holdList) return new Promise((resolve,reject) => syn.listHolds.push(mode => mode === 'throw' ? reject(new Error('list failed')) : resolve(pick())));
      return pick();
    },
    async observe(o) {
      if (syn.observeFault) throw new Error('store unavailable');
      syn.observations.push(JSON.parse(JSON.stringify(o)));
      if (syn.holdObserve) await new Promise((resolve,reject) => syn.observeHolds.push(mode => mode === 'throw' ? reject(new Error('observe failed')) : resolve()));
      return { ok: true };
    },
    async cached(uid) {
      syn.calls.push(['cached', uid]);
      if (syn.holdCached) return new Promise((resolve,reject) => syn.cachedHolds.push(mode => mode === 'throw' ? reject(new Error('cached failed')) : resolve(syn.cache[uid] ?? null)));
      return syn.cache[uid] ?? null;
    },
  };
  const answer = (entry, status, extra) => ({ eventId: entry.eventId, status, reason: null, recoveryRef: null, currentVersion: null,
    times: { signedAt: null, receivedAt: '2026-10-05T02:00:00.000Z', committedAt: null, publishedAt: null }, ...extra });
  const transport = {
    submit(entry) {
      syn.calls.push(['submit', entry.eventId, syn.epoch]);
      const respond = async () => {
        if (syn.submitMode === 'failed' || syn.submitMode === 'held') return Promise.resolve(answer(entry, syn.submitMode, { reason: 'predecessor-unresolved' }));
        if (syn.submitMode === 'ended') return Promise.reject({ status: 401, code: 'AUTH_SESSION_ENDED' });
        if (syn.submitMode === 'network') return Promise.reject({ kind: 'network' });
        if (syn.submitMode === 'mismatch') return Promise.reject({ status: 409, code: 'AUTH_SESSION_MISMATCH' });
        if (syn.submitMode === 'conflict') return Promise.resolve(answer(entry, 'conflict', { reason: 'other-approved',
          currentVersion: { recordId: 'report-x', versionId: 'server-v', sha256: 'ab'.repeat(32) } }));
        const payload=unb64(entry.envelope.payload), envelope=entry.envelope;
        const version={recordId:payload.recordId,versionId:payload.versionId,sha256:await hashText(JSON.stringify(payload))};
        const contentDigest=await hashText('signed:'+version.sha256+':'+await hashText(envelope.protected+'.'+envelope.payload+'.'+envelope.signature)+':clinical');
        const receipt={eventId:entry.eventId,contentDigest,recordId:payload.recordId,versionId:payload.versionId,ledgerReceipts:[{eventId:'ledger-'+entry.eventId,durableAt:'2026-10-05T02:00:00.000Z'}],committedAt:'2026-10-05T02:00:00.000Z',publishedAt:'2026-10-05T02:00:00.000Z'};
        const adoption={eventId:entry.eventId,studyId:payload.studyId,institutionId:payload.managingInstitutionId,version,signedAt:payload.signedAt,deviceId:payload.deviceId,deviceSequence:payload.deviceSequence,predecessorEventId:null,ancestors:[],receipt};
        return answer(entry, 'committed', { currentVersion: version, adoption, times: { signedAt: payload.signedAt, receivedAt: '2026-10-05T02:00:00.000Z', committedAt: receipt.committedAt, publishedAt: receipt.publishedAt } });
      };
      if (!syn.holdSubmit) return respond();
      return new Promise((resolve, reject) => syn.submitHolds.push(() => respond().then(resolve, reject)));
    },
    read(uid) {
      syn.calls.push(['read', uid]);
      const body = { recordId: 'report-' + uid, versionId: 'v-read-' + syn.calls.length, text: 'SYN 판독 본문 ' + syn.calls.length };
      if (!syn.holdRead) return Promise.resolve(body);
      return new Promise((resolve,reject) => syn.readHolds.push(mode => mode === 'throw' ? reject(new Error('read failed')) : resolve(body)));
    },
  };
  // Page isolation uses a queue-port stand-in; Q04/Q08 run this UI against the actual C queue and reconcile.
  store.queue = o => ({
    async enqueue(e) {
      try { const receipt = await store.enqueue(e); if (receipt.eventId !== e.eventId || receipt.digest !== await digest(e)) throw new Error('receipt');
        queueStates.set(e.eventId, { state: 'pending', evidence: null }); return { status: 'pending-offline', receipt: syn.badQueueReceipt ? {...receipt,eventId:'other-event'} : receipt }; }
      catch { return { status: 'not-saved' }; }
    },
    async send(t, session, control) {
      const entries = await store.list(o), result = [];
      for (const e of entries.sort((a,b) => a.deviceSequence-b.deviceSequence)) {
        if (!control.active()) return [];
        if (e.owner.subject !== o.subject) continue;
        const saved = queueStates.get(e.eventId) || { state: 'pending', evidence: null };
        if (['committed','conflict','refused'].includes(saved.state)) continue;
        control.changed(e, saved.state, saved.evidence);
        let state, evidence, retryable = false;
        try { evidence = await t.submit(e);
          state = { committed: 'committed', duplicate: 'committed', held: 'held', refused: 'refused', conflict: 'conflict', failed: 'pending' }[evidence.status];
          retryable = state === 'pending' || state === 'held';
        } catch (err) { state = err.kind === 'http' && [401,403,409].includes(err.status) ? 'awaiting-reauth' : 'sent-unknown'; retryable = state === 'sent-unknown'; }
        if (!control.active()) return [];
        queueStates.set(e.eventId, { state, evidence }); control.changed(e, state, evidence); result.push({ eventId: e.eventId, state, retryable });
        if (state === 'awaiting-reauth') break;
      }
      return result;
    },
  });
  syn.notify = () => syn.subscribers.forEach(f => f());
  const context = { accountGeneration: () => syn.accountGeneration, subscribe: f => { syn.subscribers.push(f); return () => { syn.subscribers = syn.subscribers.filter(x=>x!==f); }; }, owner: () => syn.owner, online: () => syn.online, session: () => { syn.session.epoch = syn.epoch; return syn.session; }, opening: () => syn.opening };
  syn.controller = KinOfflineReport.create({ view, store, signer, transport, context, scheduler: { schedule: (fn, ms) => { const h = { fn, ms }; syn.timers.push(h); return h; }, cancel: h => { syn.timers = syn.timers.filter(x=>x!==h); } } });
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

        # AC44: even a nominally successful queue port must acknowledge this exact event.
        self.js(BOOT)
        self.js('() => { syn.badQueueReceipt = true; }')
        mismatch = self.approve_click()
        self.assertEqual('not-saved', mismatch['status'], 'AC44 other event receipt is not my approval')

        # AC26: a delayed durable receipt, including failure, never erases subsequent typing.
        for outcome in ('ok', 'throw', 'mismatch'):
            self.js(BOOT)
            self.page.fill('#findings', 'SYN snapshot')
            self.js("() => { syn.holdPut = true; syn.delayed = syn.approve(); }")
            self.page.wait_for_function('() => syn.putHolds.length === 1')
            self.assertNotEqual(PENDING_LABEL, self.status(), 'AC26 durable receipt precedes pending')
            self.page.fill('#findings', 'SYN later input')
            self.js('mode => syn.putHolds.shift()(mode)', outcome)
            result = self.js('() => syn.delayed')
            self.assertEqual('pending-offline' if outcome == 'ok' else 'not-saved', result['status'], 'AC26 bad receipt never means pending')
            self.assertEqual('SYN later input', self.page.input_value('#findings'), 'AC26 later input survives')

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

        # AC17: approval lanes protect even the same owner/session/UID when older jobs finish last.
        for outcome in ('ok', 'throw', 'mismatch'):
            self.js(BOOT)
            self.js("() => { syn.holdSign = true; syn.old = syn.approve(); }")
            self.page.wait_for_function('() => syn.signHolds.length === 1')
            self.js("() => { syn.holdSign = false; syn.online = true; }")
            newest = self.js('() => syn.approve()')
            self.js('mode => syn.signHolds.shift()(mode)', outcome)
            self.js('() => syn.old')
            self.assertEqual(newest, self.js('() => syn.controller.state(syn.opening.uid)'), 'AC17 newest approval survives old job')

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
        self.assertEqual("stale", state["status"])
        self.assertEqual(1, len(set(c[1] for c in self.js("() => syn.submits()"))))
        self.assertNotEqual(PENDING_LABEL, self.status())
        # Account switch while a read is pending: the earlier account's body is never shown to the next account.
        self.js("""() => { syn.holdRead = true; syn.opening = { uid: 'C', generation: 10 }; syn.third = syn.controller.open('C'); }""")
        self.page.wait_for_function("() => syn.readHolds.length === 1")
        report_before = self.page.text_content("#report")
        self.js("() => { syn.owner = syn.makeOwner('r2'); syn.epoch = 9; syn.readHolds.shift()(); }")
        self.assertIs(False, self.js("() => syn.third"))
        self.assertEqual(report_before, self.page.text_content("#report"))
        # A->B->A while an offline cache display is being recorded: the earlier opening is not painted.
        self.js("""() => { syn.owner = syn.makeOwner('r1'); syn.epoch = 10; syn.online = false; syn.holdRead = false; syn.holdObserve = true;
          syn.cache.D = { recordId: 'report-D', versionId: 'v-d', text: 'SYN 이전 열기 본문' }; syn.opening = { uid: 'D', generation: 11 }; syn.fourth = syn.controller.open('D'); }""")
        self.page.wait_for_function("() => syn.observeHolds.length === 1")
        self.js("() => { syn.opening = { uid: 'E', generation: 12 }; syn.opening = { uid: 'D', generation: 13 }; syn.holdObserve = false; syn.observeHolds.shift()(); }")
        self.assertIs(False, self.js("() => syn.fourth"))
        self.assertNotEqual("SYN 이전 열기 본문", self.page.text_content("#report"))
        # A->B->A while the device cache is read: nothing is shown and no display is recorded for the earlier opening.
        observed = len(self.js("() => syn.observations"))
        self.js("() => { syn.holdCached = true; syn.opening = { uid: 'D', generation: 15 }; syn.fifth = syn.controller.open('D'); }")
        self.page.wait_for_function("() => syn.cachedHolds.length === 1")
        self.js("() => { syn.opening = { uid: 'E', generation: 16 }; syn.opening = { uid: 'D', generation: 17 }; syn.holdCached = false; syn.cachedHolds.shift()(); }")
        self.assertIs(False, self.js("() => syn.fifth"))
        self.assertEqual(observed, len(self.js("() => syn.observations")))
        # An older submission's answer never replaces the newer event's published reference.
        self.js("() => { syn.online = true; syn.opening = { uid: 'F', generation: 14 }; syn.holdSubmit = true; }")
        self.page.click("#approve")
        self.page.wait_for_function("() => syn.submitHolds.length === 1")
        self.js("() => { syn.firstApproval = syn.lastApproval; syn.holdSubmit = false; }")
        self.page.click("#approve")
        self.page.wait_for_function("() => syn.entries.size >= 3")
        self.js("() => syn.submitHolds.shift()()")
        newer = self.js("() => syn.lastApproval")
        self.js("() => syn.firstApproval.then(() => true)")
        latest = self.js("uid => ({ ...syn.controller.state(uid) })", "F")
        self.assertEqual(newer["eventId"], latest["eventId"])
        self.assertEqual(self.js("id => syn.entries.get(id).access.target.versionId", newer["eventId"]), latest["currentVersion"]["versionId"])

        # AC20: two reads of one opening are separate jobs, including a late failure.
        for outcome in ('ok', 'throw'):
            self.js(BOOT)
            self.js("() => { syn.online=true; syn.holdRead=true; syn.j1=syn.controller.open(syn.opening.uid); syn.j2=syn.controller.open(syn.opening.uid); }")
            self.js('() => syn.readHolds.pop()()')
            self.assertTrue(self.js('() => syn.j2'))
            latest = self.page.text_content('#report')
            self.js('mode => syn.readHolds.shift()(mode)', outcome)
            self.assertFalse(self.js('() => syn.j1'), 'AC20 earlier read is stale')
            self.assertEqual(latest, self.page.text_content('#report'), 'AC20 newest body survives old read')
        # AC18: authority generations must catch account ABA even when epoch/owner strings are restored.
        for port in ('Read', 'Cached'):
            for outcome in ('ok', 'throw'):
                self.js(BOOT)
                self.js("port => { syn.online=port==='Read'; syn['hold'+port]=true; syn.cache[syn.opening.uid]={recordId:'report-x',versionId:'cached',text:'old body'}; syn.old=syn.controller.open(syn.opening.uid); }", port)
                self.page.wait_for_function('port => syn[port.toLowerCase()+"Holds"].length === 1', arg=port)
                self.js("() => { const old={...syn.owner}; Object.assign(syn.owner,syn.makeOwner('r2')); syn.accountGeneration++; syn.controller.render(); syn.hidden=syn.controller.state(syn.opening.uid); Object.assign(syn.owner,old); syn.accountGeneration++; }")
                self.js('x => syn[x.port.toLowerCase()+"Holds"].shift()(x.outcome)', {'port':port,'outcome':outcome})
                self.assertFalse(self.js('() => syn.old'), 'AC18 account ABA suppresses old body')
                self.assertEqual('', self.page.text_content('#report'), 'AC18 no former account body')
                self.assertIsNone(self.js('() => syn.hidden.signedText'), 'AC18 getter excludes another owner')
        # AC19: offline observation continuation is subject to the same opening boundary, for resolve and reject.
        for outcome in ('ok','throw'):
            self.js(BOOT)
            self.js("() => { syn.holdObserve=true; syn.cache[syn.opening.uid]={recordId:'report-x',versionId:'cached',text:'old opening'}; syn.old=syn.controller.open(syn.opening.uid); }")
            self.page.wait_for_function('() => syn.observeHolds.length===1')
            self.js("() => { const uid=syn.opening.uid; syn.opening={uid:'other',generation:2}; syn.opening={uid,generation:3}; }")
            self.js('mode => syn.observeHolds.shift()(mode)',outcome)
            self.assertFalse(self.js('() => syn.old'),'AC19 old observation cannot paint')
            self.assertEqual('',self.page.text_content('#report'),'AC19 old opening body absent')

    def test_d04_end_reauth_and_other_account(self):
        # AC13/14: ABA with no intervening job still invalidates the original authority token.
        for change in ('aba','session'):
            self.js(BOOT)
            self.js('() => {syn.holdSign=true;syn.old=syn.approve();}')
            self.page.wait_for_function('() => syn.signHolds.length===1')
            self.js("change=>{if(change==='session'){syn.epoch++;syn.session.epoch=syn.epoch;}else{const old={...syn.owner};Object.assign(syn.owner,syn.makeOwner('r2'));syn.accountGeneration++;Object.assign(syn.owner,old);syn.accountGeneration++;}syn.signHolds.shift()();}",change)
            self.assertEqual('stale',self.js('() => syn.old.status || syn.old.then(x=>x.status)'),'AC13 authority generation defeats account ABA')
            self.assertEqual(0,self.js('() => syn.entries.size'),'AC13 stale signer starts no enqueue')
        self.js(BOOT)
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
        # A switch while the signature is pending stops that approval: nothing is stored or sent under the next account.
        stored, sent = self.js("() => syn.entries.size"), len(self.js("() => syn.submits()"))
        self.js("() => { syn.opening = { uid: 'G', generation: 20 }; syn.holdSign = true; syn.submitMode = 'commit'; }")
        self.page.click("#approve")
        self.page.wait_for_function("() => syn.signHolds.length === 1")
        self.js("() => { syn.owner = syn.makeOwner('r2'); syn.epoch = 4; syn.controller.render(); syn.signHolds.shift()(); syn.holdSign = false; }")
        self.js("() => syn.lastApproval.then(() => true)")
        self.assertEqual((stored, sent), (self.js("() => syn.entries.size"), len(self.js("() => syn.submits()"))))
        self.assertEqual("", self.status())
        # A switch while the queue listing is pending stops that sync.
        self.js("() => { syn.owner = syn.makeOwner('r1'); syn.epoch = 5; syn.online = false; syn.opening = { uid: 'H', generation: 21 }; }")
        self.page.fill("#findings", "SYN 대기 승인")
        pending = self.approve_click()
        self.assertEqual(PENDING_LABEL, self.status())
        self.js("() => { syn.online = true; syn.holdList = true; syn.pendingSync = syn.controller.sync(); }")
        self.page.wait_for_function("() => syn.listHolds.length === 1")
        sent = len(self.js("() => syn.submits()"))
        self.js("() => { syn.owner = syn.makeOwner('r2'); syn.epoch = 6; syn.listHolds.shift()(); }")
        self.js("() => syn.pendingSync.then(() => true)")
        self.assertEqual(sent, len(self.js("() => syn.submits()")))
        # U5's other session-end signal (403/409 AUTH_SESSION_MISMATCH) holds the queue for re-authentication like ENDED.
        self.js("() => { syn.owner = syn.makeOwner('r1'); syn.epoch = 7; syn.holdList = false; syn.submitMode = 'mismatch'; }")
        self.js("() => syn.controller.sync()")
        self.assertEqual(REAUTH_LABEL, self.status())
        self.assertIn(pending["eventId"], self.js("() => [...syn.entries.keys()]"))

        # AC13-16: same UID throughout; success, exception and malformed result at both asynchronous approval cuts.
        for port in ('Sign','Put'):
            for switch in ('account','aba','session'):
                for outcome in ('ok','throw','mismatch'):
                    self.js(BOOT)
                    self.js("port => { syn['hold'+port]=true; syn.old=syn.approve(); }",port)
                    self.page.wait_for_function('port => syn[port.toLowerCase()+"Holds"].length===1',arg=port)
                    self.js("x => { syn['hold'+x.port]=false; const old={...syn.owner}; if(x.switch==='session') {syn.epoch++; syn.session.epoch=syn.epoch;} else {Object.assign(syn.owner,syn.makeOwner('r2')); syn.accountGeneration++; if(x.switch==='aba'){Object.assign(syn.owner,old);syn.accountGeneration++;}} syn.online=true; }",{'port':port,'switch':switch})
                    newest=self.js('() => syn.approve()')
                    calls=self.js('() => syn.calls.length')
                    self.js('x => syn[x.port.toLowerCase()+"Holds"].shift()(x.outcome)',{'port':port,'outcome':outcome})
                    result=self.js('() => syn.old')
                    self.assertEqual('stale',result['status'],'AC13/14 old authority result is stale')
                    self.assertEqual(newest,self.js('() => syn.controller.state(syn.opening.uid)'),'AC15/16 newer account approval is unchanged')
                    self.assertEqual(calls,self.js('() => syn.calls.length'),'AC13/16 stale continuation starts no port call')
                    self.assertEqual('sub-r1',self.js('() => syn.signRequests[0].owner.subject'),'AC13 owner snapshot is immutable')
        # AC21: old queue recovery cannot repopulate or submit after another account approved the same UID.
        for outcome in ('ok','throw'):
            self.js(BOOT)
            self.js('() => syn.approve()')
            self.js('() => {syn.online=true;syn.holdList=true;syn.old=syn.controller.sync();}')
            self.page.wait_for_function('() => syn.listHolds.length===1')
            self.js("() => {syn.owner=syn.makeOwner('r2');syn.accountGeneration++;syn.holdList=false;}")
            newest=self.js('() => syn.approve()')
            sent=self.js('() => syn.submits().length')
            self.js('mode=>syn.listHolds.shift()(mode)',outcome)
            self.js('() => syn.old')
            self.assertEqual(newest,self.js('() => syn.controller.state(syn.opening.uid)'),'AC21 stale list leaves current state')
            self.assertEqual(sent,self.js('() => syn.submits().length'),'AC21 stale list dispatches nothing')
        # AC23: all old submit outcomes have zero effect after the new owner's job.
        for outcome in ('commit','failed','held','network','ended','mismatch'):
            self.js(BOOT)
            self.js('() => {syn.online=true;syn.holdSubmit=true;syn.old=syn.approve();}')
            self.page.wait_for_function('() => syn.submitHolds.length===1')
            self.js("() => {syn.owner=syn.makeOwner('r2');syn.accountGeneration++;syn.holdSubmit=false;}")
            newest=self.js('() => syn.approve()')
            self.js('mode=>{syn.submitMode=mode;syn.submitHolds.shift()();}',outcome)
            self.js('() => syn.old')
            self.assertEqual(newest,self.js('() => syn.controller.state(syn.opening.uid)'),'AC23 stale submit leaves newest state')
            self.assertEqual(0,self.js('() => syn.timers.length'),'AC23 stale submit schedules no retry')

        # AC37: authority notification alone releases abandoned progress, without a new approval.
        for port in ('Sign', 'Put'):
            for change in ('aba', 'session'):
                self.js(BOOT)
                self.page.fill('#findings', 'SYN retained input')
                self.js("port => { syn['hold'+port]=true; syn.old=syn.approve(); }", port)
                self.page.wait_for_function('port => syn[port.toLowerCase()+"Holds"].length===1', arg=port)
                self.js("change => { if(change==='session'){syn.epoch++;}else{const a={...syn.owner};Object.assign(syn.owner,syn.makeOwner('r2'));syn.accountGeneration++;syn.notify();Object.assign(syn.owner,a);syn.accountGeneration++;}syn.notify(); }", change)
                self.assertEqual('', self.status(), 'AC37 authority notification releases stale progress')
                self.js('port => syn[port.toLowerCase()+"Holds"].shift()()', port)
                self.js('() => syn.old')
                self.js('() => {syn.online=true;syn.notify();}')
                if port == 'Put':
                    self.page.wait_for_function("() => syn.controller.state(syn.opening.uid).status==='published'")
                    self.assertEqual('Approved', self.status(), 'AC37 recovered durable approval is visible')
                else:
                    self.assertEqual([], self.js('() => syn.submits()'))
                self.assertEqual('SYN retained input', self.page.input_value('#findings'))
                self.assertEqual(1, self.js('() => syn.signRequests.length'))
        # AC43/P5: same doctor's session renewal wakes the queue, preserving body and subsequent typing.
        self.js(BOOT)
        self.js('() => {syn.online=true;}')
        self.js('() => syn.controller.open(syn.opening.uid)')
        body = self.page.text_content('#report')
        self.js('() => {syn.online=false;}')
        self.approve_click()
        self.page.fill('#findings', 'SYN after approval')
        self.js('() => {syn.epoch++;syn.accountGeneration++;syn.online=true;syn.notify();}')
        self.page.wait_for_function("() => syn.controller.state(syn.opening.uid).status==='published'")
        self.assertEqual(body, self.page.text_content('#report'), 'AC43 same owner renewal preserves report body')
        self.assertEqual('SYN after approval', self.page.input_value('#findings'))
        self.js('() => syn.notify()')
        self.assertEqual(body, self.page.text_content('#report'), 'AC43 repeated notification preserves body')
        self.js("() => {Object.assign(syn.owner,syn.makeOwner('r2'));syn.accountGeneration++;syn.notify();}")
        self.assertEqual('', self.page.text_content('#report'), 'AC43 changed owner clears former report')

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
        # When the access event cannot be stored, an offline re-display and a print do not happen at all.
        self.js("""() => { syn.observeFault = true; syn.printMode = 'return'; syn.cache.S1 = { recordId: 'report-S1', versionId: 'v-cached', text: 'SYN 새 캐시 본문' };
          syn.opening = { uid: 'S1', generation: 4 }; }""")
        prints = len([c for c in self.js("() => syn.calls") if c[0] == "print"])
        self.assertIs(False, self.js("() => syn.controller.open('S1')"))
        self.assertNotEqual("SYN 새 캐시 본문", self.page.text_content("#report"))
        self.assertEqual("not-recorded", self.js("v => syn.controller.print(v)", version))
        self.assertEqual(prints, len([c for c in self.js("() => syn.calls") if c[0] == "print"]))

        # AC24: an opening/account change while recording print-opened never starts the old print.
        for change in ('opening','uid','account'):
            for outcome in ('ok','throw'):
                self.js(BOOT)
                self.js("() => {syn.holdObserve=true;syn.old=syn.controller.print({uid:syn.opening.uid,recordId:'report-x',versionId:'v-x'});}")
                self.page.wait_for_function('() => syn.observeHolds.length===1')
                self.js("change=>{if(change==='account'){syn.owner=syn.makeOwner('r2');syn.accountGeneration++;}else{syn.opening={...syn.opening,generation:2,uid:change==='uid'?'other':syn.opening.uid};}}",change)
                self.js('async mode=>{syn.observeHolds.shift()(mode);await Promise.resolve();await Promise.resolve();}',outcome)
                self.assertEqual([],self.js("() => syn.calls.filter(c=>c[0]==='print')"),'AC24 old print is not opened')
                self.js('() => syn.old')
        # AC25: already opened dialogs may finish; their stale callbacks cannot create new-owner observations.
        for outcome in ('return','cancel'):
            self.js(BOOT)
            self.js("() => {syn.holdPrint=true;syn.old=syn.controller.print({uid:syn.opening.uid,recordId:'report-x',versionId:'v-x'});}")
            self.page.wait_for_function('() => syn.printHolds.length===1')
            observed=self.js('() => syn.observations')
            self.js("mode=>{syn.owner=syn.makeOwner('r2');syn.accountGeneration++;syn.printMode=mode;syn.printHolds.shift()();}",outcome)
            self.assertEqual('cancelled',self.js('() => syn.old'),'AC25 stale print callback is cancelled')
            self.assertEqual(observed,self.js('() => syn.observations'),'AC25 stale dialog records no new observation')
        # A second print on the same owner/opening supersedes the old callback, including cancellation.
        for outcome in ('return','cancel'):
            self.js(BOOT)
            self.js("() => {syn.holdPrint=true;syn.v={uid:syn.opening.uid,recordId:'report-x',versionId:'v-x'};syn.old=syn.controller.print(syn.v);}")
            self.page.wait_for_function('() => syn.printHolds.length===1')
            self.js('() => {syn.newPrint=syn.controller.print(syn.v);}')
            self.page.wait_for_function('() => syn.printHolds.length===2')
            self.js('() => syn.printHolds.pop()()')
            self.assertEqual('dialog-returned',self.js('() => syn.newPrint'))
            observed=self.js('() => syn.observations')
            self.js('mode=>{syn.printMode=mode;syn.printHolds.shift()();}',outcome)
            self.assertEqual('cancelled',self.js('() => syn.old'),'AC25 replaced print callback is cancelled')
            self.assertEqual(observed,self.js('() => syn.observations'),'AC25 replaced dialog records no observation')


if __name__ == "__main__":
    unittest.main()
