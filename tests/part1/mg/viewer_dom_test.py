# coding: utf-8
"""TEST-MG-DOM (E-MG R1): the mammography viewer module in isolated Chromium with real public pixels.

REQ-MG-02/03/04/05/06 -> RISK-MG-OMIT / FALSE-ANATOMY / WRONG-STUDY / FLIP-CLIP / STALE (and the MG07/MG08
seams of R1: atomic layout change, prefetch is not display).

The module is mounted with its public contract only: a manifest of DICOM JSON headers read from the
real files, a frame loader that serves the real stored frame bytes, an identity, and a viewport seam.
The seam here is a small reference canvas renderer standing in for the pinned OHIF renderer (R2 binds
the real one); it draws exactly what the module asks for, and records what it drew.

D73: assertions bind to behaviour - which frame identities reach the renderer, what the doctor-visible
slot label states (role, date, side/view, kind, slice/total, position), what the displayed pixels show
(chest-wall side, air vs tissue brightness), and what the seam was asked to do (fit, 1:1, pan). No
product source text, internal name or DOM shape beyond accessible roles/names is read. Pixel hashes are
facts of the original frames. Variants (mirrored, relabelled, damaged, a same-patient prior copy) are
test-owned and exist only in memory; they are named as such and never stand in for a real prior (the
real same-subject prior is EA1141-4339969). A sample set whose root directory is absent SKIPS the case
with that reason (not run, never a pass); a listed file missing or changed under a present root FAILS.
KIN_MG_MODEL / KIN_MG_VIEWER may point at module copies (mutants.py); the product tree is never edited.
"""
from pathlib import Path
from contextlib import closing
import copy
import hashlib
import importlib.util
import os
import re
import unittest
from urllib.parse import urlparse

import numpy as np
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
# Loaded by path under its own name: a sibling unit (tests/part1/xa) uses the same file names.
_spec = importlib.util.spec_from_file_location("kin_mg_dicom_contract", HERE / "dicom_contract_test.py")
_contract = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_contract)
dataset, dicom_json, sample_path = _contract.dataset, _contract.dicom_json, _contract.sample_path
per_frame_projection, voi, tag = _contract.per_frame_projection, _contract.voi, _contract.tag
ROOT = HERE.parents[2]
MODEL = Path(os.environ.get("KIN_MG_MODEL") or ROOT / "worklist-v0" / "hpacs-lite" / "mammography-model.js")
VIEWER = Path(os.environ.get("KIN_MG_VIEWER") or ROOT / "worklist-v0" / "hpacs-lite" / "viewer-mammography.js")
ORIGIN = "https://mg.test"
CMMD = {"R CC": "cmmd-d2-0140-1", "R MLO": "cmmd-d2-0140-2", "L CC": "cmmd-d2-0140-3", "L MLO": "cmmd-d2-0140-4"}
DBT = {"R MLO": "ea1141-3227336-185841", "L MLO": "ea1141-3227336-148695", "L CC": "ea1141-3227336-310042", "R CC": "ea1141-3227336-319808"}
WAIT = 30_000

HARNESS = r"""<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000"><div id="host" style="width:1000px;height:1000px"></div>
<script src="/mammography-model.js"></script><script src="/viewer-mammography.js"></script>
<script>
window.mg={loads:[],events:[],renders:[],handles:[],detached:[],violations:[],serial:0,handleSerial:0,control:{},hashing:false,
  identityNow:{institution:'H1',subject:'reader-1',sequence:7},endListeners:[],held:new Map(),luts:new Map(),renderHeld:[],renderRelease:[],screen:{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function lut(bits,d){
  const key=[bits,d.voi.center,d.voi.width,d.voi.fn,d.invert,d.modality.slope,d.modality.intercept].join('|');
  if(mg.luts.has(key))return mg.luts.get(key);
  const size=bits===8?256:65536,out=new Uint8ClampedArray(size),c=d.voi.center,w=d.voi.width;
  for(let v=0;v<size;v++){
    const x=v*d.modality.slope+d.modality.intercept;let y;
    if(d.voi.fn==='SIGMOID')y=255/(1+Math.exp(-4*(x-c)/w));
    else if(d.voi.fn==='LINEAR_EXACT')y=Math.min(1,Math.max(0,(x-c)/w+0.5))*255;
    else y=Math.min(1,Math.max(0,(x-(c-0.5))/(w-1)+0.5))*255;
    out[v]=d.invert?255-y:y;
  }
  mg.luts.set(key,out);return out;
}
function paint(canvas,element,image,d){
  canvas.width=element.clientWidth;canvas.height=element.clientHeight;
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);
  const off=document.createElement('canvas');off.width=image.columns;off.height=image.rows;
  const octx=off.getContext('2d'),data=octx.createImageData(image.columns,image.rows),table=lut(image.bits,d),px=image.pixels;
  for(let i=0,j=0;i<px.length;i++,j+=4){const g=table[px[i]];data.data[j]=g;data.data[j+1]=g;data.data[j+2]=g;data.data[j+3]=255;}
  octx.putImageData(data,0,0);
  ctx.imageSmoothingEnabled=false;
  ctx.translate(canvas.width/2+d.pan.x,canvas.height/2+d.pan.y);ctx.scale(d.scale*(d.flipH?-1:1),d.scale*(d.flipV?-1:1));
  ctx.drawImage(off,-image.columns/2,-image.rows/2);ctx.setTransform(1,0,0,1,0,0);
}
const viewport={attach(element,info){
  const id=++mg.handleSerial,canvas=document.createElement('canvas');
  canvas.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%';element.append(canvas);
  // The seam contract: current() is asked immediately before painting; a superseded render paints nothing.
  // control.holdRender(image,'before'|'after') holds a render before its paint or after it (async renderer).
  const hold=async(image,phase)=>{if(mg.control.holdRender&&mg.control.holdRender(image,phase)){mg.renderHeld.push(phase+':'+image.frame);await new Promise(r=>mg.renderRelease.push(r));}};
  const handle={detached:false,async render(image,d,opts){
    const row={handle:id,sop:image&&image.sop,frame:image&&image.frame,tag:image&&image.tag,display:JSON.parse(JSON.stringify(d)),detached:handle.detached};
    mg.renders.push(row);
    if(handle.detached){mg.violations.push({handle:id,what:'render-after-detach',sop:row.sop,frame:row.frame,tag:row.tag});throw Error('detached');}
    if(!image||!image.pixels)throw Error('no image');
    if(mg.control.failRender&&mg.control.failRender(image))throw Error('render failed');
    if(mg.hashing)row.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',image.pixels.buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
    await hold(image,'before');
    if(!opts||typeof opts.current!=='function'||!opts.current()){row.superseded=true;row.finished=true;return {rendered:false,superseded:true,sop:image.sop,frame:image.frame};}
    paint(canvas,element,image,d);row.painted=true;mg.screen[id]=image.frame;
    await hold(image,'after');
    row.finished=true;return {rendered:true,sop:image.sop,frame:image.frame};
  },detach(){if(handle.detached)mg.violations.push({handle:id,what:'double-detach'});handle.detached=true;mg.detached.push(id);canvas.remove();}};
  mg.handles.push({id,info,element,canvas,handle});return handle;
}};
async function load(ref,{signal,purpose}){
  const serial=++mg.serial,row={serial,purpose,sop:ref.sop,frame:ref.frame,study:ref.study,series:ref.series,state:'pending'};mg.loads.push(row);
  const meta=mg.frames[ref.sop];
  if(!meta){row.state='unknown';throw Error('unknown object');}
  const c=mg.control;
  if(c.hold&&c.hold(row)){
    // A held request models a slow decode; with ignoreAbort it still completes after cancellation.
    row.state='held';row.wasHeld=true;const ignore=!!c.ignoreAbort;
    try{await new Promise((resolve,reject)=>{mg.held.set(serial,resolve);if(!ignore)signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));});}
    catch(e){row.state='aborted';throw e;}
    row.state='pending';row.ignoreAbort=ignore;
  }
  if(signal.aborted&&!row.ignoreAbort){row.state='aborted';throw Object.assign(Error('aborted'),{name:'AbortError'});}
  if(c.fail&&c.fail(row)){const kind=c.fail(row);row.state='failed';throw Object.assign(Error('load failed'),kind==='denied'?{refusal:'denied'}:{});}
  const frame=c.wrongFrame&&c.wrongFrame(row)||ref.frame;
  const r=await fetch('/frames/'+meta.sample+'/'+(meta.variant||'raw')+'/'+frame);
  if(!r.ok){row.state='http-'+r.status;throw Error('http '+r.status);}
  const buffer=await r.arrayBuffer();
  row.state='done';
  return {sop:ref.sop,frame,rows:meta.rows,columns:meta.columns,bits:meta.bits,tag:serial,pixels:meta.bits===8?new Uint8Array(buffer):new Uint16Array(buffer)};
}
window.mgRelease=serial=>{const r=mg.held.get(serial);mg.held.delete(serial);if(r)r();return !!r;};
window.mgMount=({manifest,frames,studies})=>{
  mg.frames=frames;
  const identity={institution:'H1',subject:'reader-1',sequence:7,studies,check:()=>({...mg.identityNow}),
    onEnd(fn){mg.endListeners.push(fn);return ()=>{mg.endListeners=mg.endListeners.filter(x=>x!==fn);};}};
  const events={};for(const name of ['requested','loaded','displayed'])events[name]=r=>mg.events.push({name,...r});
  window.controller=KinViewerMammography.mount({host:document.getElementById('host'),source:{manifest,load},viewport,identity,events});
};
// Screen facts of one handle's canvas: tissue fraction and mean brightness of the outer 5% strips of
// the displayed image box, plus the last display the module asked for.
window.mgStrips=(id,threshold)=>{
  const h=mg.handles.find(x=>x.id===id),last=[...mg.renders].reverse().find(r=>r.handle===id&&r.painted),d=last.display;
  const w=h.canvas.width,ht=h.canvas.height,data=h.canvas.getContext('2d').getImageData(0,0,w,ht).data;
  const bw=d.columns*d.scale,bh=d.rows*d.scale,x0=w/2+d.pan.x-bw/2,y0=ht/2+d.pan.y-bh/2,strip=Math.max(1,Math.floor(bw*0.05));
  const stats=(a,b)=>{let n=0,t=0,s=0;for(let y=Math.max(0,Math.ceil(y0));y<Math.min(ht,Math.floor(y0+bh));y++)for(let x=Math.max(0,Math.ceil(a));x<Math.min(w,Math.floor(b));x++){const g=data[(y*w+x)*4];n++;s+=g;if(g>threshold)t++;}return {tissue:n?t/n:0,mean:n?s/n:0,n};};
  return {width:w,height:ht,display:d,left:stats(x0,x0+strip),right:stats(x0+bw-strip,x0+bw)};
};
</script></body></html>"""


