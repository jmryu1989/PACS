# coding: utf-8
"""TEST-S8-U1a-NATIVE and TEST-S8-U1a-EDGE-GAP: the VR VOI Slab on the pinned native renderer.

Runs on a fresh synthetic GitHub-hosted runner only (profile volume-vr-voi). The module makes its own synthetic series
(contract accuracy fixtures: grids G-AX/G-OB1/G-OB2, volumes V-BOX/V-MARK, encodings E-U/E-S/E-SLOPE, series S-FULL and
the two missing-slice variants) and leaves the shared projection phantom untouched.

Assertions bind to (D73): geometry and pixel oracles computed here from those series (contract C-01..C-07) on the native VR
canvas, the read-only VR capability inspect() (contract §13, M-09), English control names and roles, the required scope
wording and the absence of forbidden words. They never bind to shader text, Korean sentences, data attributes or id
prefixes. Every case also runs a negative control on the same pixels: an oracle that should be wrong is shown to be wrong.
VRVOI-MEASURE and VRVOI-MAX lines are observations for the record, never the reason a case passes; so are the phase records
(Phases, D419) they carry for the Crop diagnosis and every MAX target action.

Render range (C-02 as corrected by S8-U1a-SPEC-B-F01): an axis whose integer index extent is [l, u] renders over
[l - 0.5, u + 0.5]; the 8 corners of that outer box through the source IJK->LPS affine are the unmasked render range and
a full crop's planes. Voxel centres and the OP-1 marker rule are unchanged, so marker and partial regions get no half voxel.

MAX after S8-U1a fix9 (S8-SCULPT-PERF B-u; REQ-S8-SCULPT-PERF-TARGET, TEST-S8-SCULPT-PERF-MAX): every MAX render action has
one absolute deadline of 30 s from just before its click, enforced from outside the browser; the temporary MAX-H bound and
its e53e281 baseline are gone. BU-T04: the action's compile and link calls (the phase record's GL counts) are those of the
install at the first mask and of one new display variant at Reset VR, and none for every other edit. BU-T03: the frame each
action leaves equals, pixel for pixel, today's generator (KinVolumeVrMasks.build) for the same applied masks drawn on the
same mapper, camera, display and jitter texture; a generator frame is drawn once per distinct state and bounded on its own.
NT-U1a-06 holds BU-T08 (install failures) and BU-T05 (write and frame failures); test_vr_voi_13 holds BU-T06a and BU-T06b.

BU-T03 in its own unit (S8-U1a fix10, D531): drawing today's generator for every MAX state costs the compile B-u removes
(15 frames, 469.8 s and 600.8 s on the fix9 and fix10 local runs), so the generator comparison runs in
VolumeRenderingVoiGeneratorE2E, the MAX flow
again with BU-T03 on, under its own profile (volume-bu-generator) and cap GENERATOR_CAP_S. The 14 test_vr_voi_* cases keep
MAX with its 30 s bound and BU-T04 in volume-vr-voi; BU-T03 runs in that one class only.
"""
import base64, contextlib, io, json, math, os, re, signal, threading, time, unittest, uuid
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_rendering import VolumeRenderingE2E

# The profile's suite_timeout (CI-T-01 compares the two); every wait is bounded by what is left of it minus a margin.
SUITE_CAP_S = 900
# The volume-bu-generator profile's suite_timeout (CI-T-06 compares the two), the bound of the BU-T03 class's waits.
GENERATOR_CAP_S = 1300
SUITE_MARGIN_S = 60
T_AXIS, T_OBLIQUE = 1.0, 1.5
SPACING, STEP, DIMS = (.5, .5), 2.5, (64, 64, 33)
GRIDS = {'G-AX': (1, 0, 0, 0, 1, 0), 'G-OB1': (1, 0, 0, 0, .8, .6), 'G-OB2': (.8, .6, 0, -.36, .48, .8)}
MARKERS = {'MK-SMALL': ((30, 33), (30, 33), (13, 13), 1000), 'MK-FIRST': ((8, 15), (8, 15), (0, 0), 1500),
           'MK-LAST': ((48, 55), (48, 55), (32, 32), 1700), 'MK-MID': ((20, 27), (40, 47), (15, 17), 1200)}
ENCODINGS = {'E-U': (0, 1, -1024), 'E-S': (1, 1, 0), 'E-SLOPE': (0, 2, -1024)}
VARIANTS = {'S-FULL': (), 'S-GAP-MID': (16,), 'S-GAP-NEAR-FIRST': (1,)}
TRANSFER = {'TF-MARK': ((-1000, '#000000', 0), (899, '#000000', 0), (900, '#ffffff', 1), (2000, '#ffffff', 1)),
            'TF-COLOR': ((-1000, '#000000', 0), (1399, '#000000', 0), (1400, '#ff0000', 1), (1600, '#ff0000', 1),
                         (1601, '#0000ff', 1), (2000, '#0000ff', 1))}
THRESHOLD = {'TF-MARK': 900, 'TF-COLOR': 1400}
MAX_STEPS = tuple('MX-%02d' % n for n in range(28))
REASON_KEYS = {'source-irregular', 'source-unsupported', 'source-changed', 'vr-not-reproducible', 'vr-not-final',
               'vr-unapplied-edit', 'busy', 'vr-layout', 'vr-combination', 'vr-limit', 'render-failed', 'context-lost',
               'access-lost', 'vr-output-unsupported'}
FORBIDDEN = ('골제거', 'bone removal', '자동')

# REQ-S8-SCULPT-PERF-TARGET: each MAX render action within 30 s on the CI's software GL. REFERENCE_S bounds one frame of
# today's generator drawn for BU-T03 (its compile is the cost B-u removes); both are fixed values, never raised after a result.
TARGET_S, REFERENCE_S = 30, 120


def process_table():
    """{pid: (parent pid, argv)} from Linux /proc; None where processes cannot be listed (no supervisor can be started)."""
    if not os.path.isdir('/proc/self/task'):
        return None
    table = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open('/proc/%s/stat' % name, 'rb') as stat_file:
                stat = stat_file.read()
            with open('/proc/%s/cmdline' % name, 'rb') as argv_file:
                argv = [part.decode('utf-8', 'replace') for part in argv_file.read().split(b'\0') if part]
        except OSError:
            continue
        # The command name in stat may hold spaces or parentheses; the fields after its last ')' are fixed.
        table[int(name)] = (int(stat[stat.rindex(b')') + 2:].split()[1]), argv)
    return table


def subtree(table, root):
    children = {}
    for pid, (parent, _) in table.items():
        children.setdefault(parent, []).append(pid)
    out, todo = [], [root]
    while todo:
        for child in children.get(todo.pop(), ()):
            out.append(child); todo.append(child)
    return out


def browser_roots():
    """The Chromium browser processes this test process started through Playwright's driver: a browser binary whose parent is
    not one (its renderer, GPU and zygote processes are its descendants). None where processes cannot be listed."""
    table = process_table()
    if table is None:
        return None
    def chromium(pid):
        argv = table.get(pid, (0, []))[1]
        return bool(argv) and re.search(r'chrom|headless_shell', os.path.basename(argv[0]), re.I) is not None
    return {pid for pid in subtree(table, os.getpid()) if chromium(pid) and not chromium(table[pid][0])}


class Supervisor:
    """MAX external deadline for one browser: a thread outside the browser kills the browser's whole process tree when the
    armed absolute deadline passes, so a hung page, renderer or GPU process cannot hold a Playwright call past it. The call
    then fails with the browser gone; nothing is retried or extended. One deadline is armed at a time."""

    def __init__(self, root):
        self.root, self.lock, self.timer, self.token, self.fired = root, threading.Lock(), None, 0, None

    def arm(self, deadline, label):
        with self.lock:
            if self.timer is not None:
                self.timer.cancel()
            self.token += 1; token = self.token
            self.timer = threading.Timer(max(0., deadline - time.monotonic()), self.fire, (token, label, deadline))
            self.timer.daemon = True; self.timer.start()
            return token

    def disarm(self, token):
        """Stops the deadline armed as token; returns the supervisor's record when it already ended the browser for it."""
        with self.lock:
            if token == self.token and self.timer is not None:
                self.timer.cancel(); self.timer = None
            return self.fired if self.fired and self.fired['token'] == token else None

    def fire(self, token, label, deadline):
        with self.lock:
            if token != self.token or self.fired:
                return
            # Only processes still under this test process: a pid is never signalled after it left the tree.
            table, killed = process_table() or {}, []
            mine = set(subtree(table, os.getpid()))
            for pid in [p for p in [self.root] + subtree(table, self.root) if p in mine]:
                try:
                    os.kill(pid, signal.SIGKILL); killed.append(pid)
                except OSError:
                    pass
            self.fired = {'token': token, 'label': label, 'late_s': round(time.monotonic() - deadline, 3), 'killed': len(killed)}
            self.timer = None
        print('VRVOI-MAX ' + json.dumps({'step': 'supervisor', **{k: x for k, x in self.fired.items() if k != 'token'}}), flush=True)


PHASE_BINDING = '__vrVoiPhases'
PHASE_STALL_MS = 250


def now_ms():
    return time.time() * 1000


def no_phase(name):
    return contextlib.nullcontext()


class Phases:
    """D419 phase record of one action: the Crop diagnosis and every MAX target action use this one
    recorder, armed before the action's input. It keeps the test's own phases (input, the click from dispatch to Playwright's
    return, the render wait, three frames, the product check, the step's state and pixel assertions) and the page's (HELPERS
    phaseStart: target handler start and end, the first new IMAGE_RENDERED, three frames after it, compile/link and other GL
    calls by phase, heartbeats and frames) as they arrive through a page binding, so a click that times out, a missed deadline
    or a browser the supervisor ends still leaves the phases up to then and the first stall. Observation only: nothing here
    decides a case. Times are epoch ms; the page's clock is mapped through the offset read when armed."""
    routes, pages = {}, {}

    def __init__(self, page, target, step, action, state=False):
        self.page, self.step, self.action, self.id = page, step, action, uuid.uuid4().hex
        self.marks, self.events, self.beats, self.frames, self.gl, self.seqs = [], [], [], [], {}, set()
        self.click_at, self.unread = None, None
        Phases.routes[self.id] = self
        if Phases.pages.get(id(page)) is not page:
            page.expose_binding(PHASE_BINDING, Phases.receive); Phases.pages[id(page)] = page
        before = now_ms(); clock = page.evaluate('o=>vrVoi.phaseStart(o)', {'id': self.id, 'binding': PHASE_BINDING, 'target': target, 'state': state})
        after = now_ms(); self.offset = clock - (before + after) / 2; self.armed_at = before; self.marks.append(['arm', before, after, False])

    @staticmethod
    def receive(source, batch):
        recorder = Phases.routes.get(batch.get('id')) if isinstance(batch, dict) else None
        if recorder is not None:
            recorder.take(batch)

    def take(self, batch):
        self.seqs.add(batch['seq']); self.events += batch['e']; self.beats += batch['b']; self.gl = batch['gl']
        self.frames += batch['f'][:max(0, 30000 - len(self.frames))]

    @contextlib.contextmanager
    def phase(self, name):
        mark = [name, now_ms(), None, False]; self.marks.append(mark)
        if name == 'click':
            self.click_at = mark[1]
        try:
            yield
        except BaseException:
            mark[2], mark[3] = now_ms(), True; raise
        mark[2] = now_ms()

    def prepare(self, action):
        """The action's input (a drawn shape, typed values) as the phase 'input'; a failure there writes the record too."""
        try:
            with self.phase('input'):
                action()
        except BaseException as error:
            line = {'step': self.step, 'action': self.action, 'outcome': 'input-failed', 'failure': repr(error)[:200]}
            print('VRVOI-MAX ' + json.dumps({**line, 'phases': self.finish(now_ms(), False)}), flush=True); raise

    def finish(self, end, alive):
        """The record up to end. alive: the page answers, so the recorder is removed and its last batch read; otherwise only
        what already reached the test counts, and one bounded protocol call delivers the batches already sent."""
        try:
            if alive:
                rest = self.page.evaluate('()=>vrVoi.phaseStop()')
                if rest:
                    self.take(rest)
            elif not self.page.is_closed():
                self.page.wait_for_timeout(1)
        except Exception as error:
            self.unread = repr(error)[:160]
        Phases.routes.pop(self.id, None)
        return self.summary(end)

    def summary(self, end):
        origin = self.click_at if self.click_at is not None else self.armed_at
        rel = lambda t: None if t is None else round(t - origin, 1)
        events = sorted(((t - self.offset, name, extra) for name, t, extra in self.events), key=lambda e: e[0])
        first = lambda name, after=None: next((t for t, n, _ in events if n == name and (after is None or t >= after)), None)
        began, ended = first('handler-start'), first('handler-end')
        rendered = first('rendered', began) if began is not None else None
        spans = [list(mark) for mark in self.marks]
        if began is not None:
            spans.append(['handler', began, ended, False])
        if ended is not None:
            spans.append(['to-render', ended, rendered, False])
        if rendered is not None:
            spans.append(['raf-3', rendered, first('frames-3', rendered), False])
        spans.sort(key=lambda s: s[1])

        def at(t, length):
            """Where a gap from t of length ms sits: the phase that ended last before it, the phases in progress at its start,
            those that began inside it, and the page events that still left the page inside it (tasks that ended)."""
            done = [s for s in spans if s[2] is not None and s[2] <= t]
            return {'after': max(done, key=lambda s: s[2])[0] if done else None, 'in': [s[0] for s in spans if s[1] <= t and (s[2] is None or s[2] > t)],
                    'began': [s[0] for s in spans if t < s[1] < t + length], 'page_events': [[n, rel(x)] for x, n, _ in events if t < x < t + length][:10]}
        # Heartbeat gaps from the end of arming to end; the last one has no beat after it (open: the page sent nothing more).
        beats = sorted(t - self.offset for t in self.beats if self.armed_at <= t - self.offset <= end)
        edges = [self.marks[0][2]] + beats + [max(end, beats[-1] if beats else end)]
        gaps = [(a, b - a, n == len(edges) - 2) for n, (a, b) in enumerate(zip(edges, edges[1:]))]
        gap = lambda g: None if g is None else {'at': rel(g[0]), 'ms': round(g[1], 1), 'open': g[2], **at(g[0], g[1])}
        frames = sorted(t - self.offset for t in self.frames)
        after_click = [(t, n, x) for t, n, x in events if began is not None and t >= began]
        out = {'origin': 'click' if self.click_at is not None else 'arm', 'clock_offset_ms': round(self.offset, 1), 'end': rel(end),
               'spans': [[s[0], rel(s[1]), rel(s[2])] + (['raised'] if s[3] else []) for s in spans],
               'last_page_event': [events[-1][1], rel(events[-1][0])] if events else None,
               'pointer_down': rel(first('pointer-down')), 'render_requests': sum(n == 'render-request' for _, n, _ in after_click),
               'rendered': sum(n == 'rendered' for _, n, _ in after_click), 'input_clicks': sum(n == 'input-click' for _, n, _ in events),
               'gl': {phase: {name: [g[0], round(g[1], 1), round(g[2], 1)] for name, g in sorted(table.items())} for phase, table in self.gl.items() if table},
               'beats': len(beats), 'first_stall': gap(next((g for g in gaps if g[1] > PHASE_STALL_MS), None)), 'longest_gap': gap(max(gaps, key=lambda g: g[1]) if gaps else None),
               'gaps': [[rel(a), round(d, 1)] for a, d, _ in sorted(gaps, key=lambda g: -g[1])[:5] if d > PHASE_STALL_MS],
               'frames': len(frames), 'longest_frame_gap_ms': round(max((b - a for a, b in zip(frames, frames[1:])), default=0.), 1),
               'long_tasks': sorted(([rel(x[0] - self.offset), round(x[1], 1)] for _, n, x in events if n == 'long-task'), key=lambda g: -g[1])[:3],
               'slow_gl': sorted(([x[0], rel(x[1] - self.offset), round(x[2], 1)] for _, n, x in events if n == 'slow-gl'), key=lambda g: -g[2])[:3],
               'batches': len(self.seqs), 'batches_missing': (max(self.seqs) + 1 - len(self.seqs)) if self.seqs else None, 'unread': self.unread}
        states = {n: x for _, n, x in events if n in ('start', 'handler-end', 'stop') and x is not None}
        if states:
            out['states'] = states
        return out


def grid_axes(grid):
    """Columns: the world step (mm) of one index along i, j, k (contract F-72; origin 0)."""
    iop = np.array(GRIDS[grid], float); row, col = iop[:3], iop[3:]
    return np.column_stack([row * SPACING[1], col * SPACING[0], np.cross(row, col) * STEP])


def world(grid, ijk):
    return grid_axes(grid) @ np.asarray(ijk, float)


def index_rows(grid):
    return np.linalg.inv(grid_axes(grid))


def box(grid, lo=(0, 0, 0), hi=(63, 63, 32)):
    """Rays through the index box [lo, hi] (voxel-centre coordinates). Marker and partial regions use it as they are; the
    default is the first-to-last voxel-centre box, which is not the render range (render_box)."""
    rows = index_rows(grid); return [(rows[i], lo[i], hi[i]) for i in range(3)]


def render_box(grid):
    """The unmasked render range (C-02 as corrected): each index extent widened by half a voxel, [-0.5, dims - 0.5]."""
    return box(grid, (-.5, -.5, -.5), tuple(n - .5 for n in DIMS))


def outer_corners(grid):
    """The 8 corners of the rendered outer box in world mm (G-AX: x, y -0.25..31.75 and z -1.25..81.25)."""
    axes = grid_axes(grid)
    return np.array([axes @ np.array([i, j, k], float) for i in (-.5, DIMS[0] - .5) for j in (-.5, DIMS[1] - .5) for k in (-.5, DIMS[2] - .5)])


def slab(center, normal, thickness):
    n = np.asarray(normal, float); h = float(n @ np.asarray(center, float)); return (n, h - thickness / 2, h + thickness / 2)


def crop(grid, ranges):
    """Crop planes sit half a voxel outside the kept index range (contract F-21)."""
    rows = index_rows(grid); return [(rows[i], ranges[i][0] - .5, ranges[i][1] + .5) for i in range(3)]


def visible(name, threshold):
    """The index box in which linear interpolation keeps a marker at or above the transfer threshold, inside the extent."""
    (i0, i1), (j0, j1), (k0, k1), hu = MARKERS[name]; f = max(0., 1 - threshold / hu)
    return ([max(0., i0 - f), max(0., j0 - f), max(0., k0 - f)], [min(63., i1 + f), min(63., j1 + f), min(32., k1 + f)])


def chord(grid, name, threshold, direction):
    """Ray length (mm) through the centre of a marker's visible box along a view direction (test-plan §8.3)."""
    lo, hi = visible(name, threshold); per = np.abs(index_rows(grid) @ np.asarray(direction, float))
    return min((h - l) / x for l, h, x in zip(lo, hi, per) if x > 1e-9)


