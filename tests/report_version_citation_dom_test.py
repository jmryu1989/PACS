# coding: utf-8
"""TEST-S3-U5b-HISTORY-CITATION-DOM: the shipped report-history block against a stubbed api.

REQ-S3-U5b-HISTORY-CITATION -> RISK-S3-U5b-WRONG-BODY / FALSE-EMPTY / CROSS-VERSION /
REVOKED-LINEAGE / IDENTIFIER-LEAK -> TEST-S3-U5b-HISTORY-CITATION-DOM.

The whole shipped history block is taken out of main.html as ONE slice - showHistory,
closeHistory, the answer predicate, the renderer and both addEventListener lines - and runs on a
blank page over the real #histmodal markup, the shipped report-citation.js and the shipped
report-preview.js formatter. The harness declares no history state and no close handler of its
own: it clicks the real #hist-close. That is deliberate, because the browser mutants break
exactly those statements, and a harness that owned them would report kills for its own code.

What is stubbed and therefore NOT proven here: `api()`. The stub reproduces the shape the
product's api() attaches to a failure (`.status`, main.html:1210,1227) so the 403/404/401 arms
travel the same branch, but the real fetch, the real logout on 401 and any server behaviour
belong to the live suite and stay unverified. No LiveStack, no database, no Orthanc, no DICOM.

Hosted only: this file has never run anywhere but the hosted runner's measurement step.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
# Named override, like tests/report_citation_dom_test.py:28. The mutant runner points this at a
# copy of main.html; the BASELINE goes through the same override so a broken override cannot
# manufacture kills.
MAIN = Path(os.environ.get("KIN_HISTORY_CITATION_MAIN",
                           ROOT / "worklist-v0" / "hpacs-lite" / "main.html")).read_text(encoding="utf-8")
CITATION_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js").read_text(encoding="utf-8")
PAPER_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-preview.js").read_text(encoding="utf-8")

UID = "1.2.3"
SERVER_ACTOR = "server-actor@kin"
SESSION_ACTOR = "session-actor@kin"
AUTHOR = "author-x@kin"
LIST_PATH = "/studies/%s/report/versions" % UID


def slice_between(source, start_marker, end_marker):
    start = source.index(start_marker)
    end = source.index(end_marker, start + len(start_marker))
    return source[start:end]


def extract_function(source, name):
    """The shipped function, brace matched past a destructured parameter list."""
    start = source.index("function %s(" % name)
    if source[max(0, start - 6):start] == "async ":
        start -= 6
    depth, quote, escaped, open_brace = 0, None, False, -1
    index = source.index("(", start)
    while index < len(source):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                open_brace = source.index("{", index)
                break
        index += 1
    if open_brace < 0:
        raise ValueError(name)
    depth, quote, escaped = 0, None, False
    for index in range(open_brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


# The end marker is the two-line composite: the following line in main.html is the bare "    /**"
# opener of the next comment, so a single-line marker would leave an unterminated block comment
# and every case would die before its first assertion.
HISTORY_BLOCK = slice_between(MAIN, "    // ── 판독문 이력 ──",
                              "    /**\n     * 판독문 textarea를 **스크립트로**")
HIST_HTML = slice_between(MAIN, '<div class="modal" id="histmodal"', "\n  </div>") + "\n  </div>"
DISPLAY_ACTOR_FN = extract_function(MAIN, "displayActor")

HARNESS = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="b-history">History</button>
HISTHTML
<script>
CITATIONJS
</script>
<script>
PAPERJS
</script>
<script>
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const RFIELDS = ["findings", "conclusion", "recommendation"];
const actorNames = new Map();
DISPLAYACTORFN
let serverMode = true;
let selectedUid = "UIDVALUE";
let alerts = [];
function alert(message) { alerts.push(message); }
// The session identity the product can reach. It is deliberately NOT the server-echoed actor:
// a mutant that builds the attribution line from the session must be observable, and without
// this object it would only throw a ReferenceError and be scored a survivor.
const KinAuth = { has: () => true, session: () => ({ state: "approved", institution: "kin", sub: "SESSIONACTOR" }) };

let apiCalls = [], apiQueue = {}, pending = [];
function apiPush(path, replies) { apiQueue[path] = (apiQueue[path] || []).concat(replies); }
function replyValue(reply) {
  // The product's api() attaches `.status` to a failed response and throws a TypeError for a
  // transport failure; the branches under test read exactly those two shapes.
  if (reply.status) throw Object.assign(new Error(reply.message || "실패"), { status: reply.status });
  if (reply.network) throw new TypeError("Failed to fetch");
  return reply.body;
}
async function api(method, path) {
  apiCalls.push(path);
  const queue = apiQueue[path] || [];
  const reply = queue.length > 1 ? queue.shift() : queue[0];
  if (!reply) throw Object.assign(new Error("unexpected request " + path), { status: 500 });
  if (reply.defer) return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
  return replyValue(reply);
}
window.settle = (index, reply) => {
  const slot = pending[index];
  try { slot.resolve(replyValue(reply)); } catch (error) { slot.reject(error); }
};
window.press = version => {
  const button = document.querySelector('.vcite-btn[data-version="' + version + '"]');
  const host = button.closest(".ver").querySelector(".vcite-host");
  return loadHistoryCitations(selectedUid, Number(version), host, button);
};
window.blockText = version => {
  const host = document.querySelector('.vcite-host[data-version="' + version + '"]');
  return host ? host.textContent : null;
};
window.blockLines = version => {
  const host = document.querySelector('.vcite-host[data-version="' + version + '"]');
  return host ? [...host.querySelectorAll("p")].map(p => p.textContent) : null;
};
window.blockHeadings = version => {
  const host = document.querySelector('.vcite-host[data-version="' + version + '"]');
  return host ? [...host.querySelectorAll("h5")].map(h => h.textContent) : null;
};
window.citationRequests = () => apiCalls.filter(path => path.includes("/report/versions/"));
HISTORYBLOCK
</script></body></html>"""


