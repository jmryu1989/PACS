# coding: utf-8
"""TEST-S8-U1a-NATIVE and TEST-S8-U1a-EDGE-GAP: the VR VOI Slab on the pinned native renderer.

Runs on a fresh synthetic GitHub-hosted runner only (profile volume-vr-voi). The module makes its own synthetic series
(contract accuracy fixtures: grids G-AX/G-OB1/G-OB2, volumes V-BOX/V-MARK, encodings E-U/E-S/E-SLOPE, series S-FULL and
the two missing-slice variants) and leaves the shared projection phantom untouched.

Assertions bind to (D73): geometry and pixel oracles computed here from those series (contract C-01..C-07) on the native VR
canvas, the read-only VR capability inspect() (contract §13, M-09), English control names and roles, the required scope
wording and the absence of forbidden words. They never bind to shader text, Korean sentences, data attributes or id
prefixes. Every case also runs a negative control on the same pixels: an oracle that should be wrong is shown to be wrong.
VRVOI-MEASURE and VRVOI-MAX lines are observations for the record, never the reason a case passes.
"""
import base64, io, json, math, time, unittest, uuid
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_rendering import VolumeRenderingE2E

# The profile's suite_timeout (CI-T-01 compares the two); every wait is bounded by what is left of it minus a margin.
SUITE_CAP_S = 900
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
MAX_STEPS = tuple('MX-%02d' % n for n in range(24))
REASON_KEYS = {'source-irregular', 'source-unsupported', 'source-changed', 'vr-not-reproducible', 'vr-not-final',
               'vr-unapplied-edit', 'busy', 'vr-layout', 'vr-combination', 'vr-limit', 'render-failed', 'context-lost',
               'access-lost', 'vr-output-unsupported'}
FORBIDDEN = ('골제거', 'bone removal', '자동')


def grid_axes(grid):
    """Columns: the world step (mm) of one index along i, j, k (contract F-72; origin 0)."""
    iop = np.array(GRIDS[grid], float); row, col = iop[:3], iop[3:]
    return np.column_stack([row * SPACING[1], col * SPACING[0], np.cross(row, col) * STEP])


def world(grid, ijk):
    return grid_axes(grid) @ np.asarray(ijk, float)


def index_rows(grid):
    return np.linalg.inv(grid_axes(grid))


def box(grid, lo=(0, 0, 0), hi=(63, 63, 32)):
    """Rays through the voxel-centre range [lo, hi] (contract C-02: the render range is first to last voxel centre)."""
    rows = index_rows(grid); return [(rows[i], lo[i], hi[i]) for i in range(3)]


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
 info:()=>{const v=one(),c=v.getCanvas(),e=v.element,m=mapper(),cam=v.getCamera();return {width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight,hostWidth:e.clientWidth,hostHeight:e.clientHeight,dpr:devicePixelRatio,viewPlaneNormal:Array.from(cam.viewPlaneNormal),viewUp:Array.from(cam.viewUp),parallel:cam.parallelProjection===true,sampleDistance:m.getSampleDistance(),planes:m.getClippingPlanes().map(p=>({origin:Array.from(p.getOrigin()),normal:Array.from(p.getNormal())})),properties:JSON.stringify(m.getViewSpecificProperties()??null)}},
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
 release:()=>{const w=window.vrVoi.watch;if(!w)return;w.element.removeEventListener(E.Events.IMAGE_RENDERED,w.frame);w.dialog.removeEventListener('click',w.action,true);w.dialog.removeEventListener('change',w.action,true);w.observer.disconnect();window.vrVoi.watch=null},
 arm:()=>{const w=window.vrVoi.watch;w.frames=0;w.statusWrites=0;w.armed=true},
 watched:()=>{const w=window.vrVoi.watch;return w?{frames:w.frames,armed:w.armed,statusWrites:w.statusWrites}:null},
 frames:()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r)))),
 inspect:()=>window.kinVolumeVr.inspect()};}"""


class Scene:
    """One native VR frame (DPR 1) and the affine world->canvas map of its parallel camera (contract C-03)."""

    def __init__(self, v):
        self.info = v.evaluate('()=>vrVoi.info()'); lit = v.evaluate('()=>vrVoi.lit()')
        self.w, self.h = lit['width'], lit['height']
        raw = np.frombuffer(base64.b64decode(lit['bits']), np.uint8)
        self.lit = np.unpackbits(raw, bitorder='little')[:self.w * self.h].reshape(self.h, self.w).astype(bool)
        probe = np.array(v.evaluate('p=>vrVoi.project(p)', [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]), float)
        self.b = probe[0]; self.M = (probe[1:] - probe[0]).T
        self.pinv = np.linalg.pinv(self.M); self.d = np.linalg.svd(self.M)[2][2]
        ys, xs = np.mgrid[0:self.h, 0:self.w]; self.uv = np.stack([xs + .5, ys + .5], -1).astype(float); self.uvb = self.uv - self.b
        self.px_per_mm = float(np.sqrt(abs(np.linalg.det(self.M @ self.M.T))) ** .5)

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


# NT-U1a-05 sub-case MAX geometry on G-AX seen from Superior (test-plan §4 MAX-B, MAX-C).
F9 = ([6.4375, 26.375, 0], [19.3125, 27.625, 0])
SLAB_A, SLAB_B = ([15.75, 14.25, 40], 23), ([15.75, 16.75, 40], 23)
CI, CELLS = (0., 25.75, 5.25, 25.75), [(c, r) for r in range(2) for c in range(4)]


def rectangle(scene, corners):
    a, b = scene.css(corners)
    return np.array([a, [b[0], a[1]], b, [a[0], b[1]]])


def max_regions(scene, polygons, voi_slab):
    """Independent regions (MAX-C): box, crop keep, slab keep, each applied polygon and F9, every boundary's T band removed."""
    box_c = box('G-AX'); crop_c = crop('G-AX', ((0, 51), (0, 63), (0, 32)))[0]; slab_c = slab(voi_slab[0], (0, 1, 0), voi_slab[1]); f9 = rectangle(scene, F9)
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