def voi_series(stack, grid='G-AX', volume='V-MARK', encoding='E-U', variant='S-FULL'):
    """This module's synthetic CT: 64x64 voxels of 0.5 mm, 33 slices 2.5 mm apart, IPP = k * slice step (contract C-01)."""
    rep, slope, intercept = ENCODINGS[encoding]; axes = grid_axes(grid); hu = np.zeros((33, 64, 64), np.int32)
    if volume == 'V-BOX':
        hu[:] = 500
    else:
        for (i0, i1), (j0, j1), (k0, k1), value in MARKERS.values():
            hu[k0:k1 + 1, j0:j1 + 1, i0:i1 + 1] = value
    uid, series, frame = ct.generate_uid(), ct.generate_uid(), ct.generate_uid(); patient = 'VRVOI-' + uuid.uuid4().hex[:10]
    f = ct.Fixture(uid, patient, '한림병원', 'jmryu', 'VRVOI-SYNTHETIC'); stack.active[uid] = f
    ae = ct.AE(ae_title='HALLYM_CT'); ae.add_requested_context(ct.CTImageStorage, ct.ExplicitVRLittleEndian)
    assoc = ae.associate('127.0.0.1', 4242, ae_title='KINLAB')
    if not assoc.is_established:
        raise RuntimeError('Local CT association failed')
    try:
        for k in range(33):
            if k in VARIANTS[variant]:
                continue
            sop = ct.generate_uid(); meta = ct.FileMetaDataset(); meta.TransferSyntaxUID = ct.ExplicitVRLittleEndian
            meta.MediaStorageSOPClassUID = ct.CTImageStorage; meta.MediaStorageSOPInstanceUID = sop; meta.ImplementationClassUID = ct.generate_uid()
            d = ct.FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128); d.SOPClassUID = ct.CTImageStorage; d.SOPInstanceUID = sop
            d.SpecificCharacterSet = 'ISO_IR 192'; d.PatientName = 'VRVOI^SYNTHETIC'; d.PatientID = patient; d.PatientBirthDate = ''; d.PatientSex = 'O'; d.InstitutionName = '한림병원'
            d.StudyInstanceUID = uid; d.SeriesInstanceUID = series; d.FrameOfReferenceUID = frame; d.StudyDate = d.SeriesDate = '20261002'; d.StudyTime = d.SeriesTime = '120000'
            d.AccessionNumber = 'VRVOI'; d.StudyID = 'VRVOI'; d.StudyDescription = d.SeriesDescription = 'VR VOI ' + volume + ' ' + grid + ' ' + encoding + ' ' + variant
            d.Modality = 'CT'; d.SeriesNumber = 1; d.InstanceNumber = k + 1; d.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
            d.ImageOrientationPatient = [format(x, '.10g') for x in GRIDS[grid]]; d.ImagePositionPatient = [format(x, '.10g') for x in axes[:, 2] * k]
            d.SliceLocation = k * STEP; d.PixelSpacing = list(SPACING); d.SliceThickness = d.SpacingBetweenSlices = STEP
            d.Rows = d.Columns = 64; d.SamplesPerPixel = 1; d.PhotometricInterpretation = 'MONOCHROME2'; d.BitsAllocated = d.BitsStored = 16; d.HighBit = 15
            # A window that shows 0 HU as mid gray keeps the first canvas readable for both volumes.
            d.WindowCenter = 500 if volume == 'V-BOX' else 0; d.WindowWidth = 1000; d.RescaleIntercept = intercept; d.RescaleSlope = slope; d.RescaleType = 'HU'
            stored = (hu[k] - intercept) // slope; d.PixelRepresentation = rep
            d.PixelData = stored.astype('<i2' if rep else '<u2').tobytes(); status = assoc.send_c_store(d)
            if status is None or status.Status != 0:
                raise RuntimeError('Synthetic CT C-STORE failed')
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request('GET', '/studies', 'jmryu')
        if result.status == 200 and any(s['uid'] == uid for s in result.body['studies']):
            if stack.request('PATCH', '/studies/' + uid, 'jmryu', {'ss': 'Verified'}).status != 200:
                raise RuntimeError('Synthetic CT verification failed')
            f.vrvoi = {'grid': grid, 'volume': volume, 'encoding': encoding, 'variant': variant, 'hu': hu}
            return f
        time.sleep(.25)
    raise RuntimeError('VR VOI CT did not reach local API')


# Page helpers. The VR viewport is the rendering engine's only VOLUME_3D viewport; pixels come from its native canvas.
HELPERS = """()=>{if(window.vrVoi)return;
const E=cornerstone.Enums,views=()=>cornerstone.getRenderingEngines().flatMap(e=>e.getViewports()).filter(v=>v.type===E.ViewportType.VOLUME_3D);
const one=()=>{const list=views();if(list.length!==1)throw Error('VOLUME_3D viewports: '+list.length);return list[0]};
const mapper=()=>one().getActors()[0].actor.getMapper();
const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return btoa(s)};
window.vrVoi={
 count:()=>views().length,
 info:()=>{const v=one(),c=v.getCanvas(),e=v.element,m=mapper(),cam=v.getCamera();return {width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight,hostWidth:e.clientWidth,hostHeight:e.clientHeight,dpr:devicePixelRatio,viewPlaneNormal:Array.from(cam.viewPlaneNormal),viewUp:Array.from(cam.viewUp),parallel:cam.parallelProjection===true,parallelScale:cam.parallelScale,sampleDistance:m.getSampleDistance(),planes:m.getClippingPlanes().map(p=>({origin:Array.from(p.getOrigin()),normal:Array.from(p.getNormal())})),properties:JSON.stringify(m.getViewSpecificProperties()??null)}},
 rect:()=>{const r=one().element.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}},
 project:points=>{const v=one();return points.map(p=>Array.from(v.worldToCanvas(p)))},
 projection:()=>{const v=one(),img=cornerstone.cache.getVolume(v.getVolumeId()).imageData,e=Array.from(img.getSpatialExtent()),w=v.element.clientWidth,h=v.element.clientHeight;
  const c=[[e[0],e[2],e[4]],[e[1],e[2],e[4]],[e[0],e[3],e[4]],[e[0],e[2],e[5]]].map(i=>Array.from(v.worldToCanvas(Array.from(img.indexToWorld(i))))).map(p=>[p[0]/w,p[1]/h]);
  return {base:c[0],axes:c.slice(1).map(p=>[p[0]-c[0][0],p[1]-c[0][1]])}},
 source:()=>{const vol=cornerstone.cache.getVolume(one().getVolumeId()),img=vol.imageData,d=Array.from(vol.dimensions),last=d.map(n=>n-1);
  const corners=[];for(const i of [0,last[0]])for(const j of [0,last[1]])for(const k of [0,last[2]])corners.push([i,j,k]);
  return {volumeId:vol.volumeId,dimensions:d,last:Array.from(img.indexToWorld(last)),hu:[...corners,last.map(n=>Math.floor(n/2))].map(i=>vol.voxelManager.getAtIJK(...i)),imageId:vol.imageIds[0]}},
 lit:()=>{const c=one().getCanvas(),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,n=c.width*c.height,out=new Uint8Array(Math.ceil(n/8));for(let p=0,i=0;p<n;p++,i+=4)if(Math.max(d[i],d[i+1],d[i+2])>5)out[p>>3]|=1<<(p&7);return {width:c.width,height:c.height,bits:b64(out)}},
 rgba:()=>{const c=one().getCanvas(),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return {width:c.width,height:c.height,bytes:b64(new Uint8Array(d.buffer))}},
 observe:([dialog,status])=>{window.vrVoi.release();const v=one(),w={frames:0,armed:false,statusWrites:0,element:v.element,dialog};
  // A click on the canvas ends a drag after its renders; drags are armed explicitly before the first move.
  w.frame=()=>{if(w.armed)w.frames++};w.action=e=>{if(e&&w.element.contains(e.target))return;w.frames=0;w.statusWrites=0;w.armed=true};
  v.element.addEventListener(E.Events.IMAGE_RENDERED,w.frame);dialog.addEventListener('click',w.action,true);dialog.addEventListener('change',w.action,true);
  w.observer=new MutationObserver(()=>{if(w.armed)w.statusWrites++});w.observer.observe(status,{childList:true,characterData:true,subtree:true});window.vrVoi.watch=w},
 release:()=>{window.vrVoi.phaseStop();const w=window.vrVoi.watch;if(!w)return;w.element.removeEventListener(E.Events.IMAGE_RENDERED,w.frame);w.dialog.removeEventListener('click',w.action,true);w.dialog.removeEventListener('change',w.action,true);w.observer.disconnect();window.vrVoi.watch=null},
 arm:()=>{const w=window.vrVoi.watch;w.frames=0;w.statusWrites=0;w.armed=true},
 watched:()=>{const w=window.vrVoi.watch;return w?{frames:w.frames,armed:w.armed,statusWrites:w.statusWrites}:null},
 frames:()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r)))),
 inspect:()=>window.kinVolumeVr.inspect(),
 // Renderer reads for NT-U1a-03 preconditions: the applied transfer functions evaluated at given HU, shading, and the HU the
 // VR's own volume holds at given indices (the render input).
 display:hus=>{const p=one().getActors()[0].actor.getProperty(),c=p.getRGBTransferFunction(0),o=p.getScalarOpacity(0),node=(f,i)=>{const n=[];f.getNodeValue(i,n);return n};
  return {shade:p.getShade(),color:Array.from({length:c.getSize()},(_,i)=>node(c,i)),opacity:Array.from({length:o.getSize()},(_,i)=>node(o,i)),
   at:hus.map(hu=>{const rgb=[0,0,0];c.getColor(hu,rgb);return {hu,rgb,opacity:o.getValue(hu)}})}},
 hu:indices=>{const vol=cornerstone.cache.getVolume(one().getVolumeId());return indices.map(i=>vol.voxelManager.getAtIJK(...i))},
 // What a frame depends on apart from the masks (input, transfer function, sample distance, gradient and shading, camera,
 // canvas, crop planes and GL device). Reads only.
 conditions:()=>{const v=one(),m=mapper(),p=v.getActors()[0].actor.getProperty(),cam=v.getCamera(),c=v.getCanvas(),gl=v.getRenderingEngine().offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  const nodes=f=>Array.from({length:f.getSize()},(_,i)=>{const n=[];f.getNodeValue(i,n);return n}),vol=cornerstone.cache.getVolume(v.getVolumeId()),last=Array.from(vol.dimensions).map(n=>n-1);
  return {css:[v.element.clientWidth,v.element.clientHeight],canvas:[c.width,c.height],dpr:devicePixelRatio,viewPlaneNormal:Array.from(cam.viewPlaneNormal),viewUp:Array.from(cam.viewUp),parallel:cam.parallelProjection===true,parallelScale:cam.parallelScale,
   sampleDistance:m.getSampleDistance(),planes:m.getClippingPlanes().map(q=>({origin:Array.from(q.getOrigin()),normal:Array.from(q.getNormal())})),gradient:[p.getUseGradientOpacity(0),p.getGradientOpacityMinimumOpacity(0),p.getGradientOpacityMaximumOpacity(0)],
   shade:p.getShade(),interpolation:p.getInterpolationType(),color:nodes(p.getRGBTransferFunction(0)),opacity:nodes(p.getScalarOpacity(0)),dimensions:Array.from(vol.dimensions),spacing:Array.from(vol.imageData.getSpacing()),
   last:Array.from(vol.imageData.indexToWorld(last)),hu:[[0,0,0],last,last.map(n=>Math.floor(n/2))].map(i=>vol.voxelManager.getAtIJK(...i)),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}},
 // BU-T03: the state a frame shows (the applied masks as the capability reports them, and the conditions above).
 referenceKey:()=>{const s=window.kinVolumeVr.inspect();return JSON.stringify({masks:{voi:s.voi,crop:s.crop,sculpt:s.sculpt,original:s.originalView},conditions:window.vrVoi.conditions()})},
 // BU-T03: one frame of today's generator for the applied masks (KinVolumeVrMasks.build of the same request the VR applies)
 // on the same mapper, camera, display and jitter texture, read from the same canvas; then the VR's own properties are put
 // back and drawn again. The request is rebuilt from the capability and the public VOI model, not from the VR's internals.
 reference:async()=>{const v=one(),m=mapper(),s=window.kinVolumeVr.inspect(),V=window.KinVolumeVrVoi,M=window.KinVolumeVrMasks,img=cornerstone.cache.getVolume(v.getVolumeId()).imageData;
  const request={voi:s.voi?V.shaderPlane({mode:'Slab',orientation:s.voi.orientation,slab:s.voi.slab},V.binding(img)):null,original:s.originalView,
   sculpt:(s.sculpt||[]).map(o=>({side:o.side,projection:o.projection,region:o.region.kind==='Polygon'?{kind:'Polygon',points:o.region.points,bounds:o.region.bounds}:{kind:o.region.kind,bounds:o.region.bounds}}))};
  const saved=m.getViewSpecificProperties()||{},list=saved.OpenGL?.ShaderReplacements||[],pristine={...saved,OpenGL:{...(saved.OpenGL||{}),ShaderReplacements:list.filter(r=>!M.owned(r.replacementValue))}};
  const drawn=()=>new Promise(done=>{const seen=()=>{v.element.removeEventListener(E.Events.IMAGE_RENDERED,seen);requestAnimationFrame(()=>done())};v.element.addEventListener(E.Events.IMAGE_RENDERED,seen);v.render()});
  const generated=M.build(request),started=performance.now();m.setViewSpecificProperties(M.properties(pristine,generated));await drawn();
  const ms=performance.now()-started,pixels=window.vrVoi.rgba();m.setViewSpecificProperties(saved);await drawn();
  return {pixels,ms:Math.round(ms),generated:generated!==null}},
 // Phase recorder of one action (D419; the S8-U1a-SPEC-B-F03 Crop trace made one recorder for the Crop diagnosis and every
 // MAX target action, so they all pay the same cost). Everything is pass-through
 // and removed by phaseStop: the target button's pointer-down and click before any product listener (window, capture) and
 // after the product's handler (dialog, bubble), the VR viewport's render requests, IMAGE_RENDERED, every animation frame, a
 // 100 ms heartbeat, long tasks, and the duration of WebGL and 2D canvas calls by phase (before the target click, in its
 // handler where the preflight runs, after it; a call of 50 ms or more is listed with its start). Every event and every
 // heartbeat sends what was recorded to the test's page binding: a batch leaves the page when its task ends, so a stall
 // shows as the heartbeat gap that ends it, and a browser ended in a stall leaves the test everything up to that task.
 phaseStart:o=>{window.vrVoi.phaseStop();const v=one(),m=mapper(),send=window[o.binding],clock=()=>performance.timeOrigin+performance.now();
  const r={id:o.id,seq:0,e:[],b:[],f:[],gl:{pre:{},handler:{},render:{}},phase:'pre',rendered:false,after:-1,count:0,undo:[]};
  const take=()=>{const out={id:r.id,seq:r.seq++,e:r.e,b:r.b,f:r.f,gl:r.gl};r.e=[];r.b=[];r.f=[];return out};
  const flush=()=>{if(r.e.length||r.b.length||r.f.length)try{send(take())}catch(_){}};
  const ev=(name,extra)=>{if(r.count++<3000)r.e.push([name,clock(),extra===undefined?null:extra]);flush()};
  const state=()=>{const s=window.kinVolumeVr?.inspect?.(),p=m.getViewSpecificProperties()??null;return {planes:m.getClippingPlanes().length,masks:(p?.OpenGL?.ShaderReplacements||[]).length,propertiesLength:JSON.stringify(p).length,voi:s?!!s.voi:null,sculpt:s?.sculpt?.length??0,crop:s?.crop??null}};
  r.ev=ev;r.take=take;r.state=o.state?state:()=>null;ev('start',r.state());
  const beat=setInterval(()=>{r.b.push(clock());flush()},100);r.undo.push(()=>clearInterval(beat));
  let live=true;const raf=()=>{if(!live)return;r.f.push(clock());if(r.after>=0&&r.after<3&&++r.after===3)ev('frames-3');requestAnimationFrame(raf)};requestAnimationFrame(raf);r.undo.push(()=>{live=false});
  try{const ob=new PerformanceObserver(list=>{for(const x of list.getEntries())ev('long-task',[performance.timeOrigin+x.startTime,x.duration])});ob.observe({type:'longtask'});r.undo.push(()=>ob.disconnect())}catch(_){}
  const rendered=()=>{ev('rendered');if(r.phase!=='pre'&&!r.rendered){r.rendered=true;r.after=0}};v.element.addEventListener(E.Events.IMAGE_RENDERED,rendered);r.undo.push(()=>v.element.removeEventListener(E.Events.IMAGE_RENDERED,rendered));
  const named=e=>{const b=e.target?.closest?.('button,[role=button]');return b?(b.getAttribute('aria-label')||b.textContent||'').trim():null};
  const down=e=>{if(r.phase==='pre'&&named(e)===o.target)ev('pointer-down')};
  const start=e=>{const name=named(e);if(r.phase!=='pre')return;if(name===o.target){r.phase='handler';ev('handler-start')}else ev('input-click',name)};
  const end=e=>{if(r.phase==='handler'&&named(e)===o.target){r.phase='render';ev('handler-end',r.state());flush()}};
  const dialog=window.vrVoi.watch.dialog;window.addEventListener('mousedown',down,true);window.addEventListener('click',start,true);dialog.addEventListener('click',end,false);
  r.undo.push(()=>{window.removeEventListener('mousedown',down,true);window.removeEventListener('click',start,true);dialog.removeEventListener('click',end,false)});
  const own=Object.prototype.hasOwnProperty.call(v,'render'),render=v.render;v.render=function(...a){ev('render-request');return render.apply(this,a)};r.undo.push(()=>{if(own)v.render=render;else delete v.render});
  const timed=(proto,name)=>{const original=proto&&proto[name];if(typeof original!=='function')return;proto[name]=function(...a){const s=performance.now();try{return original.apply(this,a)}finally{const d=performance.now()-s,t=r.gl[r.phase],g=t[name]||(t[name]=[0,0,0]);g[0]++;g[1]+=d;if(d>g[2])g[2]=d;if(d>=50)ev('slow-gl',[name,performance.timeOrigin+s,d])}};r.undo.push(()=>{proto[name]=original})};
  for(const C of [window.WebGL2RenderingContext,window.WebGLRenderingContext])if(C)for(const n of ['compileShader','linkProgram','getShaderParameter','getProgramParameter','useProgram','drawArrays','drawElements','texImage3D','texSubImage3D','texImage2D','readPixels','finish','flush'])timed(C.prototype,n);
  timed(window.CanvasRenderingContext2D?.prototype,'drawImage');
  window.vrVoi.phases=r;return clock()},
 phaseStop:()=>{const r=window.vrVoi.phases;if(!r)return null;for(const f of r.undo.reverse())try{f()}catch(_){}window.vrVoi.phases=null;r.e.push(['stop',performance.timeOrigin+performance.now(),r.state()]);return r.take()}};}"""


