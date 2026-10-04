#!/usr/bin/env python3
"""O9 band judge of S8-U1a fix9 (TEST-S8-SCULPT-PERF BU-T02): the approved O9 rule (o9-rule.md revision 5, S8-SCULPT-PERF-
PREP-R-003 ACCEPT) as the product's tests apply it to the native boundary records of tests/e2e/test_volume_bu_boundary.py.
The decision rule, the arithmetic model, the record validation and the rebuilt sweep are the approved verifier's
(o9_verify.py revision 5) unchanged; pass = rule_pass AND 0 out-of-range, as there. What differs is what is pinned: the
approved verifier pinned its harness copies of the generator and of the B-u prototype by file hash; here every record
carries the sha256 of the shader texts it actually rendered (the fixed B-u text of KinVolumeVrMasks.TEXT, and every text
today's generator KinVolumeSculpt.shaderReplacement produced for the sweep), and they must equal PINNED_TEXTS, the texts the
rule's model and its accepted records were made with. These are byte pins on purpose (D73 §14): the model evaluates those
expressions as written, so any change to them is a new shader the rule has not covered (drift = rule FAIL).

Original header of the approved verifier follows.

O9 verifier, revision 5 (S8-SPD-R3-F01; S8-SPD-PREP-F01..F03, F06, F07; PREP-SOL-F01..F04, F11..F13): decides, for every stored old-vs-B-u mismatch of the
native boundary records, whether the binary32 evaluation model M of o9-rule.md admits BOTH decisions at that point.
Pure CPU, exact rational arithmetic, no GPU.

Model M (o9-rule.md 2): every + - x result rounded to nearest binary32 or fused (FMA), sums of more than two terms in any
association, division and the length/sqrt built-ins within 3 / 6 ULP, compile-time folding in higher precision, the
crossing right-hand side in either association, denormals flushed or kept; the constants of each shader are the binary32
values it actually receives: the generator's printed literal parsed to binary32 (correctly rounded decimal, or via the
double = Float32Array value) and B-u's Float32Array values. The verifier evaluates the shader expressions AS WRITTEN
(including max(ee, 1e-20) and the clamp) in outward-rounded interval arithmetic, separately for each representation
vector, and forms the inside-decision set each shader may produce (B-u: R_f32; old: R_f32 or R_dec). Revision 3: a stored
mismatch is approved (in-band) only if EACH observed decision - the record's removal value normalised to inside/outside by
the side - lies in THAT shader's own allowed set (never the union); inputs are checked against the declared range BEFORE
any evaluation (out-of-range = its own failing class). No tolerance band and no reference distance enters the decision.
Model M is an assumption, not something the verifier can confirm: only violations that put an observed decision outside
its shader's allowed set are detectable; a violation that happens to produce an allowed decision is not.

  verify   --record RUN.json [--record RUN.json ...] --out OUT.json     exit 0 all in-band, 1 otherwise, 2 usage error
  selftest --out OUT.json                                                exit 0 all checks hold, 1 otherwise
           counter-examples of S8-SPD-PREP-F01 (ellipse under a 1e6 projection, f* = 0), F02 (rectangle bound whose literal
           and Float32Array roundings differ; polygon bounding box; equal-representation identity input stays exact), F03
           (edges shorter than sqrt(1e-20), a zero-length edge, ee on both sides of 1e-20), R3-F01 (Astra's point), plus a
           soundness fuzz: binary32 emulations of the shaders (sequential, fused, reassociated, both representations) on
           random and boundary-adjacent inputs over the whole product input range must always fall inside the allowed set.
Revision 4: flush-to-zero in every association of intermediate sums and for subnormal operands (SOL-F01); every record is
validated (complete case/side set, rebuilt geometry, tallies, gl_error 0, status/exit) before anything in it is classified,
and only the rebuilt geometry is used (SOL-F02/F03); the reference sources are pinned by full byte sha256 (SOL-F04).
Revision 5 (PREP-SOL-F11..F13): fixture decisions / fixture.sides / agree_both_sides cross-checked and the fixture must
agree for rule_pass; by_tag compared key by key and per-group decisions checked, every count a non-negative integer; each
rebuilt query occurrence is consumed once per case/side (multiset).
selftest --record RUN.json (repeatable) feeds the stored records to the record-validation controls."""
import argparse
import json
import math
import os
import random
import sys
from decimal import Decimal, getcontext
from fractions import Fraction as F

import numpy as np

getcontext().prec = 80
MIN_NORMAL = F(1, 2 ** 126)
DIV_ULPS, LEN_ULPS = 3, 6
T_TEXT, EE_MIN_TEXT = "1e-7", "1e-20"
EDGE_EPS = 1e-9
OFF = [-1e-6, -5e-7, -3e-7, -2e-7, -1.5e-7, -1.2e-7, -1.01e-7, -1.003e-7, -1e-7, -9.97e-8, -9.9e-8, -5e-8, -1e-9, 0, 1e-9, 5e-8,
       9.9e-8, 9.97e-8, 1e-7, 1.003e-7, 1.01e-7, 1.2e-7, 1.5e-7, 2e-7, 3e-7, 5e-7, 1e-6]
DY = [0, 9e-12, 9e-10, 1e-9, -1e-9, 9.99e-10, 1.001e-9, -9.99e-10, -1.001e-9, 2e-9, 9e-9, 1e-7]
R001 = {"points": [[0.1, 2e-7], [0.9, 2.009e-7], [0.9, 0.8], [0, 0.8], [0, 0]], "bounds": [0, 0.9, 0, 0.8], "q": [0.5, 1.003e-7]}
BOTH, TRUE, FALSE = frozenset((True, False)), frozenset((True,)), frozenset((False,))


# ---------------------------------------------------------------- binary32 values
def f32(x):
    """Math.fround / Float32Array: double -> nearest binary32 (ties to even)."""
    return float(np.float32(x))


def _f32_neighbours(c):
    return float(np.nextafter(np.float32(c), np.float32(-np.inf))), float(np.nextafter(np.float32(c), np.float32(np.inf)))


def f32_down(fr):
    c = float(np.float32(float(fr)))
    while F(c) > fr:
        c = _f32_neighbours(c)[0]
    while F(_f32_neighbours(c)[1]) <= fr:
        c = _f32_neighbours(c)[1]
    return c


def f32_up(fr):
    c = float(np.float32(float(fr)))
    while F(c) < fr:
        c = _f32_neighbours(c)[1]
    while F(_f32_neighbours(c)[0]) >= fr:
        c = _f32_neighbours(c)[0]
    return c


def f32_nearest(fr):
    """correct rounding of an exact rational to binary32, ties to even."""
    lo, hi = f32_down(fr), f32_up(fr)
    if lo == hi:
        return lo
    dl, dh = fr - F(lo), F(hi) - fr
    if dl != dh:
        return lo if dl < dh else hi
    return lo if (int(np.float32(lo).view(np.uint32)) & 1) == 0 else hi


def js_string(x):
    """shortest round-trip decimal of a double (the generator's String(value))."""
    return repr(float(x))


def reps(x):
    """{'f32': Float32Array value, 'dec': correctly rounded binary32 of the printed literal}"""
    return {"f32": f32(x), "dec": f32_nearest(F(js_string(x)))}


# ---------------------------------------------------------------- outward-rounded intervals (model M)
class I:
    __slots__ = ("lo", "hi")

    def __init__(self, lo, hi=None):
        self.lo = F(lo)
        self.hi = F(lo if hi is None else hi)

    def __repr__(self):
        return "[%r, %r]" % (float(self.lo), float(self.hi))

    def contains(self, v):
        return self.lo <= F(v) <= self.hi


def rnd(lo, hi, ulps=0):
    """every binary32 result M allows for an exact value in [lo, hi]: outward to the binary32 grid, plus ulps steps, plus 0
    when denormals may be flushed."""
    a, b = f32_down(F(lo)), f32_up(F(hi))
    for _ in range(ulps):
        a, b = _f32_neighbours(a)[0], _f32_neighbours(b)[1]
    a, b = F(a), F(b)
    if a < MIN_NORMAL and b > -MIN_NORMAL:
        a, b = min(a, F(0)), max(b, F(0))
    return I(a, b)


def add(x, y):
    return rnd(x.lo + y.lo, x.hi + y.hi)


def sub(x, y):
    return rnd(x.lo - y.hi, x.hi - y.lo)


def _prod(x, y):
    p = [x.lo * y.lo, x.lo * y.hi, x.hi * y.lo, x.hi * y.hi]
    return min(p), max(p)


def mul(x, y):
    return rnd(*_prod(x, y))


def sqr(x):
    if x.lo >= 0:
        return rnd(x.lo * x.lo, x.hi * x.hi)
    if x.hi <= 0:
        return rnd(x.hi * x.hi, x.lo * x.lo)
    return rnd(0, max(x.lo * x.lo, x.hi * x.hi))


def div(x, y):
    if y.lo <= 0 <= y.hi:
        raise ZeroDivisionError("divisor interval contains 0")
    q = [x.lo / y.lo, x.lo / y.hi, x.hi / y.lo, x.hi / y.hi]
    return rnd(min(q), max(q), DIV_ULPS)


def _sqrt_down(fr):
    if fr <= 0:
        return F(0)
    s = F((Decimal(fr.numerator) / Decimal(fr.denominator)).sqrt())
    while s * s > fr:
        s -= abs(s) / 10 ** 70
    return s


def _sqrt_up(fr):
    if fr <= 0:
        return F(0)
    s = F((Decimal(fr.numerator) / Decimal(fr.denominator)).sqrt())
    while s * s < fr:
        s += abs(s) / 10 ** 70
    return s


def sqrt_iv(x):
    return rnd(_sqrt_down(max(x.lo, F(0))), _sqrt_up(max(x.hi, F(0))), LEN_ULPS)


def cst(v):
    """a binary32 constant or operand as M may see it: the value itself, or 0 if it is subnormal and flushed."""
    v = F(v)
    if v != 0 and abs(v) < MIN_NORMAL:
        return I(min(v, F(0)), max(v, F(0)))
    return I(v)


def hull(ivs):
    ivs = list(ivs)
    return I(min(x.lo for x in ivs), max(x.hi for x in ivs))


def sum_any_order(terms):
    """sum of terms in ANY association (revision 4, PREP-SOL-F01): every binary association tree over the terms is
    evaluated with an outward-rounded, flush-to-zero-aware add() at EVERY intermediate node, and the hull of all results
    is returned. Terms that are exactly 0 are dropped (adding an exact zero is exact); a term interval may contain 0 when a
    subnormal product may be flushed. A fused multiply-add skips the product's rounding; its exact product lies inside the
    term's outward-rounded interval, so it is covered."""
    t = [x for x in terms if not (x.lo == 0 and x.hi == 0)]
    if not t:
        return I(0)
    memo = {}

    def sums(idx):
        if idx in memo:
            return memo[idx]
        items = sorted(idx)
        if len(items) == 1:
            memo[idx] = t[items[0]]
            return memo[idx]
        first, rest = items[0], items[1:]
        out = []
        for mask in range(0, 1 << len(rest)):          # unordered split: the first index always goes left
            left = frozenset([first] + [rest[k] for k in range(len(rest)) if mask >> k & 1])
            right = idx - left
            if not right:
                continue
            out.append(add(sums(left), sums(right)))
        memo[idx] = hull(out)
        return memo[idx]
    return sums(frozenset(range(len(t))))


