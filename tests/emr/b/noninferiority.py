"""REQ-D952 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> paired p95/median t bounds.

The experimental unit is a paired block, not a request. The estimand is the
geometric mean of candidate/baseline block-p95 ratios. Pooled p95 is diagnostic.
No optional stopping, refitting to the run, or within-block pseudo-replication.
"""
import math
import random
import statistics

LATENCY_RATIO_LIMIT = 1.10
CONCURRENT_RATIO_LIMIT = 1.10
CONCURRENT_MEDIAN_LIMIT = 1.00
CI_RATIO_LIMIT = 1.25
MIN_ATTRIBUTION = .95
SINGLE_BLOCKS = 10
SINGLE_REQUESTS = 120
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


def noninferiority(baseline, candidate, limit=LATENCY_RATIO_LIMIT, *, statistic='p95'):
    if len(baseline) != len(candidate):
        raise ValueError('paired blocks required')
    logs, before, after = [], [], []
    for a, b in zip(baseline, candidate):
        if len(a) != len(b):
            raise ValueError('paired blocks require equal sample counts')
        # Validate all observations even when the median would hide a NaN.
        p95(a)
        p95(b)
        if statistic not in ('p95', 'median'):
            raise ValueError('p95 or median statistic required')
        estimator = p95 if statistic == 'p95' else statistics.median
        before.append(estimator(a))
        after.append(estimator(b))
        logs.append(math.log(after[-1] / before[-1]))
    result = log_ratio_bound(logs)
    pooled_a, pooled_b = p95(sum(baseline, [])), p95(sum(candidate, []))
    return {**result, 'baseline_block_' + statistic + '_ms': before, 'candidate_block_' + statistic + '_ms': after,
            'block_log_ratios': logs, 'baseline_p95_ms': pooled_a, 'candidate_p95_ms': pooled_b,
            'pooled_p95_ratio': pooled_b / pooled_a, 'point_limit': limit,
            'upper_limit': LATENCY_RATIO_LIMIT,
            'accepted': result['point_ratio'] <= limit and result['upper_95_ratio'] <= LATENCY_RATIO_LIMIT,
            'samples_per_revision': sum(map(len, baseline)), 'paired_blocks': len(baseline),
            'statistic': statistic,
            'method': 'one-sided 95% Student t on paired block-' + statistic + ' log ratios'}