def boundary_gaps(scene, polygons, slabs):
    """Smallest distance (px) between distinct oracle boundaries: polygons, F9, crop line, slab lines and box edges."""
    def distance(points, poly):
        s0 = np.asarray(poly, float); e = np.roll(s0, -1, 0) - s0; d = np.asarray(points, float)[:, None, :] - s0[None]
        t = np.clip((d * e[None]).sum(-1) / np.maximum((e * e).sum(-1), 1e-12)[None], 0, 1)
        return float(np.linalg.norm(d - t[..., None] * e[None], axis=-1).min())
    lines = [scene.css([[25.75, 0, 0], [25.75, 31.5, 0]])] + [scene.css([[0, c[1] + sgn * t / 2, 0], [31.5, c[1] + sgn * t / 2, 0]]) for c, t in slabs for sgn in (-1, 1)]
    lines += [scene.css(edge) for edge in ([[0, 0, 0], [0, 31.5, 0]], [[31.5, 0, 0], [31.5, 31.5, 0]], [[0, 0, 0], [31.5, 0, 0]], [[0, 31.5, 0], [31.5, 31.5, 0]])]
    shapes = [np.asarray(poly, float) for poly in polygons] + [rectangle(scene, F9)]; best = math.inf
    for n, pa in enumerate(shapes):
        for pb in shapes[n + 1:] + [np.asarray(line) for line in lines]:
            best = min(best, distance(pa, pb), distance(pb, pa))
    return best


