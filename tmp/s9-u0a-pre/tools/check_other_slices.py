# coding: utf-8
"""Probe: every other marker cut and function extraction the 9 legacy files take from main.html, on the f1d5406 page
and on the page under test - equal text means the PRE moves do not reach them (only BASE_BLOCK/REPORT_BLOCK do)."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from page_source import read_page_source  # noqa: E402

PAIRS = {
    "BASE_CSS": ("    * { box-sizing: border-box; }", "\n\n    /* ── 상단메뉴"),
    "PANEL_CSS": ("    .panel { display: flex;", "\n"),
    "REPORT_CSS": ("    /* Report */", "    .citefield {"),
    "MODAL_CSS": (".modal { display: none;", "/* ══ 클릭 피드백"),
    "RBTNS_HTML": ('<div class="rbtns">', "\n        </div>"),
    "BARS_HTML": ('<div class="draftbar" id="draftbar"', '<div id="citelist"'),
    "DICTATION_HTML": ('<div id="citelist"', '<div class="redit">'),
    "REDIT_HTML": ('<div class="redit">', "\n        </div>"),
    "RFOOT_HTML": ('<div class="rfoot2">', "\n        </div>"),
    "PANE_HTML": ('<div class="modal" id="stalemodal"', "\n  </div>"),
    "CITE_HTML": ('<div class="modal" id="cite-preview"', "\n  </div>"),
    "STRUCT_HTML": ('<div class="modal" id="structmodal"', "\n  </div>"),
    "DICTATION_BLOCK": ("    // ══════════ 받아쓰기 (S3-ASR-U4) ══════════", '    $("#t-mod").addEventListener("change", renderTemplates);'),
    "HOLD_BLOCK": ("    // ══════════ 동시 판독 점유 (교훈 §2) ══════════", "    // ══════════ 이탈 시 판독문 보존 (교훈 §1) ══════════"),
    "UNLOAD_BLOCK": ("    const AUTOSAVE_MS = 20000;", "    // ② 로그아웃"),
    "LOGOUT_BLOCK": ("    // ② 로그아웃", "    // 다른 사람이 잡거나 놓은 걸"),
    "SELECT_BLOCK": ("    function select(uid, {", "    function renderClinical()"),
    "DICTATION_PANE_HTML": ('<div id="dictation-pane"', '\n        <div class="redit">'),
}
FUNCTIONS = ("api", "reportWriteBlock", "reportEditorBlock", "templateInsertionBlock", "insertTemplate",
             "updateReportButtons", "goOnline", "goOffline")


def functions(source, name):
    script = ("const ts=require(process.argv[1]);const src=require('fs').readFileSync(0,'utf8');"
              "const sf=ts.createSourceFile('x.js',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);"
              "const n=[];(function walk(x){if(ts.isFunctionDeclaration(x)&&x.name&&x.name.text===process.argv[2])n.push(x.getText(sf));ts.forEachChild(x,walk);})(sf);"
              "process.stdout.write(JSON.stringify(n));")
    return subprocess.check_output(["node", "-e", script, str(ROOT / "api/node_modules/typescript"), name], input=source,
                                   text=True, encoding="utf-8")


def cut(source, a, b):
    i = source.index(a)
    return source[i:source.index(b, i + len(a))]


original = subprocess.check_output(["git", "cat-file", "--filters",
                                    "f1d540626aac03f46de23a9620d69f4c9da66037:worklist-v0/hpacs-lite/main.html"], cwd=ROOT)
original = original.decode("utf-8").replace("\r\n", "\n")
current = read_page_source(ROOT / "worklist-v0" / "hpacs-lite" / "main.html")
result = {k: cut(original, *p) == cut(current, *p) for k, p in PAIRS.items()}
result.update({f"function {n}": functions(original, n) == functions(current, n) for n in FUNCTIONS})
print(json.dumps(result, ensure_ascii=False, indent=1))
print("all equal:", all(result.values()))