class Frames:
    """Real stored frame bytes, read from the sample file at its Pixel Data offset."""

    def __init__(self):
        self.meta = {}

    def describe(self, sample_id):
        if sample_id not in self.meta:
            self.meta[sample_id] = _contract.pixel_layout(sample_id)
        return self.meta[sample_id]

    def read(self, sample_id, frame, variant="raw"):
        m = self.describe(sample_id)
        if not 1 <= frame <= m["frames"]:
            return None
        with open(m["path"], "rb") as f:
            f.seek(m["offset"] + (frame - 1) * m["size"])
            data = f.read(m["size"])
        if variant == "mirror":
            dtype = np.uint8 if m["bits"] == 8 else np.dtype("<u2")
            data = np.frombuffer(data, dtype=dtype).reshape(m["rows"], m["columns"])[:, ::-1].copy().tobytes()
        return data


FRAMES = Frames()

def entry(sample_id, json_item=None, variant=None):
    m = FRAMES.describe(sample_id)
    item = json_item or dicom_json(dataset(sample_id))
    return item, {"sample": sample_id, "variant": variant, "rows": m["rows"], "columns": m["columns"], "bits": m["bits"]}


def new_uid(n):
    return "1.2.826.0.1.3680043.10.77." + str(n)


def prior_copy(item, n, date="20090718"):
    """TEST-OWNED same-patient prior: the same pixels under new study/series/SOP UIDs and an earlier date."""
    out = copy.deepcopy(item)
    out["0020000D"] = {"vr": "UI", "Value": [new_uid(1000)]}
    out["0020000E"] = {"vr": "UI", "Value": [new_uid(1001)]}
    out["00080018"] = {"vr": "UI", "Value": [new_uid(1100 + n)]}
    out["00080020"] = {"vr": "DA", "Value": [date]}
    return out


class MammographyViewerDOMTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self):
        page = self.browser.new_page(viewport={"width": 1200, "height": 1100})

        def serve(route):
            url = urlparse(route.request.url)
            if url.path == "/viewer":
                return route.fulfill(body=HARNESS, content_type="text/html; charset=utf-8")
            if url.path == "/mammography-model.js":
                return route.fulfill(body=MODEL.read_text(encoding="utf-8"), content_type="application/javascript")
            if url.path == "/viewer-mammography.js":
                return route.fulfill(body=VIEWER.read_text(encoding="utf-8"), content_type="application/javascript")
            match = re.fullmatch(r"/frames/([a-z0-9-]+)/(raw|mirror)/(\d+)", url.path)
            if match:
                data = FRAMES.read(match.group(1), int(match.group(3)), match.group(2))
                if data is None:
                    return route.fulfill(status=404, body="")
                return route.fulfill(body=data, content_type="application/octet-stream")
            return route.fulfill(status=404, body="")

        page.route(ORIGIN + "/**", serve)
        page.goto(ORIGIN + "/viewer")
        self.addCleanup(page.close)
        return page

    def mount(self, page, current, prior=None, prior_institution="H1"):
        """current/prior: lists of (DICOM JSON item, frame meta)."""
        frames, studies = {}, []
        for role, rows, institution in (("current", current, "H1"), ("prior", prior, prior_institution)):
            if not rows:
                continue
            for item, meta in rows:
                frames[tag(item, "00080018")] = meta
            studies.append({"uid": tag(rows[0][0], "0020000D"), "role": role, "institution": institution, "instances": [r[0] for r in rows]})
        page.evaluate("a=>mgMount(a)", {"manifest": {"institution": "H1", "studies": studies}, "frames": frames,
                                        "studies": [s["uid"] for s in studies]})

    # --- observations -------------------------------------------------------------------------
    @staticmethod
    def cell(page, name):
        return page.get_by_role("group", name=name, exact=True)

    def label(self, page, name):
        return self.cell(page, name).inner_text()

    def handle_of(self, page, name):
        return page.evaluate("""n=>{const g=[...document.querySelectorAll('[role=group]')].find(e=>e.getAttribute('aria-label')===n);
            const h=mg.handles.filter(x=>g&&g.contains(x.element)&&!x.handle.detached);return h.length===1?h[0].id:null;}""", name)

    def displayed(self, page, sop=None):
        rows = page.evaluate("()=>mg.events.filter(e=>e.name==='displayed').map(e=>[e.sop,e.frame,e.role,e.side,e.view])")
        return [r for r in rows if sop is None or r[0] == sop]

    def wait_displayed(self, page, sop, frame, count=1):
        page.wait_for_function("([s,f,c])=>mg.events.filter(e=>e.name==='displayed'&&e.sop===s&&e.frame===f).length>=c", arg=[sop, frame, count], timeout=WAIT)

    def settle(self, page):
        page.wait_for_function("()=>mg.loads.every(l=>l.state!=='pending')", timeout=WAIT)
        page.wait_for_timeout(150)

    def key(self, page, name, key, times=1, sop=None):
        """Focus the cell and press a key; with `sop`, wait for each resulting display."""
        self.cell(page, name).focus()
        for _ in range(times):
            before = len(self.displayed(page, sop)) if sop else 0
            page.keyboard.press(key)
            if sop:
                page.wait_for_function("([s,n])=>mg.events.filter(e=>e.name==='displayed'&&e.sop===s).length>n", arg=[sop, before], timeout=WAIT)

    def violations(self, page):
        return page.evaluate("()=>mg.violations")

    # --- MG02 -------------------------------------------------------------------------------------
    def test_mg02_dom_first_to_last_frames_render_with_exact_ids(self):
        page = self.page()
        item, meta = entry(DBT["L CC"])
        sop, frames = tag(item, "00080018"), int(tag(item, "00280008"))
        page.evaluate("()=>{mg.hashing=true}")
        self.mount(page, [(item, meta)])
        self.wait_displayed(page, sop, 1)
        self.key(page, "Current L CC", "End", sop=sop)
        self.key(page, "Current L CC", "Home", sop=sop)
        self.key(page, "Current L CC", "ArrowDown", times=frames - 1, sop=sop)
        shown = [f for s, f, *_ in self.displayed(page, sop)]
        self.assertEqual(shown[:3], [1, frames, 1], "first, last and first again")
        self.assertEqual(shown[3:], list(range(2, frames + 1)), "MG02 DOM: every stored frame first to last, in order")
        renders = page.evaluate("s=>mg.renders.filter(r=>r.sop===s&&r.painted).map(r=>[r.frame,r.sha256])", sop)
        truth = {f: hashlib.sha256(FRAMES.read(DBT["L CC"], f)).hexdigest() for f in range(1, frames + 1)}
        self.assertEqual({f for f, _ in renders}, set(range(1, frames + 1)))
        for f, digest in renders:
            self.assertEqual(digest, truth[f], "MG02 DOM: the renderer drew the real stored frame %d" % f)
        text = self.label(page, "Current L CC")
        self.assertIn("Slice %d / %d" % (frames, frames), text)
        self.assertIn("Seen %d / %d" % (frames, frames), text)
        self.assertNotIn("Frames Unverified", text)
        self.assertTrue(all(l["sop"] == sop and 1 <= l["frame"] <= frames for l in page.evaluate("()=>mg.loads")))
        self.assertEqual(self.violations(page), [])

    def test_mg02_dom_prefetch_wrong_frame_and_wrong_total_never_count_as_displayed(self):
        page = self.page()
        item, meta = entry(DBT["L CC"])
        sop = tag(item, "00080018")
        self.mount(page, [(item, meta)])
        self.wait_displayed(page, sop, 1)
        page.wait_for_function("s=>mg.events.some(e=>e.name==='loaded'&&e.purpose==='prefetch'&&e.sop===s&&e.frame===2)", arg=sop, timeout=WAIT)
        page.wait_for_timeout(200)
        self.assertEqual([f for _, f, *_ in self.displayed(page, sop)], [1], "MG02 M12: a prefetched frame is not a displayed frame")
        self.assertIn("Seen 1 / 16", self.label(page, "Current L CC"))
        # The loader answers frame 3 with frame 4: nothing is shown or counted for either.
        page.evaluate("()=>{mg.control.wrongFrame=r=>r.frame===3?4:null}")
        self.key(page, "Current L CC", "ArrowDown", sop=sop)
        self.key(page, "Current L CC", "ArrowDown")
        self.settle(page)
        self.assertEqual([f for _, f, *_ in self.displayed(page, sop)], [1, 2])
        text = self.label(page, "Current L CC")
        self.assertIn("Slice 2 / 16", text, "the current slice stays when a wrong frame arrives")
        self.assertIn("Seen 2 / 16", text)
        self.assertEqual(self.cell(page, "Current L CC").get_by_role("button", name="Retry", exact=True).count(), 1)
        # TEST-OWNED wrong total: NumberOfFrames 17 for 16 stored frames.
        page2 = self.page()
        damaged = copy.deepcopy(item)
        damaged["00280008"] = {"vr": "IS", "Value": [17]}
        self.mount(page2, [(damaged, meta)])
        self.settle(page2)
        # D735: an object whose frame count contradicts its per-frame list is never placed; it stays listed.
        self.assertIn("Missing", self.label(page2, "Current L CC"))
        self.assertIn("Other Images (1)", page2.locator("details summary").inner_text(), "MG02: a wrong total is listed, not hidden")
        self.assertEqual(page2.evaluate("()=>mg.loads.length"), 0, "nothing of the damaged object is loaded")

    # --- MG03 -------------------------------------------------------------------------------------
    def test_mg03_dom_two_dbts_scroll_independently_with_own_positions(self):
        page = self.page()
        rows = {view: entry(sample) for view, sample in DBT.items()}
        self.mount(page, list(rows.values()))
        sops = {view: tag(rows[view][0], "00080018") for view in rows}
        for view in rows:
            self.wait_displayed(page, sops[view], 1)
        self.key(page, "Current L CC", "ArrowDown", times=5, sop=sops["L CC"])
        cc = per_frame_projection(dataset(DBT["L CC"]))
        mlo = per_frame_projection(dataset(DBT["R MLO"]))
        text = self.label(page, "Current L CC")
        self.assertIn("Slice 6 / 16", text)
        self.assertIn("Pos %.1f mm" % abs(cc[5] - cc[0]), text, "MG03: the L CC slab shows its own depth")
        self.assertIn("Slice 1 / 18", self.label(page, "Current R MLO"))
        self.assertEqual([f for _, f, *_ in self.displayed(page, sops["R MLO"])], [1], "MG03: the other DBT did not move")
        self.key(page, "Current R MLO", "End", sop=sops["R MLO"])
        text = self.label(page, "Current R MLO")
        self.assertIn("Slice 18 / 18", text)
        self.assertIn("Pos %.1f mm" % abs(mlo[17] - mlo[0]), text)
        self.assertIn("Slice 6 / 16", self.label(page, "Current L CC"))

    def test_mg03_dom_same_length_dbts_are_not_linked_and_missing_positions_stay_unverified(self):
        page = self.page()
        r_mlo, l_mlo = entry(DBT["R MLO"]), entry(DBT["L MLO"])
        no_position = copy.deepcopy(dicom_json(dataset(DBT["L CC"])))
        for f in no_position["52009230"]["Value"]:
            f.pop("00209113", None)
        l_cc = entry(DBT["L CC"], no_position)
        self.mount(page, [r_mlo, l_mlo, l_cc])
        sop_r, sop_l, sop_cc = (tag(x[0], "00080018") for x in (r_mlo, l_mlo, l_cc))
        for s in (sop_r, sop_l):
            self.wait_displayed(page, s, 1)
        self.key(page, "Current L MLO", "ArrowDown", times=9, sop=sop_l)
        self.settle(page)
        self.assertIn("Slice 10 / 18", self.label(page, "Current L MLO"))
        self.assertIn("Slice 1 / 18", self.label(page, "Current R MLO"), "MG03 M5: the same slice number is not forced on the other DBT")
        self.assertEqual([f for _, f, *_ in self.displayed(page, sop_r)], [1], "MG03 M5: no automatic sync by index")
        # D735: a DBT whose positions are absent has no verified geometry; it is not placed, it is listed.
        text = self.label(page, "Current L CC")
        self.assertIn("Missing", text, "MG03: a DBT without positions is not placed as slices")
        self.assertNotRegex(text, r"Pos \d", "no millimetre value is invented")
        self.assertIn("Other Images (1)", page.locator("details summary").inner_text())
        self.assertFalse(any(l["sop"] == sop_cc for l in page.evaluate("()=>mg.loads")))

    # --- MG04 -------------------------------------------------------------------------------------
    def four_view(self):
        return {view: entry(sample) for view, sample in CMMD.items()}

    def test_mg04_dom_compare_layout_identifies_every_slot_and_switches_kind(self):
        page = self.page()
        current = self.four_view()
        prior = {view: (prior_copy(item, n), meta) for n, (view, (item, meta)) in enumerate(current.items())}
        self.mount(page, list(current.values()), list(prior.values()))
        for view in current:
            self.wait_displayed(page, tag(current[view][0], "00080018"), 1)
            text = self.label(page, "Current " + view)
            for fact in ("Current", "2010-07-18", view, "Conventional"):
                self.assertIn(fact, text, view)
        page.get_by_role("button", name="Compare CC", exact=True).click()
        for view in ("R CC", "L CC"):
            self.wait_displayed(page, tag(prior[view][0], "00080018"), 1)
        for name, date in (("Current R CC", "2010-07-18"), ("Current L CC", "2010-07-18"), ("Prior R CC", "2009-07-18"), ("Prior L CC", "2009-07-18")):
            text = self.label(page, name)
            self.assertIn(date, text, name)
            self.assertIn("Conventional", text, name)
        self.assertEqual(self.cell(page, "Current R MLO").count(), 0)
        self.assertEqual(page.get_by_role("button", name="Compare CC", exact=True).get_attribute("aria-pressed"), "true")
        prior_rows = [r for r in self.displayed(page) if r[2] == "prior"]
        self.assertEqual(sorted((r[3], r[4], r[0]) for r in prior_rows),
                         sorted([("R", "CC", tag(prior["R CC"][0], "00080018")), ("L", "CC", tag(prior["L CC"][0], "00080018"))]))
        page.get_by_role("button", name="Synthetic 2D", exact=True).click()
        page.wait_for_function("()=>document.querySelector('[aria-label=\"Prior L CC\"]')?.innerText.includes('Synthetic 2D')", timeout=WAIT)
        for name in ("Current R CC", "Current L CC", "Prior R CC", "Prior L CC"):
            text = self.label(page, name)
            self.assertIn("Synthetic 2D", text)
            self.assertIn("Missing", text, "MG04: a slot without that kind says so")
            self.assertIsNone(self.handle_of(page, name), "nothing is drawn in a missing slot")
        page.get_by_role("button", name="Conventional", exact=True).click()
        page.get_by_role("button", name="Compare MLO", exact=True).click()
        page.wait_for_function("()=>!!document.querySelector('[aria-label=\"Prior L MLO\"]')", timeout=WAIT)
        self.wait_displayed(page, tag(prior["L MLO"][0], "00080018"), 1)
        self.assertIn("2009-07-18", self.label(page, "Prior L MLO"))
        self.assertEqual(self.violations(page), [])

    def test_mg04_dom_other_patient_duplicate_and_partial_switch_are_never_applied(self):
        # Another real patient as the intended prior.
        page = self.page()
        current = self.four_view()
        other = entry("cmmd-d1-0577-1")
        self.mount(page, list(current.values()), [other])
        self.wait_displayed(page, tag(current["R CC"][0], "00080018"), 1)
        page.get_by_role("button", name="Compare CC", exact=True).click()
        page.wait_for_function("()=>!!document.querySelector('[aria-label=\"Prior R CC\"]')", timeout=WAIT)
        for name in ("Prior R CC", "Prior L CC"):
            text = self.label(page, name)
            self.assertIn("Refused", text, "MG04: another patient's study is not used as the prior")
            self.assertNotIn("2011-07-18", text)
        other_sop = tag(other[0], "00080018")
        self.assertFalse(any(l["sop"] == other_sop for l in page.evaluate("()=>mg.loads")), "no image of the other patient is requested")
        self.assertNotEqual(page.get_by_role("status").first.inner_text().strip(), "")
        # A duplicate R CC: no image is picked until the doctor chooses.
        page2 = self.page()
        dup = copy.deepcopy(current["R CC"][0])
        dup["00080018"] = {"vr": "UI", "Value": [new_uid(2001)]}
        dup["00200013"] = {"vr": "IS", "Value": [9]}
        self.mount(page2, list(current.values()) + [(dup, current["R CC"][1])])
        self.wait_displayed(page2, tag(current["L CC"][0], "00080018"), 1)
        self.settle(page2)
        self.assertIn("Ambiguous (2)", self.label(page2, "Current R CC"))
        r_sops = {tag(current["R CC"][0], "00080018"), new_uid(2001)}
        self.assertFalse(any(l["sop"] in r_sops for l in page2.evaluate("()=>mg.loads")), "MG04: no duplicate is chosen silently")
        self.cell(page2, "Current R CC").get_by_role("button").first.click()
        page2.wait_for_function("s=>mg.events.some(e=>e.name==='displayed'&&s.includes(e.sop))", arg=list(r_sops), timeout=WAIT)
        self.assertNotIn("Ambiguous", self.label(page2, "Current R CC"))
        # A layout change where one new image cannot be drawn, then one that cannot be loaded.
        page3 = self.page()
        prior = {view: (prior_copy(item, n), meta) for n, (view, (item, meta)) in enumerate(current.items())}
        self.mount(page3, list(current.values()), list(prior.values()))
        for view in current:
            self.wait_displayed(page3, tag(current[view][0], "00080018"), 1)
        before = {name: self.handle_of(page3, name) for name in ("Current R CC", "Current L CC", "Current R MLO", "Current L MLO")}
        page3.evaluate("s=>{mg.control.failRender=i=>i.sop===s}", tag(prior["L CC"][0], "00080018"))
        page3.get_by_role("button", name="Compare CC", exact=True).click()
        page3.wait_for_function("s=>mg.renders.some(r=>r.sop===s)", arg=tag(prior["L CC"][0], "00080018"), timeout=WAIT)
        self.settle(page3)
        self.assertEqual(self.cell(page3, "Prior R CC").count(), 0, "MG04 M11: a partly failed change is not applied")
        self.assertEqual({name: self.handle_of(page3, name) for name in before}, before, "MG04 M11: the current arrangement and its viewports stay")
        self.assertEqual(page3.get_by_role("button", name="Current", exact=True).get_attribute("aria-pressed"), "true")
        self.assertTrue(page3.locator("[role=group]").first.is_visible())
        # The prior MLO images were never requested, so this change really has to load them.
        page3.evaluate("s=>{mg.control.failRender=null;mg.control.fail=r=>r.sop===s?'network':null}", tag(prior["R MLO"][0], "00080018"))
        page3.get_by_role("button", name="Compare MLO", exact=True).click()
        page3.wait_for_function("s=>mg.loads.some(l=>l.sop===s&&l.state==='failed')", arg=tag(prior["R MLO"][0], "00080018"), timeout=WAIT)
        self.settle(page3)
        self.assertEqual(self.cell(page3, "Prior R MLO").count(), 0, "a failed load keeps the arrangement too")
        self.assertEqual({name: self.handle_of(page3, name) for name in before}, before)
        page3.evaluate("()=>{mg.control.fail=null}")
        page3.get_by_role("button", name="Compare CC", exact=True).click()
        page3.wait_for_function("()=>!!document.querySelector('[aria-label=\"Prior R CC\"]')", timeout=WAIT)
        self.assertEqual(self.violations(page3), [])

    # --- MG05 -------------------------------------------------------------------------------------
    @staticmethod
    def pixel_facts(sample_id, item):
        """From the stored pixels through the object's own VOI (PS3.3 C.11.2.1.2): the display value of
        the tissue threshold, and how much brighter the chest-wall edge strip is than the opposite strip."""
        pixels = _contract.frame_pixels(sample_id, 1)
        low = float(np.percentile(pixels, 5))
        stored = low + 0.1 * (float(pixels.max()) - low)
        # Window from the header: top level, or the first window of the shared Frame VOI LUT.
        voi_item = item
        if "00281050" not in item:
            voi_item = item["52009229"]["Value"][0]["00289132"]["Value"][0]
        center, width = float(tag(voi_item, "00281050")), float(tag(voi_item, "00281051"))
        fn = tag(voi_item, "00281056") or tag(item, "00281056") or "LINEAR"
        strip = max(1, pixels.shape[1] // 20)
        left, right = voi(pixels[:, :strip], center, width, fn).mean(), voi(pixels[:, -strip:], center, width, fn).mean()
        return float(voi(np.array([stored]), center, width, fn)[0]), float(abs(right - left))

    def thresholds(self, sample_id, item):
        return self.pixel_facts(sample_id, item)[0]

    def screen_side(self, page, name, threshold):
        s = page.evaluate("([id,t])=>mgStrips(id,t)", [self.handle_of(page, name), threshold])
        if s["right"]["tissue"] > s["left"]["tissue"] + 0.3:
            return "right", s
        if s["left"]["tissue"] > s["right"]["tissue"] + 0.3:
            return "left", s
        self.fail("chest wall side not decidable on screen for %s: %r" % (name, s))

    def test_mg05_dom_real_pixels_fit_one_to_one_and_pan_reach_all_tissue(self):
        page = self.page()
        current = self.four_view()
        self.mount(page, list(current.values()))
        for view, (item, _) in current.items():
            self.wait_displayed(page, tag(item, "00080018"), 1)
        for view, (item, meta) in current.items():
            name = "Current " + view
            threshold, stored_contrast = self.pixel_facts(CMMD[view], item)
            side, s = self.screen_side(page, name, threshold)
            self.assertEqual(side, "right" if view.startswith("R") else "left", "MG05 M6: chest wall side on screen for " + name)
            empty, wall = (s["left"], s["right"]) if side == "right" else (s["right"], s["left"])
            self.assertLess(empty["mean"], 64, "MG05: air stays dark with the stored VOI in " + name)
            self.assertGreater(wall["mean"] - empty["mean"], 0.5 * stored_contrast,
                               "MG05: tissue is brighter than air on screen as in the stored pixels of " + name)
            d = s["display"]
            self.assertEqual((d["rows"], d["columns"]), (meta["rows"], meta["columns"]))
            self.assertLessEqual(d["columns"] * d["scale"], s["width"] + 0.5, "MG05 M7: Fit shows the whole acquired width of " + name)
            self.assertLessEqual(d["rows"] * d["scale"], s["height"] + 0.5, "MG05 M7: Fit shows the whole acquired height of " + name)
            self.assertTrue(abs(d["columns"] * d["scale"] - s["width"]) < 1 or abs(d["rows"] * d["scale"] - s["height"]) < 1)
            self.assertEqual(d["pan"], {"x": 0, "y": 0})
        cell = self.cell(page, "Current R CC")
        cell.click()
        page.get_by_role("button", name="1:1", exact=True).click()
        hid = self.handle_of(page, "Current R CC")
        page.wait_for_function("id=>{const r=[...mg.renders].reverse().find(x=>x.handle===id);return r&&r.display.scale===1}", arg=hid, timeout=WAIT)
        box = cell.bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        def drag(dx, dy, times):
            for _ in range(times):
                page.mouse.move(cx, cy)
                page.mouse.down()
                page.mouse.move(cx + dx, cy + dy, steps=4)
                page.mouse.up()
                page.wait_for_timeout(50)
            page.wait_for_timeout(150)
            return page.evaluate("id=>[...mg.renders].reverse().find(x=>x.handle===id&&x.painted).display", hid)

        rows, columns = current["R CC"][1]["rows"], current["R CC"][1]["columns"]
        d = drag(200, 200, 6)
        self.assertEqual(d["scale"], 1)
        self.assertEqual((round(d["pan"]["x"]), round(d["pan"]["y"])), (columns // 2, rows // 2), "MG05: panning reaches the top-left tissue edge")
        d = drag(-200, -200, 12)
        self.assertEqual((round(d["pan"]["x"]), round(d["pan"]["y"])), (-(columns // 2), -(rows // 2)), "MG05: panning reaches the bottom-right edge")
        page.get_by_role("button", name="Fit", exact=True).click()
        page.wait_for_function("id=>{const r=[...mg.renders].reverse().find(x=>x.handle===id);return r&&r.display.scale<1&&r.display.pan.x===0}", arg=hid, timeout=WAIT)

    def test_mg05_dom_mirrored_unlabelled_copies_and_user_zoom_are_respected(self):
        page = self.page()
        current = self.four_view()
        mirrored = copy.deepcopy(current["R CC"][0])
        mirrored["00200020"] = {"vr": "CS", "Value": ["A", "L"]}
        unlabelled = copy.deepcopy(current["L CC"][0])
        unlabelled.pop("00200020")
        rows = [entry(CMMD["R CC"], mirrored, "mirror"), entry(CMMD["L CC"], unlabelled), current["R MLO"], current["L MLO"]]
        self.mount(page, rows)
        for item, _ in rows:
            self.wait_displayed(page, tag(item, "00080018"), 1)
        side, _ = self.screen_side(page, "Current R CC", self.thresholds(CMMD["R CC"], mirrored))
        self.assertEqual(side, "right", "MG05: a copy stored mirrored is turned back from its Patient Orientation")
        side, s = self.screen_side(page, "Current L CC", self.thresholds(CMMD["L CC"], unlabelled))
        self.assertEqual(side, "left", "shown exactly as stored")
        self.assertFalse(s["display"]["flipH"] or s["display"]["flipV"], "MG05: no orientation, no guessed flip")
        self.assertIn("Orientation Unverified", self.label(page, "Current L CC"))
        self.assertNotIn("Orientation Unverified", self.label(page, "Current R MLO"))
        # User zoom survives a slice change and is only reset by Fit.
        page2 = self.page()
        item, meta = entry(DBT["L CC"])
        sop = tag(item, "00080018")
        self.mount(page2, [(item, meta)])
        self.wait_displayed(page2, sop, 1)
        hid = self.handle_of(page2, "Current L CC")
        fit = page2.evaluate("id=>[...mg.renders].reverse().find(x=>x.handle===id&&x.painted).display.scale", hid)
        box = self.cell(page2, "Current L CC").bounding_box()
        page2.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page2.keyboard.down("Control")
        page2.mouse.wheel(0, -100)
        page2.keyboard.up("Control")
        page2.wait_for_function("([id,f])=>{const r=[...mg.renders].reverse().find(x=>x.handle===id&&x.painted);return r&&r.display.scale>f*1.2}", arg=[hid, fit], timeout=WAIT)
        zoomed = page2.evaluate("id=>[...mg.renders].reverse().find(x=>x.handle===id&&x.painted).display.scale", hid)
        self.key(page2, "Current L CC", "ArrowDown", sop=sop)
        after = page2.evaluate("id=>[...mg.renders].reverse().find(x=>x.handle===id&&x.painted)", hid)
        self.assertEqual(after["frame"], 2)
        self.assertAlmostEqual(after["display"]["scale"], zoomed, places=9, msg="MG05: the doctor's zoom is not replaced on the next slice")
        page2.get_by_role("button", name="Fit", exact=True).click()
        page2.wait_for_function("([id,f])=>{const r=[...mg.renders].reverse().find(x=>x.handle===id&&x.painted);return r&&Math.abs(r.display.scale-f)<1e-9}", arg=[hid, fit], timeout=WAIT)

    # --- EA1141-4339969: real current/prior with DBT and device synthetic 2D ---------------------------
    def test_mg04_dom_paired_real_prior_compare_dbt_and_synthetic_2d(self):
        page = self.page()
        current = [entry(s) for s in _contract.CURRENT_DBT + _contract.CURRENT_2D]
        prior = [entry(s) for s in _contract.PRIOR_DBT]
        sop = {s: tag(item, "00080018") for s, (item, _) in zip(_contract.CURRENT_DBT + _contract.CURRENT_2D + _contract.PRIOR_DBT, current + prior)}
        self.mount(page, current, prior)
        names = ("R CC", "L CC", "R MLO", "L MLO")
        for name, sample_id in zip(names, _contract.CURRENT_2D):
            self.wait_displayed(page, sop[sample_id], 1)
            text = self.label(page, "Current " + name)
            for fact in ("1945-02-13", name, "Synthetic 2D"):
                self.assertIn(fact, text, "MG04: the stored synthetic view is offered and named in " + name)
        self.assert_no_partial_friction(page)
        page.get_by_role("button", name="Compare CC", exact=True).click()
        page.wait_for_function("()=>!!document.querySelector('[aria-label=\"Prior L CC\"]')", timeout=WAIT)
        for name in ("Prior R CC", "Prior L CC"):
            text = self.label(page, name)
            self.assertIn("1944-02-21", text)
            self.assertIn("Missing", text, "MG04: no prior synthetic view exists, and none is made from DBT")
        page.get_by_role("button", name="DBT", exact=True).click()
        for sample_id in (_contract.CURRENT_DBT[0], _contract.CURRENT_DBT[1], _contract.PRIOR_DBT[0], _contract.PRIOR_DBT[1]):
            self.wait_displayed(page, sop[sample_id], 1)
        self.assert_no_partial_friction(page)
        frames = {s: int(dataset(s).NumberOfFrames) for s in (_contract.CURRENT_DBT[1], _contract.PRIOR_DBT[1])}
        self.assertIn("Slice 1 / %d" % frames[_contract.CURRENT_DBT[1]], self.label(page, "Current L CC"))
        self.assertIn("Slice 1 / %d" % frames[_contract.PRIOR_DBT[1]], self.label(page, "Prior L CC"))
        # The prior left CC is stored mirrored (Patient Orientation P\L); on screen its chest wall is at the left.
        item, _ = prior[1]
        threshold, _ = self.pixel_facts(_contract.PRIOR_DBT[1], item)
        side, _ = self.screen_side(page, "Prior L CC", threshold)
        self.assertEqual(side, "left", "MG05: the real prior is turned to the standard orientation from its tags")
        self.key(page, "Current L CC", "End", sop=sop[_contract.CURRENT_DBT[1]])
        self.settle(page)
        last = frames[_contract.CURRENT_DBT[1]]
        self.assertIn("Slice %d / %d" % (last, last), self.label(page, "Current L CC"))
        self.assertIn("Slice 1 / %d" % frames[_contract.PRIOR_DBT[1]], self.label(page, "Prior L CC"),
                      "MG03: the prior DBT keeps its own slice; frame numbers are never matched across DBTs")
        self.assertEqual([f for _, f, *_ in self.displayed(page, sop[_contract.PRIOR_DBT[1]])], [1])
        self.assertEqual(self.violations(page), [])
        page.evaluate("()=>controller.dispose()")
        self.mount(page, current, prior)
        for sample_id in _contract.CURRENT_2D:
            self.wait_displayed(page, sop[sample_id], 1, count=2)
        self.assert_no_partial_friction(page)

    # --- MG06 -------------------------------------------------------------------------------------
    def test_mg06_dom_late_and_stale_results_never_overwrite_the_current_slice(self):
        page = self.page()
        item, meta = entry(DBT["L CC"])
        sop = tag(item, "00080018")
        self.mount(page, [(item, meta)])
        self.wait_displayed(page, sop, 1)
        page.wait_for_function("s=>mg.events.some(e=>e.name==='loaded'&&e.purpose==='prefetch'&&e.frame===2)", arg=sop, timeout=WAIT)
        page.evaluate("()=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.purpose==='display'&&r.frame===16}")
        self.key(page, "Current L CC", "End")  # A (held)
        page.wait_for_function("()=>mg.loads.filter(l=>l.state==='held').length===1", timeout=WAIT)
        self.key(page, "Current L CC", "Home")  # back to the slice on screen
        self.key(page, "Current L CC", "ArrowDown", sop=sop)  # B (prefetched, shown at once)
        self.key(page, "Current L CC", "End")  # A again (held)
        page.wait_for_function("()=>mg.loads.filter(l=>l.state==='held').length===2", timeout=WAIT)
        held = page.evaluate("()=>mg.loads.filter(l=>l.state==='held').map(l=>l.serial)")
        self.assertIn("Slice 2 / 16", self.label(page, "Current L CC"), "MG06: a pending request keeps the current slice on screen")
        page.evaluate("s=>mgRelease(s)", held[1])
        self.wait_displayed(page, sop, 16)
        page.evaluate("s=>mgRelease(s)", held[0])
        self.settle(page)
        renders16 = page.evaluate("s=>mg.renders.filter(r=>r.sop===s&&r.frame===16).map(r=>r.tag)", sop)
        # Camera/resize can repaint the current resource; none may use the superseded supply.
        self.assertEqual(set(renders16), {held[1]}, "MG06 M9: the first request for the same slice (A->B->A) is never drawn")
        self.assertIn("Slice 16 / 16", self.label(page, "Current L CC"))
        # A passing failure keeps the slice; Retry recovers it.
        page.evaluate("()=>{mg.control.hold=null;mg.control.ignoreAbort=false;mg.control.fail=r=>r.frame===14?'network':null}")
        self.key(page, "Current L CC", "ArrowUp", sop=sop)
        self.key(page, "Current L CC", "ArrowUp")
        self.settle(page)
        self.assertIn("Slice 15 / 16", self.label(page, "Current L CC"), "MG06: a short failure keeps the position")
        page.evaluate("()=>{mg.control.fail=null}")
        self.cell(page, "Current L CC").get_by_role("button", name="Retry", exact=True).click()
        self.wait_displayed(page, sop, 14)
        self.assertIn("Slice 14 / 16", self.label(page, "Current L CC"))
        self.assertEqual(self.violations(page), [])

    def release_all(self, page):
        """Release every held load, newest first, and wait until nothing is in flight."""
        page.evaluate("()=>[...mg.held.keys()].sort((a,b)=>b-a).forEach(s=>mgRelease(s))")
        self.settle(page)

    def frames_shown(self, page, sop):
        return [f for _, f, *_ in self.displayed(page, sop)]

    def camera_action(self, page, name, action):
        self.cell(page, name).focus()
        if action in ("Fit", "1:1"):
            page.get_by_role("button", name=action, exact=True).click()
            return
        if action == "resize":
            page.locator("#host").evaluate("e=>e.style.height='900px'")
            page.wait_for_timeout(50)  # allow ResizeObserver delivery, not a success condition
            return
        box = self.cell(page, name).bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        if action == "zoom":
            page.keyboard.down("Control")
            page.mouse.wheel(0, -100)
            page.keyboard.up("Control")
        else:
            page.mouse.down()
            page.mouse.move(x + 35, y + 20)
            page.mouse.up()

    def test_mg06_dom_camera_and_navigation_share_one_latest_paint_gate(self):
        # Review CE: End -> delayed render -> Fit -> release used to produce [1,3,1].
        # Every camera action crosses both delayed load and delayed paint, in both intent orders.
        item, meta = entry(DBT["L CC"])
        item = copy.deepcopy(item)
        item["00280008"] = {"vr": "IS", "Value": [3]}
        item["52009230"]["Value"] = item["52009230"]["Value"][:3]
        sop, name = tag(item, "00080018"), "Current L CC"
        for action in ("Fit", "zoom", "pan", "1:1", "resize"):
            for order in ("navigation-first", "camera-first"):
                for delayed in ("paint", "load"):
                    with self.subTest(action=action, order=order, delayed=delayed), closing(self.page()) as page:
                        self.mount(page, [(item, meta)])
                        self.wait_displayed(page, sop, 1)
                        self.settle(page)
                        hid = self.handle_of(page, name)
                        if order == "navigation-first":
                            if delayed == "paint":
                                page.evaluate("()=>{mg.control.holdRender=(i,p)=>{if(p==='before'&&i.frame===3){mg.control.holdRender=null;return true;}return false;}}")
                            else:
                                page.evaluate("()=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.frame===3}")
                            self.key(page, name, "End")
                            page.wait_for_function("mode=>mode==='paint'?mg.renderHeld.length>0:mg.held.size>0", arg=delayed, timeout=WAIT)
                            self.camera_action(page, name, action)
                        else:
                            # Hold the camera render of 1, then ask End. For load-delay cases the new
                            # target is separately held: completing the camera must still expose nothing.
                            page.evaluate("()=>{mg.control.holdRender=(i,p)=>{if(p==='before'){mg.control.holdRender=null;return true;}return false;}}")
                            self.camera_action(page, name, action)
                            page.wait_for_function("()=>mg.renderHeld.length>0", timeout=WAIT)
                            if delayed == "load":
                                page.evaluate("()=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.frame===3}")
                            self.key(page, name, "End")
                            if delayed == "load":
                                page.wait_for_function("()=>mg.held.size>0", timeout=WAIT)
                                page.evaluate("()=>mg.renderRelease.splice(0).forEach(r=>r())")
                                page.wait_for_function("()=>mg.renders.filter(r=>r.frame===1).every(r=>r.finished)", timeout=WAIT)
                                self.assertEqual(page.evaluate("()=>mg.renders.filter(r=>r.painted).map(r=>r.frame)"), [1],
                                                 "a superseded camera paint has no visible effect while the new load waits")
                        page.evaluate("()=>{mg.control.hold=null;mg.renderRelease.splice(0).forEach(r=>r());[...mg.held.keys()].forEach(mgRelease)}")
                        self.wait_displayed(page, sop, 3)
                        page.wait_for_function("()=>mg.renders.every(r=>r.finished)", timeout=WAIT)
                        self.settle(page)
                        self.assertEqual(self.frames_shown(page, sop), [1, 3],
                                         "MG06 M24: a camera repaint never resubmits the old displayed frame")
                        painted = page.evaluate("()=>mg.renders.filter(r=>r.painted).map(r=>r.frame)")
                        # Valid resize/camera paints may repeat the latest frame, but never revive an old one.
                        changes = [f for i, f in enumerate(painted) if i == 0 or f != painted[i - 1]]
                        self.assertEqual(changes, [1, 3],
                                         "MG06 M24: a camera repaint never resubmits the old displayed frame")
                        self.assertEqual(page.evaluate("id=>mg.screen[id]", hid), 3)
                        self.assertIn("Slice 3 / 3", self.label(page, name))
                        self.assertIn("Seen 2 / 3", self.label(page, name))
                        last = page.evaluate("()=>mg.renders.filter(r=>r.painted).at(-1).display")
                        if action == "pan":
                            self.assertGreater(last["pan"]["x"], 0)
                        elif action == "1:1":
                            self.assertEqual(last["scale"], 1)
                        self.assertEqual(self.violations(page), [])

    def test_mg04_dom_duplicate_and_mixed_minip_mount_and_choose(self):
        original, meta = entry(DBT["L CC"])
        for mixed in (False, True):
            page, errors = self.page(), []
            page.on("pageerror", lambda e: errors.append(str(e)))
            a, b = copy.deepcopy(original), copy.deepcopy(original)
            b["00080018"] = {"vr": "UI", "Value": [new_uid(3901)]}
            for item in ([a] if mixed else [a, b]):
                item["00089207"] = {"vr": "CS", "Value": ["MIN_IP"]}
                for f in item["52009230"]["Value"]:
                    f["00189504"]["Value"][0]["00089207"] = {"vr": "CS", "Value": ["MIN_IP"]}
            self.mount(page, [(a, meta), (b, meta)])
            self.assertIn("Ambiguous (2)", self.label(page, "Current L CC"))
            self.assertEqual(self.displayed(page), [])
            buttons = self.cell(page, "Current L CC").get_by_role("button")
            self.assertEqual(buttons.count(), 2)
            buttons.first.click()
            self.wait_displayed(page, tag(a, "00080018"), 1)
            self.assertIn("MinIP Slab", self.label(page, "Current L CC"))
            self.assertEqual(errors, [])
            self.assertEqual(self.violations(page), [])

    def assert_no_partial_friction(self, page):
        visible = page.locator("body").inner_text()
        accessible = page.evaluate("()=>[...document.querySelectorAll('[title],[aria-label],[aria-description]')].map(e=>[e.title,e.getAttribute('aria-label'),e.getAttribute('aria-description')].join(' ')).join(' ')")
        self.assertNotRegex(visible + accessible, r"Partial|Full View|Inferred Full|전체 촬영|부분 촬영",
                            "MG04 M32: absent Partial View adds no label tooltip warning or action")
        self.assertEqual(page.get_by_role("button", name=re.compile(r"^Use ")).count(), 0)
        self.assertEqual(page.get_by_role("dialog").count(), 0)

    def test_mg04_dom_absent_empty_and_no_partial_have_the_same_normal_flow(self):
        for declaration in (None, [], ["NO"]):
            page = self.page()
            current = list(self.four_view().values())
            current = [(copy.deepcopy(o), m) for o, m in current]
            for o, _ in current:
                o.pop("00281350", None)
                if declaration is not None:
                    o["00281350"] = {"vr": "CS", "Value": declaration}
            prior = [(prior_copy(o, i), m) for i, (o, m) in enumerate(current)]
            self.mount(page, current, prior)
            for o, _ in current:
                self.wait_displayed(page, tag(o, "00080018"), 1)
            self.assert_no_partial_friction(page)
            page.get_by_role("button", name="Compare CC", exact=True).click()
            for o, _ in (prior[0], prior[2]):
                self.wait_displayed(page, tag(o, "00080018"), 1)
            self.assert_no_partial_friction(page)
            page.get_by_role("button", name="DBT", exact=True).click()
            expect(page.get_by_role("button", name="DBT", exact=True)).to_have_attribute("aria-pressed", "true")
            page.get_by_role("button", name="Conventional", exact=True).click()
            for o, _ in (prior[0], prior[2]):
                self.wait_displayed(page, tag(o, "00080018"), 1, count=2)
            self.assert_no_partial_friction(page)
            page.evaluate("()=>controller.dispose()")
            self.mount(page, current, prior)
            for o, _ in current:
                self.wait_displayed(page, tag(o, "00080018"), 1, count=2)
            self.settle(page)
            self.assert_no_partial_friction(page)

    def test_mg06_dom_latest_intent_wins_over_delayed_seek_and_scroll_bursts(self):
        page = self.page()
        item, meta = entry(DBT["L CC"])
        sop = tag(item, "00080018")
        self.mount(page, [(item, meta)])
        self.wait_displayed(page, sop, 1)
        page.wait_for_function("()=>mg.events.some(e=>e.name==='loaded'&&e.purpose==='prefetch'&&e.frame===2)", timeout=WAIT)
        # End is delayed; Home asks for the slice already on screen; then End's frame arrives.
        page.evaluate("()=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.purpose==='display'&&r.frame===16}")
        self.key(page, "Current L CC", "End")
        page.wait_for_function("()=>mg.loads.some(l=>l.state==='held')", timeout=WAIT)
        self.key(page, "Current L CC", "Home")
        self.release_all(page)
        self.assertEqual(self.frames_shown(page, sop), [1], "MG06 M13: a request back to the current slice cancels the delayed one")
        self.assertIn("Slice 1 / 16", self.label(page, "Current L CC"))
        self.assertFalse(page.evaluate("s=>mg.renders.some(r=>r.sop===s&&r.frame===16&&r.painted)", sop))
        # A seek burst End/Home/End/Home (fresh window: nothing of slice 16 cached) with every delayed
        # load arriving afterwards, newest first.
        page3 = self.page()
        self.mount(page3, [(item, meta)])
        self.wait_displayed(page3, sop, 1)
        page3.evaluate("()=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.purpose==='display'&&r.frame===16}")
        for key in ("End", "Home", "End", "Home"):
            self.key(page3, "Current L CC", key)
        page3.wait_for_function("()=>mg.loads.filter(l=>l.wasHeld).length===2", timeout=WAIT)
        self.release_all(page3)
        self.assertEqual(self.frames_shown(page3, sop), [1], "the last seek of the burst is what stays on screen")
        self.assertIn("Slice 1 / 16", self.label(page3, "Current L CC"))
        # A scroll burst: five steps down while every frame from 2 on (prefetch included) is delayed.
        page2 = self.page()
        page2.evaluate("()=>{mg.control.hold=r=>r.frame>=2}")
        self.mount(page2, [(item, meta)])
        self.wait_displayed(page2, sop, 1)
        page2.wait_for_function("()=>mg.loads.some(l=>l.state==='held'&&l.purpose==='prefetch'&&l.frame===2)", timeout=WAIT)
        self.cell(page2, "Current L CC").focus()
        for _ in range(5):
            page2.keyboard.press("ArrowDown")
        page2.wait_for_timeout(300)
        requested = page2.evaluate("()=>mg.loads.filter(l=>l.purpose==='display').map(l=>l.frame)")
        self.assertEqual(requested[-1:], [6], "MG06 M16: a scroll burst moves from the latest intent")
        self.release_all(page2)
        self.wait_displayed(page2, sop, 6)
        self.settle(page2)
        self.assertEqual(self.frames_shown(page2, sop), [1, 6], "only the last step of the burst is displayed")
        self.assertIn("Slice 6 / 16", self.label(page2, "Current L CC"))
        # Three wheel notches in a row while frames are delayed: three slices further, nothing in between.
        box = self.cell(page2, "Current L CC").bounding_box()
        page2.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        for _ in range(3):
            page2.mouse.wheel(0, 100)
        page2.wait_for_function("()=>mg.loads.some(l=>l.state==='held'&&l.purpose==='display'&&l.frame===9)", timeout=WAIT)
        self.release_all(page2)
        self.wait_displayed(page2, sop, 9)
        self.settle(page2)
        self.assertEqual(self.frames_shown(page2, sop), [1, 6, 9])
        self.assertIn("Slice 9 / 16", self.label(page2, "Current L CC"))
        self.assertEqual(self.violations(page2), [])

    def test_mg06_dom_superseded_renders_are_neither_painted_nor_reported(self):
        page = self.page()
        item, meta = entry(DBT["L CC"])
        sop = tag(item, "00080018")
        self.mount(page, [(item, meta)])
        self.wait_displayed(page, sop, 1)
        page.wait_for_function("()=>mg.events.some(e=>e.name==='loaded'&&e.purpose==='prefetch'&&e.frame===2)", timeout=WAIT)
        hid = self.handle_of(page, "Current L CC")
        # The render of slice 16 is held before its paint; the doctor goes Home and one slice down.
        page.evaluate("()=>{mg.control.holdRender=(i,phase)=>phase==='before'&&i.frame===16}")
        self.key(page, "Current L CC", "End")
        page.wait_for_function("()=>mg.renderHeld.includes('before:16')", timeout=WAIT)
        self.key(page, "Current L CC", "Home")
        self.key(page, "Current L CC", "ArrowDown")
        page.evaluate("()=>{mg.control.holdRender=null;mg.renderRelease.splice(0).forEach(r=>r())}")
        self.wait_displayed(page, sop, 2)
        self.settle(page)
        self.assertFalse(page.evaluate("s=>mg.renders.some(r=>r.sop===s&&r.frame===16&&r.painted)", sop),
                         "MG06 M15: a render superseded before its paint is not painted")
        self.assertEqual(self.frames_shown(page, sop), [1, 2])
        self.assertIn("Slice 2 / 16", self.label(page, "Current L CC"))
        # The render of slice 16 paints and then finishes late (an asynchronous renderer); Home follows.
        page.evaluate("()=>{mg.control.holdRender=(i,phase)=>phase==='after'&&i.frame===16}")
        self.key(page, "Current L CC", "End")
        page.wait_for_function("()=>mg.renderHeld.includes('after:16')", timeout=WAIT)
        self.key(page, "Current L CC", "Home")
        page.evaluate("()=>{mg.control.holdRender=null;mg.renderRelease.splice(0).forEach(r=>r())}")
        self.wait_displayed(page, sop, 1, count=2)
        self.settle(page)
        self.assertEqual(self.frames_shown(page, sop), [1, 2, 1], "MG06 M14: a render superseded after its paint is not reported as the current display")
        self.assertEqual(page.evaluate("id=>mg.screen[id]", hid), 1, "the screen ends on the latest intent")
        text = self.label(page, "Current L CC")
        self.assertIn("Slice 1 / 16", text)
        self.assertIn("Seen 2 / 16", text, "MG06 M14: a render superseded after its paint is not counted as seen")
        self.assertEqual(self.violations(page), [])

    def test_mg04_dom_partial_and_oversized_objects_are_never_auto_placed(self):
        page = self.page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        current = self.four_view()
        partial = copy.deepcopy(current["R CC"][0])
        partial["00281352"] = {"vr": "SQ", "Value": [{"00080102": {"vr": "SH", "Value": ["SCT"]}, "00080100": {"vr": "SH", "Value": ["255561001"]},
                                                      "00080104": {"vr": "LO", "Value": ["Medial"]}}]}
        oversized = copy.deepcopy(current["L CC"][0])
        oversized["00080018"] = {"vr": "UI", "Value": [new_uid(3001)]}
        oversized["00280008"] = {"vr": "IS", "Value": [2001]}
        rows = [(partial, current["R CC"][1]), current["L CC"], current["R MLO"], current["L MLO"], (oversized, current["L CC"][1])]
        self.mount(page, rows)
        for view in ("L CC", "R MLO", "L MLO"):
            self.wait_displayed(page, tag(current[view][0], "00080018"), 1)
        self.settle(page)
        self.assertIn("Partial Only (1)", self.label(page, "Current R CC"), "MG04: a partial acquisition is not placed as the full R CC")
        loads = page.evaluate("()=>mg.loads.map(l=>l.sop)")
        self.assertNotIn(tag(partial, "00080018"), loads, "nothing is loaded for a partial view until it is chosen")
        self.assertNotIn(new_uid(3001), loads, "MG02: an object with an impossible frame count is never loaded")
        self.assertIn("Other Images (2)", page.locator("details summary").inner_text())
        self.cell(page, "Current R CC").get_by_role("button", name="Use Partial Medial", exact=True).click()
        self.wait_displayed(page, tag(partial, "00080018"), 1)
        self.assertIn("Partial Medial", self.label(page, "Current R CC"), "a chosen partial view stays labelled as partial")
        self.assertEqual(errors, [])
        self.assertEqual(self.violations(page), [])

        # V2 exception labels are specific to actual partial evidence; absent normal images above
        # receive none of these labels. Unknown section codes never masquerade as a verified region.
        for variant in ("unknown-section", "conflict", "missing-bto-section"):
            page2 = self.page()
            if variant == "missing-bto-section":
                obj, meta = entry(DBT["L CC"])
                obj = copy.deepcopy(obj)
                obj["00281350"] = {"vr": "CS", "Value": ["YES"]}
                obj.pop("00281352", None)
                expected = "Partial View Unverified"
            else:
                obj, meta = copy.deepcopy(partial), current["R CC"][1]
                if variant == "unknown-section":
                    obj["00281352"] = {"vr": "SQ", "Value": [{}]}
                    expected = "Partial View"
                else:
                    obj["00281350"] = {"vr": "CS", "Value": ["NO"]}
                    expected = "Partial View Conflict"
            self.mount(page2, [(obj, meta)])
            self.settle(page2)
            self.assertEqual(page2.evaluate("()=>mg.loads.length"), 0, "explicit partial/contradictory objects never auto-load")
            if variant == "unknown-section":
                self.cell(page2, "Current R CC").get_by_role("button", name="Use Partial View", exact=True).click()
                self.wait_displayed(page2, tag(obj, "00080018"), 1)
                self.assertIn(expected, self.label(page2, "Current R CC"))
                self.assertNotIn("Unknown Section", self.label(page2, "Current R CC"))
            else:
                page2.get_by_text(re.compile(r"^Other Images")).click()
                self.assertIn(expected, page2.locator("body").inner_text())
                self.assertIn("자동 배치하지 않았습니다", page2.locator("body").inner_text())

    def test_mg06_dom_dispose_layout_switch_and_account_change_stop_late_results(self):
        page = self.page()
        rows = {view: entry(sample) for view, sample in DBT.items()}
        self.mount(page, list(rows.values()))
        sops = {view: tag(rows[view][0], "00080018") for view in rows}
        for view in rows:
            self.wait_displayed(page, sops[view], 1)
        page.evaluate("s=>{mg.control.ignoreAbort=true;mg.control.hold=r=>r.purpose==='display'&&r.sop===s&&r.frame===16}", sops["L CC"])
        self.key(page, "Current L CC", "End")
        page.wait_for_function("()=>mg.loads.some(l=>l.state==='held')", timeout=WAIT)
        old = self.handle_of(page, "Current L CC")
        page.get_by_role("button", name="Compare CC", exact=True).click()
        page.wait_for_function("()=>!!document.querySelector('[aria-label=\"Prior L CC\"]')", timeout=WAIT)
        self.assertIn(old, page.evaluate("()=>mg.detached"), "the replaced viewport is released")
        held = page.evaluate("()=>mg.loads.filter(l=>l.state==='held').map(l=>l.serial)")
        page.evaluate("s=>mgRelease(s)", held[0])
        self.settle(page)
        self.assertEqual(self.violations(page), [], "MG06 M10: a released viewport is never drawn into again")
        self.assertFalse(any(r["tag"] == held[0] for r in page.evaluate("()=>mg.renders")))
        # Dispose while a load is held: nothing is drawn afterwards and every viewport is released once.
        # (The late L CC frame above may serve later requests of the same frame; hold an R CC frame instead.)
        page.evaluate("s=>{mg.control.hold=r=>r.purpose==='display'&&r.sop===s&&r.frame===16}", sops["R CC"])
        self.key(page, "Current R CC", "End")
        page.wait_for_function("()=>mg.loads.filter(l=>l.state==='held').length===1", timeout=WAIT)
        late = page.evaluate("()=>mg.loads.find(l=>l.state==='held').serial")
        count = page.evaluate("()=>mg.renders.length")
        page.evaluate("()=>controller.dispose()")
        page.evaluate("s=>mgRelease(s)", late)
        self.settle(page)
        self.assertEqual(page.evaluate("()=>mg.renders.length"), count, "MG06: nothing is drawn after dispose")
        state = page.evaluate("()=>({handles:mg.handles.map(h=>h.id),detached:mg.detached,host:document.getElementById('host').children.length})")
        self.assertEqual(sorted(state["detached"]), sorted(state["handles"]), "every viewport released exactly once")
        self.assertEqual(state["host"], 0)
        self.assertEqual(self.violations(page), [])
        # Another account in the same window: the images are hidden, late results ignored.
        page2 = self.page()
        item, meta = rows["L CC"]
        self.mount(page2, [(item, meta)])
        self.wait_displayed(page2, sops["L CC"], 1)
        page2.evaluate("()=>{mg.identityNow={institution:'H1',subject:'reader-2',sequence:7}}")
        self.key(page2, "Current L CC", "ArrowDown")
        self.settle(page2)
        self.assertEqual(page2.locator("[role=group]").count(), 0, "MG06: images are removed when the account changes")
        self.assertEqual(page2.evaluate("()=>mg.handles.every(h=>h.handle.detached)"), True)
        self.assertNotEqual(page2.get_by_role("status").inner_text().strip(), "")
        self.assertEqual([f for _, f, *_ in self.displayed(page2, sops["L CC"])], [1])
        # A refused frame request (access revoked) also stops and hides.
        page3 = self.page()
        self.mount(page3, [(item, meta)])
        self.wait_displayed(page3, sops["L CC"], 1)
        page3.evaluate("()=>{mg.control.fail=r=>r.frame===3?'denied':null}")
        # Frame 2 is shown; the refused request for frame 3 (its prefetch) ends the display.
        self.key(page3, "Current L CC", "ArrowDown", sop=sops["L CC"])
        page3.wait_for_function("()=>!document.querySelector('[role=group]')", timeout=WAIT)
        self.settle(page3)
        self.assertEqual(page3.locator("[role=group]").count(), 0, "MG06: a refused request ends the display")
        self.assertEqual(page3.evaluate("()=>mg.handles.every(h=>h.handle.detached)"), True)


if __name__ == "__main__":
    unittest.main()