class VolumeRenderingVoiE2E(VolumeRenderingE2E):
    @classmethod
    def setUpClass(cls):
        cls.suite_started = time.monotonic()
        super().setUpClass()

    # Bounds and observation helpers -----------------------------------------------------------------------------------
    def remaining(self, limit):
        left = min(limit, self.suite_started + SUITE_CAP_S - SUITE_MARGIN_S - time.monotonic())
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

    def open_series(self, fixture, page=None):
        """Worklist, filmbox viewer, MPR and the first plane selected (the opened_projection flow) on this module's series."""
        self.seed_report(fixture); p = page or self.login(); self.choose(p, fixture)
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

    def settle(self, v, limit=30):
        """A new native render after the action, three frames for the product's post-render check, and the VR still shown."""
        v.wait_for_function('()=>{const w=vrVoi.watched();return !!w&&w.armed&&w.frames>=1}', timeout=self.remaining(limit) * 1000)
        v.evaluate('()=>vrVoi.frames()'); self.still_shown(v)

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
        select = self.voi(v).get_by_role('combobox', name='VOI Preset', exact=True)
        if defaults:
            # Choosing a preset writes its default slab into the editors, even when that preset is already selected.
            select.select_option('Coronal' if preset != 'Coronal' else 'Axial')
        select.select_option(preset)
        for values, prefix in ((center, 'VOI Center '), (pivot, 'VOI Pivot ')):
            if values is not None:
                for axis, value in zip('LPS', values):
                    self.field(v, prefix + axis).fill(repr(float(value)))
        if thickness is not None:
            self.field(v, 'VOI Thickness').fill(repr(float(thickness)))
        self.button(v, 'Apply VOI').click(); self.settle(v); return self.inspect(v)

    def assert_voi(self, state, center, normal, thickness, pivot=None):
        self.assertIsNotNone(state['voi']); slab_state = state['voi']['slab']; self.assertEqual(state['voi']['mode'], 'Slab')
        np.testing.assert_allclose(slab_state['center'], center, atol=1e-6, rtol=0); np.testing.assert_allclose(slab_state['normal'], normal, atol=1e-6, rtol=0)
        self.assertAlmostEqual(slab_state['thickness'], thickness, delta=1e-6)
        if pivot is not None:
            np.testing.assert_allclose(slab_state['pivot'], pivot, atol=1e-6, rtol=0)

    def markers(self, scene, grid, transfer, names=None, tolerance=T_AXIS):
        """P(m) per marker, or None when the ray through the marker is shorter than the sample distance (test-plan §8.3)."""
        result = {}
        for name in names or MARKERS:
            if chord(grid, name, THRESHOLD[transfer], scene.d) < scene.info['sampleDistance']:
                result[name] = None; continue
            region = scene.marker(grid, name, THRESHOLD[transfer], tolerance); result[name] = bool(scene.lit[region].any())
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
        """NT-U1a-00 (OQ-3, C-02): the unmasked range is first to last voxel centre and slab planes sit where the model puts them."""
        a = voi_series(self.stack, 'G-AX', 'V-BOX'); self.assert_series(a); p, v = self.open_series(a); self.open_vr(v)
        self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v)
        results = {}
        for view in ('Left', 'Anterior'):
            self.view_from(v, view); scene = Scene(v); cons = box('G-AX')
            faces = [(1, 'low'), (1, 'high'), (2, 'low'), (2, 'high')] if view == 'Left' else [(0, 'low'), (0, 'high'), (2, 'low'), (2, 'high')]
            for index, side in faces:
                result = scene.plane_strips(cons, index, side, T_AXIS); results[f'{view} box {index}{side}'] = result; self.assertTrue(edge_ok(result), (view, index, side, result))
            # Negative control: the voxel-face convention (render range half a voxel wider) is more than T away on this canvas.
            face = scene.plane_strips(box('G-AX', (-.5, -.5, -.5), (63.5, 63.5, 32.5)), 2, 'high', T_AXIS)
            self.assertFalse(edge_ok(face), ('voxel-face oracle should differ', view, face))
        state = self.apply_slab(v, 'Axial', center=[15.75, 15.75, 41.25], thickness=40); self.assert_voi(state, [15.75, 15.75, 41.25], [0, 0, 1], 40)
        for view in ('Left', 'Anterior'):
            self.view_from(v, view); scene = Scene(v); cons = box('G-AX') + [slab([15.75, 15.75, 41.25], [0, 0, 1], 40)]
            for side in ('low', 'high'):
                result = scene.plane_strips(cons, 3, side, T_AXIS); results[f'{view} slab {side}'] = result; self.assertTrue(edge_ok(result), (view, side, result))
            # Under the voxel-face texture convention the planes would land at z' = -1.25 + z * 82.5 / 80 (FD-07).
            shifted = box('G-AX') + [(np.array([0, 0, 1.]), -1.25 + 21.25 * 82.5 / 80, -1.25 + 61.25 * 82.5 / 80)]
            for side in ('low', 'high'):
                self.assertFalse(edge_ok(scene.plane_strips(shifted, 3, side, T_AXIS)), ('face-convention slab oracle should differ', view, side))
        self.measure('NT-U1a-00', edges=results, px_per_mm=Scene(v).px_per_mm)

    def test_vr_voi_01_box_slab_edges_axis_and_oblique(self):
        """NT-U1a-01 (AC-A09-02): slab-made guaranteed edges within T-EDGE on G-AX, G-OB1 and G-OB2, after a drag rotation too."""
        cases = [('G-AX', 'Axial', 41.0, 41.4, ['Left', 'Anterior', 'yaw'], T_AXIS, [(0, 0, 1), (0, 0, 1)]),
                 ('G-AX', 'Sagittal', 15.5, 16.0, ['Superior', 'Anterior'], T_AXIS, [(1, 0, 0), (1, 0, 0)]),
                 ('G-OB1', 'Axial', None, 30.0, ['Left', 'yaw'], T_OBLIQUE, None), ('G-OB2', 'Axial', None, 30.0, ['Left', 'yaw'], T_OBLIQUE, None)]
        measured = []
        for grid, preset, centre_value, thickness, views, tolerance, _ in cases:
            with self.subTest(grid=grid, preset=preset):
                a = voi_series(self.stack, grid, 'V-BOX'); p, v = self.open_series(a); self.open_vr(v)
                self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v)
                centre = world(grid, (31.5, 31.5, 16)); normal = {'Axial': (0, 0, 1), 'Sagittal': (1, 0, 0)}[preset]
                if centre_value is not None:
                    centre = np.array(centre); centre[{'Axial': 2, 'Sagittal': 0}[preset]] = centre_value
                state = self.apply_slab(v, preset, center=list(centre), thickness=thickness); self.assert_voi(state, centre, normal, thickness)
                cons = box(grid) + [slab(centre, normal, thickness)]; n = np.array(normal, float); h = float(n @ centre)
                for view in views:
                    if view == 'yaw':
                        self.yaw(v)
                    else:
                        self.view_from(v, view)
                    scene = Scene(v)
                    for side in ('low', 'high'):
                        result = scene.plane_strips(cons, 3, side, tolerance); measured.append({'grid': grid, 'view': view, 'side': side, **result})
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

    def test_vr_voi_03_signed_rescaled_encodings_same_result(self):
        """NT-U1a-03 (AC-A09-04, OP-2 (a)): E-U, E-S and E-SLOPE give the same markers, lit set and saturated RGBA for slab A."""
        renders = {}
        for encoding in ('E-U', 'E-S', 'E-SLOPE'):
            a = voi_series(self.stack, 'G-AX', 'V-MARK', encoding); self.assert_series(a); p, v = self.open_series(a); self.open_vr(v)
            self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10)
            scene = Scene(v); rgba = v.evaluate('()=>vrVoi.rgba()')
            pixels = np.frombuffer(base64.b64decode(rgba['bytes']), np.uint8).reshape(rgba['height'], rgba['width'], 4)
            renders[encoding] = {'scene': scene, 'markers': self.markers(scene, 'G-AX', 'TF-MARK'), 'rgba': pixels}
            if encoding == 'E-S':
                # Negative control: the same encoding with slab B shows a different marker set.
                self.apply_slab(v, 'Axial', center=[15.75, 15.75, 32.5], thickness=5)
                renders['E-S slab B'] = {'markers': self.markers(Scene(v), 'G-AX', 'TF-MARK')}
            v.close()
        reference = renders['E-U']; scene = reference['scene']
        band = np.zeros_like(scene.lit)
        for name in MARKERS:
            lo, hi = visible(name, THRESHOLD['TF-MARK']); cons = box('G-AX', lo, hi); band |= scene.ring(lambda du, dv: scene.hits(cons, du, dv), T_AXIS)[1]
        saturated = (reference['rgba'][..., :3] >= 250).all(-1) & ~band
        self.assertGreater(int(saturated.sum()), 0)
        differences = {}
        for encoding in ('E-S', 'E-SLOPE'):
            other = renders[encoding]; self.assertEqual(other['markers'], reference['markers'], encoding)
            self.assertTrue(np.array_equal(other['scene'].lit & ~band, scene.lit & ~band), encoding)
            np.testing.assert_array_equal(other['rgba'][saturated], reference['rgba'][saturated])
            differences[encoding] = int((other['rgba'] != reference['rgba']).any(-1).sum())
        self.assertNotEqual(renders['E-S slab B']['markers'], renders['E-S']['markers'])
        self.measure('NT-U1a-03', markers=reference['markers'], rgba_differences=differences, saturated=int(saturated.sum()))

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
            self.assertIn('mm', voi.locator('label', has=self.field(v, name)).inner_text(), name)
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); unmasked = Scene(v); plain = self.markers(unmasked, 'G-AX', 'TF-MARK')
        # A sculpt over MK-LAST makes Original View meaningful for both masks.
        corner = unmasked.css([world('G-AX', (46, 0, 31)), world('G-AX', (57, 0, 32.4))]); r = v.evaluate('()=>vrVoi.rect()')
        points = [((min(corner[:, 0]) - 4) / r['width'], (min(corner[:, 1]) - 4) / r['height']), ((max(corner[:, 0]) + 4) / r['width'], (max(corner[:, 1]) + 4) / r['height'])]
        self.sculpt_region(v, self.dialog(v), 'Rectangle', 'Inside', points); self.dialog(v).get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)
        sculpted = self.markers(Scene(v), 'G-AX', 'TF-MARK'); self.assertFalse(sculpted['MK-LAST'])
        # VS-02: Axial default = voxel-centre midpoint, full projected thickness; the image equals the unmasked one.
        state = self.apply_slab(v, 'Axial'); self.assert_voi(state, [15.75, 15.75, 40], [0, 0, 1], 80, [15.75, 15.75, 40]); self.assertEqual(state['voiHistoryDepth'], 1)
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
        self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 80)
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
        # LC-12: a window resize redraws the same tissue; the VOI is unchanged.
        size, css = v.viewport_size, list(self.css_size); v.set_viewport_size({'width': size['width'] - 40, 'height': size['height']})
        v.wait_for_function('w=>vrVoi.info().cssWidth!==w', arg=css[0], timeout=self.remaining(30) * 1000)
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
        """NT-U1a-05 (CB-01..CB-04, CB-09, CB-10): crop x VOI x sculpt intersect and never erase each other; MAX below."""
        ledger = []
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40))
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
            scene = Scene(v); r = v.evaluate('()=>vrVoi.rect()'); corners = scene.css([[3.75, 3.75, 0], [5.75, 7.75, 0]])
            self.sculpt_region(v, dialog, 'Rectangle', 'Inside', [(corners[0][0] / r['width'], corners[0][1] / r['height']), (corners[1][0] / r['width'], corners[1][1] / r['height'])])
            # CB-10: Drawing locks the VOI with the camera and display edits.
            expect(self.button(v, 'Apply VOI')).to_be_disabled(); expect(dialog.get_by_label('View From', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)
        def apply_crop(i_max):
            dialog.get_by_label('I Max', exact=True).fill(str(i_max)); dialog.get_by_role('button', name='Apply Crop', exact=True).click(); self.settle(v)
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

    # NT-U1a-05 sub-case MAX (test-plan §4 MAX-A..MAX-G) ---------------------------------------------------------------
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
        try:
            self.max_steps(p, v_mark, state, step)
            print('VRVOI-MAX ' + json.dumps({'step': 'done', 'total_s': round(time.monotonic() - started, 3), 'suite_elapsed_s': round(time.monotonic() - self.suite_started, 3)}), flush=True)
        except BaseException as error:
            # MAX-E: observation off, preview cancelled, VR closed, no VR viewport, S checked, and the MPR alive when the
            # product closed the VR. Cleanup errors are reported with the first failure, which is raised unchanged.
            first = state['first'] or ('outside-step', error); cleanup = []; v = state['page']
            product_closed = v is not None and not self.dialog(v).is_visible() and first[0] not in ('MX-00', 'MX-01', 'MX-23')
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
            print('VRVOI-MAX failed ' + json.dumps({'step': first[0], 'reason': repr(first[1])[:500], 'product_closed_vr': product_closed, 'cleanup_errors': cleanup}), flush=True)
            raise first[1]

    def max_steps(self, p, v_mark, state, step):
        f9, slab_a, slab_b = [list(c) for c in F9], SLAB_A, SLAB_B
        ctx = {}

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
            self.assertGreater(int(regions['CROP'].sum()), 0); self.assertGreater(int(regions['KEPT'].sum()), 0); self.assertGreaterEqual(int(regions['9'].sum()), 400)
            # Distinct oracle boundaries are at least 2 T + 2 = 4 px apart.
            self.assertGreaterEqual(boundary_gaps(scene, polygons, slabs), 4)
        def draw_freehand(vertices):
            dialog.get_by_label('Sculpt Tool', exact=True).select_option('Freehand Area'); dialog.get_by_label('Removal Side', exact=True).select_option('Inside')
            dialog.get_by_role('button', name='Draw Region', exact=True).click(); overlay = dialog.get_by_label('Sculpt removal preview', exact=True)
            expect(overlay).to_have_count(1); box_ = overlay.bounding_box(); ctx['overlay'] = box_
            screen = [(box_['x'] + x * box_['width'], box_['y'] + y * box_['height']) for x, y in vertices]
            v.mouse.move(*screen[0]); v.mouse.down()
            for point in screen[1:]:
                v.mouse.move(*point)
            v.mouse.up(); expect(dialog.get_by_role('button', name='Apply Sculpt', exact=True)).to_be_enabled()

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
            s = self.apply_slab(v, 'Coronal', center=slab_a[0], thickness=slab_a[1]); self.assert_voi(s, slab_a[0], [0, 1, 0], slab_a[1])
            self.assertEqual(s['voiHistoryDepth'], 1); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
            scene = Scene(v); r = oracle(scene, [], slab_a)
            self.assertEqual(dark(scene, r['VOI']), 0); self.assertEqual(dark(scene, r['CROP']), 0); self.assertEqual(dark(scene, r['2X']), 0); self.assertGreaterEqual(fraction(scene, r['KEPT']), .99)
        step('MX-05', mx05)
        successes = set()
        for n in range(8):
            def mx_sculpt(n=n):
                earlier = self.inspect(v)['sculpt'] or []
                draw_freehand(ctx['vertices'][n])
                if n == 0:
                    for name in ('Apply VOI', 'Move Slab', 'Disable VOI'):
                        expect(self.button(v, name)).to_be_disabled()
                    for label in ('View From',):
                        expect(dialog.get_by_label(label, exact=True)).to_be_disabled()
                    for name in ('Apply Display', 'Apply Crop'):
                        expect(dialog.get_by_role('button', name=name, exact=True)).to_be_disabled()
                dialog.get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)
                s = self.inspect(v); applied_geometry(s, n, ctx['vertices'][n], earlier)
                self.assert_voi(s, slab_a[0], [0, 1, 0], slab_a[1]); self.assertEqual(s['voiHistoryDepth'], 1)
                self.assertEqual(s['crop'], {'i': [0, 51], 'j': [0, 63], 'k': [0, 32]}); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
                expect(self.button(v, 'Apply VOI')).to_be_enabled()
                scene = Scene(v); polygons = css_polygons(s); r = oracle(scene, polygons, slab_a)
                placement(scene, r, polygons, [slab_a, slab_b]); judge(scene, r, n + 1)
                successes.add(dialog.get_by_role('status').text_content())
            step('MX-%02d' % (6 + n), mx_sculpt)

        def mx14():
            self.field(v, 'VOI Move').fill('2.5'); self.button(v, 'Move Slab').click(); self.settle(v)
            s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2); self.assertEqual(len(s['sculpt']), 8)
            self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], ctx['P6'])
            scene = Scene(v); polygons = css_polygons(s); r = oracle(scene, polygons, slab_b); judge(scene, r, 8)
            # Negative control: the slab before the move is wrong on the two moved bands.
            a = oracle(scene, polygons, slab_a); moved = (r['_masks']['voi'] != a['_masks']['voi']) & r['CROPKEEP'] & ~(a['_band'] | r['_band'])
            for n_ in range(8):
                moved &= ~r['_masks']['p%d' % n_]
            moved &= ~r['_masks']['f9']; wrong = int((scene.lit[moved] != a['_masks']['voi'][moved]).sum()); self.assertGreaterEqual(wrong, 400)
            successes.add(dialog.get_by_role('status').text_content())
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
            self.button(v, 'Disable VOI').click(); self.settle(v); s = self.inspect(v); self.assertIsNone(s['voi']); self.assertEqual(s['voiHistoryDepth'], 3)
            self.assertAlmostEqual(float(self.field(v, 'VOI Center P').input_value()), slab_b[0][1], delta=1e-9); self.assertEqual(s['sculpt'], M['inspect']['sculpt'])
            self.assertEqual(s['crop'], M['inspect']['crop']); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], M['planes'])
            scene = Scene(v); r = oracle(scene, css_polygons(s), slab_b); judge(scene, r, 8, voi_on=False, nine=True); ctx['off'] = scene.lit.copy()
        step('MX-18', mx18)

        def mx19():
            self.button(v, 'Apply VOI').click(); self.settle(v); s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 4)
            scene = Scene(v); r = oracle(scene, css_polygons(s), slab_b); judge(scene, r, 8, nine=True)
        step('MX-19', mx19)

        def mx20():
            self.button(v, 'Undo VOI').click(); self.settle(v); s = self.inspect(v); self.assertIsNone(s['voi']); self.assertEqual(s['voiHistoryDepth'], 3); self.assertEqual(s['sculpt'], M['inspect']['sculpt'])
            scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, voi_on=False, nine=True)
            self.button(v, 'Undo VOI').click(); self.settle(v); s = self.inspect(v); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2)
            self.assertEqual(s['sculpt'], M['inspect']['sculpt']); scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, nine=True)
        step('MX-20', mx20)

        def mx21():
            dialog.get_by_role('button', name='Undo Sculpt', exact=True).click(); self.settle(v); s = self.inspect(v)
            self.assertEqual(s['sculpt'], M['inspect']['sculpt'][:7]); self.assert_voi(s, slab_b[0], [0, 1, 0], slab_b[1]); self.assertEqual(s['voiHistoryDepth'], 2)
            self.assertEqual(s['crop'], M['inspect']['crop']); self.assertEqual(v.evaluate('()=>vrVoi.info()')['planes'], M['planes'])
            scene = Scene(v); polygons = css_polygons(M['inspect']); r = oracle(scene, polygons, slab_b)
            self.assertGreaterEqual(fraction(scene, r['R8']), .95, 'the removed region is the last applied one'); judge(scene, oracle(scene, polygons[:7], slab_b), 7)
        step('MX-21', mx21)

        def mx22():
            earlier = self.inspect(v)['sculpt']; draw_freehand(ctx['vertices'][7]); dialog.get_by_role('button', name='Apply Sculpt', exact=True).click(); self.settle(v)
            s = self.inspect(v); self.assertEqual(len(s['sculpt']), 8); applied_geometry(s, 7, ctx['vertices'][7], earlier)
            scene = Scene(v); judge(scene, oracle(scene, css_polygons(s), slab_b), 8, nine=True)
        step('MX-22', mx22)

        def mx23():
            v.evaluate('()=>vrVoi.release()'); dialog.get_by_role('button', name='Close VR', exact=True).click(); expect(self.dialog(v)).to_be_hidden()
            self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.preserved(v, state['S']); v.close(); state['page'] = None
        step('MX-23', mx23)

    def test_vr_voi_06_preflight_refusal_and_native_failure_close_only_vr(self):
        """NT-U1a-06 (CB-05, CB-06, LC-10): a refused link keeps the display; a failure after the write closes only VR."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40)); self.open_vr(v)
        self.transfer(v, 'TF-MARK'); self.view_from(v, 'Anterior'); applied = self.apply_slab(v, 'Axial', center=[15.75, 15.75, 40], thickness=10); before = Scene(v)
        self.field(v, 'VOI Thickness').fill('5')
        # (a) One LINK_STATUS answer is false, armed and disarmed around the click in one synchronous page call.
        v.evaluate("""button=>{const protos=[window.WebGL2RenderingContext,window.WebGLRenderingContext].filter(Boolean).map(c=>c.prototype),originals=protos.map(p=>p.getProgramParameter);let once=true;
          protos.forEach((proto,i)=>{proto.getProgramParameter=function(program,name){if(once&&name===this.LINK_STATUS){once=false;return false}return originals[i].call(this,program,name)}});
          try{button.click()}finally{protos.forEach((proto,i)=>{proto.getProgramParameter=originals[i]})}}""", self.button(v, 'Apply VOI').element_handle())
        self.quiet(v); state = self.inspect(v); self.assertEqual(state['lastRefusal'], 'render-failed'); self.assertEqual(state['voi'], applied['voi'])
        self.assertTrue(self.dialog(v).get_by_role('status').text_content().strip()); self.assertTrue(np.array_equal(Scene(v).lit, before.lit))
        # Negative control: the same apply without the injection succeeds.
        self.button(v, 'Apply VOI').click(); self.settle(v); self.assert_voi(self.inspect(v), [15.75, 15.75, 40], [0, 0, 1], 5)
        # (b) The native render after the write throws: only VR closes, the reason is shown, the MPR renders again.
        v.evaluate("()=>{const vp=cornerstone.getRenderingEngines().flatMap(e=>e.getViewports()).find(v=>v.type===cornerstone.Enums.ViewportType.VOLUME_3D);vp.render=()=>{throw Error('INJECTED VR VOI FAILURE')}}")
        self.field(v, 'VOI Thickness').fill('10'); self.button(v, 'Apply VOI').click()
        expect(self.dialog(v)).to_be_hidden(); self.assertTrue(self.notice(v).text_content().strip()); self.assertNotEqual(self.notice(v).text_content(), self.shown_notice)
        self.assertEqual(v.evaluate('()=>vrVoi.count()'), 0); self.preserved(v, start); self.mpr_live_after_mask_failure(v, start['native'])
        self.open_vr(v); self.assertIsNone(self.inspect(v)['voi']); self.dialog(v).get_by_role('button', name='Close VR', exact=True).click()

    def test_vr_voi_07_source_mpr_marks_report_preserved(self):
        """NT-U1a-07 (SB-04, X-05..X-07): every VOI action leaves source, MPR, marks, report and Job title as they were."""
        a = voi_series(self.stack, 'G-AX', 'V-MARK'); p, v = self.open_series(a); start = self.start_state(v, (15.75, 15.75, 40))
        p.locator('#findings').fill('KEEP VR VOI REPORT'); v.get_by_label('Job Title', exact=True).fill('KEEP VR VOI JOB'); jobs = self.jobs(a)
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
        """EG-U1a-B3 (AC-07): a slice-normal slab whose planes are the first and last slice planes equals the unmasked silhouette."""
        for grid in ('G-AX', 'G-OB1'):
            with self.subTest(grid=grid):
                a = voi_series(self.stack, grid, 'V-BOX'); p, v = self.open_series(a); self.open_vr(v)
                self.dialog(v).get_by_role('button', name='Apply Display', exact=True).click(); self.settle(v); self.view_from(v, 'Left'); plain = Scene(v)
                centre = world(grid, (31.5, 31.5, 16)); normal = grid_axes(grid)[:, 2] / STEP
                self.apply_slab(v, 'Axial', center=list(centre), thickness=80); state = self.inspect(v)
                self.assertAlmostEqual(state['voi']['slab']['thickness'], 80, delta=1e-6)
                if grid == 'G-OB1':
                    # The slice normal (0, -0.6, 0.8) is the Axial preset turned about L by the tilt, around the volume centre.
                    tilt = math.degrees(math.atan2(-normal[1], normal[2])); self.field(v, 'VOI Rotate Degrees').fill(repr(tilt))
                    self.voi(v).get_by_role('combobox', name='VOI Rotate Axis', exact=True).select_option('L'); self.button(v, 'Rotate Slab').click(); self.settle(v)
                    np.testing.assert_allclose(self.inspect(v)['voi']['slab']['normal'], normal, atol=1e-6)
                    np.testing.assert_allclose(self.inspect(v)['voi']['slab']['center'], centre, atol=1e-6)
                masked = Scene(v); differ = masked.lit != plain.lit
                band = masked.ring(lambda du, dv: masked.hits(box(grid), du, dv), T_OBLIQUE if grid != 'G-AX' else T_AXIS)[1]
                self.assertEqual(int((differ & ~band).sum()), 0, grid); v.close()

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


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(VolumeRenderingVoiE2E(n) for n in loader.getTestCaseNames(VolumeRenderingVoiE2E) if n.startswith('test_vr_voi_') and n in VolumeRenderingVoiE2E.__dict__)


if __name__ == '__main__':
    unittest.main(verbosity=2)
