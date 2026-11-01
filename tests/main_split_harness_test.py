# coding: utf-8
"""main_split_harness.WorkerNetwork: what a SharedWorker asks for is answered by the page's synthetic origin or reported,
never left waiting unreported - played against a scripted CDP session, without a browser.

The contract (Opus review of #296 efe708c, P3-1 and P3-2):
* a worker request's body reaches the page handler whole, also when CDP sends it only in postDataEntries (its postData
  field is deprecated and is left out of long bodies);
* a page handler whose own answer CDP refuses while the worker still waits fails the request and reports it unanswered;
* a worker that has gone is not reported, and a handler that cannot answer (a missing asset) is reported and failed.
"""
import base64
import json
import sys
import unittest

from playwright.sync_api import Error as PlaywrightError

import main_split_harness as sh

URL = "https://syn.test/api/preload/syn-body"


class Cdp:
    """The browser CDP session: the paused request belongs to a SharedWorker of context `ctx`."""

    def __init__(self, refuse_fulfill=False, worker_gone=False):
        self.refuse_fulfill, self.worker_gone, self.sent = refuse_fulfill, worker_gone, []

    def send(self, method, params=None):
        self.sent.append(method)
        if method == "Target.getTargetInfo":
            return {"targetInfo": {"type": "shared_worker", "browserContextId": "ctx"}}
        if method == "Fetch.fulfillRequest" and (self.refuse_fulfill or self.worker_gone):
            raise PlaywrightError("Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.")
        if method == "Fetch.failRequest" and self.worker_gone:
            raise PlaywrightError("Protocol error (Fetch.failRequest): Invalid InterceptionId.")
        return {}


def network(cdp, answer):
    net = object.__new__(sh.WorkerNetwork)
    net.cdp, net.reported = cdp, []
    net.contexts = {"ctx": (object(), answer, lambda method, url: net.reported.append((method, url)))}
    return net


def paused(request):
    return {"requestId": "interception-1", "frameId": "worker-1", "request": {"method": "POST", "url": URL, **request}}


def answer_json(route, request):
    route.fulfill(json={"seen": request.post_data_json})


class WorkerNetworkAnswers(unittest.TestCase):
    def test_a_body_sent_only_as_post_data_entries_reaches_the_handler_whole(self):
        body = json.dumps({"studies": ["1.2.840.9." + str(n) for n in range(2000)]})
        half = len(body) // 2
        entries = [{"bytes": base64.b64encode(part.encode()).decode()} for part in (body[:half], body[half:])]
        seen = []
        net = network(Cdp(), lambda route, request: seen.append(request.post_data_json) or answer_json(route, request))
        net._paused(paused({"hasPostData": True, "postDataEntries": entries}))
        self.assertEqual([json.loads(body)], seen)
        self.assertIn("Fetch.fulfillRequest", net.cdp.sent)
        self.assertEqual([], net.reported)

    def test_a_refused_answer_while_the_worker_waits_is_failed_and_reported(self):
        net = network(Cdp(refuse_fulfill=True), answer_json)
        net._paused(paused({"postData": "{}"}))
        self.assertEqual([("POST", URL)], net.reported)
        self.assertEqual("Fetch.failRequest", net.cdp.sent[-1])

    def test_a_gone_worker_is_not_reported(self):
        net = network(Cdp(worker_gone=True), answer_json)
        net._paused(paused({"postData": "{}"}))
        self.assertEqual([], net.reported)

    def test_a_handler_that_cannot_answer_is_reported_and_failed(self):
        def missing(route, request):
            raise FileNotFoundError("historical asset")
        net = network(Cdp(), missing)
        net._paused(paused({"postData": "{}"}))
        self.assertEqual([("POST", URL)], net.reported)
        self.assertEqual("Fetch.failRequest", net.cdp.sent[-1])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