def cmp_le_iv(x, c):
    """x <= c for intervals"""
    return TRUE if x.hi <= c.lo else FALSE if x.lo > c.hi else BOTH


def cmp_lt_iv(x, y):
    return TRUE if x.hi < y.lo else FALSE if x.lo >= y.hi else BOTH


def cmp_ge_iv(x, c):
    return TRUE if x.lo >= c.hi else FALSE if x.hi < c.lo else BOTH


def cmp_le(x, c):
    return cmp_le_iv(x, I(c))


def b_and(a, b):
    return frozenset(p and q for p in a for q in b)


def b_or(a, b):
    return frozenset(p or q for p in a for q in b)


def b_xor(a, b):
    return frozenset(p != q for p in a for q in b)


def b_ne(a, b):
    return frozenset(p != q for p in a for q in b)


# ---------------------------------------------------------------- the shader expressions under M
def q_iv(proj, pos):
    """q = base + axes[0]*posIS.x + axes[1]*posIS.y + axes[2]*posIS.z (binary32 constants in proj), any association/FMA."""
    out = []
    for m in (0, 1):
        terms = [cst(proj["base"][m])] + [mul(cst(proj["axes"][k][m]), cst(pos[k])) for k in range(3)]
        out.append(sum_any_order(terms))
    return out


def bbox_set(q, b):
    B = [cst(v) for v in b]
    return b_and(b_and(cmp_ge_iv(q[0], B[0]), cmp_le_iv(q[0], B[1])), b_and(cmp_ge_iv(q[1], B[2]), cmp_le_iv(q[1], B[3])))


def edge_terms(q, a, e, cy, T, ee_min, crossing):
    A, E = [cst(a[0]), cst(a[1])], [cst(e[0]), cst(e[1])]
    d = [sub(q[0], A[0]), sub(q[1], A[1])]
    ee = add(sqr(E[0]), sqr(E[1]))
    den = I(max(ee.lo, ee_min), max(ee.hi, ee_min))
    dot_de = add(mul(d[0], E[0]), mul(d[1], E[1]))
    u0 = div(dot_de, den)
    u = I(min(max(u0.lo, F(0)), F(1)), min(max(u0.hi, F(0)), F(1)))
    r = [sub(d[0], mul(u, E[0])), sub(d[1], mul(u, E[1]))]
    dist = sqrt_iv(add(sqr(r[0]), sqr(r[1])))
    boundary = cmp_le(dist, T)
    par = FALSE
    if crossing:
        slab = b_ne(cmp_lt_iv(q[1], A[1]), cmp_lt_iv(q[1], cst(cy)))
        dy = sub(q[1], A[1])
        if E[1].lo <= 0 <= E[1].hi:
            raise ZeroDivisionError("crossing divisor e.y may be 0")
        r1 = add(A[0], div(mul(dy, E[0]), E[1]))                   # a.x + ((q.y - a.y) * e.x) / e.y
        r2 = add(A[0], mul(dy, div(E[0], E[1])))                   # a.x + (q.y - a.y) * (e.x / e.y)  (folded constant)
        rhs = I(min(r1.lo, r2.lo), max(r1.hi, r2.hi))
        par = b_and(slab, cmp_lt_iv(q[0], rhs))
    return boundary, par, dist


def decision_set(region, proj, pos, rep):
    """decisions M allows for 'q is in the region' in one shader with representation vector rep ('f32' or 'dec')."""
    P = {"base": [reps(v)[rep] for v in proj["base"]], "axes": [[reps(v)[rep] for v in ax] for ax in proj["axes"]]}
    q = q_iv(P, pos)
    b = region["bounds"]
    info = {"q": [repr(q[0]), repr(q[1])]}
    if region["kind"] == "Rectangle":
        return bbox_set(q, [reps(v)[rep] for v in b]), info
    if region["kind"] == "Ellipse":
        c = [reps((b[0] + b[1]) / 2)[rep], reps((b[2] + b[3]) / 2)[rep]]
        rr = [reps((b[1] - b[0]) / 2)[rep], reps((b[3] - b[2]) / 2)[rep]]
        w = [div(sub(q[0], cst(c[0])), cst(rr[0])), div(sub(q[1], cst(c[1])), cst(rr[1]))]
        f = add(sqr(w[0]), sqr(w[1]))
        info["f"] = repr(f)
        return cmp_le(f, F(1)), info
    T = F(reps(1e-7)[rep] if rep == "f32" else f32_nearest(F(T_TEXT)))
    ee_min = F(f32(1e-20) if rep == "f32" else f32_nearest(F(EE_MIN_TEXT)))
    pts = region["points"]
    n = len(pts)
    inbox = bbox_set(q, [reps(v)[rep] for v in b])
    boundary, parity, best = FALSE, FALSE, None
    for i in range(n):
        a, cpt = pts[(i - 1) % n], pts[i]
        e = [cpt[0] - a[0], cpt[1] - a[1]]
        A = [reps(a[0])[rep], reps(a[1])[rep]]
        E = [reps(e[0])[rep], reps(e[1])[rep]]
        cy = reps(cpt[1])[rep]
        bd, par, dist = edge_terms(q, A, E, cy, T, ee_min, abs(e[1]) > EDGE_EPS)
        boundary = b_or(boundary, bd)
        parity = b_xor(parity, par)
        if best is None or dist.lo < best[1].lo:
            best = (i, dist)
    info["nearest_edge"] = best[0]
    info["nearest_edge_distance"] = repr(best[1])
    info["threshold"] = float(T)
    return b_and(inbox, b_or(parity, boundary)), info


def classify(region, proj, pos):
    """inside-decision sets M allows: B-u = R_f32 only; old = R_f32 or R_dec (its literal parse is one of the two).
    in_band = a difference between old and B-u is possible at this point (some o in old_set, b in bu_set, o != b)."""
    s_f32, i_f32 = decision_set(region, proj, pos, "f32")
    s_dec, i_dec = decision_set(region, proj, pos, "dec")
    old_set, bu_set = s_f32 | s_dec, s_f32
    res = {"bu_set": sorted(bu_set), "old_set": sorted(old_set), "f32_set": sorted(s_f32), "dec_set": sorted(s_dec),
           "repr_differs": s_f32 != s_dec, "f32": i_f32, "dec": i_dec,
           "in_band": any(o != b for o in old_set for b in bu_set)}
    res["reason"] = ("model M admits a difference at this point" if res["in_band"] else
                     "model M admits only %s for old and %s for B-u: both shaders must decide alike" % (sorted(old_set), sorted(bu_set)))
    return res


def observed_inside(side, removed):
    """records store the REMOVAL decision (lab.js boundary(): pixel set = getColorForValue returned vec4(0)); a region with
    side Inside removes inside points, side Outside removes outside points."""
    if side not in ("Inside", "Outside") or not isinstance(removed, bool):
        raise ValueError("side %r / removal %r not interpretable" % (side, removed))
    return removed if side == "Inside" else not removed


def judge(region, proj, pos, side, old_removed, bu_removed):
    """approve a stored mismatch only if EACH observed decision lies in that shader's own allowed set (never the union)."""
    cl = classify(region, proj, pos)
    oi, bi = observed_inside(side, old_removed), observed_inside(side, bu_removed)
    cl["observed_inside"] = {"old": oi, "bu": bi}
    cl["old_observed_allowed"] = oi in cl["old_set"]
    cl["bu_observed_allowed"] = bi in cl["bu_set"]
    cl["approved"] = cl["old_observed_allowed"] and cl["bu_observed_allowed"] and oi != bi
    cl["reason"] = ("each observed decision lies in its own shader's allowed set" if cl["approved"] else
                    "observed old inside=%s (allowed %s), B-u inside=%s (allowed %s): not both inside their own sets" % (oi, cl["old_set"], bi, cl["bu_set"]))
    return cl


# ---------------------------------------------------------------- declared input range (o9-rule.md 4), checked BEFORE evaluation
PRODUCT_EPS, MAX_POINTS, MAX_COEF = 1e-9, 64, 1e6


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_input(region, proj, pos, side=None):
    """-> list of violated conditions (empty = inside the declared range). Mirrors the product's validRegion /
    validProjection (volume-sculpt.js) and adds posIS: three finite binary32 values in [0, 1]."""
    p = []
    if not (isinstance(pos, (list, tuple)) and len(pos) == 3 and all(_finite(v) for v in pos)):
        return ["posIS is not three finite numbers"]
    for i, v in enumerate(pos):
        if f32(v) != v:
            p.append("posIS[%d] = %r is not a binary32 value" % (i, v))
        if not 0 <= v <= 1:
            p.append("posIS[%d] = %r outside [0, 1]" % (i, v))
    if side is not None and side not in ("Inside", "Outside"):
        p.append("side %r" % (side,))
    sv = lambda v: isinstance(v, (list, tuple)) and len(v) == 2 and all(_finite(x) and abs(x) <= MAX_COEF for x in v)  # noqa: E731
    axes = proj.get("axes") if isinstance(proj, dict) else None
    if not isinstance(proj, dict) or not sv(proj.get("base")) or not (isinstance(axes, (list, tuple)) and len(axes) == 3 and all(sv(a) for a in axes)):
        p.append("projection base/axes are not finite 2-vectors within |1e6|")
    elif not any(axes[i][0] * axes[j][1] - axes[i][1] * axes[j][0] != 0 for i in range(3) for j in range(i + 1, 3)):
        p.append("projection is not rank 2")
    b = region.get("bounds") if isinstance(region, dict) else None
    if not (isinstance(b, (list, tuple)) and len(b) == 4 and all(_finite(x) for x in b)):
        return p + ["region bounds missing or not finite"]
    kind = region.get("kind")
    if kind in ("Rectangle", "Ellipse"):
        if not (b[0] >= 0 and b[1] <= 1 and b[2] >= 0 and b[3] <= 1 and b[1] - b[0] > PRODUCT_EPS and b[3] - b[2] > PRODUCT_EPS):
            p.append("%s bounds outside [0,1] or extent <= 1e-9" % kind)
    elif kind == "Polygon":
        pts = region.get("points")
        if not (isinstance(pts, (list, tuple)) and 3 <= len(pts) <= MAX_POINTS):
            return p + ["polygon needs 3..64 points"]
        if not all(isinstance(q, (list, tuple)) and len(q) == 2 and all(_finite(x) and 0 <= x <= 1 for x in q) for q in pts):
            p.append("polygon point outside [0,1]^2 or not finite")
        else:
            n = len(pts)
            area = sum(pts[(i - 1) % n][0] * pts[i][1] - pts[i][0] * pts[(i - 1) % n][1] for i in range(n)) / 2
            if abs(area) <= PRODUCT_EPS:
                p.append("polygon area <= 1e-9")
            xs, ys = [q[0] for q in pts], [q[1] for q in pts]
            if any(abs(a - c) > PRODUCT_EPS for a, c in zip([min(xs), max(xs), min(ys), max(ys)], b)):
                p.append("polygon bounds differ from its points by more than 1e-9")
    else:
        p.append("region kind %r" % (kind,))
    return p


