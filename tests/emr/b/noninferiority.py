"""REQ-D949 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> paired block p95 t bound.

The experimental unit is a paired block, not a request. The estimand is the
geometric mean of candidate/baseline block-p95 ratios. Pooled p95 is diagnostic.
No optional stopping, refitting to the run, or within-block pseudo-replication.
"""
import math
import random
import statistics

LATENCY_RATIO_LIMIT = 1.10
CONCURRENT_RATIO_LIMIT = 1.00
CI_RATIO_LIMIT = 1.25
MIN_ATTRIBUTION = .95
SINGLE_BLOCKS = 30
CONCURRENT_BLOCKS = 24
SUSTAINED_BLOCKS = 12

# One-sided Student t .95 quantiles, df=1..30. Fixed D949 designs use
# df=29/23/11; small known-input tests and CI also use this table.
T95 = (None, 6.3137515148, 2.9199855804, 2.3533634348, 2.1318467863,
       2.0150483733, 1.9431802805, 1.8945786051, 1.8595480375,
       1.8331129327, 1.8124611228, 1.7958848187, 1.7822875556,
       1.7709333959, 1.7613101358, 1.7530503557, 1.7458836763,
       1.7396067261, 1.7340636066, 1.7291328115, 1.7247182429,
       1.7207429028, 1.7171443744, 1.7138715277, 1.7108820799,
       1.7081407613, 1.7056179198, 1.7032884457, 1.7011309343,
       1.6991270265, 1.6972608866)


def p95(values):
    ordered = sorted(values)
    if not ordered or any(not math.isfinite(v) or v <= 0 for v in ordered):
        raise ValueError('latencies must be finite and positive')
    return ordered[math.ceil(.95 * len(ordered)) - 1]


def log_ratio_bound(log_ratios):
    n = len(log_ratios)
    if not 2 <= n <= len(T95) or any(not math.isfinite(x) for x in log_ratios):
        raise ValueError('2..31 finite paired block log ratios required')
    mean = statistics.mean(log_ratios)
    sd = statistics.stdev(log_ratios)
    se = sd / math.sqrt(n)
    return {'point_ratio': math.exp(mean), 'upper_95_ratio': math.exp(mean + T95[n-1] * se),
            'mean_log_ratio': mean, 'sd_log_ratio': sd, 'se_log_ratio': se,
            'degrees_of_freedom': n-1, 't_95': T95[n-1]}


def noninferiority(baseline, candidate, limit=LATENCY_RATIO_LIMIT):
    if len(baseline) != len(candidate):
        raise ValueError('paired blocks required')
    logs, before, after = [], [], []
    for a, b in zip(baseline, candidate):
        if len(a) != len(b):
            raise ValueError('paired blocks require equal sample counts')
        before.append(p95(a))
        after.append(p95(b))
        logs.append(math.log(after[-1] / before[-1]))
    result = log_ratio_bound(logs)
    pooled_a, pooled_b = p95(sum(baseline, [])), p95(sum(candidate, []))
    return {**result, 'baseline_block_p95_ms': before, 'candidate_block_p95_ms': after,
            'block_log_ratios': logs, 'baseline_p95_ms': pooled_a, 'candidate_p95_ms': pooled_b,
            'pooled_p95_ratio': pooled_b / pooled_a, 'point_limit': limit,
            'upper_limit': LATENCY_RATIO_LIMIT,
            'accepted': result['point_ratio'] <= limit and result['upper_95_ratio'] <= LATENCY_RATIO_LIMIT,
            'samples_per_revision': sum(map(len, baseline)), 'paired_blocks': len(baseline),
            'method': 'one-sided 95% Student t on paired block-p95 log ratios'}


def gate_result(statistics_result, mode):
    """CI records NI statistics without using the bound as a hosted gate."""
    if mode == 'ci-gross':
        return statistics_result['point_ratio'] <= CI_RATIO_LIMIT
    if mode == 'acceptance':
        return statistics_result['accepted']
    raise ValueError('explicit ci-gross or commander acceptance mode required')


def power_self_check(replicates=20000):
    """Prospective normal log-ratio model, seed/SD fixed before R9 data.

    SD=.15 is conservative relative to r7 single (.078), close to c48 (.150).
    This is a design check under assumptions, not measured power. Concurrent's
    point<=1 caps acceptance near .5 at equality: report it separately.
    """
    rng = random.Random(949)
    result = {'seed': 949, 'replicates': replicates, 'sd_log_ratio': .15,
              'assumption': 'independent normal paired block-p95 log ratios; true ratio=1'}
    for name, n, point_limit in [('single', SINGLE_BLOCKS, 1.10),
                                  ('concurrent', CONCURRENT_BLOCKS, 1.00),
                                  ('sustained', SUSTAINED_BLOCKS, 1.10)]:
        bounds = accepted = 0
        for _ in range(replicates):
            value = log_ratio_bound([rng.gauss(0, .15) for _ in range(n)])
            bound = value['upper_95_ratio'] <= LATENCY_RATIO_LIMIT
            bounds += bound
            accepted += bound and value['point_ratio'] <= point_limit
        result[name] = {'blocks': n, 'ni_bound_power': bounds / replicates,
                        'acceptance_power': accepted / replicates}
    result['passed'] = result['single']['acceptance_power'] >= .94
    return result


if __name__ == '__main__':
    import json
    result = power_self_check()
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