# BU-T06a/BU-T06b page helpers: a mask session of the product module (KinVolumeMaskRenderer.session, its public API) on a
# VOLUME_3D viewport the test enables on the shared engine, and later on a new rendering engine the test makes. GL calls are
# counted per canvas from the WebGL prototypes (pass-through), so calls on a lost context are visible; the renderer hands out
# a binding proxy of its context, so the canvas, not the context object, names the context.
SESSION_HELPERS = """()=>{if(window.vrBu)return;const E=cornerstone.Enums;
const counts=new Map(),watched=['compileShader','linkProgram','useProgram','uniform4i','uniform4iv','uniform4fv','uniform2fv','getUniform','getUniformLocation','deleteProgram'];
for(const C of [window.WebGL2RenderingContext,window.WebGLRenderingContext])if(C)for(const name of watched){const original=C.prototype[name];if(typeof original!=='function')continue;
 C.prototype[name]=function(...args){const c=counts.get(this.canvas)||{};c[name]=(c[name]||0)+1;counts.set(this.canvas,c);return original.apply(this,args)}}
const count=gl=>({...(counts.get(gl.canvas)||{})});
const frameFor=view=>done=>{let finished=false,frames=0;const finish=error=>{if(finished)return;finished=true;view.element.removeEventListener(E.Events.IMAGE_RENDERED,seen);Promise.resolve().then(()=>done({error}))};
 const seen=()=>finish(null);view.element.addEventListener(E.Events.IMAGE_RENDERED,seen);try{view.render()}catch(error){finish(error);return}
 const tick=()=>{if(finished)return;if(++frames>3)finish(Error('no frame'));else requestAnimationFrame(tick)};requestAnimationFrame(tick)};
const drawn=view=>new Promise(done=>{const seen=()=>{view.element.removeEventListener(E.Events.IMAGE_RENDERED,seen);requestAnimationFrame(()=>done())};view.element.addEventListener(E.Events.IMAGE_RENDERED,seen);view.render()});
const pixels=view=>{const c=view.getCanvas(),d=new Uint8Array(c.getContext('2d').getImageData(0,0,c.width,c.height).data.buffer);let s='';for(let i=0;i<d.length;i+=32768)s+=String.fromCharCode.apply(null,d.subarray(i,i+32768));return {width:c.width,height:c.height,bytes:btoa(s)}};
async function viewport(engine,id){const element=document.createElement('div');element.style.cssText='position:fixed;left:0;bottom:0;width:256px;height:256px';document.body.append(element);
 engine.enableElement({viewportId:id,type:E.ViewportType.VOLUME_3D,element,defaultOptions:{parallelProjection:true}});const view=engine.getViewport(id);
 await view.setVolumes([{volumeId:cornerstone.cache.getVolume(projectionVP.getVolumeId()).volumeId}]);view.setProperties({preset:'CT-Bone'});view.resetCamera();await drawn(view);return view}
// A VOI slab and one rectangle region through the public VOI and sculpt models, on the viewport's own projection.
function request(view){const V=window.KinVolumeVrVoi,S=window.KinVolumeSculpt,img=cornerstone.cache.getVolume(view.getVolumeId()).imageData,bound=V.binding(img);
 const voi=V.apply(V.initial(),bound,{orientation:'Axial',slab:{center:[15.75,15.75,40],normal:[0,0,1],pivot:[15.75,15.75,40],thickness:20}}).voi;
 const projection=S.projection(img,p=>view.worldToCanvas(p),view.element.clientWidth,view.element.clientHeight);
 return {voi:V.shaderPlane(voi,bound),sculpt:[S.makeOperation(S.makeRegion('Rectangle',[[.35,.35],[.65,.65]]),projection,'Inside')],original:false}}
window.vrBu={
 open:async()=>{const engine=projectionVP.getRenderingEngine(),view=await viewport(engine,'kin-test-bu-shared'),mapper=view.getActors()[0].actor.getMapper();
  const gl=engine.offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext(),session=KinVolumeMaskRenderer.session({target:{engine,mapper,frame:frameFor(view)}});
  const a=request(view),result=await session.apply(a);Object.assign(window.vrBu,{engine,view,gl,session,a});return {status:result.status,gen:result.gen,state:session.state().status}},
 // The product VR's Apply VOI is clicked and the test session applies another request; while both are in flight the
 // registry's release runs (as a viewer-wide unit would on a loss) and then the context is lost.
 loseWithPending:button=>{const b=window.vrBu;button.click();b.pending=b.session.apply({voi:b.a.voi,sculpt:[],original:false});const pending=b.session.state().pending;
  const kept=window.vrReleases[0]();b.gl.getExtension('WEBGL_lose_context').loseContext();return {kept,pending:pending&&pending.gen,lost:b.gl.isContextLost()}},
 afterLoss:async()=>{const b=window.vrBu,result=await b.pending,state=b.session.state(),before=count(b.gl);let refused=null;
  try{b.session.apply(b.a)}catch(error){refused=error.kinVrReason}const render=await b.session.render(),after=count(b.gl),errors=[];
  for(let n=0;n<4;n++){const e=b.gl.getError();errors.push(e);if(e===b.gl.NO_ERROR)break}
  return {pending:result.status,state:{status:state.status,committed:state.committed&&state.committed.gen,pending:state.pending},refused,render:render.status,
   calls:Object.fromEntries(Object.entries(after).map(([k,n])=>[k,n-(before[k]||0)]).filter(([,n])=>n)),errors,lostCode:b.gl.CONTEXT_LOST_WEBGL,noError:b.gl.NO_ERROR}},
 reacquire:async()=>{const b=window.vrBu,engine=new cornerstone.RenderingEngine('kin-test-bu-new-context');b.engine2=engine;const view=await viewport(engine,'kin-test-bu-new');
  const gl=engine.offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext(),mapper=view.getActors()[0].actor.getMapper(),plain=pixels(view),before=count(gl);
  const result=await b.session.reacquire({engine,mapper,frame:frameFor(view)}),after=count(gl),state=b.session.state(),shown=pixels(view);
  const M=window.KinVolumeVrMasks,saved=mapper.getViewSpecificProperties()||{},list=saved.OpenGL?.ShaderReplacements||[];
  mapper.setViewSpecificProperties(M.properties({...saved,OpenGL:{...(saved.OpenGL||{}),ShaderReplacements:list.filter(r=>!M.owned(r.replacementValue))}},M.build(b.a)));await drawn(view);const generator=pixels(view);
  mapper.setViewSpecificProperties(saved);await drawn(view);const again=pixels(view),info=gl.getExtension('WEBGL_debug_renderer_info');
  return {status:result.status,gen:result.gen,state:{status:state.status,committed:state.committed&&state.committed.gen,sameRequest:!!state.committed&&state.committed.request===b.a},
   compile:(after.compileShader||0)-(before.compileShader||0),link:(after.linkProgram||0)-(before.linkProgram||0),plain,shown,generator,again,renderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null}},
 close:()=>{const b=window.vrBu;try{b.session.close()}catch(_){}try{b.engine2&&b.engine2.destroy()}catch(_){}}};}"""

class Scene:
    """One native VR frame (DPR 1) and the affine world->canvas map of its parallel camera (contract C-03)."""

    def __init__(self, v, pixels=True):
        """pixels=False reads the camera only, so a region can be fixed before the frame's pixels are read (read_pixels)."""
        self.info = v.evaluate('()=>vrVoi.info()'); self.w, self.h = self.info['width'], self.info['height']
        if pixels:
            self.read_pixels(v)
        probe = np.array(v.evaluate('p=>vrVoi.project(p)', [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]), float)
        self.b = probe[0]; self.M = (probe[1:] - probe[0]).T
        self.pinv = np.linalg.pinv(self.M); self.d = np.linalg.svd(self.M)[2][2]
        ys, xs = np.mgrid[0:self.h, 0:self.w]; self.uv = np.stack([xs + .5, ys + .5], -1).astype(float); self.uvb = self.uv - self.b
        self.px_per_mm = float(np.sqrt(abs(np.linalg.det(self.M @ self.M.T))) ** .5)

    def read_pixels(self, v):
        lit = v.evaluate('()=>vrVoi.lit()'); self.w, self.h = lit['width'], lit['height']
        raw = np.frombuffer(base64.b64decode(lit['bits']), np.uint8)
        self.lit = np.unpackbits(raw, bitorder='little')[:self.w * self.h].reshape(self.h, self.w).astype(bool)

    def css(self, points):
        return np.asarray(points, float) @ self.M.T + self.b

    def hits(self, constraints, du=0., dv=0.):
        """Rays (pixel centres shifted by du, dv) that meet every linear constraint lo <= a.p <= hi somewhere. A ray is
        p0 + s d with p0 the least-squares preimage of its pixel, so a.p is linear in the pixel and in s."""
        lo = np.full((self.h, self.w), -np.inf); hi = np.full((self.h, self.w), np.inf)
        for a, low, high in constraints:
            a = np.asarray(a, float); rate = float(a @ self.d); g = self.pinv.T @ a; value = self.uvb @ g + (du * g[0] + dv * g[1])
            if abs(rate) < 1e-12:
                inside = (value >= low) & (value <= high); lo = np.where(inside, lo, np.inf); hi = np.where(inside, hi, -np.inf)
            else:
                s1, s2 = (low - value) / rate, (high - value) / rate
                lo = np.maximum(lo, np.minimum(s1, s2)); hi = np.minimum(hi, np.maximum(s1, s2))
        return lo <= hi

    def polygon(self, points, du=0., dv=0.):
        """Pixel centres inside a canvas polygon (CSS px), evaluated only near its bounding box; callers drop the T band."""
        pts = np.asarray(points, float); inside = np.zeros((self.h, self.w), bool)
        x0, y0 = np.maximum(np.floor(pts.min(0) - 3).astype(int), 0); x1, y1 = np.minimum(np.ceil(pts.max(0) + 3).astype(int), [self.w, self.h])
        if x1 <= x0 or y1 <= y0:
            return inside
        u = self.uv[y0:y1, x0:x1, 0] + du; v = self.uv[y0:y1, x0:x1, 1] + dv; c = np.zeros(u.shape, bool)
        for (ax, ay), (bx, by) in zip(pts, np.roll(pts, -1, 0)):
            if ay != by:
                cross = ((ay > v) != (by > v)) & (u < (bx - ax) * (v - ay) / (by - ay) + ax); c ^= cross
        inside[y0:y1, x0:x1] = c; return inside

    def ring(self, fn, radius, count=8):
        """(centre, band, dilation): band = the decision changes within radius px; dilation = true somewhere within it."""
        centre = fn(0., 0.); band = np.zeros_like(centre); grown = centre.copy()
        for n in range(count):
            a = 2 * math.pi * n / count; other = fn(radius * math.cos(a), radius * math.sin(a)); band |= other != centre; grown |= other
        return centre, band, grown

    def plane_strips(self, constraints, index, side, tolerance, away=4., width=4.):
        """A guaranteed edge (contract E(T)): the boundary plane of one constraint is parallel to the rays (within 1 degree),
        so it projects to a line. Strips beyond the tolerance on each side, away from every other boundary, must be all lit
        inside and dark outside. Returns the counts; the caller asserts."""
        a, low, high = constraints[index]; a = np.asarray(a, float)
        parallel = abs(a @ self.d) / np.linalg.norm(a) <= math.sin(math.radians(1))
        others = [c for n, c in enumerate(constraints) if n != index]
        centre, band, _ = self.ring(lambda du, dv: self.hits(others, du, dv), away)
        domain = centre & ~band; g = self.pinv.T @ a; value = (self.uv - self.b) @ g; norm = float(np.linalg.norm(g))
        s = (value - low) / norm if side == 'low' else (high - value) / norm
        inside = domain & (s > tolerance) & (s <= tolerance + width); outside = domain & (s < -tolerance) & (s >= -tolerance - width)
        return {'parallel': bool(parallel), 'inside': int(inside.sum()), 'inside_lit': float(self.lit[inside].mean()) if inside.any() else None,
                'outside': int(outside.sum()), 'outside_lit': int(self.lit[outside].sum())}

    def marker(self, grid, name, threshold, tolerance):
        lo, hi = visible(name, threshold); cons = box(grid, lo, hi)
        return self.ring(lambda du, dv: self.hits(cons, du, dv), tolerance)[2]


def edge_ok(result):
    return result['parallel'] and result['inside'] > 0 and result['outside'] > 0 and result['inside_lit'] >= .99 and result['outside_lit'] == 0


# NT-U1a-03 fixed RGBA region (S8-U1a-SPEC-B-F02), defined from geometry and the transfer function before any pixel is read.
# V-MARK/G-AX, TF-MARK, shading off, Anterior, a Coronal slab y 20.75..22.75 mm: rays through world x 10.5..13 and
# z 38.75..41.25 keep only MK-MID's uniform 1200 HU interior, whose every interpolation neighbour is MK-MID (index
# [21,26] x [41,46] x [15,17]). Each contributing sample is white with opacity 1, so the pixel is [255, 255, 255, 255]
# whatever the ray phase; 2 mm of kept ray is longer than the 0.583 mm sample distance seen on hosted runs.
RGBA_SLAB = ((15.75, 21.75, 40.), 2.)
RGBA_REGION = ((10.5, 13.), (38.75, 41.25))
RGBA_KNOWN = (255, 255, 255, 255)
# Negative control: the same region under a Coronal slab whose kept ray (y 25.75..27.75) meets no marker.
RGBA_EMPTY_SLAB = ((15.75, 26.75, 40.), 2.)


def hex_rgb(color):
    return tuple(int(color[n:n + 2], 16) / 255 for n in (1, 3, 5))


def transfer_at(name, hu):
    """The piecewise-linear transfer function of the knots at hu: (rgb 0..1, opacity), held at the end knots beyond them."""
    knots = TRANSFER[name]
    if hu <= knots[0][0]:
        return hex_rgb(knots[0][1]), knots[0][2]
    for (x0, c0, a0), (x1, c1, a1) in zip(knots, knots[1:]):
        if hu <= x1:
            t = (hu - x0) / (x1 - x0); r0, r1 = hex_rgb(c0), hex_rgb(c1)
            return tuple(r0[m] + t * (r1[m] - r0[m]) for m in range(3)), a0 + t * (a1 - a0)
    return hex_rgb(knots[-1][1]), knots[-1][2]


def marker_band(scene, grid='G-AX', transfer='TF-MARK'):
    """C-04: the pixels within T of any marker's visible-box boundary."""
    band = np.zeros((scene.h, scene.w), bool)
    for name in MARKERS:
        lo, hi = visible(name, THRESHOLD[transfer]); cons = box(grid, lo, hi); band |= scene.ring(lambda du, dv: scene.hits(cons, du, dv), T_AXIS)[1]
    return band


def rgba_region(scene):
    """The fixed region's pixels: rays meeting world x and z of RGBA_REGION, minus its own T band and every marker band."""
    (x0, x1), (z0, z1) = RGBA_REGION; cons = [(np.array([1., 0, 0]), x0, x1), (np.array([0, 0, 1.]), z0, z1)]
    centre, band, _ = scene.ring(lambda du, dv: scene.hits(cons, du, dv), T_AXIS)
    return centre & ~band & ~marker_band(scene)


def rgba_neighbours(slab_spec=RGBA_SLAB):
    """Every voxel index a kept sample of the region's rays can interpolate from (floor..ceil of the sample index range)."""
    (x0, x1), (z0, z1) = RGBA_REGION; (centre, thickness) = slab_spec; y0, y1 = centre[1] - thickness / 2, centre[1] + thickness / 2
    lo, hi = index_rows('G-AX') @ np.array([x0, y0, z0]), index_rows('G-AX') @ np.array([x1, y1, z1])
    ranges = [range(int(math.floor(min(a, b))), int(math.ceil(max(a, b))) + 1) for a, b in zip(lo, hi)]
    return [[i, j, k] for i in ranges[0] for j in ranges[1] for k in ranges[2]]


def rgba_difference(a, b):
    """Observation only: differing pixels, differing channel elements and the largest channel difference."""
    unequal = a != b
    return {'pixels': int(unequal.any(-1).sum()), 'elements': int(unequal.sum()), 'max': int(np.abs(a.astype(int) - b.astype(int)).max())}


# NT-U1a-05 sub-case MAX geometry on G-AX seen from Superior (test-plan §4 MAX-B, MAX-C).
F9 = ([6.4375, 26.375, 0], [19.3125, 27.625, 0])
SLAB_A, SLAB_B = ([15.75, 14.25, 40], 23), ([15.75, 16.75, 40], 23)
CI, CELLS = (0., 25.75, 5.25, 25.75), [(c, r) for r in range(2) for c in range(4)]


def rectangle(scene, corners):
    a, b = scene.css(corners)
    return np.array([a, [b[0], a[1]], b, [a[0], b[1]]])


def max_regions(scene, polygons, voi_slab):
    """Independent regions (MAX-C): box, crop keep, slab keep, each applied polygon and F9, every boundary's T band removed.
    The box is the rendered outer box, so the half voxel beyond the edge voxel centres is box, not background."""
    box_c = render_box('G-AX'); crop_c = crop('G-AX', ((0, 51), (0, 63), (0, 32)))[0]; slab_c = slab(voi_slab[0], (0, 1, 0), voi_slab[1]); f9 = rectangle(scene, F9)
    preds = {'box': lambda du, dv: scene.hits(box_c, du, dv), 'crop': lambda du, dv: scene.hits([crop_c], du, dv),
             'voi': lambda du, dv: scene.hits([slab_c], du, dv), 'f9': lambda du, dv: scene.polygon(f9, du, dv)}
    for n, poly in enumerate(polygons):
        preds['p%d' % n] = (lambda poly: lambda du, dv: scene.polygon(poly, du, dv))(poly)
    masks, band = {}, np.zeros((scene.h, scene.w), bool)
    for key, fn in preds.items():
        centre, changed, _ = scene.ring(fn, T_AXIS); masks[key] = centre; band |= changed
    anyp = np.zeros_like(band)
    for n in range(len(polygons)):
        anyp |= masks['p%d' % n]
    B, C, V, F = masks['box'], masks['crop'], masks['voi'], masks['f9']; keep = ~band
    out = {'BOX': B & keep, 'BG': ~B & keep, 'VOI': B & C & ~V & ~anyp & keep, 'CROP': B & ~C & V & ~anyp & keep,
           '2X': B & ~C & ~V & keep, 'KEPT': B & C & V & ~anyp & ~F & keep, '9': B & C & V & F & keep, 'CROPKEEP': B & C & keep}
    for n in range(len(polygons)):
        others = np.zeros_like(band)
        for m in range(len(polygons)):
            if m != n:
                others |= masks['p%d' % m]
        out['R%d' % (n + 1)] = B & C & V & masks['p%d' % n] & ~others & keep
    out['_masks'] = masks; out['_band'] = band
    return out


def cell_vertices(scene, overlay):
    """MAX-B: per cell of the common interior, 64 vertices at alternating radii R1 and 0.72 R1, overlay-normalized."""
    width, height = (CI[1] - CI[0]) / 4, (CI[3] - CI[2]) / 2; out, radii = [], []
    span = np.abs(scene.css([[width, height, 0]])[0] - scene.css([[0, 0, 0]])[0])
    r1 = .40 * min(span[0] / overlay['width'], span[1] / overlay['height'])
    for c, r in CELLS:
        centre = scene.css([[CI[0] + width * (c + .5), CI[2] + height * (r + .5), 0]])[0]; cn = (centre[0] / overlay['width'], centre[1] / overlay['height'])
        out.append([(cn[0] + (r1 if m % 2 == 0 else .72 * r1) * math.cos(2 * math.pi * m / 64), cn[1] + (r1 if m % 2 == 0 else .72 * r1) * math.sin(2 * math.pi * m / 64)) for m in range(64)])
        radii.append(r1)
    return out, r1


def lit_count(v):
    """Lit pixels (max(R, G, B) > 5) of the native VR canvas, from the bitmap the oracles read."""
    lit = v.evaluate('()=>vrVoi.lit()'); raw = np.frombuffer(base64.b64decode(lit['bits']), np.uint8)
    return int(np.unpackbits(raw, bitorder='little')[:lit['width'] * lit['height']].sum())


def rgba_array(raw):
    """vrVoi.rgba() as an (h, w, 4) array."""
    return np.frombuffer(base64.b64decode(raw['bytes']), np.uint8).reshape(raw['height'], raw['width'], 4)


def boundary_gaps(scene, polygons, slabs):
    """Smallest distance (px) between distinct oracle boundaries: polygons, F9, crop line, slab lines and box edges."""
    def distance(points, poly):
        s0 = np.asarray(poly, float); e = np.roll(s0, -1, 0) - s0; d = np.asarray(points, float)[:, None, :] - s0[None]
        t = np.clip((d * e[None]).sum(-1) / np.maximum((e * e).sum(-1), 1e-12)[None], 0, 1)
        return float(np.linalg.norm(d - t[..., None] * e[None], axis=-1).min())
    (x0, y0, _), (x1, y1, _) = outer_corners('G-AX').min(0), outer_corners('G-AX').max(0)
    lines = [scene.css([[25.75, y0, 0], [25.75, y1, 0]])] + [scene.css([[x0, c[1] + sgn * t / 2, 0], [x1, c[1] + sgn * t / 2, 0]]) for c, t in slabs for sgn in (-1, 1)]
    lines += [scene.css(edge) for edge in ([[x0, y0, 0], [x0, y1, 0]], [[x1, y0, 0], [x1, y1, 0]], [[x0, y0, 0], [x1, y0, 0]], [[x0, y1, 0], [x1, y1, 0]])]
    shapes = [np.asarray(poly, float) for poly in polygons] + [rectangle(scene, F9)]; best = math.inf
    for n, pa in enumerate(shapes):
        for pb in shapes[n + 1:] + [np.asarray(line) for line in lines]:
            best = min(best, distance(pa, pb), distance(pb, pa))
    return best