# ---------------------------------------------------------------- exact reference values (information only)
def exact_q(proj, pos, rep="f32"):
    return [F(reps(proj["base"][m])[rep]) + sum((F(reps(proj["axes"][k][m])[rep]) * F(pos[k]) for k in range(3)), F(0)) for m in (0, 1)]


def seg_dist(q, a, e):
    dx, dy = q[0] - a[0], q[1] - a[1]
    ee = e[0] * e[0] + e[1] * e[1]
    t = min(max((dx * e[0] + dy * e[1]) / ee, F(0)), F(1)) if ee else F(0)
    rx, ry = dx - t * e[0], dy - t * e[1]
    return _sqrt_down(rx * rx + ry * ry)


# ---------------------------------------------------------------- binary32 emulation (independent of the interval code)
def r32(fr):
    return F(f32_nearest(F(fr)))


def _flush(v):
    return F(0) if v != 0 and abs(v) < MIN_NORMAL else v


EMU_MODES = ("seq", "fma", "rev", "seq-ftz", "fma-ftz", "rev-ftz")


def emulate(region, proj, pos, rep, mode):
    """one concrete binary32 evaluation of the shader: mode 'seq' (left to right, every op rounded), 'fma' (multiply-adds
    fused), 'rev' (q summed right to left, crossing rhs with the folded constant); the '-ftz' variants additionally flush
    every subnormal operand and result to zero (revision 4, PREP-SOL-F01)."""
    ftz = mode.endswith("-ftz")
    mode = mode[:-4] if ftz else mode
    R = (lambda x: _flush(r32(x))) if ftz else r32
    K = (lambda v: _flush(F(v))) if ftz else F
    P = {"base": [K(reps(v)[rep]) for v in proj["base"]], "axes": [[K(reps(v)[rep]) for v in ax] for ax in proj["axes"]]}
    X = [K(p) for p in pos]
    q = []
    for m in (0, 1):
        t = [P["axes"][k][m] * X[k] for k in range(3)]
        if mode == "seq":
            s = P["base"][m]
            for k in range(3):
                s = R(s + R(t[k]))
        elif mode == "fma":
            s = P["base"][m]
            for k in range(3):
                s = R(s + t[k])
        else:
            s = R(R(R(t[2]) + R(t[1])) + R(t[0]))
            s = R(s + P["base"][m])
        q.append(s)
    b = region["bounds"]
    B = [K(reps(v)[rep]) for v in b]
    inbox = q[0] >= B[0] and q[0] <= B[1] and q[1] >= B[2] and q[1] <= B[3]
    if region["kind"] == "Rectangle":
        return inbox
    if region["kind"] == "Ellipse":
        c = [K(reps((b[0] + b[1]) / 2)[rep]), K(reps((b[2] + b[3]) / 2)[rep])]
        rr = [K(reps((b[1] - b[0]) / 2)[rep]), K(reps((b[3] - b[2]) / 2)[rep])]
        w = [R(R(q[m] - c[m]) / rr[m]) for m in (0, 1)]
        f = R(R(w[0] * w[0]) + R(w[1] * w[1])) if mode != "fma" else R(w[0] * w[0] + R(w[1] * w[1]))
        return f <= 1
    T = F(reps(1e-7)[rep] if rep == "f32" else f32_nearest(F(T_TEXT)))
    ee_min = F(f32(1e-20) if rep == "f32" else f32_nearest(F(EE_MIN_TEXT)))
    pts = region["points"]
    n = len(pts)
    boundary = parity = False
    for i in range(n):
        a, cpt = pts[(i - 1) % n], pts[i]
        e = [cpt[0] - a[0], cpt[1] - a[1]]
        A = [K(reps(a[0])[rep]), K(reps(a[1])[rep])]
        E = [K(reps(e[0])[rep]), K(reps(e[1])[rep])]
        d = [R(q[0] - A[0]), R(q[1] - A[1])]
        if mode == "fma":
            ee = R(E[0] * E[0] + R(E[1] * E[1]))
            dde = R(d[0] * E[0] + R(d[1] * E[1]))
        else:
            ee = R(R(E[0] * E[0]) + R(E[1] * E[1]))
            dde = R(R(d[0] * E[0]) + R(d[1] * E[1]))
        u = min(max(R(dde / max(ee, ee_min)), F(0)), F(1))
        if mode == "fma":
            r = [R(d[m] - u * E[m]) for m in (0, 1)]
        else:
            r = [R(d[m] - R(u * E[m])) for m in (0, 1)]
        rr2 = R(R(r[0] * r[0]) + R(r[1] * r[1]))
        dist = R(_sqrt_down(rr2)) if rr2 > 0 else F(0)
        boundary = boundary or dist <= T
        if abs(e[1]) > EDGE_EPS:
            cy = K(reps(cpt[1])[rep])
            if (q[1] < A[1]) != (q[1] < cy):
                dy = R(q[1] - A[1])
                rhs = R(A[0] + R(dy * R(E[0] / E[1]))) if mode == "rev" else R(A[0] + R(R(dy * E[0]) / E[1]))
                if q[0] < rhs:
                    parity = not parity
    return inbox and (parity or boundary)


# ---------------------------------------------------------------- geometry of lab.js boundaryCases()
def polygon_region(points, bounds=None):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return {"kind": "Polygon", "points": [list(p) for p in points], "bounds": list(bounds) if bounds else [min(xs), max(xs), min(ys), max(ys)]}


IDENTITY = {"base": [0, 0], "axes": [[1, 0], [0, 1], [0, 0]]}


def pos_for(p, q, z):
    a, b = p["axes"][0], p["axes"][1]
    rx = q[0] - p["base"][0] - p["axes"][2][0] * z
    ry = q[1] - p["base"][1] - p["axes"][2][1] * z
    det = a[0] * b[1] - b[0] * a[1]
    return [f32((rx * b[1] - b[0] * ry) / det), f32((a[0] * ry - rx * a[1]) / det), f32(z)]


def q_of(p, pos):
    return [p["base"][m] + p["axes"][0][m] * pos[0] + p["axes"][1][m] * pos[1] + p["axes"][2][m] * pos[2] for m in (0, 1)]


def edge_queries(a, b, vertical):
    out, dx, dy = [], b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    n = [0, 1] if vertical else [-dy / ln, dx / ln]
    for i in range(48):
        t = (i + 0.5) / 48
        x, y = a[0] + dx * t, a[1] + dy * t
        for o in OFF:
            out.append(([x + o * n[0], y + o * n[1]], o))
    for v in (a, b):
        for ox in (-2e-7, -1e-7, 0, 1e-7, 2e-7):
            for oy in (-2e-7, -1e-7, 0, 1e-7, 2e-7):
                out.append(([v[0] + ox, v[1] + oy], "vertex"))
    return out


def boundary_cases():
    cases = [{"group": "fixture", "name": "R-001 S8-SPD-F02 exact fixture", "region": polygon_region(R001["points"], R001["bounds"]),
              "projection": IDENTITY, "z": 0, "queries": [(R001["q"], "r001-q")]}]
    ys = 2e-7
    for dy in DY:
        pts = [[0.1, ys], [0.9, ys + dy], [0.9, 0.8], [0, 0.8], [0, 0]]
        name = "dy=" + (repr(dy).replace("e-0", "e-") if dy else "0")
        cases.append({"group": "dy-sweep", "name": name, "region": polygon_region(pts), "projection": IDENTITY, "z": 0,
                      "queries": [(R001["q"], "r001-q-on-sweep")] + edge_queries(pts[0], pts[1], True)})
    c, s = math.cos(20 * math.pi / 180), math.sin(20 * math.pi / 180)
    rot = lambda p: [0.5 + c * (p[0] - 0.5) - s * (p[1] - 0.5) + 0.02, 0.5 + s * (p[0] - 0.5) + c * (p[1] - 0.5) - 0.01]  # noqa: E731
    pts = [rot(p) for p in [[0.2, 0.25], [0.8, 0.25], [0.8, 0.75], [0.2, 0.75], [0.2, 0.5]]]
    cases.append({"group": "general", "name": "rotated 20 deg + shifted polygon, identity projection", "region": polygon_region(pts),
                  "projection": IDENTITY, "z": 0, "queries": edge_queries(pts[0], pts[1], False) + edge_queries(pts[2], pts[3], False)})
    c, s = math.cos(15 * math.pi / 180), math.sin(15 * math.pi / 180)
    proj = {"base": [0.11, -0.04], "axes": [[0.9 * c, 0.9 * s], [-0.9 * s, 0.9 * c], [0.013, 0.021]]}
    pts = [[0.1, 0.3], [0.9, 0.3], [0.9, 0.8], [0.1, 0.8]]
    cases.append({"group": "general", "name": "axis-aligned polygon, non-identity projection (rot 15 deg, scale 0.9, z 0.37)", "region": polygon_region(pts),
                  "projection": proj, "z": 0.37, "queries": edge_queries(pts[0], pts[1], False) + edge_queries(pts[1], pts[2], False)})
    b = [0.1, 0.9, 0.2, 0.8]
    q = []
    sides = [[[b[0], b[2]], [b[1], b[2]]], [[b[1], b[2]], [b[1], b[3]]], [[b[1], b[3]], [b[0], b[3]]], [[b[0], b[3]], [b[0], b[2]]]]
    for a, e in sides:
        dx, dy = e[0] - a[0], e[1] - a[1]
        ln = math.hypot(dx, dy)
        n = [dy / ln, -dx / ln]
        for i in range(12):
            t = (i + 0.5) / 12
            for o in OFF:
                q.append(([a[0] + dx * t + o * n[0], a[1] + dy * t + o * n[1]], o))
    cases.append({"group": "general", "name": "rectangle [0.1,0.9]x[0.2,0.8]", "region": {"kind": "Rectangle", "bounds": b[:]}, "projection": IDENTITY, "z": 0, "queries": q})
    cx, cy, rx, ry, qe = 0.5, 0.5, 0.4, 0.3, []
    for i in range(48):
        th = 2 * math.pi * (i + 0.5) / 48
        bx, by, nx, ny = cx + rx * math.cos(th), cy + ry * math.sin(th), math.cos(th) / rx, math.sin(th) / ry
        ln = math.hypot(nx, ny)
        for o in OFF:
            qe.append(([bx + o * nx / ln, by + o * ny / ln], o))
    cases.append({"group": "general", "name": "ellipse in [0.1,0.9]x[0.2,0.8]", "region": {"kind": "Ellipse", "bounds": b[:]}, "projection": IDENTITY, "z": 0, "queries": qe})
    for k in cases:
        k["pos"] = [[f32(x[0][0]), f32(x[0][1]), 0.0] if k["projection"] is IDENTITY else pos_for(k["projection"], x[0], k["z"]) for x in k["queries"]]
    return cases


