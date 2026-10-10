"""D941: one-sided non-inferiority of same-run candidate/r3 p95.

Resample paired interleaved blocks, then requests within the selected blocks.
The 95th percentile bootstrap ratio is an upper bound, not a two-sided test
for any difference. Fixed constants and seed precede collection of live data.
"""
import math
import random

BOOTSTRAP_REPLICATES = 10000
BOOTSTRAP_SEED = 941
LATENCY_RATIO_LIMIT = 1.10
CONCURRENT_RATIO_LIMIT = 1.00
MIN_SINGLE_SAMPLES = 30
MIN_INTERLEAVED_BLOCKS = 6
MIN_ATTRIBUTION = .95


def p95(values):
    ordered = sorted(values)
    if not ordered or any(not math.isfinite(v) or v <= 0 for v in ordered):
        raise ValueError('latencies must be finite and positive')
    return ordered[math.ceil(.95 * len(ordered)) - 1]


def noninferiority(baseline, candidate, limit=LATENCY_RATIO_LIMIT):
    if len(baseline) != len(candidate) or len(baseline) < 2:
        raise ValueError('at least two paired blocks required')
    for a, b in zip(baseline, candidate):
        if len(a) != len(b):
            raise ValueError('paired blocks require equal sample counts')
        p95(a)
        p95(b)
    rng = random.Random(BOOTSTRAP_SEED)
    ratios = []
    for _ in range(BOOTSTRAP_REPLICATES):
        a, b = [], []
        for index in rng.choices(range(len(baseline)), k=len(baseline)):
            # Paired block controls temporal drift. Requests are independent
            # across revisions, so within-block resampling is independent.
            a.extend(rng.choices(baseline[index], k=len(baseline[index])))
            b.extend(rng.choices(candidate[index], k=len(candidate[index])))
        ratios.append(p95(b) / p95(a))
    before, after = p95(sum(baseline, [])), p95(sum(candidate, []))
    upper = sorted(ratios)[math.ceil(.95 * len(ratios)) - 1]
    return {'baseline_p95_ms': before, 'candidate_p95_ms': after,
            'p95_ratio': after / before, 'upper_95_ratio': upper,
            'ratio_limit': limit, 'accepted': after / before <= limit and upper <= limit,
            'samples_per_revision': sum(map(len, baseline)), 'paired_blocks': len(baseline),
            'method': 'one-sided 95% paired-block hierarchical percentile bootstrap',
            'bootstrap_replicates': BOOTSTRAP_REPLICATES, 'bootstrap_seed': BOOTSTRAP_SEED}