class VolumeRenderingVoiE2E(VolumeRenderingE2E):
    # The cap of this class's profile, and whether MAX also compares each action's frame with today's generator (BU-T03):
    # only VolumeRenderingVoiGeneratorE2E does, in its own unit, so the generator frames never spend this suite's cap.
    suite_cap_s = SUITE_CAP_S
    generator_reference = False

    @classmethod
    def setUpClass(cls):
        cls.suite_started = time.monotonic()
        super().setUpClass()
        # MAX: the browser the base class launched is the only one this process has started; its process is what the
        # external supervisor ends at a missed deadline. Not found (no process list, or not exactly one): MAX fails there.
        roots = browser_roots()
        cls.browser_root = next(iter(roots)) if roots is not None and len(roots) == 1 else None

    # Bounds and observation helpers -----------------------------------------------------------------------------------
    def remaining(self, limit):
        left = min(limit, self.suite_started + self.suite_cap_s - SUITE_MARGIN_S - time.monotonic())
        if left <= 0:
            raise AssertionError('suite-deadline')
        return left

    def measure(self, case, **values):
        print('VRVOI-MEASURE ' + json.dumps({'case': case, **values}, default=lambda x: x.tolist() if hasattr(x, 'tolist') else str(x)), flush=True)

    def dialog(self, v):
        return v.get_by_role('dialog').filter(has=v.get_by_role('heading', name='Volume Rendering', exact=True))

    def voi(self, v):
        return self.dialog(v).get_by_role('group', name='VOI', exact=True)

    def notice(self, v):
        return v.locator('#kin-volume-orientation').get_by_role('status', include_hidden=True)

    def inspect(self, v):
        return v.evaluate('()=>vrVoi.inspect()')

    def open_series(self, fixture, page=None, seed=True):
        """Worklist, filmbox viewer, MPR and the first plane selected (the opened_projection flow) on this module's series.
        seed=False opens a series whose report is already seeded, in a new login (its own browser context)."""
        if seed:
            self.seed_report(fixture)
        p = page or self.login(); self.choose(p, fixture)
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        v = opened.value; ct.canvas_ready(v, 1); self.ready(v); self.mpr(v); self.choose_volume(v, v, 0)
        v.evaluate("()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId)}")
        v.evaluate(HELPERS); return p, v

    def open_vr(self, v):
        """Open Volume Rendering (inherited vr helper), then arm the render and status observation on that VR."""
        dialog = self.vr(v); v.evaluate(HELPERS); self.assertEqual(v.evaluate('()=>vrVoi.count()'), 1)
        v.evaluate('args=>vrVoi.observe(args)', [self.dialog(v).element_handle(), self.dialog(v).get_by_role('status').element_handle()])
        self.shown_notice = self.notice(v).text_content(); info = v.evaluate('()=>vrVoi.info()')
        self.assertEqual(info['dpr'], 1); self.css_size = [info['cssWidth'], info['cssHeight']]
        return dialog

    def settle(self, v, limit=30, deadline=None, phases=None):
        """A new native render after the action, three frames for the product's post-render check, and the VR still shown.
        Given the action's absolute deadline (MAX), the wait is what is left of it, never a fresh limit. Given a phase
        recorder, the three parts are its phases 'render-wait', 'frames' and 'product-check'."""
        mark = phases.phase if phases else no_phase
        if deadline is None:
            timeout = self.remaining(limit) * 1000
        else:
            timeout = (deadline - time.monotonic()) * 1000
            if timeout <= 0:
                raise AssertionError('MAX deadline passed before the render wait')
        started = time.monotonic()
        try:
            with mark('render-wait'):
                v.wait_for_function('()=>{const w=vrVoi.watched();return !!w&&w.armed&&w.frames>=1}', timeout=timeout)
        except Exception:
            # Observation for a D348 decision (MAX-F): how long the wait ran before the bound; the failure is raised unchanged.
            self.measure('settle-timeout', waited_s=round(time.monotonic() - started, 3)); raise
        waited = time.monotonic() - started
        if waited >= 10:
            self.measure('settle-slow', waited_s=round(waited, 3))
        with mark('frames'):
            v.evaluate('()=>vrVoi.frames()')
        with mark('product-check'):
            self.still_shown(v)

    def responsive(self, v, limit=30):
        """Seconds until a trivial page call answers again, bounded by min(limit, the suite deadline); None when it did not."""
        started = time.monotonic()
        try:
            v.wait_for_function('()=>true', timeout=self.remaining(limit) * 1000); return round(time.monotonic() - started, 3)
        except Exception:
            return None

    def traced_crop(self, v, dialog, i_max, condition, **context):
        """Apply Crop with I Max = i_max under the phase recorder (Phases, with the capability state at start, after the
        handler and at stop) and the unchanged settle bound. Writes one VRVOI-MEASURE line and returns the click or settle
        failure, or None; the caller raises it. The wait is never restarted: after a failure only a bounded responsiveness
        probe follows, and the recorder is read from the page only when the page answers."""
        phases = Phases(v, 'Apply Crop', 'NT-U1a-05-crop-diagnosis', condition, state=True)
        phases.prepare(lambda: dialog.get_by_label('I Max', exact=True).fill(str(i_max)))
        started, failure = time.monotonic(), None
        try:
            with phases.phase('click'):
                dialog.get_by_role('button', name='Apply Crop', exact=True).click()
            self.settle(v, phases=phases)
        except Exception as error:
            failure = error
        ended = now_ms()
        record = {'condition': condition, 'i_max': i_max, **context, 'outcome': 'settled' if failure is None else 'failed',
                  'failure': repr(failure)[:200] if failure else None, 'wait_s': round(time.monotonic() - started, 3)}
        if failure is not None:
            record['responsive_after_s'] = self.responsive(v)
        record['phases'] = phases.finish(ended, failure is None or record['responsive_after_s'] is not None)
        self.measure('NT-U1a-05-crop-diagnosis', **record)
        return failure

    def nt05_sculpt(self, v, dialog):
        """The NT-U1a-05 sculpt: Rectangle Inside over x 3.75..5.75, y 3.75..7.75 mm seen from Superior (EG-U4-B2)."""
        scene = Scene(v, pixels=False); r = v.evaluate('()=>vrVoi.rect()'); corners = scene.css([[3.75, 3.75, 0], [5.75, 7.75, 0]])
        self.sculpt_region(v, dialog, 'Rectangle', 'Inside', [(corners[0][0] / r['width'], corners[0][1] / r['height']), (corners[1][0] / r['width'], corners[1][1] / r['height'])])
        # CB-10: Drawing locks the VOI with the camera and display edits.
        expect(self.button(v, 'Apply VOI')).to_be_disabled(); expect(dialog.get_by_label('View From', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)

    def crop_diagnosis(self, fixture):
        """S8-U1a-SPEC-B-F03 diagnosis on V-MARK/G-AX seen from Superior, each condition in its own login, viewer page and VR
        (a fresh GL context, so its first Crop builds its own clipping program):
          1-first-crop: TF-COLOR, no VOI or sculpt, the first Crop (the NT-U1a-05 step that did not settle on hosted runs);
          2-ct-bone-crop: the same geometry and Crop under the opening CT-Bone display;
          3-crop-after-voi-sculpt: TF-COLOR with the NT-U1a-05 VOI and sculpt applied, then the same Crop.
        A condition whose first Crop settles applies the same Crop once more (its program now built: the render alone). The
        records are observations; a condition that does not settle within min(30 s, the suite deadline) is a failure, raised
        after every condition the page state allows has been recorded."""
        failures = []
        for name, transfer, masks in (('1-first-crop', 'TF-COLOR', False), ('2-ct-bone-crop', None, False), ('3-crop-after-voi-sculpt', 'TF-COLOR', True)):
            try:
                self.remaining(30)
            except AssertionError as error:
                failures.append(error); break
            p, v = self.open_series(fixture, seed=False); prepared, failure = {}, None
            try:
                started = time.monotonic(); dialog = self.open_vr(v); prepared['open_vr_s'] = round(time.monotonic() - started, 3)
                if transfer:
                    started = time.monotonic(); self.transfer(v, transfer); prepared['transfer_s'] = round(time.monotonic() - started, 3)
                self.view_from(v, 'Superior')
                if masks:
                    started = time.monotonic(); self.apply_slab(v, 'Coronal', center=[15.75, 14.25, 40], thickness=23); prepared['voi_s'] = round(time.monotonic() - started, 3)
                    started = time.monotonic(); self.nt05_sculpt(v, dialog); prepared['sculpt_s'] = round(time.monotonic() - started, 3)
                failure = self.traced_crop(v, dialog, 51, name, prepared=prepared)
                if failure is None:
                    failure = self.traced_crop(v, dialog, 51, name + '-again')
            except Exception as error:
                failure = error; self.measure('NT-U1a-05-crop-diagnosis', condition=name, prepared=prepared, outcome='failed before the crop', failure=repr(error)[:200])
            if failure is not None:
                failures.append(failure)
                if self.responsive(v) is None:
                    break
            v.close(); p.close()
        if failures:
            raise failures[0]

    def show_whole_box(self, v, grid):
        """Observation precondition (test-plan §8.3, §8.4): every face, plane and marker a case reads is on the canvas.
        The VR opens fitted to the axial footprint and View From and drags keep that scale, so on G-AX (outer box 32 x 32 x
        82.5 mm) the k extent leaves an 826 px canvas in Left and Anterior. Zooming out with the dialog's wheel (a view
        control that must not move any mask, REQ-S8-U1a-SOURCE-BOUND) until the sphere around the voxel-face box fits keeps
        it on the canvas for every later View From or drag; the scale reached is asserted, and the oracles read the camera
        actually shown."""
        info = v.evaluate('()=>vrVoi.info()'); radius = float(np.linalg.norm(grid_axes(grid) @ np.array(DIMS, float))) / 2
        need = radius * 1.05 * max(1., info['cssHeight'] / info['cssWidth'])
        for _ in range(3):
            scale = v.evaluate('()=>vrVoi.info()')['parallelScale']
            if scale >= need:
                break
            r = v.evaluate('()=>vrVoi.rect()'); v.mouse.move(r['x'] + r['width'] / 2, r['y'] + r['height'] / 2)
            # One wheel step zooms by at most e; the product clamps a larger step.
            v.evaluate('()=>vrVoi.arm()'); v.mouse.wheel(0, 500 * min(1., math.log(need * 1.01 / scale))); self.settle(v)
        scale = v.evaluate('()=>vrVoi.info()')['parallelScale']
        self.assertGreaterEqual(scale, need, ('observation precondition: the whole box is on the canvas', grid, scale, need))
        return scale

    def still_shown(self, v):
        expect(self.dialog(v)).to_be_visible()
        self.assertEqual(v.evaluate('()=>vrVoi.count()'), 1)
        self.assertEqual(self.notice(v).text_content(), self.shown_notice, 'no notice: the VR was not closed by a failure')
        info = v.evaluate('()=>vrVoi.info()'); self.assertEqual(info['dpr'], 1); self.assertEqual([info['cssWidth'], info['cssHeight']], self.css_size)

    def quiet(self, v):
        """An action without a render (a refusal or a cancelled preview): three frames, no settle."""
        v.evaluate('()=>vrVoi.frames()')

    def view_from(self, v, name):
        select = self.dialog(v).get_by_label('View From', exact=True)
        if select.input_value() != name:
            select.select_option(name); self.settle(v)

    def yaw(self, v, pixels=75):
        """A horizontal drag: yaw about the Left view's up axis (0.4 degree per pixel), rays stay horizontal."""
        self.view_from(v, 'Left'); r = v.evaluate('()=>vrVoi.rect()'); x, y = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
        v.evaluate('()=>vrVoi.arm()'); v.mouse.move(x, y); v.mouse.down(); v.mouse.move(x + pixels, y, steps=15); v.mouse.up(); self.settle(v)

    def transfer(self, v, name):
        dialog = self.dialog(v); dialog.get_by_label('Transfer Mode', exact=True).select_option('Custom'); knots = TRANSFER[name]
        while dialog.get_by_label('Knot %d HU' % len(knots), exact=True).count() == 0:
            dialog.get_by_role('button', name='Add Knot', exact=True).click()
        while dialog.get_by_label('Knot %d HU' % (len(knots) + 1), exact=True).count():
            dialog.get_by_role('button', name='Remove Knot', exact=True).click()
        for n, (hu, color, opacity) in enumerate(knots, 1):
            dialog.get_by_label('Knot %d HU' % n, exact=True).fill(str(hu)); dialog.get_by_label('Knot %d Color' % n, exact=True).fill(color)
            dialog.get_by_label('Knot %d Opacity' % n, exact=True).fill(str(opacity))
        dialog.get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v)

    def field(self, v, name):
        return self.voi(v).get_by_role('spinbutton', name=name, exact=True)

    def button(self, v, name):
        return self.voi(v).get_by_role('button', name=name, exact=True)

    def apply_slab(self, v, preset, center=None, thickness=None, pivot=None, defaults=True):
        self.slab_inputs(v, preset, center, thickness, pivot, defaults)
        self.button(v, 'Apply VOI').click(); self.settle(v); return self.inspect(v)

    def slab_inputs(self, v, preset, center=None, thickness=None, pivot=None, defaults=True):
        """The Slab editors apply_slab fills before its Apply VOI."""
        select = self.voi(v).get_by_role('combobox', name='VOI Preset', exact=True)
        if defaults:
            # Choosing a preset writes its default slab into the editors, even when that preset is already selected.
            select.select_option('Coronal' if preset != 'Coronal' else 'Axial')
            select.select_option(preset)
        else:
            # Only the given fields change over the slab already in the editors (VS-06 pivot only). select_option dispatches
            # change even for the option already shown, which writes that preset's defaults; a user re-choosing the shown
            # option sends no change, so the preset is checked, not chosen.
            expect(select).to_have_value(preset)
        for values, prefix in ((center, 'VOI Center '), (pivot, 'VOI Pivot ')):
            if values is not None:
                for axis, value in zip('LPS', values):
                    self.field(v, prefix + axis).fill(repr(float(value)))
        if thickness is not None:
            self.field(v, 'VOI Thickness').fill(repr(float(thickness)))

    def assert_voi(self, state, center, normal, thickness, pivot=None):
        self.assertIsNotNone(state['voi']); slab_state = state['voi']['slab']; self.assertEqual(state['voi']['mode'], 'Slab')
        np.testing.assert_allclose(slab_state['center'], center, atol=1e-6, rtol=0); np.testing.assert_allclose(slab_state['normal'], normal, atol=1e-6, rtol=0)
        self.assertAlmostEqual(slab_state['thickness'], thickness, delta=1e-6)
        if pivot is not None:
            np.testing.assert_allclose(slab_state['pivot'], pivot, atol=1e-6, rtol=0)

    def markers(self, scene, grid, transfer, names=None, tolerance=T_AXIS):
        """P(m) per marker, or None when it is not observed (test-plan §8.3): the ray through it is shorter than the sample
        distance, or its region has no pixel on this canvas (off the canvas is not 'absent')."""
        result = {}
        for name in names or MARKERS:
            if chord(grid, name, THRESHOLD[transfer], scene.d) < scene.info['sampleDistance']:
                result[name] = None; continue
            region = scene.marker(grid, name, THRESHOLD[transfer], tolerance)
            result[name] = bool(scene.lit[region].any()) if region.any() else None
        return result

    def preserved(self, v, start):
        """S: source, MPR, marks and report inputs as they were (X-05..X-07)."""
        self.preserved_volume(start['volume'], self.volume_state(v)); self.assertEqual(self.native_pixels(v), start['native'])
        self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'), start['marks']); self.assertEqual(self.originals(), start['originals'])
        self.unchanged_rows(start['rows'])

    def start_state(self, v, point):
        marks = self.add_mark(v, 'VR VOI kept mark', point=point)
        return {'marks': marks, 'volume': self.volume_state(v), 'native': self.native_pixels(v), 'originals': self.originals(), 'rows': self.rows()}

    def readback(self, fixture):
        """FC-1: the series as the synthetic Orthanc holds it."""
        import pydicom
        rows = self.stack._orthanc_request('POST', '/tools/lookup', fixture.uid.encode('ascii')).body
        study = next(row['ID'] for row in rows if row['Type'] == 'Study'); out = []
        for instance in self.stack._orthanc_request('GET', f'/studies/{study}/instances').body:
            d = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + instance['ID'] + '/file')))
            out.append({'ipp': [float(x) for x in d.ImagePositionPatient], 'iop': [float(x) for x in d.ImageOrientationPatient],
                        'spacing': [float(x) for x in d.PixelSpacing], 'stored': d.pixel_array.astype(np.int64),
                        'slope': float(d.RescaleSlope), 'intercept': float(d.RescaleIntercept), 'study': str(d.StudyInstanceUID)})
        return out

    def assert_series(self, fixture):
        meta = fixture.vrvoi; rows = self.readback(fixture); axes = grid_axes(meta['grid'])
        expected = [k for k in range(33) if k not in VARIANTS[meta['variant']]]; self.assertEqual(len(rows), len(expected))
        by_k = {}
        for row in rows:
            self.assertEqual(row['study'], fixture.uid); np.testing.assert_allclose(row['iop'], GRIDS[meta['grid']], atol=1e-9)
            self.assertEqual(row['spacing'], list(SPACING)); k = int(round(float(np.asarray(row['ipp']) @ axes[:, 2]) / STEP ** 2))
            np.testing.assert_allclose(row['ipp'], axes[:, 2] * k, atol=1e-6); by_k[k] = row
        self.assertEqual(sorted(by_k), expected)
        for k, row in by_k.items():
            np.testing.assert_array_equal(row['stored'] * row['slope'] + row['intercept'], meta['hu'][k])
        return by_k

    # TEST-S8-U1a-NATIVE -----------------------------------------------------------------------------------------------
    def test_vr_voi_00_render_extent_and_sample_position_convention(self):
        """NT-U1a-00 (OQ-3, C-02 as corrected by S8-U1a-SPEC-B-F01): the unmasked range ends at the outer voxel faces and the
        slab planes 21.25 and 61.25 mm sit at their world positions; either disagreeing beyond T is a stop (OQ-3)."""
        a = voi_series(self.stack, 'G-AX', 'V-BOX'); self.assert_series(a); p, v = self.open_series(a); self.open_vr(v)
        self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.show_whole_box(v, 'G-AX')
        results = {}
        for view in ('Left', 'Anterior'):
            self.view_from(v, view); scene = Scene(v); cons = render_box('G-AX')
            faces = [(1, 'low'), (1, 'high'), (2, 'low'), (2, 'high')] if view == 'Left' else [(0, 'low'), (0, 'high'), (2, 'low'), (2, 'high')]
            for index, side in faces:
                result = scene.plane_strips(cons, index, side, T_AXIS); results[f'{view} box {index}{side}'] = result; self.assertTrue(edge_ok(result), (view, index, side, result))
            # Negative control: the first-to-last voxel-centre range (the uncorrected C-02) is 1.25 mm inside each k face,
            # more than T on this canvas, so the same strips tell the two ranges apart.
            for side in ('low', 'high'):
                centres = scene.plane_strips(box('G-AX'), 2, side, T_AXIS)
                self.assertFalse(edge_ok(centres), ('voxel-centre range oracle should differ', view, side, centres))
        state = self.apply_slab(v, 'Axial', center=[15.75, 15.75, 41.25], thickness=40); self.assert_voi(state, [15.75, 15.75, 41.25], [0, 0, 1], 40)
        for view in ('Left', 'Anterior'):
            self.view_from(v, view); scene = Scene(v); cons = render_box('G-AX') + [slab([15.75, 15.75, 41.25], [0, 0, 1], 40)]
            for side in ('low', 'high'):
                result = scene.plane_strips(cons, 3, side, T_AXIS); results[f'{view} slab {side}'] = result; self.assertTrue(edge_ok(result), (view, side, result))
            # Negative control (FD-07): a texture affine mismatch, a plane computed on the voxel-centre extent but sampled on
            # the texture that spans the outer box, would land at z' = -1.25 + z * 82.5 / 80 (0.59 and 0.66 mm off). It is
            # a wrong mapping, not the outer-face convention the planes above are judged by.
            mismatch = render_box('G-AX') + [(np.array([0, 0, 1.]), -1.25 + 21.25 * 82.5 / 80, -1.25 + 61.25 * 82.5 / 80)]
            for side in ('low', 'high'):
                self.assertFalse(edge_ok(scene.plane_strips(mismatch, 3, side, T_AXIS)), ('texture-affine mismatch oracle should differ', view, side))
        self.measure('NT-U1a-00', convention='outer-face', edges=results, px_per_mm=Scene(v).px_per_mm)

    def test_vr_voi_01_box_slab_edges_axis_and_oblique(self):
        """NT-U1a-01 (AC-A09-02): slab-made guaranteed edges within T-EDGE on G-AX, G-OB1 and G-OB2, after a drag rotation too."""
        cases = [('G-AX', 'Axial', 41.0, 41.4, ['Left', 'Anterior', 'yaw'], T_AXIS, [(0, 0, 1), (0, 0, 1)]),
                 ('G-AX', 'Sagittal', 15.5, 16.0, ['Superior', 'Anterior'], T_AXIS, [(1, 0, 0), (1, 0, 0)]),
                 ('G-OB1', 'Axial', None, 30.0, ['Left', 'yaw'], T_OBLIQUE, None), ('G-OB2', 'Axial', None, 30.0, ['Left', 'yaw'], T_OBLIQUE, None)]
        measured = []
        for grid, preset, centre_value, thickness, views, tolerance, _ in cases:
            with self.subTest(grid=grid, preset=preset):
                a = voi_series(self.stack, grid, 'V-BOX'); p, v = self.open_series(a); self.open_vr(v)
                self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.show_whole_box(v, grid)
                centre = world(grid, (31.5, 31.5, 16)); normal = {'Axial': (0, 0, 1), 'Sagittal': (1, 0, 0)}[preset]
                if centre_value is not None:
                    centre = np.array(centre); centre[{'Axial': 2, 'Sagittal': 0}[preset]] = centre_value
                state = self.apply_slab(v, preset, center=list(centre), thickness=thickness); self.assert_voi(state, centre, normal, thickness)
                cons = render_box(grid) + [slab(centre, normal, thickness)]; n = np.array(normal, float); h = float(n @ centre)
                for view in views:
                    if view == 'yaw':
                        self.yaw(v)
                    else:
                        self.view_from(v, view)
                    scene = Scene(v)
                    for side in ('low', 'high'):
                        result = scene.plane_strips(cons, 3, side, tolerance); measured.append({'grid': grid, 'view': view, 'side': side, 'px_per_mm': scene.px_per_mm, **result})
                        self.assertTrue(edge_ok(result), (grid, view, side, result))
                        # Negative control (G-AX): the plane snapped to the nearest voxel face (the OP-1 (b) reading) is not within T.
                        plane = h - thickness / 2 if side == 'low' else h + thickness / 2
                        step = abs(float(n @ grid_axes(grid)[:, {'Axial': 2, 'Sagittal': 0}[preset]]))
                        snapped = (round(plane / step - .5) + .5) * step if grid == 'G-AX' else plane
                        if abs(snapped - plane) * scene.px_per_mm > 2 * tolerance:
                            wrong = list(cons); wrong[3] = (n, snapped if side == 'low' else h - thickness / 2, snapped if side == 'high' else h + thickness / 2)
                            self.assertFalse(edge_ok(scene.plane_strips(wrong, 3, side, tolerance)), ('voxel-snap oracle should differ', grid, view, side))
                v.close()
        self.measure('NT-U1a-01', edges=measured)

    def test_vr_voi_02_known_markers_kept_hidden_after_rotation(self):
        """NT-U1a-02 (AC-A09-03): markers in the slab are present, markers a slice or more outside are absent, after rotation too."""
        for grid, slabs in (('G-AX', {'A': ((15.75, 15.75, 40), 10), 'B': ((15.75, 15.75, 32.5), 5)}),
                            ('G-OB1', {'A': (tuple(world('G-OB1', (31.5, 31.5, 16))), 10), 'B': (tuple(world('G-OB1', (31.5, 31.5, 13))), 5)})):
            with self.subTest(grid=grid):
                a = voi_series(self.stack, grid, 'V-MARK'); p, v = self.open_series(a); self.open_vr(v); self.transfer(v, 'TF-MARK')
                normal = tuple(grid_axes(grid)[:, 2] / STEP)
                # The slice-normal slab of G-OB1 is the Axial preset turned about L by the grid tilt, around its own centre.
                tilt = math.degrees(math.atan2(-normal[1], normal[2]))
                views = ['Anterior', 'Left', 'yaw'] if grid == 'G-AX' else ['Left', 'yaw']
                for name, (centre, thickness) in slabs.items():
                    inside = {'A': 'MK-MID', 'B': 'MK-SMALL'}[name]; outside = {'A': 'MK-SMALL', 'B': 'MK-MID'}[name]
                    for view in views:
                        if view == 'yaw':
                            self.yaw(v)
                        else:
                            self.view_from(v, view)
                        before = self.markers(Scene(v), grid, 'TF-MARK', [outside])
                        if before[outside] is not None:
                            # Negative control: without the slab the marker to be hidden is visible on this camera.
                            self.assertIs(before[outside], True, (grid, view, outside))
                        self.apply_slab(v, 'Axial', center=list(centre), thickness=thickness, pivot=list(centre))
                        if abs(tilt) > 1e-9:
                            self.voi(v).get_by_role('combobox', name='VOI Rotate Axis', exact=True).select_option('L')
                            self.field(v, 'VOI Rotate Degrees').fill(repr(tilt)); self.button(v, 'Rotate Slab').click(); self.settle(v)
                        state = self.inspect(v); self.assert_voi(state, centre, normal, thickness)
                        scene = Scene(v); seen = self.markers(scene, grid, 'TF-MARK', [inside, outside])
                        self.assertIsNotNone(seen[inside], ('observation precondition', grid, view, inside)); self.assertIsNotNone(seen[outside], ('observation precondition', grid, view, outside))
                        self.assertEqual(seen, {inside: True, outside: False}, (grid, name, view))
                        self.measure('NT-U1a-02', grid=grid, slab=name, view=view, seen=seen, sample_distance=scene.info['sampleDistance'])
                        self.button(v, 'Disable VOI').click(); self.settle(v)
                v.close()

    def fixed_region(self, v, fixture, slab_spec):
        """Apply a Coronal slab, fix the RGBA region from the camera alone, read the source and render-input HU of every voxel
        its kept samples can interpolate from and the applied transfer functions there, and only then read the frame."""
        centre, thickness = slab_spec
        state = self.apply_slab(v, 'Coronal', center=list(centre), thickness=thickness); self.assert_voi(state, centre, [0, 1, 0], thickness)
        geometry = Scene(v, pixels=False); region = rgba_region(geometry)
        self.assertGreater(int(region.sum()), 0, 'the fixed region is on the canvas and not empty')
        cosine = abs(float(np.array([0, 1., 0]) @ geometry.d))
        self.assertGreater(cosine, .999, 'rays run along P (Anterior)')
        self.assertGreater(thickness / cosine, geometry.info['sampleDistance'], 'a kept ray is longer than one sample')
        indices = rgba_neighbours(slab_spec)
        hu = {'source': sorted({int(fixture.vrvoi['hu'][k, j, i]) for i, j, k in indices}), 'render': sorted({float(x) for x in v.evaluate('i=>vrVoi.hu(i)', indices)})}
        display = v.evaluate('h=>vrVoi.display(h)', hu['render'])
        rgba = v.evaluate('()=>vrVoi.rgba()')
        pixels = np.frombuffer(base64.b64decode(rgba['bytes']), np.uint8).reshape(rgba['height'], rgba['width'], 4)
        return {'geometry': geometry, 'region': region, 'indices': indices, 'hu': hu, 'display': display, 'rgba': pixels, 'region_rgba': pixels[region], 'slab': state['voi']['slab']}

    def encoding_session(self, fixture, seed, negative=False):
        """One NT-U1a-03 session in its own login, viewer page and VR (its own mapper and ray jitter): slab A's observed markers
        and lit set, then the fixed region under RGBA_SLAB, which must be exactly [255, 255, 255, 255]."""
        p, v = self.open_series(fixture, seed=seed); dialog = self.open_vr(v)
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); self.show_whole_box(v, 'G-AX')
        expect(dialog.get_by_label('VR Shading', exact=True)).not_to_be_checked(); expect(dialog.get_by_label('VR Opacity', exact=True)).to_have_value('100')
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); scene = Scene(v); markers = self.markers(scene, 'G-AX', 'TF-MARK')
        self.assertNotIn(None, markers.values(), ('observation precondition: every marker is observed', markers))
        out = {'scene': scene, 'markers': markers, **self.fixed_region(v, fixture, RGBA_SLAB)}
        # Preconditions of the known colour, all read before the frame: every interpolation neighbour is MK-MID in the
        # source and in the VR's own volume, TF-MARK is white and opaque there (here and in the renderer), shading is off.
        (i0, i1), (j0, j1), (k0, k1), value = MARKERS['MK-MID']
        self.assertTrue(all(i0 <= i <= i1 and j0 <= j <= j1 and k0 <= k <= k1 for i, j, k in out['indices']))
        self.assertEqual(out['hu'], {'source': [value], 'render': [float(value)]})
        self.assertEqual(transfer_at('TF-MARK', value), ((1., 1., 1.), 1.)); self.assertFalse(out['display']['shade'])
        for point in out['display']['at']:
            np.testing.assert_allclose(point['rgb'], [1, 1, 1], atol=1e-9, rtol=0); self.assertAlmostEqual(point['opacity'], 1, delta=1e-9)
        values = out['region_rgba']; wrong = (values != RGBA_KNOWN).any(-1)
        self.assertEqual(int(wrong.sum()), 0, ('fixed region RGBA', fixture.vrvoi['encoding'], int(values.shape[0]), np.unique(values[wrong], axis=0)[:5].tolist()))
        if negative:
            # Negative controls on the same session: slab B shows a different marker set, and a slab whose kept ray meets
            # no marker does not give the known colour in the same region.
            self.apply_slab(v, 'Axial', center=[15.75, 15.75, 32.5], thickness=5); out['slab_b'] = self.markers(Scene(v), 'G-AX', 'TF-MARK')
            out['empty'] = self.fixed_region(v, fixture, RGBA_EMPTY_SLAB)
        v.close(); p.close()
        return out

    def test_vr_voi_03_signed_rescaled_encodings_same_result(self):
        """NT-U1a-03 (AC-A09-04, OP-2 (a) as corrected by S8-U1a-SPEC-B-F02): E-U, E-S and E-SLOPE, each in its own session,
        show the same observed markers and the same lit set outside the C-04 bands for slab A, on the same camera, size, DPR,
        transfer functions and slab; the fixed RGBA region is exactly [255, 255, 255, 255] in all three and in a second,
        independent E-U session. Other RGBA differences are recorded, never used as a tolerance."""
        fixtures, readback, sessions = {}, {}, {}
        for name, encoding in (('E-U', 'E-U'), ('E-S', 'E-S'), ('E-SLOPE', 'E-SLOPE'), ('E-U again', 'E-U')):
            if encoding not in fixtures:
                fixtures[encoding] = voi_series(self.stack, 'G-AX', 'V-MARK', encoding); readback[encoding] = self.assert_series(fixtures[encoding])
            sessions[name] = self.encoding_session(fixtures[encoding], seed=name != 'E-U again', negative=name == 'E-S')
        reference = sessions['E-U']; band = marker_band(reference['scene']); differences = {}
        for name in ('E-S', 'E-SLOPE', 'E-U again'):
            other = sessions[name]
            for key in ('width', 'height', 'cssWidth', 'cssHeight', 'dpr', 'parallel'):
                self.assertEqual(other['geometry'].info[key], reference['geometry'].info[key], (name, key))
            np.testing.assert_allclose(np.r_[other['geometry'].M.ravel(), other['geometry'].b], np.r_[reference['geometry'].M.ravel(), reference['geometry'].b], atol=1e-6, rtol=0)
            self.assertEqual(other['geometry'].info['sampleDistance'], reference['geometry'].info['sampleDistance'], name)
            self.assertEqual({k: other['display'][k] for k in ('shade', 'color', 'opacity')}, {k: reference['display'][k] for k in ('shade', 'color', 'opacity')}, name)
            self.assertEqual(other['slab'], reference['slab'], name)
            self.assertTrue(np.array_equal(other['region'], reference['region']), name)
            self.assertEqual(other['markers'], reference['markers'], name)
            self.assertTrue(np.array_equal(other['scene'].lit & ~band, reference['scene'].lit & ~band), name)
            differences[name] = {'all': rgba_difference(other['rgba'], reference['rgba']), 'outside_band': rgba_difference(other['rgba'][~band], reference['rgba'][~band])}
        self.assertNotEqual(sessions['E-S']['slab_b'], sessions['E-S']['markers'])
        empty = sessions['E-S']['empty']; self.assertFalse((empty['region_rgba'] == RGBA_KNOWN).all(), 'a slab with no marker on the kept ray is not the known colour')
        # Negative control from the read-back stored values: reading E-U or E-SLOPE with its slope or intercept dropped takes
        # the region off TF-MARK's white plateau or lifts a voxel outside every marker (index 0, 0, 16) to an opacity above
        # zero, so the region, marker set or lit set would differ: a wrong rescale is never the same result.
        checked = 0
        for encoding in ('E-U', 'E-SLOPE'):
            rows = readback[encoding]; right = (rows[0]['slope'], rows[0]['intercept'])
            for reading in ((1., right[1]), (right[0], 0.)):
                if reading == right:
                    continue
                region_hu = {float(rows[k]['stored'][j, i]) * reading[0] + reading[1] for i, j, k in rgba_neighbours()}
                background = float(rows[16]['stored'][0, 0]) * reading[0] + reading[1]
                self.assertTrue(any(transfer_at('TF-MARK', h) != ((1., 1., 1.), 1.) for h in region_hu) or transfer_at('TF-MARK', background)[1] > 0, (encoding, reading))
                checked += 1
        self.assertEqual(checked, 3)
        self.measure('NT-U1a-03', markers=reference['markers'], region_pixels=int(reference['region'].sum()), rgba_differences=differences,
                     empty_region=np.unique(empty['region_rgba'], axis=0)[:5].tolist(), empty_hu=empty['hu'],
                     sessions={name: {'hu': s['hu'], 'slab': s['slab'], 'camera': {k: s['geometry'].info[k] for k in ('viewPlaneNormal', 'viewUp', 'parallelScale', 'sampleDistance', 'cssWidth', 'cssHeight', 'dpr')},
                                      'px_per_mm': s['geometry'].px_per_mm, 'transfer_at': s['display']['at'], 'shade': s['display']['shade'],
                                      'region_rgba': np.unique(s['region_rgba'], axis=0)[:5].tolist()} for name, s in sessions.items()})

    def test_vr_voi_04_reset_disable_undo_original_close_reopen(self):
        """NT-U1a-04 (VS-01..VS-17, LC-01, LC-03, LC-04, LC-07, LC-08, LC-12, LC-13, CB-08): the contract §7.3 state table."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40))
        self.open_vr(v); voi = self.voi(v); state = self.inspect(v)
        # VS-01, LC-08, VS-17, AC-10: nothing applied, empty-state controls off, scope wording, no forbidden words, mm labels.
        self.assertIsNone(state['voi']); self.assertEqual(state['voiHistoryDepth'], 0); self.assertFalse(state['originalView'])
        for name in ('Undo VOI', 'Disable VOI', 'Move Slab', 'Rotate Slab'):
            expect(self.button(v, name)).to_be_disabled()
        expect(voi.get_by_role('checkbox', name='Original View', exact=True)).to_be_disabled()
        text = voi.inner_text(); self.assertIn('VR에만 적용', text)
        for word in FORBIDDEN:
            self.assertNotIn(word, text)
        for name in ('VOI Center L', 'VOI Center P', 'VOI Center S', 'VOI Pivot L', 'VOI Thickness', 'VOI Move'):
            # The label that holds this spinbutton; a has= locator is resolved inside each label, so it is the bare role query.
            label = voi.locator('label', has=v.get_by_role('spinbutton', name=name, exact=True))
            expect(label).to_have_count(1); self.assertIn('mm', label.inner_text(), name)
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); self.show_whole_box(v, 'G-AX'); unmasked = Scene(v); plain = self.markers(unmasked, 'G-AX', 'TF-MARK')
        self.assertNotIn(None, plain.values(), ('observation precondition: every marker is observed', plain))
        # A sculpt over MK-LAST makes Original View meaningful for both masks; MK-LAST is shown before it (negative control).
        self.assertIs(plain['MK-LAST'], True)
        corner = unmasked.css([world('G-AX', (46, 0, 31)), world('G-AX', (57, 0, 32.4))]); r = v.evaluate('()=>vrVoi.rect()')
        points = [((min(corner[:, 0]) - 4) / r['width'], (min(corner[:, 1]) - 4) / r['height']), ((max(corner[:, 0]) + 4) / r['width'], (max(corner[:, 1]) + 4) / r['height'])]
        self.assertTrue(all(0 < c < 1 for point in points for c in point), ('observation precondition: the sculpt rectangle is on the canvas', points))
        self.sculpt_region(v, self.dialog(v), 'Rectangle', 'Inside', points); self.dialog(v).get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)
        sculpted = self.markers(Scene(v), 'G-AX', 'TF-MARK'); self.assertIs(sculpted['MK-LAST'], False)
        # VS-02: Axial default = the outer box centre and the 8 outer corners' projected thickness (82.5 mm on G-AX, C-02 as
        # corrected); that slab ends at the outer faces, so the image equals the unmasked one.
        state = self.apply_slab(v, 'Axial'); self.assert_voi(state, [15.75, 15.75, 40], [0, 0, 1], 82.5, [15.75, 15.75, 40]); self.assertEqual(state['voiHistoryDepth'], 1)
        self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK'), sculpted)
        # VS-03 slab A, VS-06 pivot only, VS-04 move, VS-05 rotate.
        a_state = self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); kept_a = Scene(v); seen_a = self.markers(kept_a, 'G-AX', 'TF-MARK')
        self.assertEqual((seen_a['MK-MID'], seen_a['MK-SMALL']), (True, False))
        state = self.apply_slab(v, 'Axial', pivot=[1, 2, 3], defaults=False); self.assert_voi(state, [15.75, 15.75, 40], [0, 0, 1], 10, [1, 2, 3])
        self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK'), seen_a)
        self.field(v, 'VOI Move').fill('-7.5'); self.button(v, 'Move Slab').click(); self.settle(v); moved = self.inspect(v)
        self.assert_voi(moved, [15.75, 15.75, 32.5], [0, 0, 1], 10, [1, 2, 3]); self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK')['MK-SMALL'], True)
        self.voi(v).get_by_role('combobox', name='VOI Rotate Axis', exact=True).select_option('L'); self.field(v, 'VOI Rotate Degrees').fill('90')
        self.button(v, 'Rotate Slab').click(); self.settle(v); turned = self.inspect(v)
        self.field(v, 'VOI Rotate Degrees').fill('-90'); self.button(v, 'Rotate Slab').click(); self.settle(v); back = self.inspect(v)
        np.testing.assert_allclose(back['voi']['slab']['center'], moved['voi']['slab']['center'], atol=1e-6); np.testing.assert_allclose(back['voi']['slab']['normal'], [0, 0, 1], atol=1e-6)
        self.assertGreater(np.abs(np.array(turned['voi']['slab']['normal']) - [0, 0, 1]).max(), .5)
        # VS-09 Undo x2 returns through the rotation records; VS-07 Reset VOI applies the preset default and stays on.
        depth = back['voiHistoryDepth']; self.button(v, 'Undo VOI').click(); self.settle(v); self.button(v, 'Undo VOI').click(); self.settle(v)
        undone = self.inspect(v); self.assertEqual(undone['voiHistoryDepth'], depth - 2); np.testing.assert_allclose(undone['voi']['slab']['center'], moved['voi']['slab']['center'], atol=1e-6)
        self.voi(v).get_by_role('combobox', name='VOI Preset', exact=True).select_option('Axial'); self.button(v, 'Reset VOI').click(); self.settle(v)
        self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 82.5)
        # VS-08 Disable keeps the editors and the sculpt; the pixels differ from slab A (negative control for the comparison).
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); editors = [self.field(v, 'VOI Thickness').input_value()]
        self.button(v, 'Disable VOI').click(); self.settle(v); off = self.inspect(v); self.assertIsNone(off['voi']); self.assertEqual(len(off['sculpt']), 1)
        self.assertEqual([self.field(v, 'VOI Thickness').input_value()], editors); disabled = self.markers(Scene(v), 'G-AX', 'TF-MARK')
        self.assertEqual(disabled, sculpted); self.assertNotEqual(disabled, seen_a)
        # VS-15, VS-16: Original View lifts VOI and sculpt in the view only and locks every mask edit until it is off.
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); before_original = self.inspect(v)
        voi.get_by_role('checkbox', name='Original View', exact=True).check(); self.settle(v); self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK'), plain)
        state = self.inspect(v); self.assertTrue(state['originalView']); self.assertEqual({k: state[k] for k in ('voi', 'sculpt', 'voiHistoryDepth')}, {k: before_original[k] for k in ('voi', 'sculpt', 'voiHistoryDepth')})
        for name in ('Apply VOI', 'Reset VOI', 'Disable VOI', 'Undo VOI', 'Move Slab', 'Rotate Slab'):
            expect(self.button(v, name)).to_be_disabled()
        for name in ('Draw Region', 'Undo Sculpt', 'Clear Sculpt'):
            expect(self.dialog(v).get_by_role('button', name=name, exact=True)).to_be_disabled()
        voi.get_by_role('checkbox', name='Original View', exact=True).uncheck(); self.settle(v); self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK'), seen_a)
        expect(self.button(v, 'Apply VOI')).to_be_enabled()
        # LC-01: A -> B -> A inside two frames; only the last generation's check counts and it does not close the VR.
        self.field(v, 'VOI Thickness').fill('10')
        v.evaluate("""([apply,thickness])=>{const set=t=>{thickness.value=t;thickness.dispatchEvent(new Event('input',{bubbles:true}));thickness.dispatchEvent(new Event('change',{bubbles:true}));apply.click()};set('10.5');set('5');set('10')}""",
                   [self.button(v, 'Apply VOI').element_handle(), self.field(v, 'VOI Thickness').element_handle()])
        self.settle(v); self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 10)
        # LC-07: forty alternating moves in a row keep one owned replacement (preflight would refuse a second, leaving the
        # VOI where it was) and the history at 32; one settle after the last.
        v.evaluate("""([move,distance])=>{for(let n=0;n<40;n++){distance.value=n%2?'-1':'1';distance.dispatchEvent(new Event('input',{bubbles:true}));move.click()}}""",
                   [self.button(v, 'Move Slab').element_handle(), self.field(v, 'VOI Move').element_handle()])
        self.settle(v)
        state = self.inspect(v); self.assertEqual(state['voiHistoryDepth'], 32); self.assert_voi(state, [15.75, 15.75, 40], [0, 0, 1], 10)
        self.assertEqual(self.markers(Scene(v), 'G-AX', 'TF-MARK'), seen_a)
        # LC-12: a window resize that resizes the VR canvas redraws the same tissue; the VOI is unchanged. The dialog stays
        # inside the window (test_vr_01), so a window no taller than the canvas cannot keep it: the wait is the precondition.
        size, css = v.viewport_size, list(self.css_size); v.set_viewport_size({'width': size['width'] - 40, 'height': min(size['height'] - 40, css[1])})
        v.wait_for_function('([w,h])=>{const i=vrVoi.info();return i.cssWidth!==w||i.cssHeight!==h}', arg=css, timeout=self.remaining(30) * 1000)
        self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 10); v.set_viewport_size(size)
        v.wait_for_function('([w,h])=>{const i=vrVoi.info();return i.cssWidth===w&&i.cssHeight===h}', arg=css, timeout=self.remaining(30) * 1000)
        # VS-13: a slab moved outside the volume is applied and shows nothing (observation).
        self.field(v, 'VOI Move').fill('200'); self.button(v, 'Move Slab').click(); self.settle(v); outside = Scene(v)
        self.measure('NT-U1a-04', outside_lit=int(outside.lit.sum()), markers=self.markers(outside, 'G-AX', 'TF-MARK'))
        # CB-08 Reset VR clears VOI, sculpt, Original View and history.
        self.dialog(v).get_by_role('button', name='Reset VR', exact=True).click(); self.settle(v); state = self.inspect(v)
        self.assertEqual({k: state[k] for k in ('voi', 'sculpt', 'originalView', 'voiHistoryDepth', 'crop')}, {'voi': None, 'sculpt': None, 'originalView': False, 'voiHistoryDepth': 0, 'crop': None})
        # LC-03 / LC-13: Close VR and Escape drop the VOI; a reopened VR starts empty.
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); self.dialog(v).get_by_role('button', name='Close VR', exact=True).click()
        expect(self.dialog(v)).to_be_hidden(); self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.open_vr(v); self.assertIsNone(self.inspect(v)['voi'])
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); self.field(v, 'VOI Thickness').focus(); v.keyboard.press('Escape')
        expect(self.dialog(v)).to_be_hidden(); self.open_vr(v); self.assertIsNone(self.inspect(v)['voi'])
        # LC-04: access revoked (viewer-jobs 403) closes only VR and drops the VOI.
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10)
        v.route('**/api/studies/*/viewer-jobs', lambda route: route.fulfill(status=403, content_type='application/json', body='{}'))
        expect(self.dialog(v)).to_be_hidden(timeout=40000); v.unroute('**/api/studies/*/viewer-jobs')
        self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.open_vr(v); self.assertIsNone(self.inspect(v)['voi'])
        self.dialog(v).get_by_role('button', name='Close VR', exact=True).click(); self.preserved(v, start)

    def test_vr_voi_05_crop_sculpt_voi_intersection_and_independence(self):
        """NT-U1a-05 (CB-01..CB-04, CB-09, CB-10): crop x VOI x sculpt intersect and never erase each other; MAX below. The
        S8-U1a-SPEC-B-F03 crop diagnosis (crop_diagnosis) runs first and every Crop of this flow is traced the same way."""
        ledger = []
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); self.seed_report(a)
        # F03 first: the three crop conditions are recorded even when the first does not settle; a failure among them is
        # raised there, before this flow repeats the same first Crop (whose own trace is recorded too).
        self.crop_diagnosis(a)
        p, v = self.open_series(a, seed=False); start = self.start_state(v, (15.75, 15.75, 40))
        dialog = self.open_vr(v); self.transfer(v, 'TF-COLOR'); self.view_from(v, 'Superior')
        # EG-U4-B2 geometry: each tool alone hides its own marker part; 48 marker voxels stay (MK-FIRST i 12..15, MK-LAST i/j 48..51).
        parts = {'R-SCULPT': ((8, 11), (8, 15)), 'R-CROP': ((52, 55), (48, 51)), 'R-VOI': ((48, 51), (52, 55)),
                 'R-KEPT-FIRST': ((12, 15), (8, 15)), 'R-KEPT-LAST': ((48, 51), (48, 51))}
        def lit(scene):
            out = {}
            for name, (i, j) in parts.items():
                cons = box('G-AX', (i[0], j[0], 0), (i[1], j[1], 32)); centre, band, _ = scene.ring(lambda du, dv: scene.hits(cons, du, dv), T_AXIS)
                core = centre & ~band; self.assertGreater(int(core.sum()), 0, name); out[name] = bool(scene.lit[core].any())
            return out
        def draw_sculpt():
            self.nt05_sculpt(v, dialog)
        def apply_crop(i_max):
            failure = self.traced_crop(v, dialog, i_max, 'NT-U1a-05 flow')
            if failure is not None:
                raise failure
        apply_crop(51); self.apply_slab(v, 'Coronal', center=[15.75, 14.25, 40], thickness=23); draw_sculpt()
        all_three = Scene(v); seen = lit(all_three); state = self.inspect(v)
        self.assertEqual(seen, {'R-SCULPT': False, 'R-CROP': False, 'R-VOI': False, 'R-KEPT-FIRST': True, 'R-KEPT-LAST': True})
        self.assertEqual(len(v.evaluate('()=>vrVoi.info()')['planes']), 6, 'C6: the crop alone makes mapper planes')
        # CB-02: removing one tool shows exactly its own region (the negative control of the intersection oracle).
        dialog.get_by_role('button', name='Undo Sculpt', exact=True).click(); self.settle(v); self.assertEqual(lit(Scene(v)), {**seen, 'R-SCULPT': True}); draw_sculpt()
        apply_crop(63); self.assertEqual(lit(Scene(v)), {**seen, 'R-CROP': True}); apply_crop(51)
        self.button(v, 'Disable VOI').click(); self.settle(v); self.assertEqual(lit(Scene(v)), {**seen, 'R-VOI': True}); self.button(v, 'Undo VOI').click(); self.settle(v)
        self.assertEqual(lit(Scene(v)), seen)
        # CB-09: Apply Display, Apply Crop and Load Preset leave the VOI as applied.
        before = self.inspect(v); dialog.get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.assertEqual(self.inspect(v)['voi'], before['voi'])
        preset_name = 'VOI keep ' + uuid.uuid4().hex[:6]; dialog.get_by_label('Preset Name', exact=True).fill(preset_name)
        dialog.get_by_role('button', name='Save New Preset', exact=True).click(); expect(dialog.get_by_label('Saved Presets', exact=True)).to_have_value(preset_name)
        dialog.get_by_role('button', name='Load Preset', exact=True).click(); self.settle(v)
        self.assertEqual(self.inspect(v)['voi'], before['voi']); self.assertEqual(self.inspect(v)['sculpt'], before['sculpt'])
        # CB-03: Reset VR and the opposite order (sculpt, VOI, crop) give the same pixels on the same camera.
        dialog.get_by_role('button', name='Reset VR', exact=True).click(); self.settle(v); self.transfer(v, 'TF-COLOR'); self.view_from(v, 'Superior')
        draw_sculpt(); self.apply_slab(v, 'Coronal', center=[15.75, 14.25, 40], thickness=23); apply_crop(51)
        again = Scene(v); self.assertEqual(lit(again), seen); self.assertEqual(int((again.lit != all_three.lit).sum()), 0)
        dialog.get_by_role('button', name='Close VR', exact=True).click(); self.preserved(v, start)
        with self.subTest('max-combination'):
            self.max_combination(p, v, start, a.uid, ledger)
        # Outside the sub-test: the MAX steps ran to the end in order, not only the 13 declared cases (test-plan §15 B3).
        self.assertEqual(tuple(ledger), MAX_STEPS)

    # NT-U1a-05 sub-case MAX (test-plan §4 MAX-A..MAX-G; S8-SCULPT-PERF TEST-S8-SCULPT-PERF-MAX, BU-T03, BU-T04) ---------
    def bounded(self, v, supervisor, step, action, started, deadline, button, check, record, phases=None):
        """One MAX action under one absolute deadline: the click, the new native render, three frames, the product's check
        and the step's state and pixel assertions all share it. The click's return and the settle start never renew it, and
        the supervisor ends the browser when it passes without an answer. Writes one VRVOI-MAX line with the action's time,
        bound and outcome, success or not, and the action's phase record (D419; armed by the caller before the input, so it
        covers the click whatever ends it); returns the seconds from just before the click to the last assertion."""
        mark = phases.phase if phases else no_phase
        token = supervisor.arm(deadline, step + ' ' + action); error = None
        try:
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError('MAX deadline passed before the action')
            with mark('click'):
                button.click(timeout=left * 1000)
            self.settle(v, deadline=deadline, phases=phases)
            with mark('assertions'):
                check()
        except BaseException as caught:
            error = caught
        fired = supervisor.disarm(token); ended = time.monotonic(); ended_ms = now_ms()
        outcome = 'supervisor' if fired else 'failed' if error is not None else 'late' if ended > deadline else 'done'
        line = {'step': step, 'action': action, **record, 'deadline_s': round(deadline - started, 3), 'elapsed_s': round(ended - started, 3),
                'outcome': outcome, 'suite_elapsed_s': round(ended - self.suite_started, 3)}
        # Read after the outcome is fixed, so the recorder's own read never counts against the deadline.
        line['phases'] = phases.finish(ended_ms, outcome in ('done', 'late')) if phases else None
        print('VRVOI-MAX ' + json.dumps(line), flush=True)
        if fired:
            raise AssertionError('MAX %s %s: the supervisor ended the browser at the absolute deadline' % (step, action)) from error
        if error is not None:
            raise error
        if outcome == 'late':
            raise AssertionError('MAX %s %s completed %.3f s after its absolute deadline' % (step, action, ended - deadline))
        return ended - started

    def freehand(self, v, dialog, vertices):
        """MAX-B input: Freehand Area, Inside, Draw Region, then one pointer move per vertex on the preview overlay (66 mouse
        events, 64 product points). Returns the overlay box the normalized vertices were placed in."""
        dialog.get_by_label('Sculpt Tool', exact=True).select_option('Freehand Area'); dialog.get_by_label('Removal Side', exact=True).select_option('Inside')
        dialog.get_by_role('button', name='Draw Region', exact=True).click(); overlay = dialog.get_by_label('Sculpt removal preview', exact=True)
        expect(overlay).to_have_count(1); box_ = overlay.bounding_box()
        screen = [(box_['x'] + x * box_['width'], box_['y'] + y * box_['height']) for x, y in vertices]
        v.mouse.move(*screen[0]); v.mouse.down()
        for point in screen[1:]:
            v.mouse.move(*point)
        v.mouse.up(); expect(dialog.get_by_role('button', name='Apply Sculpt', exact=True)).to_be_enabled()
        return box_

    def same_as_generator(self, v, step, refs):
        """BU-T03: the frame the action left equals today's generator for the same applied masks, drawn on the same mapper,
        camera, display and jitter texture and read from the same canvas: 0 differing pixels. One generator frame per distinct
        state (refs, keyed by the masks and the frame conditions), under its own external bound REFERENCE_S; afterwards the VR
        must show its own frame again. The generator frame's compile is its cost; it is recorded and never counted against
        the action."""
        shown = v.evaluate('()=>vrVoi.rgba()'); key = v.evaluate('()=>vrVoi.referenceKey()'); fresh = key not in refs
        if fresh:
            started = time.monotonic(); deadline = min(started + REFERENCE_S, self.suite_started + self.suite_cap_s - SUITE_MARGIN_S)
            token = self.supervisor.arm(deadline, step + ' generator reference'); error = reference = None
            try:
                if deadline <= time.monotonic():
                    raise AssertionError('suite-deadline before the generator reference')
                reference = v.evaluate('()=>vrVoi.reference()')
            except BaseException as caught:
                error = caught
            fired = self.supervisor.disarm(token)
            print('VRVOI-MAX ' + json.dumps({'step': step, 'action': 'generator-reference', 'outcome': 'supervisor' if fired else 'failed' if error else 'done',
                                             'frame_ms': reference and reference['ms'], 'generated': reference and reference['generated'],
                                             'elapsed_s': round(time.monotonic() - started, 3), 'suite_elapsed_s': round(time.monotonic() - self.suite_started, 3)}), flush=True)
            if fired:
                raise AssertionError('BU-T03 %s: the generator reference passed its bound of %d s' % (step, REFERENCE_S)) from error
            if error is not None:
                raise error
            back = rgba_difference(rgba_array(shown), rgba_array(v.evaluate('()=>vrVoi.rgba()')))
            self.assertEqual(back['pixels'], 0, 'BU-T03 %s: the VR shows its own frame again after the reference' % step)
            refs[key] = reference['pixels']
        difference = rgba_difference(rgba_array(shown), rgba_array(refs[key]))
        print('VRVOI-MAX ' + json.dumps({'step': step, 'action': 'generator-pixels', 'reference': 'drawn' if fresh else 'same state as before', **difference}), flush=True)
        self.assertEqual(difference['pixels'], 0, 'BU-T03 %s: pixels differing from today\'s generator %s' % (step, difference))

    def max_combination(self, p, v_mark, mark_start, mark_uid, ledger):
        started = time.monotonic(); state = {'page': None, 'S': None, 'first': None, 'mark_start': mark_start, 'mark_uid': mark_uid}

        def step(name, action):
            t0 = time.monotonic()
            if state['first'] is None:
                try:
                    action()
                except BaseException as error:
                    state['first'] = (name, error); raise
                t1 = time.monotonic(); ledger.append(name)
                print('VRVOI-MAX ' + json.dumps({'step': name, 't_start': round(t0 - started, 3), 't_end': round(t1 - started, 3),
                                                 'elapsed_s': round(t1 - t0, 3), 'suite_elapsed_s': round(t1 - self.suite_started, 3)}), flush=True)
        print('VRVOI-MAX ' + json.dumps({'step': 'start', 'suite_elapsed_s': round(started - self.suite_started, 3)}), flush=True)
        self.supervisor = None
        try:
            # Without a supervisor for this test's browser no target action has an external bound, and MAX fails here.
            try:
                if self.browser_root is None:
                    raise AssertionError('MAX: no external supervisor for the test browser (its process was not identified)')
            except BaseException as error:
                state['first'] = ('MAX-supervisor', error); raise
            self.supervisor = Supervisor(self.browser_root)
            self.max_steps(p, v_mark, state, step)
            print('VRVOI-MAX ' + json.dumps({'step': 'done', 'total_s': round(time.monotonic() - started, 3), 'suite_elapsed_s': round(time.monotonic() - self.suite_started, 3)}), flush=True)
        except BaseException as error:
            # MAX-E: observation off, preview cancelled, VR closed, no VR viewport, S checked, and the MPR alive when the
            # product closed the VR. Cleanup errors are reported with the first failure, which is raised unchanged. A browser
            # the supervisor ended leaves nothing to clean in it.
            first = state['first'] or ('outside-step', error); cleanup = []; v = state['page']
            try:
                product_closed = v is not None and not v.is_closed() and not self.dialog(v).is_visible() and first[0] not in ('MX-00', 'MX-01', 'MX-27')
            except Exception as problem:
                product_closed = False; cleanup.append(f'state: {problem!r}'[:300])
            def cancel():
                button = self.dialog(v).get_by_role('button', name='Cancel Sculpt', exact=True)
                if self.dialog(v).is_visible() and button.is_enabled():
                    button.click()
            def close():
                if self.dialog(v).is_visible():
                    self.dialog(v).get_by_role('button', name='Close VR', exact=True).click()
            for label, action in (('release', lambda: v.evaluate('()=>window.vrVoi&&vrVoi.release()')), ('cancel', cancel), ('close', close),
                                  ('none', lambda: self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0)),
                                  ('source', lambda: self.preserved(v, state['S']) if state['S'] else None),
                                  ('mpr', lambda: self.mpr_live_after_mask_failure(v, state['S']['native']) if product_closed and state['S'] else None)):
                if v is None or v.is_closed():
                    break
                try:
                    action()
                except BaseException as problem:
                    cleanup.append(f'{label}: {problem!r}'[:300])
            print('VRVOI-MAX failed ' + json.dumps({'step': first[0], 'reason': repr(first[1])[:500], 'product_closed_vr': product_closed, 'cleanup_errors': cleanup,
                                                    'supervisor': self.supervisor.fired if self.supervisor else None}), flush=True)
            raise first[1]

    def max_steps(self, p, v_mark, state, step):
        f9, slab_a, slab_b = [list(c) for c in F9], SLAB_A, SLAB_B
        ctx, refs = {}, {}

        def mx00():
            # The V-MARK flow is over: its S still holds, no VR viewport is left, and only then that page closes.
            v_mark.evaluate('()=>vrVoi.release()'); self.preserved(v_mark, state['mark_start']); self.assertEqual(v_mark.evaluate('()=>vrVoi.count()'), 0)
            ctx['size'] = v_mark.evaluate('()=>({width:innerWidth,height:innerHeight})'); v_mark.close()
        step('MX-00', mx00)

        def mx01():
            b = voi_series(self.stack, 'G-AX', 'V-BOX', 'E-U', 'S-FULL'); ctx['fixture'] = b; by_k = self.assert_series(b)
            self.assertTrue(all(int(row['stored'].min()) == int(row['stored'].max()) == 1524 for row in by_k.values()))
            fresh = p.context.new_page(); fresh.set_viewport_size(ctx['size']); self.launch(fresh, [b]); self.ready(fresh); self.mpr(fresh); self.choose_volume(fresh, fresh, 0)
            fresh.evaluate("()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId)}")
            fresh.evaluate(HELPERS); state['page'] = fresh; ctx['v'] = fresh
            source = fresh.evaluate("()=>{const vol=cornerstone.cache.getVolume(projectionVP.getVolumeId()),img=vol.imageData,c=[];for(const i of [0,63])for(const j of [0,63])for(const k of [0,32])c.push([i,j,k]);return {dims:Array.from(vol.dimensions),last:Array.from(img.indexToWorld([63,63,32])),hu:[...c,[31,31,16]].map(i=>vol.voxelManager.getAtIJK(...i)),image:vol.imageIds[0]}}")
            self.assertEqual(source['dims'], [64, 64, 33]); np.testing.assert_allclose(source['last'], [31.5, 31.5, 80], atol=1e-6); self.assertEqual(source['hu'], [500] * 9)
            self.assertIn(b.uid, source['image'])
            state['S'] = self.start_state(fresh, (15.75, 15.75, 40))
        step('MX-01', mx01)
        v = ctx['v']; b = ctx['fixture']

        def mx02():
            dialog = self.open_vr(v); ctx['dialog'] = dialog
            expect(dialog.locator('details')).to_contain_text(b.uid); self.assertNotIn(state['mark_uid'], dialog.locator('details').text_content())
            s = self.inspect(v); self.assertEqual((s['voi'], s['crop'], s['sculpt'], s['voiHistoryDepth'], s['lastRefusal']), (None, None, None, 0, None))
            self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], [])
            expect(dialog.get_by_label('VR Preset', exact=True)).to_have_value('CT-Bone'); expect(dialog.get_by_label('VR Opacity', exact=True)).to_have_value('100')
            expect(dialog.get_by_label('VR Shading', exact=True)).not_to_be_checked(); expect(dialog.get_by_label('Transfer Mode', exact=True)).to_have_value('Preset')
        step('MX-02', mx02)
        dialog = ctx['dialog']
        oracle = max_regions

        def fraction(scene, region):
            return float(scene.lit[region].mean()) if region.any() else None

        def dark(scene, region):
            return int(scene.lit[region].sum())

        def judge(scene, regions, n_ops, voi_on=True, nine=False):
            for n in range(n_ops):
                self.assertEqual(dark(scene, regions['R%d' % (n + 1)]), 0, 'sculpt %d hides its region' % (n + 1))
            if voi_on:
                self.assertEqual(dark(scene, regions['VOI']), 0, 'VOI hides its region')
            else:
                self.assertGreaterEqual(fraction(scene, regions['VOI']), .95, 'Disable VOI shows the VOI-only region')
            self.assertEqual(dark(scene, regions['CROP']), 0); self.assertEqual(dark(scene, regions['2X']), 0); self.assertEqual(dark(scene, regions['BG']), 0)
            self.assertGreaterEqual(fraction(scene, regions['KEPT']), .99)
            if nine:
                self.assertGreaterEqual(fraction(scene, regions['9']), .99, 'the refused ninth region stays shown')

        def placement(scene, regions, polygons, slabs):
            for n in range(len(polygons)):
                self.assertGreaterEqual(int(regions['R%d' % (n + 1)].sum()), 400, 'sculpt region %d is observable' % (n + 1))
            for s in slabs:
                self.assertGreaterEqual(int(oracle(scene, polygons, s)['VOI'].sum()), 400, 'VOI region is observable')
            self.assertGreater(int(regions['CROP'].sum()), 0); self.assertGreater(int(regions['KEPT'].sum()), 0)
            # F9 lies between the upper planes of slab A (25.75 mm) and slab B (28.25 mm), inside B's keep only (test-plan
            # §4 MAX-B): under A its R_9 is empty by construction, and from MX-14 on R_9 is judged under B, so it is read there.
            self.assertGreaterEqual(int(oracle(scene, polygons, slab_b)['9'].sum()), 400, 'the ninth region F9 is observable in slab B')
            # Distinct oracle boundaries are at least 2 T + 2 = 4 px apart.
            self.assertGreaterEqual(boundary_gaps(scene, polygons, slabs), 4)
        def draw_freehand(vertices):
            ctx['overlay'] = self.freehand(v, dialog, vertices)

        def applied_geometry(s, n, vertices, earlier):
            op = s['sculpt'][n]; self.assertEqual(op['side'], 'Inside'); self.assertEqual(op['region']['kind'], 'Polygon')
            self.assertEqual(len(op['region']['points']), 64, 'applied boundary keeps 64 points after the .002 filter and simplification')
            box_ = ctx['overlay']
            for (ax, ay), (ex, ey) in zip(op['region']['points'], vertices):
                self.assertLessEqual(abs(ax - ex) * box_['width'], 1.0); self.assertLessEqual(abs(ay - ey) * box_['height'], 1.0)
            expected = v.evaluate('()=>vrVoi.projection()')
            np.testing.assert_allclose(op['projection']['base'], expected['base'], atol=1e-9, rtol=0); np.testing.assert_allclose(op['projection']['axes'], expected['axes'], atol=1e-9, rtol=0)
            self.assertEqual(op['projection'], s['sculpt'][0]['projection'])
            self.assertEqual(s['sculpt'][:n], earlier)

        def css_polygons(s):
            w, h = self.css_size
            return [np.array([[x * w, y * h] for x, y in op['region']['points']]) for op in (s['sculpt'] or [])]

        def recorder(name, step_id, action, prepare=None):
            """D419: the action's phase record, armed before its input (the input itself is the phase 'input')."""
            phases = Phases(v, name, step_id, action)
            if prepare is not None:
                phases.prepare(prepare)
            return phases

        def render_action(step_id, action, n, voi, button, check, phases, built=(0, 0)):
            """A MAX target action (REQ-S8-SCULPT-PERF-TARGET): one absolute deadline min(start + 30 s, suite deadline - 60 s)
            made just before the click and shared by everything up to the step's last assertion. Then BU-T04: its compile and
            link calls (the phase record's GL counts, every phase of the action) are `built`: (2, 1) for the install at the
            VR's first mask and for the one new display variant Reset VR makes, (0, 0) for every other edit. Then BU-T03 in the
            class that runs it (generator_reference)."""
            started = time.monotonic(); deadline = min(started + TARGET_S, self.suite_started + self.suite_cap_s - SUITE_MARGIN_S)
            self.bounded(v, self.supervisor, step_id, action, started, deadline, button, check, {'n': n, 'voi': voi, 'limit_s': TARGET_S}, phases)
            calls = [sum(table.get(name, [0])[0] for table in phases.gl.values()) for name in ('compileShader', 'linkProgram')]
            print('VRVOI-MAX ' + json.dumps({'step': step_id, 'action': action, 'compile_link': calls, 'expected': list(built)}), flush=True)
            self.assertEqual(calls, list(built), 'BU-T04 %s %s: compileShader and linkProgram calls of the action' % (step_id, action))
            if self.generator_reference:
                self.same_as_generator(v, step_id + ' ' + action, refs)

        def mx03():
            dialog.get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.view_from(v, 'Superior')
            info = v.evaluate('()=>vrVoi.info()'); np.testing.assert_allclose(info['viewPlaneNormal'], [0, 0, 1], atol=1e-6); np.testing.assert_allclose(info['viewUp'], [0, -1, 0], atol=1e-6)
            self.assertTrue(info['parallel']); scene = Scene(v); regions = oracle(scene, [], slab_a)
            self.assertGreaterEqual(fraction(scene, regions['BOX']), .99); self.assertEqual(dark(scene, regions['BG']), 0)
            overlay_box = v.evaluate('()=>vrVoi.rect()'); ctx['vertices'], r1 = cell_vertices(scene, overlay_box); self.assertGreaterEqual(r1, .016)
            requested = [np.array([[x * self.css_size[0], y * self.css_size[1]] for x, y in cell]) for cell in ctx['vertices']]
            placement(scene, oracle(scene, requested, slab_a), requested, [slab_a, slab_b])
            self.measure('MAX-MX-03', px_per_mm=scene.px_per_mm, sample_distance=info['sampleDistance'], vertices=ctx['vertices'])
        step('MX-03', mx03)

        def expected_crop_planes():
            rows = []
            for axis, (lo, hi), size in ((0, (0, 51), 63), (1, (0, 63), 63), (2, (0, 32), 32)):
                n = np.zeros(3); n[axis] = 1; step_mm = (SPACING[1], SPACING[0], STEP)[axis]
                rows.append((n, (lo - .5) * step_mm)); rows.append((-n, -(hi + .5) * step_mm))
            return rows

        def same_planes(planes):
            self.assertEqual(len(planes), 6)
            for normal, offset in expected_crop_planes():
                self.assertTrue(any(np.allclose(pl['normal'], normal, atol=1e-6) and abs(float(np.dot(pl['origin'], normal)) - offset) <= 1e-6 for pl in planes), (normal, offset, planes))

        def mx04():
            dialog.get_by_label('I Min', exact=True).fill('0'); dialog.get_by_label('I Max', exact=True).fill('51'); dialog.get_by_role('button', name='Apply Crop', exact=True).click(); self.settle(v)
            self.assertEqual(self.inspect(v)['crop'], {'i': [0, 51], 'j': [0, 63], 'k': [0, 32]})
            planes = v.evaluate('()=>vrVoi.info()')['planes']; same_planes(planes); ctx['P6'] = planes
            scene = Scene(v); r = oracle(scene, [], slab_a)
            self.assertEqual(dark(scene, r['BOX'] & ~r['_masks']['crop']), 0); self.assertGreaterEqual(fraction(scene, r['CROPKEEP']), .99)
        step('MX-04', mx04)

        def mx05():
            # The VR's first mask: the install compiles the fixed program once (BU-T04), inside the same 30 s bound.
            phases = recorder('Apply VOI', 'MX-05', 'apply-voi', lambda: self.slab_inputs(v, 'Coronal', center=slab_a[0], thickness=slab_a[1]))

            def check():
                s = self.inspect(v); self.assert_voi(s, slab_a[0], [0, 1, 0], slab_a[1])
                self.assertEqual(s['voiHistoryDepth'], 1); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
                scene = Scene(v); r = oracle(scene, [], slab_a)
                self.assertEqual(dark(scene, r['VOI']), 0); self.assertEqual(dark(scene, r['CROP']), 0); self.assertEqual(dark(scene, r['2X']), 0); self.assertGreaterEqual(fraction(scene, r['KEPT']), .99)
            render_action('MX-05', 'apply-voi', 0, True, self.button(v, 'Apply VOI'), check, phases, built=(2, 1))
        step('MX-05', mx05)
        successes = set()
        for n in range(8):
            def mx_sculpt(n=n):
                earlier = self.inspect(v)['sculpt'] or []
                phases = recorder('Apply Sculpt', 'MX-%02d' % (6 + n), 'apply-sculpt', lambda: draw_freehand(ctx['vertices'][n]))
                if n == 0:
                    for name in ('Apply VOI', 'Move Slab', 'Disable VOI'):
                        expect(self.button(v, name)).to_be_disabled()
                    for label in ('View From',):
                        expect(dialog.get_by_label(label, exact=True)).to_be_disabled()
                    for name in ('Apply Display', 'Apply Crop'):
                        expect(dialog.get_by_role('button', name=name, exact=True)).to_be_disabled()

                def check():
                    s = self.inspect(v); applied_geometry(s, n, ctx['vertices'][n], earlier)
                    self.assert_voi(s, slab_a[0], [0, 1, 0], slab_a[1]); self.assertEqual(s['voiHistoryDepth'], 1)
                    self.assertEqual(s['crop'], {'i': [0, 51], 'j': [0, 63], 'k': [0, 32]}); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
                    expect(self.button(v, 'Apply VOI')).to_be_enabled()
                    scene = Scene(v); polygons = css_polygons(s); r = oracle(scene, polygons, slab_a)
                    placement(scene, r, polygons, [slab_a, slab_b]); judge(scene, r, n + 1)
                    successes.add(dialog.get_by_role('status').text_content())
                render_action('MX-%02d' % (6 + n), 'apply-sculpt', n + 1, True, dialog.get_by_role('button', name='Apply Sculpt', exact=True), check, phases)
            step('MX-%02d' % (6 + n), mx_sculpt)

        def mx14():
            phases = recorder('Move Slab', 'MX-14', 'move-slab', lambda: self.field(v, 'VOI Move').fill('2.5'))

            def check():
                s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2); self.assertEqual(len(s['sculpt']), 8)
                self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
                scene = Scene(v); polygons = css_polygons(s); r = oracle(scene, polygons, slab_b); judge(scene, r, 8)
                # Negative control: the slab before the move is wrong on the two moved bands.
                a = oracle(scene, polygons, slab_a); moved = (r['_masks']['voi'] != a['_masks']['voi']) & r['CROPKEEP'] & ~(a['_band'] | r['_band'])
                for n_ in range(8):
                    moved &= ~r['_masks']['p%d' % n_]
                moved &= ~r['_masks']['f9']; wrong = int((scene.lit[moved] != a['_masks']['voi'][moved]).sum()); self.assertGreaterEqual(wrong, 400)
                successes.add(dialog.get_by_role('status').text_content())
            render_action('MX-14', 'move-slab', 8, True, self.button(v, 'Move Slab'), check, phases)
        step('MX-14', mx14)

        def mx15():
            s = self.inspect(v); scene = Scene(v); polygons = css_polygons(s); r = oracle(scene, polygons, slab_b); judge(scene, r, 8)
            for n_ in range(8):
                self.assertGreaterEqual(int(scene.lit[r['R%d' % (n_ + 1)]].size - scene.lit[r['R%d' % (n_ + 1)]].sum()), 400, 'an oracle without sculpt %d is wrong here' % (n_ + 1))
            self.assertGreaterEqual(int((~scene.lit[r['VOI']]).sum()), 400, 'an oracle without the VOI is wrong here')
            self.assertEqual(int((~scene.lit[r['CROP']]).sum()), int(r['CROP'].sum()), 'an oracle without the crop is wrong on every crop pixel')
            info = v.evaluate('()=>vrVoi.info()')
            ctx['M'] = {'inspect': s, 'properties': info['properties'], 'planes': info['planes'], 'lit': scene.lit.copy(),
                        'buttons': [self.dialog(v).get_by_role('button', name=n_, exact=True).is_enabled() for n_ in ('Undo Sculpt', 'Clear Sculpt', 'Undo VOI')]}
            self.assertEqual(ctx['M']['buttons'], [True, True, True])
        step('MX-15', mx15)
        M = ctx['M']
        same = lambda s: {k: s[k] for k in ('voi', 'crop', 'sculpt', 'originalView', 'voiHistoryDepth')}

        def mx16():
            scene = Scene(v); r = v.evaluate('()=>vrVoi.rect()'); corners = scene.css(f9)
            self.sculpt_region(v, dialog, 'Rectangle', 'Inside', [(corners[0][0] / r['width'], corners[0][1] / r['height']), (corners[1][0] / r['width'], corners[1][1] / r['height'])])
            previous = dialog.get_by_role('status').text_content()
            dialog.get_by_role('button', name='Apply Sculpt', exact=True).click(); self.quiet(v)
            watched = v.evaluate('()=>vrVoi.watched()'); reason = dialog.get_by_role('status').text_content()
            self.assertGreaterEqual(watched['statusWrites'], 1); self.assertTrue(reason.strip()); self.assertNotEqual(reason, previous); self.assertNotIn(reason, successes)
            s = self.inspect(v)
            if s['lastRefusal'] is None:
                self.measure('MAX-MX-16', reason_key=None, note='D348: no reason key; the visible reason is the status write')
            else:
                self.assertEqual(s['lastRefusal'], 'vr-limit')
            expect(dialog).to_be_visible(); self.assertEqual(same(s), same(M['inspect']))
            info = v.evaluate('()=>vrVoi.info()'); self.assertEqual(info['properties'], M['properties']); self.assertEqual(info['planes'], M['planes'])
            self.assertTrue(np.array_equal(Scene(v).lit, M['lit'])); self.measure('MAX-MX-16', frames=watched['frames'])
            expect(dialog.get_by_label('Sculpt removal preview', exact=True)).to_have_count(1); expect(self.button(v, 'Apply VOI')).to_be_disabled()
            expect(dialog.get_by_label('View From', exact=True)).to_be_disabled()
        step('MX-16', mx16)

        def mx17():
            dialog.get_by_role('button', name='Cancel Sculpt', exact=True).click(); self.quiet(v)
            expect(dialog.get_by_label('Sculpt removal preview', exact=True)).to_have_count(0); expect(self.button(v, 'Apply VOI')).to_be_enabled()
            expect(dialog.get_by_label('View From', exact=True)).to_be_enabled(); expect(dialog.get_by_role('button', name='Apply Display', exact=True)).to_be_enabled()
            self.assertEqual(same(self.inspect(v)), same(M['inspect']))
        step('MX-17', mx17)

        def mx18():
            def check():
                s = self.inspect(v); self.assertIsNone(s['voi']); self.assertEqual(s['voiHistoryDepth'], 3)
                self.assertAlmostEqual(float(self.field(v, 'VOI Center P').input_value()), slab_b[0][1], delta=1e-9); self.assertEqual(s['sculpt'], M['inspect']['sculpt'])
                self.assertEqual(s['crop'], M['inspect']['crop']); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], M['planes'])
                scene = Scene(v); r = oracle(scene, css_polygons(s), slab_b); judge(scene, r, 8, voi_on=False, nine=True); ctx['off'] = scene.lit.copy()
            render_action('MX-18', 'disable-voi', 8, False, self.button(v, 'Disable VOI'), check, recorder('Disable VOI', 'MX-18', 'disable-voi'))
        step('MX-18', mx18)

        def mx19():
            def check():
                s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 4)
                scene = Scene(v); r = oracle(scene, css_polygons(s), slab_b); judge(scene, r, 8, nine=True)
            render_action('MX-19', 'apply-voi', 8, True, self.button(v, 'Apply VOI'), check, recorder('Apply VOI', 'MX-19', 'apply-voi'))
        step('MX-19', mx19)

        def mx20():
            # Two target actions, each with its own deadline and VRVOI-MAX line.
            def first():
                s = self.inspect(v); self.assertIsNone(s['voi']); self.assertEqual(s['voiHistoryDepth'], 3); self.assertEqual(s['sculpt'], M['inspect']['sculpt'])
                scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, voi_on=False, nine=True)
            render_action('MX-20', 'undo-voi-1', 8, False, self.button(v, 'Undo VOI'), first, recorder('Undo VOI', 'MX-20', 'undo-voi-1'))

            def second():
                s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2)
                self.assertEqual(s['sculpt'], M['inspect']['sculpt']); scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, nine=True)
            render_action('MX-20', 'undo-voi-2', 8, True, self.button(v, 'Undo VOI'), second, recorder('Undo VOI', 'MX-20', 'undo-voi-2'))
        step('MX-20', mx20)

        def mx21():
            def check():
                s = self.inspect(v)
                self.assertEqual(s['sculpt'], M['inspect']['sculpt'][:7]); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2)
                self.assertEqual(s['crop'], M['inspect']['crop']); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], M['planes'])
                scene = Scene(v); polygons = css_polygons(M['inspect']); r = oracle(scene, polygons, slab_b)
                self.assertGreaterEqual(fraction(scene, r['R8']), .95, 'the removed region is the last applied one'); judge(scene, oracle(scene, polygons[:7], slab_b), 7)
            render_action('MX-21', 'undo-sculpt', 7, True, dialog.get_by_role('button', name='Undo Sculpt', exact=True), check, recorder('Undo Sculpt', 'MX-21', 'undo-sculpt'))
        step('MX-21', mx21)

        def mx22():
            earlier = self.inspect(v)['sculpt']; phases = recorder('Apply Sculpt', 'MX-22', 'apply-sculpt', lambda: draw_freehand(ctx['vertices'][7]))

            def check():
                s = self.inspect(v); self.assertEqual(len(s['sculpt']), 8); applied_geometry(s, 7, ctx['vertices'][7], earlier)
                scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, nine=True); ctx['N'] = s
            render_action('MX-22', 'apply-sculpt', 8, True, dialog.get_by_role('button', name='Apply Sculpt', exact=True), check, phases)
        step('MX-22', mx22)
        original = self.voi(v).get_by_role('checkbox', name='Original View', exact=True)

        def mx23():
            # Original View lifts every mask and keeps them (today's generator applies none for it, BU-T03).
            def check():
                s = self.inspect(v); self.assertTrue(s['originalView']); self.assertEqual(s['sculpt'], ctx['N']['sculpt']); self.assertEqual(s['voi'], ctx['N']['voi'])
                scene = Scene(v); r = oracle(scene, css_polygons(s), slab_b)
                for n_ in range(8):
                    self.assertGreaterEqual(fraction(scene, r['R%d' % (n_ + 1)]), .95, 'Original View shows sculpt region %d' % (n_ + 1))
                self.assertGreaterEqual(fraction(scene, r['VOI']), .95, 'Original View shows the VOI-only region')
                self.assertEqual(dark(scene, r['CROP']), 0); self.assertEqual(dark(scene, r['BG']), 0); self.assertGreaterEqual(fraction(scene, r['KEPT']), .99)
            render_action('MX-23', 'original-view-on', 8, True, original, check, recorder('Original View', 'MX-23', 'original-view-on'))
        step('MX-23', mx23)

        def mx24():
            def check():
                s = self.inspect(v); self.assertFalse(s['originalView']); self.assertEqual(s['sculpt'], ctx['N']['sculpt'])
                scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, nine=True)
            render_action('MX-24', 'original-view-off', 8, True, original, check, recorder('Original View', 'MX-24', 'original-view-off'))
        step('MX-24', mx24)

        def mx25():
            def check():
                s = self.inspect(v); self.assertIsNone(s['sculpt']); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1])
                scene = Scene(v); judge(scene, oracle(scene, [], slab_b), 0)
                # Negative control: an oracle that keeps the cleared regions hidden is wrong on each of them.
                r = oracle(scene, css_polygons(ctx['N']), slab_b)
                for n_ in range(8):
                    self.assertGreaterEqual(fraction(scene, r['R%d' % (n_ + 1)]), .95, 'Clear Sculpt shows region %d again' % (n_ + 1))
            render_action('MX-25', 'clear-sculpt', 0, True, dialog.get_by_role('button', name='Clear Sculpt', exact=True), check, recorder('Clear Sculpt', 'MX-25', 'clear-sculpt'))
        step('MX-25', mx25)

        def mx26():
            # Reset VR clears VOI, sculpt and crop and resets the display: the renderer builds one new program variant (no crop
            # planes) with the fixed masks, compiled once in that frame and given the committed (empty) masks (BU-T04).
            def check():
                s = self.inspect(v)
                self.assertEqual((s['voi'], s['sculpt'], s['crop'], s['originalView'], s['voiHistoryDepth']), (None, None, None, False, 0))
                self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], [])
                scene = Scene(v); r = oracle(scene, [], slab_b)
                self.assertGreaterEqual(fraction(scene, r['BOX']), .99); self.assertEqual(dark(scene, r['BG']), 0)
            render_action('MX-26', 'reset-vr', 0, False, dialog.get_by_role('button', name='Reset VR', exact=True), check, recorder('Reset VR', 'MX-26', 'reset-vr'), built=(2, 1))
        step('MX-26', mx26)

        def mx27():
            v.evaluate('()=>vrVoi.release()'); dialog.get_by_role('button', name='Close VR', exact=True).click(); expect(self.dialog(v)).to_be_hidden()
            self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.preserved(v, state['S']); v.close(); state['page'] = None
        step('MX-27', mx27)

    def test_vr_voi_06_preflight_refusal_and_native_failure_close_only_vr(self):
        """NT-U1a-06 (CB-05, CB-06, LC-10) after S8-U1a fix9 (B-u): BU-T08 a link or compile failure at the VR's first mask,
        where the fixed mask program is installed, is a refusal that writes nothing and keeps the display and the editors;
        BU-T05 a uniform write failure (a real GL error, through the page's GL) and a frame whose render request fails each
        keep the applied VOI, its Undo history and its image, and the VR stays usable; a display that cannot draw even the
        applied masks again (every render fails) closes only VR, and the MPR draws on."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40)); self.open_vr(v)
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); before = Scene(v); status = self.dialog(v).get_by_role('status')
        self.slab_inputs(v, 'Axial', center=[15.75, 15.75, 40], thickness=10)
        # (a) One LINK_STATUS or COMPILE_STATUS answer is false, armed and disarmed around the click in one synchronous page call.
        for method, name in (('getProgramParameter', 'LINK_STATUS'), ('getShaderParameter', 'COMPILE_STATUS')):
            previous = status.text_content()
            v.evaluate("""([button,method,name])=>{const protos=[window.WebGL2RenderingContext,window.WebGLRenderingContext].filter(Boolean).map(c=>c.prototype),originals=protos.map(p=>p[method]);let once=true;
              protos.forEach((proto,i)=>{proto[method]=function(object,pname){if(once&&pname===this[name]){once=false;return false}return originals[i].call(this,object,pname)}});
              try{button.click()}finally{protos.forEach((proto,i)=>{proto[method]=originals[i]})}}""", [self.button(v, 'Apply VOI').element_handle(), method, name])
            self.quiet(v); state = self.inspect(v)
            self.assertEqual(state['lastRefusal'], 'render-failed', name); self.assertIsNone(state['voi'], name)
            self.assertTrue(status.text_content().strip(), name); self.assertNotEqual(status.text_content(), previous, name)
            self.assertTrue(np.array_equal(Scene(v).lit, before.lit), name); self.assertEqual(float(self.field(v, 'VOI Thickness').input_value()), 10., name)
        # Negative control: the same apply without a fault installs and applies.
        self.button(v, 'Apply VOI').click(); self.settle(v); applied = self.inspect(v); self.assert_voi(applied, [15.75, 15.75, 40], [0, 0, 1], 10)
        shown = Scene(v); self.assertFalse(np.array_equal(shown.lit, before.lit), 'the applied VOI changes the image')
        # (c) A uniform write that raises a GL error (the projection array sent with a wrong length, once) and (d) a render
        # request that throws once: each request fails, the applied masks are drawn again and the VR stays usable.
        write_fault = """button=>{const protos=[window.WebGL2RenderingContext,window.WebGLRenderingContext].filter(Boolean).map(c=>c.prototype),originals=protos.map(p=>p.uniform4fv);let once=true;
          protos.forEach((proto,i)=>{proto.uniform4fv=function(location,data,...rest){if(once){once=false;return originals[i].call(this,location,new Float32Array(3))}return originals[i].call(this,location,data,...rest)}});
          try{button.click()}finally{protos.forEach((proto,i)=>{proto.uniform4fv=originals[i]})}}"""
        frame_fault = """button=>{const vp=cornerstone.getRenderingEngines().flatMap(e=>e.getViewports()).find(x=>x.type===cornerstone.Enums.ViewportType.VOLUME_3D),own=Object.prototype.hasOwnProperty.call(vp,'render'),original=vp.render;
          vp.render=function(){if(own)vp.render=original;else delete vp.render;throw Error('INJECTED VR FRAME FAILURE')};button.click()}"""
        self.field(v, 'VOI Thickness').fill('5')
        for label, fault in (('write', write_fault), ('frame', frame_fault)):
            previous = status.text_content()
            v.evaluate('()=>vrVoi.arm()'); v.evaluate(fault, self.button(v, 'Apply VOI').element_handle()); self.settle(v)
            state = self.inspect(v)
            self.assertEqual(state['voi'], applied['voi'], label); self.assertEqual(state['voiHistoryDepth'], applied['voiHistoryDepth'], label)
            self.assertEqual(state['lastRefusal'], 'render-failed', label)
            self.assertTrue(status.text_content().strip(), label); self.assertNotEqual(status.text_content(), previous, label)
            self.assertTrue(np.array_equal(Scene(v).lit, shown.lit), label + ': the applied masks are shown again')
        self.button(v, 'Apply VOI').click(); self.settle(v); self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 5)
        # (b) Every native render after the write throws: the applied masks cannot be drawn again, so only VR closes, the
        # reason is shown, the MPR renders again.
        v.evaluate("()=>{const vp=cornerstone.getRenderingEngines().flatMap(e=>e.getViewports()).find(v=>v.type===cornerstone.Enums.ViewportType.VOLUME_3D);vp.render=()=>{throw Error('INJECTED VR VOI FAILURE')}}")
        self.field(v, 'VOI Thickness').fill('10'); self.button(v, 'Apply VOI').click()
        expect(self.dialog(v)).to_be_hidden(); self.assertTrue(self.notice(v).text_content().strip()); self.assertNotEqual(self.notice(v).text_content(), self.shown_notice)
        self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.preserved(v, start); self.mpr_live_after_mask_failure(v, start['native'])
        self.open_vr(v); self.assertIsNone(self.inspect(v)['voi']); self.dialog(v).get_by_role('button', name='Close VR', exact=True).click()

    def test_vr_voi_07_source_mpr_marks_report_preserved(self):
        """NT-U1a-07 (SB-04, X-05..X-07): every VOI action leaves source, MPR, marks, report and Job title as they were."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a)
        # The report is typed first and its own writes land before S: the hold that typing starts and the periodic draft
        # autosave belong to the report, not to VR. From S on, every VOI action must leave every row as it is, the saved
        # draft included (X-05..X-07).
        held = lambda r: r.request.method == 'POST' and r.url.endswith('/studies/' + a.uid + '/hold')
        saved = lambda r: r.request.method == 'PUT' and r.url.endswith('/studies/' + a.uid + '/report')
        with p.expect_response(held) as hold, p.expect_response(saved, timeout=self.remaining(45) * 1000) as draft:
            p.locator('#findings').fill('KEEP VR VOI REPORT')
        self.assertEqual(hold.value.status, 201); self.assertEqual(draft.value.status, 200)
        v.get_by_label('Job Title', exact=True).fill('KEEP VR VOI JOB'); start = self.start_state(v, (15.75, 15.75, 40)); jobs = self.jobs(a)
        rows = [json.loads(row) for row in start['rows']['ReportDraft']]
        self.assertEqual([row['findings'] for row in rows if row['uid'] == a.uid], ['KEEP VR VOI REPORT'], 'the autosaved draft is part of S')
        # Negative control: a changed MPR window is detected by the same pixel comparison, and restoring it is not.
        self.mpr_live_after_mask_failure(v, start['native'])
        self.open_vr(v); self.transfer(v, 'TF-MARK')
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); self.field(v, 'VOI Move').fill('2.5'); self.button(v, 'Move Slab').click(); self.settle(v)
        self.field(v, 'VOI Rotate Degrees').fill('30'); self.button(v, 'Rotate Slab').click(); self.settle(v); self.button(v, 'Reset VOI').click(); self.settle(v)
        self.button(v, 'Disable VOI').click(); self.settle(v); self.button(v, 'Undo VOI').click(); self.settle(v)
        self.voi(v).get_by_role('checkbox', name='Original View', exact=True).check(); self.settle(v); self.voi(v).get_by_role('checkbox', name='Original View', exact=True).uncheck(); self.settle(v)
        self.dialog(v).get_by_role('button', name='Close VR', exact=True).click(); expect(self.dialog(v)).to_be_hidden()
        self.preserved(v, start); expect(p.locator('#findings')).to_have_value('KEEP VR VOI REPORT'); expect(v.get_by_label('Job Title', exact=True)).to_have_value('KEEP VR VOI JOB')
        self.assertEqual(self.jobs(a), jobs); self.assertEqual(len(jobs), 0)

    # TEST-S8-U1a-EDGE-GAP ---------------------------------------------------------------------------------------------
    def test_vr_voi_08_first_slice_boundary(self):
        """EG-U1a-B1 (AC-05): MK-FIRST shown in a slab over k 0..2, hidden in one over k 1..3; MK-SMALL hidden in both."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); self.open_vr(v); self.transfer(v, 'TF-MARK'); self.view_from(v, 'Superior')
        self.assertGreaterEqual(chord('G-AX', 'MK-FIRST', 900, (0, 0, 1)), v.evaluate('()=>vrVoi.info()')['sampleDistance'])
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 2.5], thickness=7.5); first = self.markers(Scene(v), 'G-AX', 'TF-MARK', ['MK-FIRST'])
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 5], thickness=7.5); second = self.markers(Scene(v), 'G-AX', 'TF-MARK', ['MK-FIRST'])
        self.assertEqual((first['MK-FIRST'], second['MK-FIRST']), (True, False)); self.view_from(v, 'Anterior')
        self.assertIs(self.markers(Scene(v), 'G-AX', 'TF-MARK', ['MK-SMALL'])['MK-SMALL'], False)
        self.measure('EG-U1a-B1', margin_mm=.25)

    def test_vr_voi_09_last_slice_boundary_move(self):
        """EG-U1a-B2 (AC-06): MK-LAST shown over k 30..32, hidden after Move -2.5 (k 29..31)."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); self.open_vr(v); self.transfer(v, 'TF-MARK'); self.view_from(v, 'Superior')
        self.assertGreaterEqual(chord('G-AX', 'MK-LAST', 900, (0, 0, 1)), v.evaluate('()=>vrVoi.info()')['sampleDistance'])
        self.apply_slab(v, 'Axial', center=[15.75, 15.75, 77.5], thickness=7.5); shown = self.markers(Scene(v), 'G-AX', 'TF-MARK', ['MK-LAST'])
        self.field(v, 'VOI Move').fill('-2.5'); self.button(v, 'Move Slab').click(); self.settle(v); self.assert_voi(self.inspect(v), [15.75, 15.75, 75], [0, 0, 1], 7.5)
        hidden = self.markers(Scene(v), 'G-AX', 'TF-MARK', ['MK-LAST']); self.assertEqual((shown['MK-LAST'], hidden['MK-LAST']), (True, False))
        self.measure('EG-U1a-B2', margin_mm=.0735)

    def test_vr_voi_10_full_extent_slab_equals_unmasked(self):
        """EG-U1a-B3 (AC-07 as corrected by S8-U1a-SPEC-B-F01): a slice-normal slab from the face half a slice step outside the
        first slice to the one outside the last (82.5 mm on G-AX and G-OB1) equals the unmasked silhouette within T-EDGE."""
        for grid in ('G-AX', 'G-OB1'):
            with self.subTest(grid=grid):
                a = voi_series(self.stack, grid, 'V-BOX'); p, v = self.open_series(a); self.open_vr(v)
                self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.show_whole_box(v, grid)
                self.view_from(v, 'Left'); plain = Scene(v)
                centre = world(grid, (31.5, 31.5, 16)); normal = grid_axes(grid)[:, 2] / STEP
                projected = outer_corners(grid) @ normal; self.assertAlmostEqual(float(projected.max() - projected.min()), 82.5, delta=1e-9)
                self.apply_slab(v, 'Axial', center=list(centre), thickness=82.5); state = self.inspect(v)
                self.assertAlmostEqual(state['voi']['slab']['thickness'], 82.5, delta=1e-6)
                if grid == 'G-OB1':
                    # The slice normal (0, -0.6, 0.8) is the Axial preset turned about L by the tilt, around the volume centre.
                    tilt = math.degrees(math.atan2(-normal[1], normal[2])); self.field(v, 'VOI Rotate Degrees').fill(repr(tilt))
                    self.voi(v).get_by_role('combobox', name='VOI Rotate Axis', exact=True).select_option('L'); self.button(v, 'Rotate Slab').click(); self.settle(v)
                    np.testing.assert_allclose(self.inspect(v)['voi']['slab']['normal'], normal, atol=1e-6)
                    np.testing.assert_allclose(self.inspect(v)['voi']['slab']['center'], centre, atol=1e-6)
                masked = Scene(v); differ = masked.lit != plain.lit; tolerance = T_OBLIQUE if grid != 'G-AX' else T_AXIS
                band = masked.ring(lambda du, dv: masked.hits(render_box(grid), du, dv), tolerance)[1]
                differs = int((differ & ~band).sum()); self.assertEqual(differs, 0, grid)
                # Negative control on the same unmasked pixels: a slab from the first to the last slice-centre plane (80 mm,
                # the uncorrected AC-07) would hide lit pixels outside every T band, so this comparison tells them apart.
                kept, cut_band, _ = plain.ring(lambda du, dv: plain.hits(render_box(grid) + [slab(centre, normal, 80.)], du, dv), tolerance)
                lost = int((plain.lit & ~kept & ~cut_band & ~band).sum()); self.assertGreater(lost, 0, (grid, 'centre-plane slab oracle should differ'))
                self.measure('EG-U1a-B3', grid=grid, outside_band_differences=differs, centre_plane_slab_hides=lost); v.close()

    def missing_slice(self, variant):
        """EG-U1a-G1/G2 (X-01..X-08): a series with a missing slice is refused before any VR, with a visible reason."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK', 'E-U', variant); self.assert_series(a); self.seed_report(a); p = self.login(); self.choose(p, a)
        p.locator('#findings').fill('KEEP GAP REPORT'); jobs = self.jobs(a); originals = self.originals()
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        v = opened.value; ct.canvas_ready(v, 1); self.ready(v); v.evaluate(HELPERS); layer, reason = None, ''
        v.locator('[data-cy=Layout]').click(); v.locator('#react-portal').get_by_text('MPR', exact=True).click()
        try:
            v.wait_for_function("""()=>{const g=services.viewportGridService.getState();return g.viewports.size===3&&[...g.viewports.keys()].every(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);return v?.type==='orthographic'&&cornerstone.cache.getVolume(v.getVolumeId())?.loadStatus.loaded})}""", timeout=self.remaining(30) * 1000)
            opened_mpr = True
        except Exception:
            opened_mpr = False
        if opened_mpr:
            expect(v.locator('#kin-volume-orientation')).to_be_visible(); before = self.volume_state(v)
            v.get_by_role('button', name='Open Volume Rendering', exact=True).click(); v.wait_for_timeout(1000)
            reason = self.notice(v).text_content() or ''; layer = 'vr-entry'; self.preserved_volume(before, self.volume_state(v))
        else:
            # Strict Z spacing kept MPR closed: the reason must be visible somewhere on the viewer (OP-7 (a)).
            texts = v.evaluate("()=>[...document.querySelectorAll('[role=alert],[role=status],[role=dialog],[aria-live]')].filter(e=>e.offsetParent!==null).map(e=>e.innerText.trim()).filter(Boolean)")
            reason = ' | '.join(texts); layer = 'mpr'
        self.measure('EG-U1a-' + ('G1' if variant == 'S-GAP-MID' else 'G2'), layer=layer, reason=reason[:300])
        self.assertTrue(reason.strip(), 'OP-7 blocker: no visible reason at the layer that refused (%s)' % layer)
        self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.assertEqual(self.jobs(a), jobs); self.assertEqual(self.originals(), originals)
        expect(p.locator('#findings')).to_have_value('KEEP GAP REPORT')

    def test_vr_voi_11_missing_middle_slice_refused(self):
        self.missing_slice('S-GAP-MID')

    def test_vr_voi_12_missing_near_first_slice_refused(self):
        self.missing_slice('S-GAP-NEAR-FIRST')


    # S8-U1a fix9 (B-u) ------------------------------------------------------------------------------------------------
    def test_vr_voi_13_mask_session_context_loss_and_new_context(self):
        """BU-T06a and BU-T06b (REQ-S8-U1a-BU-LOSS-VR) on the real shared engine. With a request in flight in the product VR
        and in a mask session the test opens on the same engine (KinVolumeMaskRenderer.session, on a VOLUME_3D viewport the
        test enables there), a viewer-wide context-loss registry as VR feature-detects it gets VR's committed VOI (never the
        pending one) and VR closes with a notice that claims nothing about the MPR; the context is then lost: the test
        session's request ends cancelled-context, its committed request stays, nothing of the lost context is used again and
        GL reports nothing but the loss. BU-T06b: on a new context the test makes (a new rendering engine, not the product's)
        the session installs the fixed program once and applies the committed request again; its frame equals today's
        generator for that request on the same new viewport. Product recovery of the shared engine is INT-CTX-01 (S8-CTX),
        not this case. The page's GL context is gone afterwards, so source and report are checked in the database."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40))
        v.evaluate("()=>{window.vrReleases=[];window.kinViewerContextLoss={onContextLoss(release){vrReleases.push(release);return ()=>{window.vrUnregistered=true}}}}")
        self.open_vr(v); self.assertEqual(v.evaluate('()=>vrReleases.length'), 1, 'VR registered its release function')
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); committed = self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10)
        v.evaluate(SESSION_HELPERS); first = v.evaluate('()=>vrBu.open()')
        self.assertEqual((first['status'], first['state']), ('ok', 'open'), first)
        notice = self.notice(v).text_content(); self.field(v, 'VOI Thickness').fill('5')
        lost = v.evaluate('button=>vrBu.loseWithPending(button)', self.button(v, 'Apply VOI').element_handle())
        self.assertTrue(lost['lost']); self.assertIsNotNone(lost['pending'], 'the test session had a request in flight')
        self.assertEqual(lost['kept']['voi'], committed['voi'], 'the registry gets the committed VOI, never the pending one')
        expect(self.dialog(v)).to_be_hidden(); reason = self.notice(v).text_content()
        self.assertTrue(reason.strip()); self.assertNotEqual(reason, notice); self.assertNotIn('MPR', reason)
        self.assertTrue(v.evaluate('()=>window.vrUnregistered===true'), 'closing VR unregisters its release function')
        after = v.evaluate('()=>vrBu.afterLoss()')
        self.assertEqual(after['pending'], 'cancelled-context')
        self.assertEqual(after['state'], {'status': 'lost', 'committed': first['gen'], 'pending': None}, 'the pending request never replaces the committed one')
        self.assertEqual((after['refused'], after['render']), ('context-lost', 'cancelled-context'))
        self.assertEqual(after['calls'], {}, 'no program, location or uniform of the lost context is used again')
        self.assertTrue(set(after['errors']) <= {after['lostCode'], after['noError']}, ('GL reports nothing but the loss', after['errors']))
        new = v.evaluate('()=>vrBu.reacquire()')
        self.measure('BU-T06b', status=new['status'], compile=new['compile'], link=new['link'], renderer=new['renderer'])
        self.assertEqual(new['status'], 'ok'); self.assertEqual((new['compile'], new['link']), (2, 1), 'the fixed program is installed once in the new context')
        self.assertEqual(new['state'], {'status': 'open', 'committed': new['gen'], 'sameRequest': True})
        shown = rgba_array(new['shown'])
        self.assertEqual(rgba_difference(shown, rgba_array(new['generator']))['pixels'], 0, "the re-applied masks draw what today's generator draws for them")
        self.assertEqual(rgba_difference(shown, rgba_array(new['again']))['pixels'], 0)
        self.assertGreater(rgba_difference(shown, rgba_array(new['plain']))['pixels'], 0, 'negative control: the masks change the new viewport')
        v.evaluate('()=>vrBu.close()')
        self.assertEqual(self.originals(), start['originals']); self.unchanged_rows(start['rows']); v.close()


class VolumeRenderingVoiGeneratorE2E(VolumeRenderingVoiE2E):
    """BU-T03 (TEST-S8-SCULPT-PERF; S8-U1a fix10, D531) in its own unit: profile volume-bu-generator selects exactly this
    class's one case, and load_tests below never does. The MAX flow of NT-U1a-05 runs unchanged, with its 30 s bound per
    render action and BU-T04, and after each render action the frame is compared with today's generator for the same
    applied masks (same_as_generator: 0 differing pixels, one generator frame per distinct state under REFERENCE_S)."""
    suite_cap_s = GENERATOR_CAP_S
    generator_reference = True

    def test_bu_t03_max_frames_equal_todays_generator(self):
        # MX-00 closes a V-MARK page whose S still holds; here that page is opened only for it (no V-MARK flow precedes).
        ledger = []
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40))
        self.max_combination(p, v, start, a.uid, ledger)
        self.assertEqual(tuple(ledger), MAX_STEPS)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(VolumeRenderingVoiE2E(n) for n in loader.getTestCaseNames(VolumeRenderingVoiE2E) if n.startswith('test_vr_voi_') and n in VolumeRenderingVoiE2E.__dict__)


if __name__ == '__main__':
    unittest.main(verbosity=2)
