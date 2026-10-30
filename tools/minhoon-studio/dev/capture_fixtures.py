#!/usr/bin/env python3
"""Record what the product screens ask the server, from a SYNTHETIC stack only.

The studio mock is seeded from real responses so the mirrored screens get the
shapes the product really returns. Point this at a synthetic fixture stack
(e.g. scripts/mgxa_fixture.py), never at an environment holding real patients.

  python tools/minhoon-studio/dev/capture_fixtures.py --origin https://localhost:9643 \
      --storage-state <doctor storage-state.json> --out tmp/minhoon-studio/capture --step worklist

Output: <out>/<step>/captures.jsonl (one request per line) + bodies/ + screenshots.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
RECORDED = ("/api/", "/dicom-web/", "/instances/", "/statistics", "/system")


class Recorder:
    def __init__(self, out, max_binary):
        self.out = out
        self.max_binary = max_binary
        self.bodies = os.path.join(out, "bodies")
        os.makedirs(self.bodies, exist_ok=True)
        self.file = open(os.path.join(out, "captures.jsonl"), "a", encoding="utf-8")
        self.count = 0

    def attach(self, page, label):
        page.on("response", lambda response: self.record(response, label))

    def record(self, response, label):
        url = urlsplit(response.url)
        if not url.path.startswith(RECORDED):
            return
        request = response.request
        entry = {"t": time.time(), "page": label, "method": request.method, "path": url.path, "query": url.query,
                 "status": response.status, "type": response.headers.get("content-type", ""),
                 "accept": request.headers.get("accept", "")}
        try:
            post = request.post_data
        except Exception:
            post = None
        if post:
            entry["request"] = post[:20000]
        try:
            body = response.body()
        except Exception as error:
            entry["error"] = str(error)[:200]
            body = None
        if body is not None:
            if "json" in entry["type"] or entry["type"].startswith("text/"):
                entry["body"] = body.decode("utf-8", errors="replace")
            elif len(body) > self.max_binary:
                entry["bytes"] = len(body)
            else:
                digest = hashlib.sha256(body).hexdigest()[:24]
                with open(os.path.join(self.bodies, digest), "wb") as handle:
                    handle.write(body)
                entry["body_file"] = digest
                entry["bytes"] = len(body)
        self.file.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.file.flush()
        self.count += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--storage-state", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--step", required=True, help="worklist | viewer:<row index> | page:<file.html>")
    parser.add_argument("--rows", type=int, default=8)
    parser.add_argument("--wait", type=float, default=3.0)
    parser.add_argument("--max-binary", type=int, default=4_000_000, help="binary bodies above this keep only their size")
    args = parser.parse_args()
    out = os.path.join(args.out, args.step.replace(":", "-").replace(".", "_"))
    os.makedirs(out, exist_ok=True)
    recorder = Recorder(out, args.max_binary)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=args.storage_state, ignore_https_errors=True,
                                      viewport={"width": 1680, "height": 1000})
        page = context.new_page()
        recorder.attach(page, "main")
        context.on("page", lambda popup: recorder.attach(popup, "popup"))
        if args.step.startswith("page:"):
            page.goto(f"{args.origin}/worklist/hpacs-lite/{args.step[5:]}")
            time.sleep(args.wait * 3)
            page.screenshot(path=os.path.join(out, "page.png"))
        else:
            page.goto(f"{args.origin}/worklist/hpacs-lite/main.html")
            page.wait_for_selector("#rows tr[data-uid]", timeout=60000)
            time.sleep(args.wait)
            page.screenshot(path=os.path.join(out, "worklist.png"))
            rows = page.locator("#rows tr[data-uid]")
            uids = [rows.nth(i).get_attribute("data-uid") for i in range(rows.count())]
            json.dump(uids, open(os.path.join(out, "uids.json"), "w"))
            if args.step == "worklist":
                for index, uid in enumerate(uids[: args.rows]):
                    page.locator(f'#rows tr[data-uid="{uid}"]').click()
                    time.sleep(args.wait)
                    if index < 3:
                        page.screenshot(path=os.path.join(out, f"row{index}.png"))
            elif args.step.startswith("viewer:"):
                uid = uids[int(args.step.split(":")[1])]
                page.locator(f'#rows tr[data-uid="{uid}"]').click()
                time.sleep(args.wait)
                with context.expect_page(timeout=30000) as info:
                    page.locator(f'#rows tr[data-uid="{uid}"]').dblclick()
                viewer = info.value
                time.sleep(args.wait * 8)
                viewer.screenshot(path=os.path.join(out, "viewer.png"))
                page.screenshot(path=os.path.join(out, "main-after.png"))
        context.close()
        browser.close()
    print(json.dumps({"out": out, "recorded": recorder.count}))


if __name__ == "__main__":
    main()
