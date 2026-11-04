# coding: utf-8
"""CD-01 Product Information: the one config source, its rules and the API's build facts (pure, no stack).

REQ-CD01-PRODUCT-INFO -> RISK-CD01-FABRICATED-VALUE / RISK-CD01-MIXED-BUILD -> TEST-CD01-PURE.
Each case gives an input, observes the branch the generator or the API took, and asserts the result:

  01  C03/C12 the committed page and API outputs are what config/product-info.json builds today (--check).
  02  C02/C09/C10 the shipped facts carry every statutory item, the conditional ones in their own state, the support
      schedule and the after-support plan as two items, the AI training method and data, and no expert-use item.
  03  C03 a placeholder carries no value, every non-confirmed item states its reason, unissued reads 발급 전,
      not applicable states its basis; a confirmed item needs its value (and the contractor/importer details).
  04  C08 UDI-PI is accepted only with the confirmed product version it carries; a mismatch or a missing version
      fails; UDI-DI and the authorization number cannot be "pending" (a number is issued or not).
  05  C04 a document links only to a shipped same-origin file of the same product version; a missing file, an
      outside URL or another product version fails.
  06  C09 an end-of-support date is a date, a manufacturing date is a year and month; free text fails.
  07  C02 no expert-use key or text is accepted (D-14: not displayed until decided).
  08  C05 build-args reports HEAD and only the tag that points at it: none, exact, an older tag (not reported) and two
      tags (refused); a dirty tracked tree is refused.
  09  C05/C06 the compiled controller: GET version, public metadata, only build facts; a malformed or "unknown"
      revision and a tag without a revision read null.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_product_info", ROOT / "scripts" / "build-product-info.py")
product = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(product)
CONFIG = json.loads((ROOT / "config" / "product-info.json").read_text(encoding="utf-8"))


def node():
    found = shutil.which("node")
    if not found:
        raise unittest.SkipTest("node is required")  # pragma: no cover - CI installs node
    return found


def rows(model):
    return {row["id"]: row for row in model["rows"]}


class ProductInfoConfigTest(unittest.TestCase):
    def model(self, config=None, root=ROOT):
        return product.build_model(copy.deepcopy(CONFIG if config is None else config), root)

    def refused(self, mutate, reason, root=ROOT):
        config = copy.deepcopy(CONFIG)
        mutate(config)
        with self.assertRaises(product.ConfigError) as caught:
            product.build_model(config, root)
        self.assertIn(reason, str(caught.exception))

    def test_01_committed_outputs_are_built_from_the_config(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts" / "build-product-info.py"), "--check"],
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        model, files = product.outputs(ROOT)
        for relative, body in files.items():
            self.assertEqual((ROOT / relative).read_bytes().replace(b"\r\n", b"\n"), body, relative)
        # Both sides carry the same digest: the page embeds it, the API reports it.
        self.assertIn(model["factsDigest"].encode(), files[product.PAGE_DATA])
        self.assertIn(model["factsDigest"].encode(), files[product.API_DATA])
        # Control: a changed fact changes the digest, so a page from the old build would read Mismatch.
        changed = copy.deepcopy(CONFIG)
        changed["support"]["contact"]["note"] = "연락처 확정 전: SYN 변경"
        self.assertNotEqual(self.model(changed)["factsDigest"], model["factsDigest"])

    def test_02_shipped_facts_cover_every_item_in_its_own_state(self):
        model = self.model()
        by_id = rows(model)
        self.assertEqual([spec[0] for spec in product.ROWS], [row["id"] for row in model["rows"]])
        expected = {
            "manufacturer.name": "pending", "manufacturer.address": "confirmed", "importer": "not_applicable",
            "statutoryLabel": "confirmed", "product.authorization": "unissued", "product.name": "pending",
            "product.model": "pending", "manufacturing.serial": "pending", "manufacturing.date": "pending",
            "version.product": "pending", "udi.di": "unissued", "udi.pi": "unissued",
            "documents.description": "pending", "documents.instructions": "pending", "support.contact": "pending",
            "support.maintenance": "undetermined", "support.endOfSupport": "pending", "support.afterSupport": "pending",
            "ai.engine": "confirmed", "ai.model": "confirmed", "ai.training": "pending", "ai.performance": "pending",
            "ai.cloud": "undetermined", "ai.changes": "undetermined", "ai.notice": "pending"}
        self.assertEqual(expected, {key: row["status"] for key, row in by_id.items()})
        for key, phrase in (("product.authorization", "발급 전"), ("udi.di", "발급 전"), ("udi.pi", "발급 전"),
                            ("manufacturing.serial", "제조번호 확정 전"), ("manufacturing.date", "제조 연월 확정 전"),
                            ("support.endOfSupport", "일정 미확정"), ("support.afterSupport", "지원계획 미확정"),
                            ("support.maintenance", "위탁 여부 확정 전"), ("ai.notice", "고지 문구 확정 전"),
                            ("documents.description", "문서 확정 전"), ("documents.instructions", "문서 확정 전")):
            with self.subTest(item=key):
                self.assertTrue(by_id[key]["note"].startswith(phrase), by_id[key]["note"])
                self.assertIsNone(by_id[key]["value"])
                self.assertIsNone(by_id[key]["href"])
        # The values that are confirmed come from their records (repository pins, the registry), not from a guess.
        self.assertIn("927cfce34f31707e17f2bff35c349632fb9e2c3a", by_id["ai.engine"]["value"])
        self.assertIn("1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", by_id["ai.model"]["value"])
        self.assertEqual("디지털의료기기소프트웨어", by_id["statutoryLabel"]["value"])
        # Menus and states are English; the explanation of every row is Korean.
        for row in model["rows"]:
            self.assertRegex(row["label"], r"^[A-Za-z][A-Za-z0-9 ()/-]+$")
            self.assertIn(row["statusLabel"], {"Confirmed", "Unissued", "Pending", "Not Applicable", "Undetermined"})
            self.assertRegex(row["note"], r"[가-힣]")
        self.assertEqual(["privacy", "operator", "open-source", "accessibility"], [n["id"] for n in model["notices"]])
        self.assertEqual("/worklist/legal/open-source-notices.html", model["notices"][2]["href"])

    def test_03_values_and_reasons_never_mix(self):
        self.refused(lambda c: c["product"]["authorization"].update(value="SYN-0000"), "only a confirmed item carries values")
        self.refused(lambda c: c["manufacturing"]["serial"].update(note=""), "manufacturing.serial.note")
        self.refused(lambda c: c["product"]["authorization"].update(note="번호 없음"), "unissued number reads 발급 전")
        self.refused(lambda c: c["support"]["maintenance"].update(status="not_applicable", note="위탁 안 함"),
                     "not applicable states its basis")
        self.refused(lambda c: c["support"]["contact"].update(status="confirmed"), "support.contact.value")
        # A contractor shows its name, address and contact together, or the item is not confirmed.
        self.refused(lambda c: c["support"]["maintenance"].update(status="confirmed", value="SYN 수탁사", address="SYN 주소"),
                     "support.maintenance.contact")
        confirmed = copy.deepcopy(CONFIG)
        confirmed["support"]["maintenance"] = {"status": "confirmed", "value": "SYN 수탁사", "address": "SYN 주소",
                                               "contact": "02-000-0000", "note": "유지·관리 수탁자입니다."}
        row = rows(self.model(confirmed))["support.maintenance"]
        self.assertEqual(("confirmed", "SYN 수탁사"), (row["status"], row["value"]))
        self.assertEqual([("Address", "SYN 주소"), ("Contact", "02-000-0000")],
                         [(d["label"], d["value"]) for d in row["details"]])
        # Not applicable is a decision with its basis, not an empty field: the unconditional items refuse it.
        self.refused(lambda c: c["manufacturing"]["serial"].update(status="not_applicable", note="해당 없음: SYN"),
                     "is not one of")
        self.refused(lambda c: c["support"]["contact"].update(colour="red"), "unknown keys")

    def test_04_udi_pi_is_the_product_version(self):
        def version(c, value):
            c["version"]["product"] = {"status": "confirmed", "value": value, "note": "출시 버전입니다."}

        def pi(c, value):
            c["udi"]["pi"] = {"status": "confirmed", "value": "(8012)" + value, "version": value, "note": "UDI-PI입니다."}

        accepted = copy.deepcopy(CONFIG)
        version(accepted, "1.0.0")
        pi(accepted, "1.0.0")
        row = rows(self.model(accepted))["udi.pi"]
        self.assertEqual(("confirmed", [("Version", "1.0.0")]), (row["status"], [(d["label"], d["value"]) for d in row["details"]]))
        self.refused(lambda c: (version(c, "1.0.0"), pi(c, "1.0.1")), "version differs from the product version")
        self.refused(lambda c: pi(c, "1.0.0"), "needs the confirmed product version")
        self.refused(lambda c: c["udi"]["di"].update(status="pending", note="SYN"), "is not one of")
        self.refused(lambda c: c["product"]["authorization"].update(status="pending", note="SYN"), "is not one of")

    def test_05_documents_link_only_to_a_shipped_file_of_this_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for notice in product.NOTICE_FILES.values():
                (root / notice).parent.mkdir(parents=True, exist_ok=True)
                (root / notice).write_text("<title>SYN</title>", encoding="utf-8")
            (root / "worklist-v0/docs").mkdir(parents=True)
            (root / "worklist-v0/docs/ifu.html").write_text("<title>SYN IFU</title>", encoding="utf-8")

            def confirm(c, href="/worklist/docs/ifu.html#use", applies="1.0.0"):
                c["version"]["product"] = {"status": "confirmed", "value": "1.0.0", "note": "출시 버전입니다."}
                c["documents"]["instructions"] = {"status": "confirmed", "value": "SYN 사용자 취급설명서",
                                                  "documentVersion": "IFU-1", "href": href,
                                                  "productVersion": applies, "note": "승인 본문입니다."}

            config = copy.deepcopy(CONFIG)
            confirm(config)
            row = rows(self.model(config, root))["documents.instructions"]
            self.assertEqual(("/worklist/docs/ifu.html#use", [("Document Version", "IFU-1")]),
                             (row["href"], [(d["label"], d["value"]) for d in row["details"]]))
            self.refused(lambda c: confirm(c, href="/worklist/docs/missing.html"), "is not shipped", root)
            self.refused(lambda c: confirm(c, href="https://example.test/ifu.html"), "same-origin /worklist/ document", root)
            self.refused(lambda c: confirm(c, href="/worklist/../ifu.html"), "same-origin /worklist/ document", root)
            self.refused(lambda c: confirm(c, applies="0.9.0"), "applies to another product version", root)
            # A pending document links nowhere (no #, no 404 download).
            self.refused(lambda c: c["documents"]["description"].update(href="/worklist/docs/ifu.html"),
                         "only a confirmed item carries values", root)

    def test_06_dates_are_dates(self):
        def eos(c, value):
            c["support"]["endOfSupport"] = {"status": "confirmed", "value": value, "note": "승인된 지원정책입니다."}

        accepted = copy.deepcopy(CONFIG)
        eos(accepted, "2031-12")
        self.assertEqual("2031-12", rows(self.model(accepted))["support.endOfSupport"]["value"])
        # One confirmed, one pending: each is its own item, the pending one stays pending.
        self.assertEqual("pending", rows(self.model(accepted))["support.afterSupport"]["status"])
        self.refused(lambda c: eos(c, "영구 지원"), "YYYY-MM")
        self.refused(lambda c: c["manufacturing"].update(date={"status": "confirmed", "value": "2026", "note": "SYN"}),
                     "YYYY-MM")

    def test_07_no_expert_use_item(self):
        self.refused(lambda c: c["product"].update(expertUse={"status": "pending", "note": "SYN"}), "no expert-use item")
        self.refused(lambda c: c["product"]["name"].update(note="제품명 확정 전: 전문가용 예정"), "no expert-use text")
        text = json.dumps(self.model(), ensure_ascii=False)
        self.assertNotIn("전문가용", text)
        self.assertNotIn("xpert", text)


class BuildArgsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.git("init", "-q")
        self.git("config", "user.email", "syn@example.test")
        self.git("config", "user.name", "SYN")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        (self.root / "a.txt").write_text("a\n", encoding="utf-8")
        self.git("add", "a.txt")
        self.git("commit", "-q", "-m", "a")

    def tearDown(self):
        self.folder.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True).stdout.strip()

    def test_08_only_the_tag_that_points_at_head(self):
        head = self.git("rev-parse", "HEAD")
        self.assertEqual({"KIN_REVISION": head, "KIN_BUILD_TAG": ""}, product.build_args(self.root))
        self.git("tag", "v0.0.1-syn")
        self.assertEqual({"KIN_REVISION": head, "KIN_BUILD_TAG": "v0.0.1-syn"}, product.build_args(self.root))
        (self.root / "a.txt").write_text("b\n", encoding="utf-8")
        self.git("commit", "-q", "-am", "b")
        # The nearby older tag is not this build's tag.
        self.assertEqual({"KIN_REVISION": self.git("rev-parse", "HEAD"), "KIN_BUILD_TAG": ""}, product.build_args(self.root))
        self.git("tag", "v0.0.2-syn")
        self.git("tag", "v0.0.2-syn-again")
        with self.assertRaisesRegex(product.ConfigError, "several tags point at HEAD"):
            product.build_args(self.root)
        self.git("tag", "-d", "v0.0.2-syn-again")
        (self.root / "a.txt").write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(product.ConfigError, "tracked working tree is dirty"):
            product.build_args(self.root)
        self.assertEqual("v0.0.2-syn", product.build_args(self.root, allow_dirty=True)["KIN_BUILD_TAG"])


CONTROLLER_CHECK = r"""
const path = require('path'), fs = require('fs'), os = require('os');
const api = process.argv[1], out = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cd01-'));
const ts = require(path.join(api, 'node_modules/typescript'));
for (const name of ['product-info.controller', 'product-info-data', 'auth.guard']) {
  let source = fs.readFileSync(path.join(api, 'src', name + '.ts'), 'utf8');
  if (name === 'auth.guard') source = "import { SetMetadata } from '@nestjs/common';\nexport const Public = () => SetMetadata('public', true);\n";
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
    experimentalDecorators: true, emitDecoratorMetadata: true } }).outputText;
  fs.writeFileSync(path.join(out, name + '.js'), js);
}
module.paths.unshift(path.join(api, 'node_modules'));
require(path.join(api, 'node_modules/reflect-metadata'));
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@nestjs/')) return resolve.call(this, path.join(api, 'node_modules', request), parent, ...rest);
  return resolve.call(this, request, parent, ...rest);
};
const { ProductInfoController, buildFacts } = require(path.join(out, 'product-info.controller.js'));
const handler = ProductInfoController.prototype.version;
const cases = {};
for (const [name, env] of Object.entries(JSON.parse(process.argv[2]))) cases[name] = buildFacts(env);
process.stdout.write(JSON.stringify({ cases,
  route: { path: Reflect.getMetadata('path', handler), method: Reflect.getMetadata('method', handler),
    public: Reflect.getMetadata('public', handler), controller: Reflect.getMetadata('path', ProductInfoController) } }));