def concurrent_result(baseline, candidate):
    """D952: both complete tail and typical-requester rules must pass."""
    tail = noninferiority(baseline, candidate, CONCURRENT_RATIO_LIMIT)
    median = noninferiority(baseline, candidate, CONCURRENT_MEDIAN_LIMIT, statistic='median')
    return {**tail, 'tail_accepted': tail['accepted'], 'median': median,
            'accepted': tail['accepted'] and median['accepted']}


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
    This deliberately includes the median point condition. At equality that
    condition still caps each concurrent workload near .5; more bursts cannot
    deliver .80 whole-run power when ALL estimands are equal.
    """
    rng = random.Random(949)
    result = {'seed': 949, 'replicates': replicates, 'sd_log_ratio': .15,
              'assumption': 'independent normal paired block-p95 log ratios; true ratio=1'}
    # Fixed reference experiment for the simulation self-check, independent of
    # the selected plan. D956 empirical design power is in power_design.py.
    result['reference_single_blocks'] = 30
    for name, n, point_limit in [('single', 30, 1.10),
                                  ('concurrent_tail', CONCURRENT_BLOCKS, 1.10),
                                  ('concurrent_median', CONCURRENT_BLOCKS, 1.00),
                                  ('sustained', SUSTAINED_BLOCKS, 1.10)]:
        bounds = accepted = 0
        for _ in range(replicates):
            value = log_ratio_bound([rng.gauss(0, .15) for _ in range(n)])
            bound = value['upper_95_ratio'] <= LATENCY_RATIO_LIMIT
            bounds += bound
            accepted += bound and value['point_ratio'] <= point_limit
        result[name] = {'blocks': n, 'ni_bound_power': bounds / replicates,
                        'acceptance_power': accepted / replicates}
    models = {name: {'blocks': n, 'tail_mean': 0, 'tail_sd': .15}
              for name, n in [('single', 30), ('sustained', SUSTAINED_BLOCKS),
                             ('concurrent-24', CONCURRENT_BLOCKS), ('concurrent-48', CONCURRENT_BLOCKS)]}
    for name in ('concurrent-24', 'concurrent-48'):
        models[name].update(median_mean=0, median_sd=.15, tail_median_correlation=0)
    result['complete_rules_at_equality'] = whole_rule_probability(models, replicates)['scenarios']['all_estimands_equal']
    result['passed'] = (result['single']['acceptance_power'] >= .94
                        and .48 <= result['concurrent_median']['acceptance_power'] <= .52
                        and result['complete_rules_at_equality']['joint'] < .26)
    result['scope'] = 'complete metric, workload and joint rules; reference model uses SD=.15 for all metrics and independent tail/median; passed validates the simulation, not the 80% design target'
    return result


def whole_rule_probability(models, replicates=20000, seed=952):
    """Joint complete rules, paired tail/median covariance retained per workload.

    Normal block log ratios, independent workloads, plug-in means/SD/covariance.
    Conditional on functional/JIT/attribution/quiet-host validity and a killed
    M36; those are not random latency variables in this model. No acceptance
    evidence is created by this prospective simulation.
    """
    rng = random.Random(seed)
    scenarios = ('all_estimands_equal', 'tail_equal_r7_median', 'r7_effects')
    counts = {s: {**{k: 0 for k in models}, 'joint': 0} for s in scenarios}
    def accepts(values, mean, limit):
        n = len(values)
        avg = sum(values) / n
        sd = math.sqrt(sum((v - avg) ** 2 for v in values) / (n - 1))
        return (mean + avg <= math.log(limit)
                and mean + avg + T95[n-1] * sd / math.sqrt(n) <= math.log(1.10))
    for _ in range(replicates):
        outcomes = {s: [] for s in scenarios}
        for name, model in models.items():
            n = model['blocks']
            normals = [rng.gauss(0, 1) for _ in range(n)]
            tail = [z * model['tail_sd'] for z in normals]
            median = None
            if 'median_mean' in model:
                rho = model['tail_median_correlation']
                median = [(rho * z + math.sqrt(max(0, 1-rho*rho)) * rng.gauss(0, 1)) * model['median_sd'] for z in normals]
            for scenario in scenarios:
                passed = accepts(tail, model['tail_mean'] if scenario == 'r7_effects' else 0, 1.10)
                if median is not None:
                    passed &= accepts(median, 0 if scenario == 'all_estimands_equal' else model['median_mean'], 1.00)
                counts[scenario][name] += passed
                outcomes[scenario].append(passed)
        for scenario in scenarios:
            counts[scenario]['joint'] += all(outcomes[scenario])
    return {'seed': seed, 'replicates': replicates, 'models': models,
            'scenarios': {s: {k: n / replicates for k, n in values.items()} for s, values in counts.items()},
            'at_equality': counts['all_estimands_equal']['joint'] / replicates,
            'at_r7_effects': counts['r7_effects']['joint'] / replicates,
            'equality_target': .80, 'equality_target_met': counts['all_estimands_equal']['joint'] / replicates >= .80,
            'scope': 'joint complete statistical rules of single, sustained, c24 tail+median, c48 tail+median; M36 reuses L03',
            'assumptions': 'normal paired log ratios; r7 plug-in moments, correlated tail/median; independent workloads; no uncertainty in fitted moments; conditional on host, attribution, functional, JIT and M36 validity',
            'limitation': 'Median point<=1.00 limits each concurrent rule to at most 0.5 at complete equality; the 0.80 joint target is unattainable. Tail-only equality is a different scenario.'}


def r7_probability(directory, replicates=20000):
    import hashlib
    import json
    from pathlib import Path
    selections = {'single': 'comparison-bf351ac5', 'sustained': 'comparison-bf351ac5',
                  'concurrent-24': 'comparison-e0e0e608', 'concurrent-48': 'comparison-88acf0d6'}
    models, sources = {}, {}
    for name, comparison in selections.items():
        path = Path(directory) / comparison / 'summary.json'
        raw = path.read_bytes()
        samples = json.loads(raw)['samples'][name]
        tail = noninferiority(samples['r3'], samples['candidate'])['block_log_ratios']
        observed = {'paired_point': math.exp(statistics.mean(tail)), 'sd_log_ratio': statistics.stdev(tail)}
        if name == 'single':
            # R7's ten-request p95 is a maximum; carrying its mean to the new
            # larger-block p95 would change the estimand. Model selected blocks
            # from the recorded request populations instead (no idle effect
            # can be inferred from that older run).
            rng = random.Random(95240)
            a, b = sum(samples['r3'], []), sum(samples['candidate'], [])
            tail = [math.log(p95(rng.choices(b, k=SINGLE_REQUESTS)) / p95(rng.choices(a, k=SINGLE_REQUESTS))) for _ in range(20000)]
        model = {'blocks': SINGLE_BLOCKS if name == 'single' else SUSTAINED_BLOCKS if name == 'sustained' else CONCURRENT_BLOCKS,
                 'tail_mean': statistics.mean(tail), 'tail_sd': statistics.stdev(tail)}
        if name.startswith('concurrent'):
            median = noninferiority(samples['r3'], samples['candidate'], statistic='median')['block_log_ratios']
            model.update(median_mean=statistics.mean(median), median_sd=statistics.stdev(median),
                         tail_median_correlation=statistics.correlation(tail, median))
        models[name] = model
        sources[name] = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                         'observed_pairs': len(samples['r3']), 'observed_requests_per_block': len(samples['r3'][0]),
                         'original_block_summary': observed,
                         'moment_model': f'20000 empirical request resamples of {SINGLE_REQUESTS} per revision (seed 95240); normal approximation to block log ratios' if name == 'single' else 'observed paired blocks'}
    return {**whole_rule_probability(models, replicates), 'sources': sources,
            'design_limitation': 'r7 single uses 6x10 without prescribed 200ms gaps; R9 pilot is required to investigate idle effects; r7 is design input only'}


if __name__ == '__main__':
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument('--r7-directory')
    args = parser.parse_args()
    result = power_self_check()
    if args.r7_directory:
        result['whole_run'] = r7_probability(args.r7_directory)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