PINNED_TEXTS = {   # the modelled shader texts (PREP-SOL-F04 applied to what is rendered; see the module header)
    # sha256 of the UTF-8 of KinVolumeVrMasks.TEXT: the fixed replacement of the B-u prototype (lab/bu-masks.js, blob
    # cc0ba808, salt 0) that the rule's model and records were made with.
    "bu_sha256": "c2231aef5cb46ca4bd924e32e28b0d367b9a91d6641cbe4dcc1784f80a2c5772",
    # sha256 of the UTF-8 of JSON.stringify([...]) of shaderReplacement([{region, projection, side}]).replacementValue for
    # every rebuilt case x (Inside, Outside), in that order, from today's generator (volume-sculpt.js blob 5b29df3f = P).
    "old_sha256": "72a08cefd9af732022ca4e78f194ac080bbb9c4f0bc0173bde41b460ad066efa",
}


def check_texts(record):
    """-> problems. The record's rendered shader texts must be the pinned ones; a difference is drift."""
    texts = ((record or {}).get("boundary") or {}).get("shader_texts")
    if not isinstance(texts, dict):
        return ["record carries no shader_texts"]
    return ["shader text %s %r differs from the pinned %s" % (k, texts.get(k), v) for k, v in PINNED_TEXTS.items() if texts.get(k) != v]


# ---------------------------------------------------------------- record validation (PREP-SOL-F02/F03), before any classification
SIDES = ("Inside", "Outside")


def _proj_record(k):
    return "identity" if k["projection"] is IDENTITY else k["projection"]