def harness():
    return (HARNESS
            .replace("HISTHTML", HIST_HTML)
            .replace("CITATIONJS", CITATION_JS)
            .replace("PAPERJS", PAPER_JS)
            .replace("DISPLAYACTORFN", DISPLAY_ACTOR_FN)
            .replace("HISTORYBLOCK", HISTORY_BLOCK)
            .replace("SESSIONACTOR", SESSION_ACTOR)
            .replace("UIDVALUE", UID))


def version_row(version, action="approve", findings="첫 줄\n둘째 줄"):
    return {"id": version, "uid": UID, "version": version, "action": action, "findings": findings,
            "conclusion": "", "recommendation": "", "reason": None, "author": AUTHOR,
            "at": "2026-09-19T05:00:00.000Z"}


VERSIONS = [version_row(9), version_row(7), version_row(3)]


def readable(presence="present", revision=31, index=0, field="findings", link="current", by=AUTHOR, **extra):
    entry = {"field": field, "findingRevision": revision, "sourceIndex": index,
             "linkStateAtInsert": link, "insertedAt": "2026-09-19T05:00:00.000Z",
             "insertedBy": by, "presence": presence}
    entry.update(extra)
    return entry


def reduced(field="findings", by=AUTHOR):
    return {"field": field, "insertedAt": "2026-09-19T05:00:00.000Z", "insertedBy": by,
            "state": "source-unavailable"}


def answer(version, entries, actor=SERVER_ACTOR, **overrides):
    value = {"version": version, "actor": actor, "entries": entries}
    value.update(overrides)
    return value


def citation_path(version):
    return "/studies/%s/report/versions/%d/citations" % (UID, version)


class ReportVersionCitationDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        self.assertEqual([], getattr(self, "errors", []), "the page reported an uncaught error")
        self.page.close()

    def start(self, replies=None):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(10000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(harness())
        self.assertEqual([], self.errors, "the generated harness did not start")
        self.assertEqual("function", self.page.evaluate("typeof showHistory"),
                         "the sliced product code did not define showHistory")
        self.assertEqual("function", self.page.evaluate("typeof closeHistory"),
                         "the sliced product code did not define closeHistory")
        self.reply({LIST_PATH: [{"body": VERSIONS}]})
        if replies:
            self.reply(replies)

    def reply(self, mapping):
        self.page.evaluate("m => { for (const [path, list] of Object.entries(m)) apiPush(path, list); }",
                           mapping)

    def open_history(self):
        self.page.evaluate("showHistory()")

    def press(self, version):
        self.page.evaluate("press(%s)" % json.dumps(str(version)))

    def text(self, version):
        return self.page.evaluate("blockText(%s)" % json.dumps(str(version)))

    def lines(self, version):
        return self.page.evaluate("blockLines(%s)" % json.dumps(str(version)))

    def test_01_a_pressed_version_draws_its_own_entries_and_the_server_actor(self):
        self.start({citation_path(3): [{"body": answer(3, [readable(), readable(revision=32, index=1)])}]})
        self.open_history()
        self.assertEqual(3, self.page.evaluate("document.querySelectorAll('.ver').length"))
        self.assertEqual([], self.page.evaluate("citationRequests()"),
                         "opening the history must read no citations at all")
        # The real wiring: the shipped listener on the shipped button.
        self.page.click('.vcite-btn[data-version="3"]')
        self.page.wait_for_selector('.vcite-host[data-version="3"] h5')
        lines = self.lines(3)
        self.assertEqual(["인용된 소견"], self.page.evaluate("blockHeadings('3')"))
        self.assertIn(SERVER_ACTOR, lines[0],
                      "the attribution line must name the server-echoed actor")
        self.assertNotIn(SESSION_ACTOR, " ".join(lines),
                         "the attribution line must name the server-echoed actor")
        # attribution + limitation + one line per entry + the present caveat.
        self.assertEqual(5, len(lines), "every readable entry of a version must keep its line")
        self.assertIn("소견 r31", lines[2])
        self.assertIn("소견 r32", lines[3])
        self.assertIn("넣은 문자열이 이 칸에 그대로 있습니다", lines[2])
        self.assertEqual([citation_path(3)], self.page.evaluate("citationRequests()"),
                         "only the pressed version is read")

    def test_02_a_version_with_no_citations_says_so(self):
        self.start({citation_path(7): [{"body": answer(7, [])}]})
        self.open_history()
        self.press(7)
        lines = self.lines(7)
        self.assertEqual(2, len(lines))
        self.assertIn("인용된 소견 없음", lines[1])

    def test_03_a_refusal_is_not_an_empty_list(self):
        self.start({citation_path(3): [{"status": 403, "message": "예비 판독(RS: P) 중입니다"}],
                    citation_path(7): [{"body": answer(7, [readable()])}]})
        self.open_history()
        self.press(3)
        text = self.text(3)
        self.assertIn("접근 권한 밖", text, "a refusal must never read as an empty citation list")
        self.assertNotIn("인용된 소견 없음", text, "a refusal must never read as an empty citation list")
        # The server's own message is not copied onto the screen.
        self.assertNotIn("예비 판독", text)
        # One version's refusal leaves the rest of the history alone.
        self.press(7)
        self.assertIn("소견 r31", self.text(7))
        self.assertEqual(3, self.page.evaluate("document.querySelectorAll('.ver').length"))
        self.assertTrue(self.page.evaluate("$('#histmodal').classList.contains('show')"))

    def test_04_failures_are_unknown_replace_what_they_showed_and_a_401_draws_nothing(self):
        self.start({citation_path(3): [{"body": answer(3, [readable()])},
                                       {"status": 404, "message": "그 판을 찾을 수 없습니다"}],
                    citation_path(7): [{"status": 500, "message": "서버 오류"}],
                    citation_path(9): [{"network": True},
                                       {"status": 401, "message": "세션이 만료되었습니다"}]})
        self.open_history()
        self.press(3)
        self.assertIn("소견 r31", self.text(3))
        # A re-press that now fails must REPLACE the earlier lines: leaving them would show a
        # reading that this reader can no longer make.
        self.press(3)
        text = self.text(3)
        self.assertIn("인용 증적을 확인하지 못했습니다", text,
                      "a repeated read that fails must replace what it showed before")
        self.assertNotIn("소견 r31", text,
                         "a repeated read that fails must replace what it showed before")
        self.assertNotIn("인용된 소견 없음", text)
        self.press(7)
        self.assertIn("인용 증적을 확인하지 못했습니다", self.text(7))
        self.assertNotIn("접근 권한 밖", self.text(7))
        self.press(9)
        self.assertIn("인용 증적을 확인하지 못했습니다", self.text(9))
        # 401: api() has already torn the session down, so no citation state is drawn at all.
        self.press(9)
        self.assertEqual([], self.page.evaluate("blockHeadings('9')"),
                         "a 401 must not draw a citation state")
        self.assertEqual("확인하는 중입니다", self.text(9), "a 401 must not draw a citation state")

    def test_05_each_block_speaks_the_presence_of_its_own_version(self):
        self.start({citation_path(3): [{"body": answer(3, [readable(presence="present")])}],
                    citation_path(7): [{"body": answer(7, [readable(presence="absent")])}]})
        self.open_history()
        self.press(3)
        self.press(7)
        self.assertIn("넣은 문자열이 이 칸에 그대로 있습니다", self.text(3),
                      "each block must speak the server presence for its own version")
        self.assertIn("넣은 문자열이 이 칸에 더는 없습니다", self.text(7),
                      "each block must speak the server presence for its own version")
        self.assertNotIn("더는 없습니다", self.text(3),
                         "each block must speak the server presence for its own version")

    def test_06_every_shape_the_answer_can_fail_is_unknown_and_never_empty(self):
        # C2 names three shapes for a readable entry the server could not count; all three have
        # to fail closed, because the formatter would otherwise print a line with no state claim
        # under a success heading.
        no_presence_key = readable()
        del no_presence_key["presence"]
        arms = [
            # 1. an answer that belongs to another version
            ({"body": answer(9, [readable()])},
             "an answer for another version must make the whole answer unknown"),
            # 2. a version that is not an integer
            ({"body": answer("3", [readable()])},
             "a version that is not an integer must make the whole answer unknown"),
            # 3. entries that are not a list
            ({"body": answer(3, {"0": readable()})},
             "an entries field that is not an array must make the whole answer unknown"),
            # 4. a null entry hiding inside a valid list
            ({"body": answer(3, [readable(), None])},
             "a null entry must make the whole answer unknown"),
            # 5. an entry whose field is not one of the three
            ({"body": answer(3, [readable(field="citations")])},
             "a malformed entry must make the whole answer unknown"),
            # 6. no server actor: the attribution line would name nobody
            ({"body": answer(3, [readable()], actor="")},
             "an answer without a server actor must make the whole answer unknown"),
            # 7. a readable entry the server could not count, in all three of its shapes
            ({"body": answer(3, [readable(presence=None)])},
             "an entry without a server presence must make the whole answer unknown"),
            ({"body": answer(3, [no_presence_key])},
             "an entry whose presence key is absent must make the whole answer unknown"),
            ({"body": answer(3, [readable(presence="maybe")])},
             "an entry with an out-of-vocabulary presence must make the whole answer unknown"),
        ]
        self.start({citation_path(3): [reply for reply, _ in arms]})
        self.open_history()
        for index, (_, message) in enumerate(arms):
            self.press(3)
            text = self.text(3)
            self.assertIn("인용 증적을 확인하지 못했습니다", text, message)
            self.assertNotIn("인용된 소견 없음", text, message)
            self.assertEqual([], [line for line in self.lines(3) if "소견 r" in line], message)

    def test_07_a_reduced_entry_keeps_its_line_and_claims_nothing(self):
        self.start({citation_path(3): [{"body": answer(3, [reduced(), readable(presence="absent")])}]})
        self.open_history()
        self.press(3)
        lines = self.lines(3)
        # attribution + limitation + two entries; no present line, so no caveat.
        self.assertEqual(4, len(lines), "a reduced entry must keep its line")
        self.assertIn("이 인용의 소견을 지금 확인할 수 없습니다", lines[2])
        self.assertNotIn("소견 r", lines[2], "a reduced entry states no revision or source")
        self.assertIn("넣은 문자열이 이 칸에 더는 없습니다", lines[3])

    def test_08_two_answers_arriving_out_of_order_stay_in_their_own_blocks(self):
        self.start({citation_path(3): [{"defer": True}], citation_path(7): [{"defer": True}]})
        self.open_history()
        self.page.click('.vcite-btn[data-version="3"]')
        self.page.click('.vcite-btn[data-version="7"]')
        self.page.wait_for_function("() => pending.length === 2")
        # The later request answers first.
        self.page.evaluate("settle(1, %s)" % json.dumps({"body": answer(7, [readable(revision=77)])}))
        self.page.evaluate("settle(0, %s)" % json.dumps({"body": answer(3, [readable(revision=31)])}))
        # Wait on a signal that does NOT depend on where the answers land: the product re-enables
        # each button just before it writes. Waiting for v3's heading instead would turn a block
        # that writes into the wrong host into a harness timeout - an ERROR carrying a crash
        # marker - and the assertion below, which is what this case is about, would never run.
        self.page.wait_for_function("() => document.querySelectorAll('.vcite-btn:disabled').length === 0")
        self.assertIn("소견 r31", self.text(3), "each version block must show its own answer")
        self.assertIn("소견 r77", self.text(7), "each version block must show its own answer")
        self.assertNotIn("소견 r77", self.text(3), "each version block must show its own answer")

    def test_09_closing_discards_the_blocks_and_no_late_answer_writes(self):
        self.start({citation_path(3): [{"body": answer(3, [readable()])}],
                    citation_path(7): [{"defer": True}]})
        self.open_history()
        self.press(3)
        self.assertIn("소견 r31", self.text(3))
        self.page.click('.vcite-btn[data-version="7"]')
        self.page.wait_for_function("() => pending.length === 1")
        # The real close handler, clicked.
        self.page.click("#hist-close")
        self.assertFalse(self.page.evaluate("$('#histmodal').classList.contains('show')"))
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#hist-body .vcite').length"),
                         "closing the history must discard every drawn citation block")
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#hist-body .ver').length"),
                         "closing the history must discard every drawn citation block")
        # A citation answer that arrives while the history is closed writes nothing.
        self.page.evaluate("settle(0, %s)" % json.dumps({"body": answer(7, [readable(revision=77)])}))
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#hist-body .vcite').length"),
                         "a late citation answer must not write into a closed history")
        self.assertNotIn("소견 r77", self.page.evaluate("$('#hist-body').textContent"),
                         "a late citation answer must not write into a closed history")
        # BOTH write sites of a superseded LIST read - the success and the failure - have their
        # own arm: one guard could be deleted while the other kept every case green. Two stale
        # reads are opened (pending[1], pending[2]; pending[0] is the citation read above) and the
        # third answers the current opening.
        self.page.evaluate("apiQueue[%s] = [{defer: true}, {defer: true}, {body: %s}]"
                           % (json.dumps(LIST_PATH), json.dumps(VERSIONS)))
        self.page.click("#b-history")
        self.page.click("#b-history")
        self.page.wait_for_function("() => pending.length === 3")
        self.open_history()
        self.page.wait_for_selector(".ver")
        # A stale SUCCESS carrying a list this history never asked for.
        self.page.evaluate("settle(1, %s)" % json.dumps({"body": [version_row(99)]}))
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('.ver[data-version=\"99\"]').length"),
                         "a superseded list success must not overwrite the current history")
        self.assertEqual(3, self.page.evaluate("document.querySelectorAll('.ver').length"),
                         "a superseded list success must not overwrite the current history")
        # A stale FAILURE, on the other write site.
        self.page.evaluate("settle(2, %s)" % json.dumps({"status": 500, "message": "옛 목록 실패"}))
        self.assertNotIn("옛 목록 실패", self.page.evaluate("$('#hist-body').textContent"),
                         "a superseded list failure must not overwrite the current history")
        self.assertEqual(3, self.page.evaluate("document.querySelectorAll('.ver').length"),
                         "a superseded list failure must not overwrite the current history")

    def test_10_no_identifier_or_sentence_reaches_the_history_markup(self):
        # Both sourceRef shapes the server can store, plus the identifiers a citation never
        # carries to a screen. None of them is read by the renderer; this pins that.
        job_leak = {"insertedText": "SENTINEL-TEXT", "cid": "SENTINEL-CID", "findingId": "SENTINEL-FID",
                    "sourceRef": {"kind": "job", "jobId": "SENTINEL-JOB", "markId": "SENTINEL-MARK",
                                  "sourceRevision": 918273},
                    "headRevisionAtInsert": 918273, "studyUid": "SENTINEL-STUDY-UID",
                    "seriesUid": "SENTINEL-SERIES-UID", "sopUid": "SENTINEL-SOP-UID"}
        item_leak = {"insertedText": "SENTINEL-TEXT-2", "cid": "SENTINEL-CID-2",
                     "findingId": "SENTINEL-FID-2",
                     "sourceRef": {"kind": "item", "itemId": "SENTINEL-ITEM", "sourceRevision": 918274}}
        self.start({citation_path(3): [{"body": answer(3, [
            readable(by='<b id="kin-x">주치의</b>', **job_leak),
            readable(revision=32, index=1, **item_leak)])}]})
        self.open_history()
        self.press(3)
        self.assertIn("소견 r31", self.text(3))
        # A name is user input and this screen is a record: it may only ever be a text node.
        self.assertEqual(0, self.page.evaluate("document.querySelectorAll('#kin-x').length"),
                         "an author name must reach the screen as text, never as markup")
        self.assertIn('<b id="kin-x">주치의</b>', self.text(3))
        markup = self.page.evaluate("$('#histmodal').innerHTML")
        for sentinel in ["SENTINEL-TEXT", "SENTINEL-TEXT-2", "SENTINEL-CID", "SENTINEL-CID-2",
                         "SENTINEL-FID", "SENTINEL-FID-2", "SENTINEL-JOB", "SENTINEL-MARK",
                         "SENTINEL-ITEM", "SENTINEL-STUDY-UID", "SENTINEL-SERIES-UID",
                         "SENTINEL-SOP-UID", "918273", "918274"]:
            self.assertNotIn(sentinel, markup, sentinel + " must never reach the history markup")
        # The rows the history already drew are untouched by the citation block.
        self.assertEqual(3, self.page.evaluate("document.querySelectorAll('.ver pre').length"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