fs.rmSync(out, { recursive: true, force: true });
"""


class VersionRouteTest(unittest.TestCase):
    def test_09_compiled_controller_reports_only_build_facts(self):
        sha = "0123456789abcdef0123456789abcdef01234567"
        envs = {"release": {"KIN_BUILD_REVISION": sha, "KIN_BUILD_TAG": "v1.2.3"},
                "untagged": {"KIN_BUILD_REVISION": sha, "KIN_BUILD_TAG": ""},
                "unknown": {"KIN_BUILD_REVISION": "unknown", "KIN_BUILD_TAG": "v1.2.3"},
                "short": {"KIN_BUILD_REVISION": sha[:12]},
                "hostile-tag": {"KIN_BUILD_REVISION": sha, "KIN_BUILD_TAG": "<script>"},
                "absent": {},
                # Other environment never leaks into the answer.
                "noisy": {"KIN_BUILD_REVISION": sha, "DATABASE_URL": "postgres://syn:secret@db/kin", "HOME": "/home/syn"}}
        result = subprocess.run([node(), "-e", CONTROLLER_CHECK, str(ROOT / "api"), json.dumps(envs)],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        answer = json.loads(result.stdout)
        # Nest metadata: GET (RequestMethod 0) at the controller root, public like health.
        self.assertEqual({"path": "version", "method": 0, "public": True, "controller": "/"}, answer["route"])
        facts = json.loads((ROOT / "api/src/product-info-data.ts").read_text(encoding="utf-8")
                           .split("=", 1)[1].rsplit(" as const;", 1)[0])
        builds = {name: case["build"] for name, case in answer["cases"].items()}
        self.assertEqual({"release": {"revision": sha, "tag": "v1.2.3"}, "untagged": {"revision": sha, "tag": None},
                          "unknown": {"revision": None, "tag": None}, "short": {"revision": None, "tag": None},
                          "hostile-tag": {"revision": sha, "tag": None}, "absent": {"revision": None, "tag": None},
                          "noisy": {"revision": sha, "tag": None}}, builds)
        for name, case in answer["cases"].items():
            with self.subTest(case=name):
                self.assertEqual({"schema", "factsDigest", "productVersion", "build"}, set(case))
                self.assertEqual(facts["factsDigest"], case["factsDigest"])
                self.assertEqual(facts["productVersion"], case["productVersion"])
                self.assertNotIn("secret", json.dumps(case))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