def js_num_str(x):
    """ECMAScript Number::toString for a finite double (lab.js keys by_tag with String(tag))."""
    from decimal import Decimal as D
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    _s, digits, exp = D(repr(abs(float(x)))).normalize().as_tuple()
    ds = "".join(str(d) for d in digits)
    k, n = len(ds), exp + len(ds)
    if k <= n <= 21:
        return sign + ds + "0" * (n - k)
    if 0 < n <= 21:
        return sign + ds[:n] + "." + ds[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + ds
    e = n - 1
    es = ("+" if e > 0 else "-") + str(abs(e))
    return sign + (ds if k == 1 else ds[0] + "." + ds[1:]) + "e" + es


def tag_key(tag):
    return tag if isinstance(tag, str) else js_num_str(tag)


def _cnt(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def validate_record(j, cases):
    """-> list of problems; empty = the record is complete, consistent, error-free and its geometry is the rebuilt one.
    Revision 5 (PREP-SOL-F11..F13): fixture decisions, fixture.sides and agree_both_sides cross-checked; by_tag compared
    key by key (points from the rebuilt queries, old_vs_bu from the mismatch entries); per-group decisions; every count a
    non-negative integer."""
    from collections import Counter
    p = []
    bd = j.get("boundary") if isinstance(j, dict) else None
    if not isinstance(bd, dict):
        return ["no boundary block"]
    if bd.get("gl_error") != 0 or isinstance(bd.get("gl_error"), bool):
        p.append("gl_error = %r (must be 0)" % (bd.get("gl_error"),))
    cs = bd.get("cases")
    if not isinstance(cs, list):
        return p + ["cases missing"]
    by_name = {k["name"]: k for k in cases}
    want = {(k["name"], s) for k in cases for s in SIDES}
    seen, n_mis, n_pts, grp, fx_dec = [], 0, 0, {}, {}
    for c in cs:
        if not isinstance(c, dict):
            p.append("case entry is not an object")
            continue
        key = (c.get("case"), c.get("side"))
        seen.append(key)
        k = by_name.get(c.get("case"))
        if k is None or c.get("side") not in SIDES:
            p.append("unexpected case/side %r" % (key,))
            continue
        ms = c.get("mismatches")
        if not isinstance(ms, list):
            p.append("%r: mismatches missing" % (key,))
            continue
        if c.get("group") != k["group"] or c.get("region_kind") != k["region"]["kind"]:
            p.append("%r: group/region kind differ from the rebuilt case" % (key,))
        if c.get("projection") != _proj_record(k) or c.get("z") != k["z"]:
            p.append("%r: projection/z differ from the rebuilt case" % (key,))
        if "region" in c and c["region"] != k["region"]:
            p.append("%r: recorded region differs from the rebuilt case" % (key,))
        for f in ("points", "old_vs_bu_mismatches"):
            if not _cnt(c.get(f)):
                p.append("%r: %s is not a non-negative integer (%r)" % (key, f, c.get(f)))
        if c.get("points") != len(k["queries"]):
            p.append("%r: points %r, rebuilt queries %d" % (key, c.get("points"), len(k["queries"])))
        if c.get("old_vs_bu_mismatches") != len(ms):
            p.append("%r: old_vs_bu_mismatches %r but %d mismatch entries" % (key, c.get("old_vs_bu_mismatches"), len(ms)))
        good_ms = []
        for m in ms:
            if not (isinstance(m, dict) and all(x in m for x in ("pos", "q_double", "tag", "old", "bu")) and isinstance(m["old"], bool)
                    and isinstance(m["bu"], bool) and m["old"] != m["bu"] and isinstance(m["tag"], (str, int, float)) and not isinstance(m["tag"], bool)):
                p.append("%r: malformed mismatch entry %r" % (key, m))
            else:
                good_ms.append(m)
        # by_tag, key by key: points from the rebuilt queries, old_vs_bu from the mismatch entries
        exp_pts = Counter(tag_key(t) for _q, t in k["queries"])
        exp_mis = Counter(tag_key(m["tag"]) for m in good_ms)
        bt = c.get("by_tag")
        if not isinstance(bt, dict) or set(bt) != set(exp_pts):
            p.append("%r: by_tag keys differ from the rebuilt query tags" % (key,))
        else:
            for tg, v in bt.items():
                if not isinstance(v, dict) or not all(_cnt(x) for x in v.values()) or v.get("points") != exp_pts[tg] or v.get("old_vs_bu") != exp_mis.get(tg, 0):
                    p.append("%r: by_tag[%r] = %r, expected points %d / old_vs_bu %d" % (key, tg, v, exp_pts[tg], exp_mis.get(tg, 0)))
            if set(exp_mis) - set(exp_pts):
                p.append("%r: mismatch tags %s are not query tags of the case" % (key, sorted(set(exp_mis) - set(exp_pts))))
        if k["group"] == "fixture":
            dec = c.get("decision")
            if not (isinstance(dec, dict) and isinstance(dec.get("old"), bool) and isinstance(dec.get("bu"), bool)):
                p.append("%r: fixture decision missing or not boolean" % (key,))
            else:
                fx_dec[c["side"]] = {"old": dec["old"], "bu": dec["bu"]}
                if (dec["old"] != dec["bu"]) != (len(ms) == 1) or len(ms) > 1:
                    p.append("%r: fixture decision old=%r bu=%r contradicts its %d mismatch entries" % (key, dec["old"], dec["bu"], len(ms)))
                elif ms and (ms[0].get("old"), ms[0].get("bu")) != (dec["old"], dec["bu"]):
                    p.append("%r: fixture mismatch entry differs from the fixture decision" % (key,))
        n_mis += len(ms)
        n_pts += c.get("points") if _cnt(c.get("points")) else 0
        g = grp.setdefault(k["group"], [0, 0, 0])
        g[0] += len(ms)
        g[1] += 1
        g[2] += c.get("points") if _cnt(c.get("points")) else 0
    if sorted(seen, key=str) != sorted(want, key=str) or len(seen) != len(set(seen)):
        p.append("case/side set differs from the rebuilt cases x {Inside, Outside} (missing, extra or duplicate)")
    tot = bd.get("totals")
    if not isinstance(tot, dict):
        return p + ["totals missing"]
    if set(tot) != {"all"} | set(grp):
        p.append("totals groups %s differ from the case groups %s" % (sorted(tot), sorted({"all"} | set(grp))))
    for g, (mis, ncs, pts) in list(grp.items()) + [("all", (n_mis, len(cs), n_pts))]:
        tg = tot.get(g)
        if not isinstance(tg, dict) or not all(_cnt(v) for v in tg.values()):
            p.append("totals.%s missing or with a count that is not a non-negative integer" % g)
            continue
        if tg.get("old_vs_bu") != mis or tg.get("cases") != ncs or tg.get("decisions") != pts:
            p.append("totals.%s (old_vs_bu %r, cases %r, decisions %r) inconsistent with its case entries (%d, %d, %d)"
                     % (g, tg.get("old_vs_bu"), tg.get("cases"), tg.get("decisions"), mis, ncs, pts))
    fx = bd.get("fixture") or {}
    agree = fx.get("agree_both_sides")
    n_fx_cases = sum(1 for k in cases if k["group"] == "fixture")
    expect_agree = len(fx_dec) == 2 * n_fx_cases == 2 and all(d["old"] == d["bu"] for d in fx_dec.values())
    if not isinstance(agree, bool):
        p.append("fixture.agree_both_sides missing")
    elif agree != expect_agree:
        p.append("fixture.agree_both_sides = %r contradicts the fixture case decisions (expected %r)" % (agree, expect_agree))
    if n_fx_cases:
        sides = fx.get("sides")
        if not isinstance(sides, dict) or set(sides) != set(SIDES) or any(
                not isinstance(sides[s], dict) or (sides[s].get("old"), sides[s].get("bu")) != (fx_dec.get(s, {}).get("old"), fx_dec.get(s, {}).get("bu")) for s in SIDES):
            p.append("fixture.sides missing or different from the fixture case decisions")
    status = "failed" if (n_mis or bd.get("gl_error") or agree is not True) else "ok"
    if bd.get("status") != status:
        p.append("boundary status %r, expected %r from its own contents" % (bd.get("status"), status))
    if j.get("exit_code") != (1 if status == "failed" else 0) or j.get("status") != ("failed" if status == "failed" else "complete"):
        p.append("run status/exit %r/%r inconsistent with the boundary result" % (j.get("status"), j.get("exit_code")))
    return p


# ---------------------------------------------------------------- verify
def verify(records, cases=None):
    cases = cases or boundary_cases()
    by_name = {k["name"]: k for k in cases}
    from collections import Counter
    out = {"records": [], "totals": {"records": 0, "invalid_records": 0, "fixture_disagree": 0, "mismatches": 0, "in_band": 0, "out_of_band": 0, "out_of_range": 0,
                                     "unverified": 0, "repr_differs": 0, "drift": 0}}
    for path, j in records:
        out["totals"]["records"] += 1
        r = {"record": path, "renderer": ((j or {}).get("boundary") or {}).get("renderer"), "record_problems": validate_record(j, cases),
             "drift": check_texts(j), "mismatches": 0, "in_band": 0, "out_of_band": [], "out_of_range": [], "unverified": [], "rows": []}
        out["totals"]["drift"] += 1 if r["drift"] else 0
        if r["record_problems"]:                     # incomplete, contradictory or errored: nothing in it is classified
            out["totals"]["invalid_records"] += 1
            out["records"].append(r)
            continue
        if any(k["group"] == "fixture" for k in cases) and j["boundary"]["fixture"]["agree_both_sides"] is not True:
            r["fixture_disagrees"] = True              # the order draft's condition: R-001's fixture agrees on both sides
            out["totals"]["fixture_disagree"] += 1
        for c in j["boundary"]["cases"]:
            k = by_name[c["case"]]
            # PREP-SOL-F13: each rebuilt query occurrence of this case/side can be consumed once (a multiset)
            avail = Counter((tuple(pz), tag_key(k["queries"][qi][1])) for qi, pz in enumerate(k["pos"]))
            for m in c["mismatches"]:
                r["mismatches"] += 1
                row = {"case": c["case"], "side": c["side"], "tag": m["tag"], "pos": m["pos"], "old": m["old"], "bu": m["bu"]}
                key = (tuple(m["pos"]) if isinstance(m["pos"], list) else None, tag_key(m["tag"]))
                ok = key[0] is not None and avail[key] > 0 and q_of(k["projection"], list(m["pos"])) == list(m["q_double"])
                if ok:
                    avail[key] -= 1
                if not ok:
                    row.update(status="unverified", reason="the recorded pos/q do not match an unused rebuilt query occurrence of the case/side")
                    r["unverified"].append(row)
                    r["rows"].append(row)
                    continue
                region, proj = k["region"], k["projection"]          # verified, rebuilt geometry only (never the record's)
                bad_in = validate_input(region, proj, m["pos"], c["side"])
                if bad_in:
                    row.update(status="out-of-range", reason="; ".join(bad_in))
                    r["out_of_range"].append(row)
                    r["rows"].append(row)
                    continue
                try:
                    cl = judge(region, proj, m["pos"], c["side"], m["old"], m["bu"])
                except (ZeroDivisionError, ValueError, OverflowError) as ex:
                    row.update(status="unverified", reason="evaluation failed on an input inside the declared range: %r" % ex)
                    r["unverified"].append(row)
                    r["rows"].append(row)
                    continue
                if region["kind"] == "Polygon":
                    q = exact_q(proj, m["pos"])
                    pts = region["points"]
                    row["dist_star_min_edge"] = float(min(seg_dist(q, [F(f32(pts[i - 1][0])), F(f32(pts[i - 1][1]))],
                                                                      [F(f32(pts[i][0] - pts[i - 1][0])), F(f32(pts[i][1] - pts[i - 1][1]))]) for i in range(len(pts))))
                row.update(cl)
                row["status"] = "in-band" if cl["approved"] else "out-of-band"
                out["totals"]["repr_differs"] += 1 if cl["repr_differs"] else 0
                if cl["approved"]:
                    r["in_band"] += 1
                else:
                    r["out_of_band"].append(row)
                r["rows"].append(row)
        for k2 in ("mismatches", "in_band"):
            out["totals"][k2] += r[k2]
        for k2 in ("out_of_band", "out_of_range", "unverified"):
            out["totals"][k2] += len(r[k2])
        out["records"].append(r)
    t = out["totals"]
    out["rule_pass"] = (t["records"] > 0 and t["invalid_records"] == 0 and t["fixture_disagree"] == 0 and t["mismatches"] == t["in_band"]
                        and t["out_of_band"] == 0 and t["out_of_range"] == 0 and t["unverified"] == 0 and t["drift"] == 0)
    return out


def accepted(result):
    """BU-T02 / acceptance threshold 1: rule_pass AND 0 out-of-range (the same condition as the approved verifier)."""
    return bool(result.get("rule_pass")) and result["totals"]["out_of_range"] == 0


def synth_record(cases, mis=None):
    """a complete, self-consistent boundary record for the given cases (selftest only): mis = {(name, side): [mismatch,...]}.
    Fixture cases get decisions consistent with their mismatch entries; fixture.sides and agree_both_sides follow lab.js."""
    from collections import Counter
    mis = mis or {}
    cs, tot, fx = [], {"all": {"cases": 0, "decisions": 0, "old_vs_bu": 0}}, {}
    for k in cases:
        for s in SIDES:
            ms = mis.get((k["name"], s), [])
            pts = Counter(tag_key(t) for _q, t in k["queries"])
            mm = Counter(tag_key(m["tag"]) for m in ms)
            by_tag = {tg: {"points": n, "old_vs_bu": mm.get(tg, 0)} for tg, n in pts.items()}
            c = {"group": k["group"], "case": k["name"], "side": s, "region_kind": k["region"]["kind"], "projection": _proj_record(k),
                 "z": k["z"], "points": len(k["queries"]), "old_vs_bu_mismatches": len(ms), "by_tag": by_tag, "mismatches": ms}
            if k["group"] == "fixture":
                c["decision"] = {"old": ms[0]["old"], "bu": ms[0]["bu"], "js_double": ms[0]["old"]} if ms else {"old": False, "bu": False, "js_double": False}
                fx[s] = c["decision"]
            cs.append(c)
            for g in ("all", k["group"]):
                tt = tot.setdefault(g, {"cases": 0, "decisions": 0, "old_vs_bu": 0})
                tt["cases"] += 1
                tt["decisions"] += len(k["queries"])
                tt["old_vs_bu"] += len(ms)
    n = tot["all"]["old_vs_bu"]
    agree = len(fx) == 2 and all(d["old"] == d["bu"] for d in fx.values())
    failed = bool(n) or not agree
    return {"status": "failed" if failed else "complete", "exit_code": 1 if failed else 0,
            "boundary": {"renderer": "synthetic", "cases": cs, "totals": tot, "gl_error": 0, "fixture": {"sides": fx, "agree_both_sides": agree},
                         "status": "failed" if failed else "ok", "shader_texts": dict(PINNED_TEXTS)}}


# ---------------------------------------------------------------- selftest
def _raises(fn):
    try:
        fn()
    except (ValueError, TypeError):
        return True
    return False


def selftest(fuzz_n=3000, seed=20261004, records=None):
    checks = []

    def chk(name, ok, **detail):
        checks.append({"check": name, "ok": bool(ok), **{k: (repr(v) if isinstance(v, (F, I)) else v) for k, v in detail.items()}})

    def emu_ok(reg, pjx, pos, cl):
        """each representation's binary32 emulations against THAT representation's own set (never the union)."""
        out = {}
        for rp, key in (("f32", "f32_set"), ("dec", "dec_set")):
            for m in EMU_MODES:
                v = emulate(reg, pjx, pos, rp, m)
                out["%s/%s" % (rp, m)] = v
                if v not in cl[key]:
                    return False, out
        return True, out

    def valid(reg, pjx, pos, nm):
        bad = validate_input(reg, pjx, pos)
        if bad:
            chk("fixture %s is inside the declared range" % nm, False, problems=bad)
        return not bad

    # --- PREP-F01: ellipse under a 1e6 projection (Astra's counter-example), and f* = 0
    ell = {"kind": "Ellipse", "bounds": [0.499, 0.501, 0.499, 0.501]}
    pj = {"base": [0.5, 0], "axes": [[1000000, 0], [-1000000, 0], [0, 1]]}
    for z, name in ((0.5000000596046448, "Astra pos"), (0.5, "pos.z = 0.5 (f* = 0)")):
        pos = [f32(0.1), f32(0.1), z]
        if not valid(ell, pj, pos, name):
            continue
        try:
            cl = classify(ell, pj, pos)
            ok, emu = emu_ok(ell, pj, pos, cl)
            chk("F01 ellipse %s: no exception, every binary32 emulation inside its own representation's set, a difference possible" % name,
                ok and cl["in_band"], emulated=emu, f32_set=cl["f32_set"], dec_set=cl["dec_set"], q=cl["f32"]["q"], f=cl["f32"].get("f"))
        except Exception as ex:  # noqa: BLE001  (reported as a failed check, never skipped)
            chk("F01 ellipse %s: no exception" % name, False, error=repr(ex))
    x32 = F(f32(0.1))
    q_seq = r32(r32(r32(F(1) / 2 + r32(1000000 * x32)) - r32(1000000 * x32)) + r32(0 * F(0.5000000596046448)))
    q_fma = r32(r32(F(1) / 2 + r32(1000000 * x32)) + F(-1000000) * x32)
    qx = q_iv({"base": [0.5, 0], "axes": [[1000000.0, 0.0], [-1000000.0, 0.0], [0.0, 1.0]]}, [f32(0.1), f32(0.1), 0.5000000596046448])[0]
    chk("F01 q.x interval contains the sequential (0.5) and fused (0.49850988388061523) results", qx.contains(q_seq) and qx.contains(q_fma) and float(q_fma) == 0.49850988388061523,
        q_seq=float(q_seq), q_fma=float(q_fma), interval=repr(qx))
    small = {"kind": "Ellipse", "bounds": [0.5, 0.5 + 2e-9, 0.5, 0.5 + 2e-9]}
    for nm, reg, pjx, pos in (("centre", {"kind": "Ellipse", "bounds": [0.1, 0.9, 0.2, 0.8]}, IDENTITY, [0.5, 0.5, 0.0]),
                              ("near centre", {"kind": "Ellipse", "bounds": [0.1, 0.9, 0.2, 0.8]}, IDENTITY, [f32(0.5 + 1e-7), 0.5, 0.0]),
                              ("minimum-size ellipse", small, IDENTITY, [f32(0.5 + 1e-9), f32(0.5 + 1e-9), 0.0]),
                              ("cancellation, axes +-1e6", ell, pj, [f32(0.3), f32(0.3), 0.5])):
        if not valid(reg, pjx, pos, nm):
            continue
        cl = classify(reg, pjx, pos)
        ok, emu = emu_ok(reg, pjx, pos, cl)
        chk("F01 %s: emulations inside their own representation's set" % nm, ok, emulated=emu, f32_set=cl["f32_set"], dec_set=cl["dec_set"])

    # --- PREP-F02: rectangle bound whose literal and Float32Array roundings differ
    bnd = 0.10000002011656761
    r = reps(bnd)
    chk("F02 printed literal is '0.10000002011656761'", js_string(bnd) == "0.10000002011656761", literal=js_string(bnd))
    chk("F02 literal -> binary32 = 0.10000001639127731, Float32Array = 0.10000002384185791", r["dec"] == 0.10000001639127731 and r["f32"] == 0.10000002384185791, reps=r)
    rect = {"kind": "Rectangle", "bounds": [bnd, 0.9, 0.2, 0.8]}
    p02 = [0.10000001639127731, 0.5, 0.0]
    valid(rect, IDENTITY, p02, "F02 rectangle")
    cl = classify(rect, IDENTITY, p02)
    chk("F02 rectangle: B-u (Float32Array) certainly outside, old (literal or Float32Array) either -> a difference is possible",
        cl["in_band"] and cl["repr_differs"] and cl["bu_set"] == [False] and cl["old_set"] == [False, True], bu_set=cl["bu_set"], old_set=cl["old_set"])
    poly = polygon_region([[bnd, 0.2], [0.9, 0.2], [0.9, 0.8], [bnd, 0.8]])
    valid(poly, IDENTITY, p02, "F02 polygon")
    clp = classify(poly, IDENTITY, p02)
    chk("F02 polygon bounding box with opposite roundings is not 'certain' for old", clp["in_band"], bu_set=clp["bu_set"], old_set=clp["old_set"])
    rect2 = {"kind": "Rectangle", "bounds": [0.1, 0.9, 0.2, 0.8]}
    cl2 = classify(rect2, IDENTITY, [f32(0.1), 0.5, 0.0])
    chk("F02 identity input with equal representations keeps the exact comparison (no difference allowed)", not cl2["in_band"] and reps(0.1)["f32"] == reps(0.1)["dec"], old_set=cl2["old_set"])

    # --- PREP-F06: each observed decision against its own shader's set, side-normalised (records store REMOVAL)
    for side, old_rm, bu_rm, want in (("Inside", True, False, True), ("Inside", False, True, False),
                                      ("Outside", False, True, True), ("Outside", True, False, False)):
        j6 = judge(rect, IDENTITY, p02, side, old_rm, bu_rm)
        chk("F06 rectangle fixture side %s, removed old=%s bu=%s: %s" % (side, old_rm, bu_rm, "approved" if want else "rejected (B-u observed outside its set)"),
            j6["approved"] == want, observed_inside=j6["observed_inside"], old_set=j6["old_set"], bu_set=j6["bu_set"])
    rect_case = {"name": "F06 rectangle fixture", "group": "general", "region": rect, "projection": IDENTITY, "z": 0, "queries": [(p02[:2], "f06")], "pos": [p02]}
    for side, old_rm, bu_rm, want in (("Inside", True, False, True), ("Inside", False, True, False), ("Outside", False, True, True), ("Outside", True, False, False)):
        rec = synth_record([rect_case], {("F06 rectangle fixture", side): [{"pos": p02, "q_double": q_of(IDENTITY, p02), "tag": "f06", "old": old_rm, "bu": bu_rm}]})
        v6 = verify([("f06", rec)], [rect_case])
        chk("F06 verify(): side %s removed old=%s bu=%s -> rule %s" % (side, old_rm, bu_rm, "PASS" if want else "FAIL"), v6["rule_pass"] == want, totals=v6["totals"])
    chk("F06 a removal value that is not boolean is not interpreted", _raises(lambda: observed_inside("Inside", 1)) and _raises(lambda: observed_inside("Up", True)))

    # --- PREP-F07: the declared input range is checked before evaluation
    cases = boundary_cases()
    nonid = [k for k in cases if k["name"].startswith("axis-aligned polygon, non-identity projection")][0]
    i7 = [i for i, (qq, tg) in enumerate(nonid["queries"]) if tg == -3e-7 and nonid["pos"][i][0] > 1][0]
    p7 = nonid["pos"][i7]
    rec7 = synth_record(cases, {(nonid["name"], "Inside"): [{"pos": p7, "q_double": q_of(nonid["projection"], p7), "tag": -3e-7, "old": False, "bu": True}]})
    v7 = verify([("f07", rec7)])
    chk("F07 default sweep sample with posIS.x = %r is out-of-range and fails the rule" % p7[0], v7["totals"]["out_of_range"] == 1 and not v7["rule_pass"], totals=v7["totals"])
    one_up = float(np.nextafter(np.float32(1), np.float32(2)))
    zero_dn = float(np.nextafter(np.float32(0), np.float32(-1)))
    sq = {"kind": "Rectangle", "bounds": [0.1, 0.9, 0.2, 0.8]}
    for nm, reg, pjx, pos, want_ok in (
            ("pos 0 and 1", sq, IDENTITY, [0.0, 1.0, 0.0], True),
            ("pos just above 1", sq, IDENTITY, [one_up, 0.5, 0.0], False),
            ("pos just below 0", sq, IDENTITY, [0.5, zero_dn, 0.0], False),
            ("pos NaN", sq, IDENTITY, [float("nan"), 0.5, 0.0], False),
            ("pos infinite", sq, IDENTITY, [float("inf"), 0.5, 0.0], False),
            ("pos not binary32 (0.1 double)", sq, IDENTITY, [0.1, 0.5, 0.0], False),
            ("polygon with 2 points", {"kind": "Polygon", "points": [[0.1, 0.1], [0.9, 0.9]], "bounds": [0.1, 0.9, 0.1, 0.9]}, IDENTITY, [0.5, 0.5, 0.0], False),
            ("polygon point 1.1", polygon_region([[0.1, 0.1], [1.1, 0.1], [0.5, 0.9]]), IDENTITY, [0.5, 0.5, 0.0], False),
            ("polygon bounds inconsistent", {"kind": "Polygon", "points": [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], "bounds": [0.1, 0.8, 0.1, 0.9]}, IDENTITY, [0.5, 0.5, 0.0], False),
            ("polygon area 0", polygon_region([[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]), IDENTITY, [0.5, 0.5, 0.0], False),
            ("rectangle extent 1e-10", {"kind": "Rectangle", "bounds": [0.5, 0.5 + 1e-10, 0.2, 0.8]}, IDENTITY, [0.5, 0.5, 0.0], False),
            ("projection rank 1", sq, {"base": [0, 0], "axes": [[1, 0], [2, 0], [3, 0]]}, [0.5, 0.5, 0.0], False),
            ("projection coefficient 2e6", sq, {"base": [0, 0], "axes": [[2e6, 0], [0, 1], [0, 0]]}, [0.5, 0.5, 0.0], False),
            ("unknown region kind", {"kind": "Circle", "bounds": [0.1, 0.9, 0.2, 0.8]}, IDENTITY, [0.5, 0.5, 0.0], False)):
        bad = validate_input(reg, pjx, pos, "Inside")
        chk("F07 %s: %s" % (nm, "accepted" if want_ok else "refused before evaluation"), (not bad) == want_ok, problems=bad)

    # --- PREP-F03: edges shorter than sqrt(1e-20), a zero-length edge, ee on both sides of 1e-20
    tiny = polygon_region([[0, 0], [5e-11, 0], [1, 0], [1, 1], [0, 1]], [0, 1, 0, 1])
    pos = [f32(2.5e-11), 0.0, 0.0]
    valid(tiny, IDENTITY, pos, "F03 5e-11 edge")
    a, e = [F(0), F(0)], [F(f32(5e-11)), F(0)]
    d = [r32(F(pos[0]) - a[0]), F(0)]
    ee = r32(r32(e[0] * e[0]) + 0)
    u = min(max(r32(r32(d[0] * e[0]) / max(ee, F(f32(1e-20)))), F(0)), F(1))
    dist = r32(_sqrt_down(r32(r32(d[0] - r32(u * e[0])) ** 2)))
    q = q_iv(IDENTITY, pos)
    _bd, _par, dist_iv = edge_terms(q, [0.0, 0.0], [f32(5e-11), 0.0], 0.0, F(f32(1e-7)), F(f32(1e-20)), False)
    chk("F03 guarded expression: ee = 2.5000001e-21, u = 0.12500001, distance = 1.87499998e-11 lie in the interval evaluation",
        abs(float(ee) - 2.500000122612198e-21) < 1e-30 and abs(float(u) - 0.1250000149011612) < 1e-15 and dist_iv.contains(dist),
        ee=float(ee), u=float(u), distance=float(dist), interval=repr(dist_iv))
    clt = classify(tiny, IDENTITY, pos)
    chk("F03 point on a 5e-11 edge: boundary certain -> no difference allowed", not clt["in_band"], old_set=clt["old_set"])
    zero = polygon_region([[0.2, 0.2], [0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]])
    for nm, pz in (("zero-length edge, point at its vertex", [f32(0.2), f32(0.2), 0.0]), ("zero-length edge, point 1e-7 away", [f32(0.2), f32(0.2 - 1e-7), 0.0])):
        if not valid(zero, IDENTITY, pz, nm):
            continue
        clz = classify(zero, IDENTITY, pz)
        ok, emu = emu_ok(zero, IDENTITY, pz, clz)
        chk("F03 %s: no exception, emulations inside their own representation's set" % nm, ok, emulated=emu)
    for L in (9e-11, 1e-10, 1.1e-10):     # ee = L^2 below, at and above 1e-20
        pg = polygon_region([[0.3, 0.3], [0.3 + L, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]])
        for pz in ([f32(0.3 + L / 2), f32(0.3 - 1e-7), 0.0], [f32(0.3 + L / 2), f32(0.3 - 2e-7), 0.0]):
            if not valid(pg, IDENTITY, pz, "F03 L=%g" % L):
                continue
            clg = classify(pg, IDENTITY, pz)
            ok, emu = emu_ok(pg, IDENTITY, pz, clg)
            chk("F03 edge length %g (ee %s 1e-20), point %.1e below: emulations inside their own representation's set" % (L, "<" if L * L < 1e-20 else ">=", 0.3 - pz[1]), ok, emulated=emu)
    chk("threshold literals 1e-7 and 1e-20 parse to the same binary32 either way", reps(1e-7)["f32"] == reps(1e-7)["dec"] == f32_nearest(F(T_TEXT)) and reps(1e-20)["f32"] == f32_nearest(F(EE_MIN_TEXT)),
        t=reps(1e-7), ee_min=reps(1e-20))

    # --- R3-F01 (Astra) and fabricated records
    dyc = [k for k in cases if k["name"] == "dy=1e-7"][0]
    cla = classify(dyc["region"], IDENTITY, [0.8083333373069763, 1.8854166228265967e-7, 0.0])
    chk("R3-F01 point: a difference is possible", cla["in_band"], old_set=cla["old_set"], bu_set=cla["bu_set"])
    far = classify(dyc["region"], IDENTITY, [f32(0.5), f32(0.4), 0.0])
    chk("interior point far from every edge: certain (no difference allowed)", not far["in_band"], old_set=far["old_set"])
    k = [k for k in cases if k["name"] == "dy=0"][0]
    i_far = [i for i, x in enumerate(k["queries"]) if x[1] == 1e-6][0]
    i_near = [i for i, x in enumerate(k["queries"]) if x[1] == -1e-7][0]
    mm = lambda i: {"pos": k["pos"][i], "q_double": q_of(IDENTITY, k["pos"][i]), "tag": k["queries"][i][1], "old": False, "bu": True}  # noqa: E731
    v_far = verify([("far", synth_record(cases, {("dy=0", "Inside"): [mm(i_far)]}))], cases)
    chk("fabricated far mismatch in a complete record fails the rule (out-of-band)", not v_far["rule_pass"] and v_far["totals"]["out_of_band"] == 1, totals=v_far["totals"])
    chk("fabricated mismatch at tag -1e-7 in a complete record passes the rule", verify([("near", synth_record(cases, {("dy=0", "Inside"): [mm(i_near)]}))], cases)["rule_pass"])
    bad = synth_record(cases, {("dy=0", "Inside"): [{"pos": [0.123, 0.456, 0.0], "q_double": [0.123, 0.456], "tag": -1e-7, "old": False, "bu": True}]})
    chk("unmatched mismatch is unverified and fails", not verify([("bad", bad)], cases)["rule_pass"])

    # --- PREP-SOL-F01: rounding and flush-to-zero of every intermediate sum, in every association order
    N = 2.0 ** -126
    sol_rect = {"kind": "Rectangle", "bounds": [2.125 * N, 0.9, 0.2, 0.8]}
    sol_pj = {"base": [1.25 * N, 0], "axes": [[-N, 0], [2 * N, 0.5], [0, 0]]}
    sol_pos = [1.0, 1.0, 0.0]
    chk("SOL-F01 counter-example is inside the declared range", not validate_input(sol_rect, sol_pj, sol_pos, "Inside"), problems=validate_input(sol_rect, sol_pj, sol_pos, "Inside"))
    qx = q_iv(sol_pj, sol_pos)[0]
    chk("SOL-F01 q.x interval contains the flushed sequential result 2N and the reassociated 2.25N", qx.contains(2 * N) and qx.contains(2.25 * N), interval=repr(qx))
    js = judge(sol_rect, sol_pj, sol_pos, "Inside", True, False)
    chk("SOL-F01 judge(Inside, old removed, B-u kept) approved: both decisions are model-M results", js["approved"], old_set=js["old_set"], bu_set=js["bu_set"])
    ok, emu = emu_ok(sol_rect, sol_pj, sol_pos, classify(sol_rect, sol_pj, sol_pos))
    chk("SOL-F01 every emulation (incl. flush-to-zero orders) inside its own representation's set", ok and emu["f32/seq-ftz"] is False, emulated=emu)
    rng_t = random.Random(seed + 1)
    trans_fail, trans_n, trans_refused = [], 0, 0
    for _ in range(400):                        # subnormal <-> normal transitions of intermediate sums
        mult = lambda: rng_t.choice([-3, -2.5, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.25, 3])  # noqa: E731
        reg = {"kind": "Rectangle", "bounds": [abs(mult()) * N, 0.9, 0.2, 0.8]}
        pj = {"base": [mult() * N, 0], "axes": [[mult() * N, 0], [mult() * N, 0.5], [rng_t.choice([0, mult() * N]), 0]]}
        pz = [rng_t.choice([1.0, 0.5, 0.25, f32(rng_t.random())]), rng_t.choice([1.0, 0.5, f32(rng_t.random())]), rng_t.choice([0.0, 1.0, 0.5])]
        if validate_input(reg, pj, pz, "Inside"):
            trans_refused += 1                      # counted and reported, not silently skipped
            continue
        trans_n += 1
        cl_t = classify(reg, pj, pz)
        ok_t, emu_t = emu_ok(reg, pj, pz, cl_t)
        if not ok_t:
            trans_fail.append({"region": reg, "projection": pj, "pos": pz, "emulated": emu_t, "f32_set": cl_t["f32_set"], "dec_set": cl_t["dec_set"]})
    chk("SOL-F01 %d subnormal/normal transition inputs (%d generated outside the declared range refused and counted): every emulation (6 orders incl. flush-to-zero) inside its own set" % (trans_n, trans_refused),
        trans_n >= 300 and trans_n + trans_refused == 400 and not trans_fail, failures=trans_fail[:3], refused=trans_refused)

    # --- PREP-SOL-F02/F03: the whole record is validated before anything in it is classified
    base_far = synth_record(cases, {("dy=0", "Inside"): [mm(i_far)]})
    import copy as _copy
    t_reg = _copy.deepcopy(base_far)
    c0 = [c for c in t_reg["boundary"]["cases"] if c["case"] == "dy=0" and c["side"] == "Inside"][0]
    c0["region"] = {"kind": "Polygon", "points": [[0.1, 1.3000000424450262e-6], [0.9, 1.3000000424450262e-6], [0.9, 0.8], [0, 0.8], [0, 0]], "bounds": [0, 0.9, 0, 0.8]}
    v = verify([("tampered region", t_reg)], cases)
    chk("SOL-F02 recorded region differing from the rebuilt case: record invalid, nothing approved", not v["rule_pass"] and v["totals"]["invalid_records"] == 1 and v["totals"]["in_band"] == 0, problems=v["records"][0]["record_problems"][:3])
    t_pj = _copy.deepcopy(base_far)
    c1 = [c for c in t_pj["boundary"]["cases"] if c["case"] == "axis-aligned polygon, non-identity projection (rot 15 deg, scale 0.9, z 0.37)"][0]
    c1["projection"] = {"base": [99, 99], "axes": c1["projection"]["axes"]}
    v = verify([("tampered projection", t_pj)], cases)
    chk("SOL-F02 recorded projection base [99,99]: record invalid", not v["rule_pass"] and v["totals"]["invalid_records"] == 1, problems=v["records"][0]["record_problems"][:3])
    t_id = _copy.deepcopy(base_far)
    [c for c in t_id["boundary"]["cases"] if c["case"] == "dy=0"][0]["projection"] = {"base": [99, 99], "axes": [[1, 0], [0, 1], [0, 0]]}
    chk("SOL-F02 identity case recorded with another projection: record invalid", not verify([("x", t_id)], cases)["rule_pass"])
    if records:
        for rpath, rj in records:
            nm = os.path.basename(os.path.dirname(rpath))
            v0 = verify([(rpath, rj)], cases)
            chk("SOL-F03 the stored record %s is complete and consistent (no record problem)" % nm, v0["totals"]["invalid_records"] == 0, problems=v0["records"][0]["record_problems"][:3])
            for label, mut in (("cases = []", lambda b: b.__setitem__("cases", [])),
                               ("every mismatches array emptied (totals still non-zero)", lambda b: [c.__setitem__("mismatches", []) for c in b["cases"]]),
                               ("gl_error = 1282", lambda b: b.__setitem__("gl_error", 1282)),
                               ("one case/side removed", lambda b: b["cases"].pop()),
                               ("a case duplicated", lambda b: b["cases"].append(_copy.deepcopy(b["cases"][0]))),
                               ("points of a case changed", lambda b: b["cases"][0].__setitem__("points", b["cases"][0]["points"] + 1)),
                               ("totals.all.old_vs_bu changed", lambda b: b["totals"]["all"].__setitem__("old_vs_bu", b["totals"]["all"]["old_vs_bu"] + 1)),
                               ("status changed to ok", lambda b: b.__setitem__("status", "ok"))):
                tj = _copy.deepcopy(rj)
                mut(tj["boundary"])
                vt = verify([(rpath, tj)], cases)
                chk("SOL-F03 %s: %s -> record invalid, rule FAIL" % (nm, label), not vt["rule_pass"] and vt["totals"]["invalid_records"] == 1)
    else:
        chk("SOL-F03 stored records supplied to the self-test (--record)", False)
    # --- PREP-SOL-F11/F12/F13: fixture consistency, per-tag/per-group tallies, multiset consumption of queries
    if records:
        rpath, rj = records[0]
        nm = os.path.basename(os.path.dirname(rpath))

        def mutated(fn):
            tj = _copy.deepcopy(rj)
            fn(tj["boundary"])
            return verify([(rpath, tj)], cases)

        def flip_fixture_bu(b):
            for c in b["cases"]:
                if c["group"] == "fixture":
                    c["decision"]["bu"] = not c["decision"]["old"]

        def move_point(b):
            c = [c for c in b["cases"] if len(c["by_tag"]) >= 2][0]
            ks = sorted(c["by_tag"])
            c["by_tag"][ks[0]]["points"] -= 1
            c["by_tag"][ks[1]]["points"] += 1

        def invented(b):
            for c in b["cases"]:
                c["by_tag"] = {"invented": {"points": c["points"], "old_vs_bu": len(c["mismatches"])}}

        def neg_group(b):
            for g in b["totals"]:
                if g != "all":
                    b["totals"][g]["decisions"] = -1
        for label, fn in (("SOL-F11 both fixture decisions flipped (bu != old) while mismatches stay [] and agree stays true", flip_fixture_bu),
                          ("SOL-F11 fixture.sides differ from the fixture case decision", lambda b: b["fixture"]["sides"]["Inside"].__setitem__("bu", not b["fixture"]["sides"]["Inside"]["bu"])),
                          ("SOL-F11 agree_both_sides set false (contradicts the decisions)", lambda b: b["fixture"].__setitem__("agree_both_sides", False)),
                          ("SOL-F12 every by_tag replaced by one invented tag with equal sums", invented),
                          ("SOL-F12 per-group totals.decisions = -1", neg_group),
                          ("SOL-F12 one point moved between two tags (equal totals, different distribution)", move_point),
                          ("SOL-F12 a count stored as a float", lambda b: b["cases"][0].__setitem__("points", float(b["cases"][0]["points"]))),
                          ("SOL-F12 a count stored as a boolean", lambda b: b["cases"][0]["by_tag"][sorted(b["cases"][0]["by_tag"])[0]].__setitem__("old_vs_bu", False)),
                          ("SOL-F12 totals.all.decisions changed", lambda b: b["totals"]["all"].__setitem__("decisions", b["totals"]["all"]["decisions"] + 1))):
            vt = mutated(fn)
            chk("%s (%s): record invalid, rule FAIL" % (label, nm), not vt["rule_pass"] and vt["totals"]["invalid_records"] == 1, problems=vt["records"][0]["record_problems"][:2])
    syn = synth_record(cases)
    syn["boundary"]["fixture"]["agree_both_sides"] = False
    syn["boundary"]["status"], syn["status"], syn["exit_code"] = "failed", "failed", 1
    v = verify([("synthetic fixture=false", syn)], cases)
    chk("SOL-F11 complete 0-mismatch record with agree_both_sides false, status failed, exit 1: record invalid", not v["rule_pass"] and v["totals"]["invalid_records"] == 1)
    fxk = [k for k in cases if k["group"] == "fixture"][0]
    fm = {"pos": fxk["pos"][0], "q_double": q_of(IDENTITY, fxk["pos"][0]), "tag": "r001-q", "old": False, "bu": True}
    v = verify([("fixture disagrees", synth_record(cases, {(fxk["name"], "Inside"): [fm]}))], cases)
    chk("SOL-F11 a consistent record whose R-001 fixture disagrees is valid but fails the rule (order-draft condition)",
        not v["rule_pass"] and v["totals"]["invalid_records"] == 0 and v["totals"]["fixture_disagree"] == 1, totals=v["totals"])
    from collections import Counter as _C
    occ = _C((tuple(pz), tag_key(k["queries"][qi][1])) for qi, pz in enumerate(k["pos"]))
    chk("SOL-F13 the dy=0 query %r occurs once in the rebuilt sweep" % (k["queries"][i_near][1],), occ[(tuple(k["pos"][i_near]), tag_key(k["queries"][i_near][1]))] == 1)
    v = verify([("duplicate", synth_record(cases, {("dy=0", "Inside"): [mm(i_near), mm(i_near)]}))], cases)
    chk("SOL-F13 a once-only query registered twice: the second is unverified, rule FAIL", not v["rule_pass"] and v["totals"]["unverified"] == 1 and v["totals"]["in_band"] == 1, totals=v["totals"])
    rep_keys = [kk for kk, n in occ.items() if n > 1]
    if rep_keys:
        (pz, tg), n = rep_keys[0], occ[rep_keys[0]]
        chk("SOL-F13 a query the sweep really repeats (%d times) may be consumed up to that count, not beyond" % n,
            verify([("rep", synth_record(cases, {("dy=0", "Inside"): [dict(mm(i_near), pos=list(pz), q_double=q_of(IDENTITY, list(pz)), tag=k["queries"][[i for i, p2 in enumerate(k["pos"]) if tuple(p2) == pz][0]][1])] * (n + 1)}))], cases)["totals"]["unverified"] == 1)
    chk("SOL-F12 js_num_str matches lab.js String(): 1e-6 -> 0.000001, -9.97e-8 -> -9.97e-8, 0 -> 0, 1.5e-7 -> 1.5e-7",
        [js_num_str(x) for x in (1e-6, -9.97e-8, 0, 1.5e-7, -1e-7, 5e-8)] == ["0.000001", "-9.97e-8", "0", "1.5e-7", "-1e-7", "5e-8"])
    v_zero = verify([("complete zero-mismatch record", synth_record(cases))], cases)
    chk("SOL-F03 a complete, consistent 0-mismatch record passes", v_zero["rule_pass"], totals=v_zero["totals"])
    v_none = verify([], cases)
    chk("SOL-F03 no record at all does not pass", not v_none["rule_pass"])

    # --- PREP-SOL-F04 applied to the rendered texts: a record whose shader texts are not the pinned ones fails the rule
    v_pin = verify([("pinned texts", synth_record(cases))], cases)
    chk("SOL-F04 a complete 0-mismatch record with the pinned shader texts passes", v_pin["rule_pass"] and v_pin["totals"]["drift"] == 0)
    for label, change in (("B-u text changed", {"bu_sha256": "0" * 64}), ("generator texts changed", {"old_sha256": "1" * 64}),
                          ("shader texts missing", None)):
        drifted = synth_record(cases)
        if change is None:
            del drifted["boundary"]["shader_texts"]
        else:
            drifted["boundary"]["shader_texts"].update(change)
        v_d = verify([("drift", drifted)], cases)
        chk("SOL-F04 negative control: %s is drift and fails the rule" % label, not v_d["rule_pass"] and v_d["totals"]["drift"] == 1 and v_d["totals"]["invalid_records"] == 0)
    if records:
        for rpath, rj in records:
            chk("SOL-F04 the stored record %s carries the pinned shader texts" % os.path.basename(rpath), not check_texts(rj), problems=check_texts(rj))

    # --- soundness fuzz over the declared input range (inputs validated first; nothing is skipped silently)
    rng = random.Random(seed)
    fails, n_both, n_valid, n_invalid, attempts = [], 0, 0, 0, 0
    while n_valid < fuzz_n and attempts < 4 * fuzz_n:
        attempts += 1
        kind = rng.choice(["Polygon", "Polygon", "Ellipse", "Rectangle"])
        x0, y0 = rng.uniform(0.05, 0.55), rng.uniform(0.05, 0.55)
        w, h = rng.uniform(0.05, 0.4), rng.uniform(0.05, 0.4)
        if kind == "Polygon":
            tiny_w = rng.choice([w, 10 ** rng.uniform(-10, -3)])
            dy1 = rng.choice([0, 1e-9, 1e-7, rng.uniform(-0.04, 0.04)])
            pts = [[x0, y0], [x0 + tiny_w, y0 + dy1], [x0 + w, y0 + dy1 / 2], [x0 + w, y0 + h], [x0, y0 + h]]
            pts = [[min(max(p[0], 0.0), 1.0), min(max(p[1], 0.0), 1.0)] for p in pts]
            reg = polygon_region(pts)
            ea, eb = (pts[0], pts[1]) if rng.random() < 0.5 else (pts[1], pts[2])
        else:
            wb = w if kind == "Rectangle" or rng.random() < 0.8 else 10 ** rng.uniform(-8.9, -3)
            reg = {"kind": kind, "bounds": [x0, x0 + wb, y0, y0 + h]}
            ea, eb = [x0, y0], [x0 + wb, y0]
        t = rng.random()
        off = rng.choice([-1, 1]) * rng.choice([0, 5e-8, 1e-7, 1.5e-7, 1e-6, 1e-3])
        target = [ea[0] + (eb[0] - ea[0]) * t, ea[1] + (eb[1] - ea[1]) * t + off]
        if kind == "Ellipse":
            b = reg["bounds"]
            ang = rng.uniform(0, 2 * math.pi)
            sx = 1 + rng.choice([0, 1e-7, -1e-7, 1e-6])
            target = [(b[0] + b[1]) / 2 + (b[1] - b[0]) / 2 * math.cos(ang) * sx, (b[2] + b[3]) / 2 + (b[3] - b[2]) / 2 * math.sin(ang)]
        if rng.random() < 0.5:
            pj2, pos = IDENTITY, [f32(target[0]), f32(target[1]), 0.0]
        else:
            sc = 10 ** rng.uniform(-1, 5.4) if rng.random() < 0.3 else rng.uniform(0.5, 2)
            th = rng.uniform(0, 2 * math.pi)
            ax = [[sc * math.cos(th), sc * math.sin(th)], [-sc * math.sin(th), sc * math.cos(th)], [rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05)]]
            u0, v0, z = rng.uniform(0.02, 0.98), rng.uniform(0.02, 0.98), f32(rng.uniform(0, 1))
            base = [target[m] - ax[0][m] * u0 - ax[1][m] * v0 - ax[2][m] * z for m in (0, 1)]
            pj2 = {"base": base, "axes": ax}
            pos = pos_for(pj2, target, z)
        if validate_input(reg, pj2, pos):
            n_invalid += 1
            continue
        n_valid += 1
        try:
            cl = classify(reg, pj2, pos)
            ok, emu = emu_ok(reg, pj2, pos, cl)
        except Exception as ex:  # noqa: BLE001  (a failure, never a skip)
            fails.append({"attempt": attempts, "error": repr(ex), "region": reg, "projection": pj2, "pos": pos})
            continue
        n_both += cl["in_band"]
        if not ok:
            fails.append({"attempt": attempts, "kind": kind, "region": reg, "projection": pj2, "pos": pos, "emulated": emu, "f32_set": cl["f32_set"], "dec_set": cl["dec_set"]})
    chk("soundness fuzz: %d valid inputs (%d generated outside the declared range were refused before evaluation and counted) x 2 representations x 6 evaluation orders (incl. flush-to-zero); every emulated decision inside its own representation's set (%d inputs admit a difference)" % (n_valid, n_invalid, n_both),
        not fails and n_valid == fuzz_n, failures=fails[:5], valid=n_valid, invalid=n_invalid)
    return checks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--record", action="append", required=True)
    v.add_argument("--out", required=True)
    s = sub.add_parser("selftest")
    s.add_argument("--out", required=True)
    s.add_argument("--fuzz", type=int, default=3000)
    s.add_argument("--record", action="append", default=[], help="stored boundary records for the record-validation controls")
    a = ap.parse_args()
    if a.cmd == "verify":
        recs = []
        for p in a.record:
            with open(p, encoding="utf-8") as fh:
                recs.append((p.replace("\\", "/"), json.load(fh)))
        res = verify(recs)
        res.update(accepted=accepted(res), rule="o9-rule.md revision 5 (fixture consistency, key-by-key tallies, multiset queries, model M decision sets incl. FTZ in every association, record validation, per-shader observed check, declared range, pinned shader texts)", div_ulps=DIV_ULPS, len_ulps=LEN_ULPS)
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "x", encoding="utf-8", newline="\n") as fh:
            json.dump(res, fh, indent=1)
            fh.write("\n")
        print(summary(res))
        return 0 if res["accepted"] else 1
    recs = []
    for p in a.record:
        with open(p, encoding="utf-8") as fh:
            recs.append((p.replace("\\", "/"), json.load(fh)))
    checks = selftest(a.fuzz, records=recs)
    res = {"checks": checks, "ok": all(c["ok"] for c in checks)}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "x", encoding="utf-8", newline="\n") as fh:
        json.dump(res, fh, indent=1)
        fh.write("\n")
    for c in checks:
        print(("ok   " if c["ok"] else "FAIL ") + c["check"])
    return 0 if res["ok"] else 1


def summary(res):
    """The verdict lines a run log keeps: totals, then per record its problems and every difference that is not in-band."""
    t = res["totals"]
    lines = ["O9 verify (model M, each observed decision against its own shader's set): records %d (invalid %d, drift %d), mismatches %d, in-band %d, out-of-band %d, out-of-range %d, unverified %d, representation-dependent %d; rule %s; accepted (rule_pass AND 0 out-of-range) %s"
             % (t["records"], t["invalid_records"], t["drift"], t["mismatches"], t["in_band"], t["out_of_band"], t["out_of_range"], t["unverified"], t["repr_differs"], "PASS" if res["rule_pass"] else "FAIL", accepted(res))]
    for r in res["records"]:
        lines.append("  %s: record problems %d, drift %d, %d mismatches, %d in-band, %d out-of-band, %d out-of-range, %d unverified" % (r["record"], len(r["record_problems"]), len(r["drift"]), r["mismatches"], r["in_band"], len(r["out_of_band"]), len(r["out_of_range"]), len(r["unverified"])))
        lines += ["     record problem: %s" % x for x in r["record_problems"][:20]] + ["     drift: %s" % x for x in r["drift"]]
        lines += ["     %s %s %s %s %s" % (x["status"], x["case"], x["side"], x["tag"], x.get("reason")) for x in (r["out_of_band"] + r["out_of_range"] + r["unverified"])[:20]]
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
